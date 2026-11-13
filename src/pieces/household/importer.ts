/** Offline import into a different home. No legacy backend is activated. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Db } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { migrateHouseholdTables } from '../../core/household/schema.js';
import { HouseholdRows } from '../../core/household/rows.js';
import { TokenDatabase } from '../../core/household/tokens.js';
import { parseHouseholdDocument, parseTokenDocument } from '../../household.js';
import { SessionDatabase } from '../../ui/session-db.js';
import type { SessionFile } from '../../ui/sessions.js';

const concerns = ['settings', 'agents', 'members', 'projects', 'tokens', 'token_use', 'sessions', 'links', 'challenges', 'passkeys', 'push', 'readers', 'piece_settings', 'imports'] as const;
function optional(path: string): Buffer | undefined {
  try { return readFileSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
}
function snapshot(home: string): Map<string, Buffer | undefined> {
  const files = new Map(['household.json', 'tokens.json', 'tokens.used.json', 'ui-sessions.json', 'ui-cookie.key'].map(name => [name, optional(join(home, name))]));
  let pieces: string[];
  try { pieces = readdirSync(join(home, 'pieces')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; pieces = []; }
  for (const name of pieces.sort()) {
    const path = `pieces/${name}/settings.json`;
    const body = optional(join(home, path));
    if (body !== undefined) files.set(path, body);
  }
  return files;
}
const checksumOf = (files: Map<string, Buffer | undefined>) => createHash('sha256').update(JSON.stringify([...files].map(([p,b]) => [p,b?.toString('base64') ?? null]))).digest('hex');
function object(bytes: Buffer | undefined, fallback?: object): Record<string, unknown> {
  if (!bytes && fallback) return fallback as Record<string, unknown>;
  if (!bytes) throw new Error('Source household.json is required');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source document must be an object');
  return value as Record<string, unknown>;
}
/** Publish only a complete durable key, never a half-written final pathname. */
function copyKey(home: string, key: Buffer): void {
  const temp = join(home, `.ui-cookie.key-import-${randomUUID()}`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, key); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temp, join(home, 'ui-cookie.key'));
    const dir = openSync(home, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { unlinkSync(temp); }
}
/** Caller holds the destination's stopped-daemon gate; the source must be stopped too. */
export function importHousehold(db: Db, home: string, from: string, now: number, options: { interrupt?: () => void } = {}) {
  if (realpathSync(home) === realpathSync(from)) throw new Error('Household import requires a different destination home');
  const files = snapshot(from), checksum = checksumOf(files);
  const raw = object(files.get('household.json'));
  parseHouseholdDocument(home, raw);
  const tokens = parseTokenDocument(object(files.get('tokens.json'), { v: 1, tokens: [] }));
  const used = object(files.get('tokens.used.json'), {});
  if (Object.values(used).some(v => typeof v !== 'string')) throw new Error('Invalid token usage');
  const sessions = object(files.get('ui-sessions.json'), { v: 1, sessions: {} });
  if (sessions.v !== 1 || !sessions.sessions || typeof sessions.sessions !== 'object' || Array.isArray(sessions.sessions)) throw new Error('Invalid session document');
  for (const field of ['links', 'challenges', 'passkeys', 'members']) if (sessions[field] !== undefined && (!sessions[field] || typeof sessions[field] !== 'object' || Array.isArray(sessions[field]))) throw new Error(`Invalid session ${field}`);
  const settings = [...files].filter(([p]) => p.startsWith('pieces/')).map(([p,b]) => [p.split('/')[1], object(b)] as const);
  const key = files.get('ui-cookie.key');
  if (key && key.length !== 32) throw new Error('Invalid source cookie key');
  if (!key && files.get('ui-sessions.json')) throw new Error('Source sessions require their cookie key');
  // Key files stay files. An exclusive, byte-identical copy is safe to retain
  // after an interruption: retry accepts it; no credential is re-minted.
  const keyPath = join(home, 'ui-cookie.key'), previousKey = optional(keyPath);
  if (previousKey && (!key || !previousKey.equals(key))) throw new Error('Destination cookie key differs from source');
  return db.transaction(() => {
    migrateHouseholdTables(db);
    const receipts = new HouseholdRows<{ checksum: string; at: number }>(db, 'imports');
    const receipt = receipts.get('legacy-home');
    if (receipt) {
      if (receipt.checksum !== checksum) throw new Error('Household source changed since import');
      if (key && !previousKey) copyKey(home, key);
      return { imported: false, checksum };
    }
    if (concerns.some(c => new HouseholdRows(db, c).entries().length)) throw new Error('Destination household tables must be empty');
    new HouseholdDatabase(db).replace(home, raw);
    const tokenStore = new TokenDatabase(db), sessionStore = new SessionDatabase(db);
    tokenStore.replace(tokens, used as Record<string,string>);
    sessionStore.replace(sessions as unknown as SessionFile);
    const pieces = new HouseholdRows(db, 'piece_settings');
    for (const [id, value] of settings) pieces.put(id, value);
    options.interrupt?.();
    const same = (a: unknown, b: unknown) => { if (!isDeepStrictEqual(a,b)) throw new Error('Household import content comparison failed'); };
    same(new HouseholdDatabase(db).document(), raw);
    same(tokenStore.document(), tokens); same(tokenStore.used(), used);
    same(sessionStore.read(), sessions); same(pieces.entries(), [...settings].sort(([a],[b]) => a.localeCompare(b)));
    if (checksumOf(snapshot(from)) !== checksum) throw new Error('Source changed during household import');
    if (key && !previousKey) copyKey(home, key);
    receipts.put('legacy-home', { checksum, at: now });
    return { imported: true, checksum, counts: { agents: (raw.agents as string[]).length, members: (raw.members as unknown[] | undefined)?.length ?? 0, tokens: tokens.tokens.length, sessions: Object.keys(sessions.sessions as object).length, pieces: settings.length } };
  }).immediate();
}
