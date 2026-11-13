/** Offline import into a different home. No legacy backend is activated. */
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Db } from '../core/index.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdRows } from '../core/household/rows.js';
import { TokenDatabase } from '../core/household/tokens.js';
import { parseHouseholdDocument, parseTokenDocument } from '../household.js';
import { SessionDatabase } from '../ui/session-db.js';
import type { SessionFile } from '../ui/sessions.js';

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
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Source document is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source document must be an object');
  return value as Record<string, unknown>;
}
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const seconds = z.number().finite();
const storedSession = z.object({ issuedAt: seconds, secret: digest, seenAt: seconds.optional(), device: z.string().optional(), label: z.string().optional(), via: z.enum(['token','link','passkey']).optional(), signedInAt: seconds.optional(), agent: z.literal(true).optional() }).passthrough();
const link = z.object({ expires: seconds, secret: digest, label: z.string().optional(), signedInAt: seconds.optional(), agent: z.literal(true).optional() }).passthrough();
const challenge = z.object({ expires: seconds, purpose: z.enum(['register','login']), secret: digest.optional() }).passthrough();
const passkey = z.object({ id: z.string().min(1), publicKey: z.string().min(1), alg: z.number().int(), counter: z.number().int().nonnegative(), label: z.string(), created: seconds, lastUsed: seconds.optional(), secret: digest, tokenLabel: z.string().optional() }).passthrough();
const credentialMaps = z.object({
  v: z.literal(1), sessions: z.record(digest, storedSession), links: z.record(digest, link).optional(),
  challenges: z.record(digest, challenge).optional(), passkeys: z.record(z.string(), passkey).optional(),
}).passthrough();
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
  const target = realpathSync(home), source = realpathSync(from);
  if (target === source || target.startsWith(source + '/')) throw new Error('Household import requires a different destination home');
  const files = snapshot(from), checksum = checksumOf(files);
  const raw = object(files.get('household.json'));
  parseHouseholdDocument(home, raw);
  const tokens = parseTokenDocument(object(files.get('tokens.json'), { v: 1, tokens: [] }));
  const used = object(files.get('tokens.used.json'), {});
  if (Object.values(used).some(v => typeof v !== 'string')) throw new Error('Invalid token usage');
  const sessions = object(files.get('ui-sessions.json'), { v: 1, sessions: {} });
  if (!credentialMaps.safeParse(sessions).success) throw new Error('Invalid session credentials');
  for (const [id, value] of Object.entries((sessions.passkeys ?? {}) as Record<string,{id:string}>)) if (id !== value.id) throw new Error('Invalid passkey credential id');
  if (sessions.members !== undefined && (!sessions.members || typeof sessions.members !== 'object' || Array.isArray(sessions.members))) throw new Error('Invalid session members');
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
    const assertImportContentEqual = (a: unknown, b: unknown) => { if (!isDeepStrictEqual(a,b)) throw new Error('Household import content comparison failed'); };
    assertImportContentEqual(new HouseholdDatabase(db).document(), raw);
    assertImportContentEqual(tokenStore.document(), tokens); assertImportContentEqual(tokenStore.used(), used);
    assertImportContentEqual(sessionStore.read(), sessions); assertImportContentEqual(Object.fromEntries(pieces.entries()), Object.fromEntries(settings));
    // Envelope reconstruction intentionally reads only its named entities.
    // Also compare physical IDs, so a hidden extra row cannot import a token
    // or other state that does not appear in the reconstructed document.
    const keys = (value: unknown) => Object.keys((value ?? {}) as object).sort();
    const expectedIds: Record<typeof concerns[number], string[]> = {
      settings: ['household-envelope','session-envelope','token-envelope'],
      agents: [...new Set(raw.agents as string[])].sort(),
      members: ((raw.members ?? []) as Array<{person:string}>).map(m => m.person).sort(),
      projects: [], tokens: [...new Set(tokens.tokens.map(t => t.sha256))].sort(), token_use: keys(used),
      sessions: keys(sessions.sessions), links: keys(sessions.links), challenges: keys(sessions.challenges), passkeys: keys(sessions.passkeys),
      readers: keys(sessions.members),
      push: sessions.push === undefined ? [] : ['state', ...keys((sessions.push as {subs?:object}).subs).map(id => `sub:${id}`)].sort(),
      piece_settings: settings.map(([id]) => id).sort(), imports: [],
    };
    for (const concern of concerns) assertImportContentEqual(new HouseholdRows(db, concern).entries().map(([id]) => id).sort(), expectedIds[concern]);
    for (const digest of expectedIds.tokens) assertImportContentEqual(tokenStore.records(digest), tokens.tokens.filter(t => t.sha256 === digest));
    if (checksumOf(snapshot(from)) !== checksum) throw new Error('Source changed during household import');
    if (key && !previousKey) copyKey(home, key);
    receipts.put('legacy-home', { checksum, at: now });
    return { imported: true, checksum, counts: { agents: (raw.agents as string[]).length, members: (raw.members as unknown[] | undefined)?.length ?? 0, tokens: tokens.tokens.length, sessions: Object.keys(sessions.sessions as object).length, pieces: settings.length } };
  }).immediate();
}
