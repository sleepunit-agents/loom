/** Offline policy slice only. The final migration composition owns the stopped-daemon
 * gate and must include names, requests, grants and audit in the same transaction. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { migrate, type Db } from '../../core/index.js';
import { secretAgent, secretName } from './input.js';
import { secretPolicy, type SecretPolicy } from './policy.js';
import { schema } from './schema/001.js';

const level = z.enum(['ask', 'auto', 'never']);
const sourcePolicy = z.object({
  v: z.literal(1).optional(),
  default: level.default('ask'),
  secrets: z.record(secretName, z.object({
    grant: level.optional(),
    agents: z.array(secretAgent).max(1000).optional(),
    houses: z.array(secretAgent).max(1000).optional(),
    // The old decide() clamps positive integer durations at eight hours.
    minutes: z.number().int().positive().transform(n => Math.min(n, 480)).optional(),
  }).strict()).default({}),
}).strict();
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};

/** No raw source or validation diagnostics escape: a malformed metadata file may
 * contain an accidental value. Unknown fields are refused, never copied to DB. */
export function parseLegacySecretPolicy(bytes: Buffer): SecretPolicy {
  try {
    const parsed = sourcePolicy.parse(JSON.parse(bytes.toString('utf8')));
    return secretPolicy.parse({ default: parsed.default, secrets: parsed.secrets });
  } catch { throw new Error('Invalid legacy secret policy'); }
}

/** Explicit read-only policy.json input; never discovers a home or reads the
 * encrypted value store. Same bytes are a no-op, different bytes are refused. */
export function importSecretPolicy(db: Db, from: string, options: { interrupt?: () => void } = {}) {
  let bytes: Buffer;
  try { bytes = readFileSync(from); }
  catch { throw new Error('Cannot read legacy secret policy'); }
  const policy = parseLegacySecretPolicy(bytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  return db.transaction(() => {
    migrate(db, 'secrets', schema);
    const previous = db.prepare("SELECT value FROM secrets_meta WHERE key='policy-source-checksum'").get() as { value: string } | undefined;
    if (previous) {
      if (previous.value !== checksum) throw new Error('A different secret policy source was already imported');
      return { imported: false, checksum, names: Object.keys(policy.secrets).length };
    }
    if (db.prepare("SELECT 1 FROM secrets_meta WHERE key='policy'").get()) throw new Error('Secret policy destination must be empty before import');
    db.prepare("INSERT INTO secrets_meta VALUES ('policy',?)").run(JSON.stringify(policy));
    const interrupted: unknown = options.interrupt?.();
    if (interrupted instanceof Promise) {
      void interrupted.catch(() => {});
      throw new Error('Policy import interruption hook must be synchronous');
    }
    const actual = db.prepare("SELECT value FROM secrets_meta WHERE key='policy'").get() as { value: string };
    if (canonical(JSON.parse(actual.value)) !== canonical(policy)) throw new Error('Secret policy import comparison failed');
    db.prepare("INSERT INTO secrets_meta VALUES ('policy-source-checksum',?)").run(checksum);
    return { imported: true, checksum, names: Object.keys(policy.secrets).length };
  })();
}
