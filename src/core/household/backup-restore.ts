/** Restore validation prerequisite. No destination IO, daemon startup or Secrets
 * interpretation. Only a future owning restore consumer may publish these bytes. */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Decrypter } from 'age-encryption';
import { z } from 'zod';
import { HouseholdDatabase } from './document.js';

const MiB = 1024 * 1024;
const magic = Buffer.from('loom-next-household\0\x01');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const agentName = /^[a-z][a-z0-9-]{0,39}$/;
const digest = /^[a-f0-9]{64}$/;
const manifestSchema = z.object({
  format: z.literal('loom-next-household'), version: z.literal(1),
  files: z.array(z.object({ path: z.string().max(256), bytes: z.number().int().nonnegative().max(256 * MiB),
    sha256: z.string().regex(digest) }).strict()).max(16384),
  absent: z.array(z.string().max(256)).max(16384),
}).strict();
const limits = { bundleBytes: 896 * MiB, headerBytes: 4 * MiB, databaseImageBytes: 256 * MiB,
  secretsBytes: 256 * MiB, databaseBytes: 512 * MiB, documentBytes: 64 * MiB,
  fileBytes: 10 * MiB, documentCount: 4096, entryCount: 16384 };
/** Lower any ceiling for constrained restore consumers, never raise format caps. */
export type RestoreBudget = Partial<typeof limits>;
export interface ValidatedHouseholdBundle {
  /** Borrowed views into the supplied plaintext; never retain beyond its lifetime.
   * Validation is not authority to execute settings, start workers or restore Secrets. */
  files: ReadonlyMap<string, Buffer>;
  absent: readonly string[];
  agents: readonly string[];
}
const fail = () => new Error('Household restore validation failed');
function budgetFor(input: RestoreBudget) {
  const budget = { ...limits, ...input };
  for (const key of Object.keys(limits) as (keyof typeof limits)[])
    if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0 || budget[key] > limits[key]) throw fail();
  return budget;
}

/** Validate the actual decrypted binary envelope before ANY destination writes.
 * Does not accept unregistered fixture-only app images. No pathname DB opens,
 * migrations, source reads or writes. Caller owns/wipes the borrowed plaintext.
 * Hashes detect corruption, not provenance: age recipients can also author data.
 * This is a bounded format validator, not a sandbox for hostile native SQLite. */
export function validateHouseholdBundle(plain: Buffer, inputBudget: RestoreBudget = limits): ValidatedHouseholdBundle {
  try {
    const budget = budgetFor(inputBudget);
    if (!Buffer.isBuffer(plain) || plain.length > budget.bundleBytes || plain.length < magic.length + 4
      || !plain.subarray(0, magic.length).equals(magic)) throw fail();
    const start = magic.length + 4, size = plain.readUInt32BE(magic.length), end = start + size;
    if (!size || size > budget.headerBytes || end > plain.length) throw fail();
    const header = plain.subarray(start, end);
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header));
    // Writer emits canonical compact JSON. Re-encoding rejects duplicate keys,
    // invalid/lossy encodings and ambiguous numeric spellings before interpretation.
    if (!Buffer.from(JSON.stringify(raw)).equals(header)) throw fail();
    const manifest = manifestSchema.parse(raw);
    if (manifest.files.length > budget.entryCount || manifest.absent.length > budget.entryCount) throw fail();
    const files = new Map<string, Buffer>(), absent = new Set<string>();
    let offset = end;
    for (const item of manifest.files) {
      if (files.has(item.path) || item.bytes > plain.length - offset) throw fail();
      const bytes = plain.subarray(offset, offset + item.bytes); offset += item.bytes;
      if (hash(bytes) !== item.sha256) throw fail();
      files.set(item.path, bytes);
    }
    if (offset !== plain.length) throw fail();
    for (const path of manifest.absent) {
      if (absent.has(path) || files.has(path)) throw fail();
      absent.add(path);
    }
    const app = files.get('loom.db'), recovery = files.get('secrets/recovery.age');
    if (!app?.length || app.length > budget.databaseImageBytes || !recovery?.length || recovery.length > budget.secretsBytes
      || files.get('ui-cookie.key') && files.get('ui-cookie.key')!.length !== 32) throw fail();
    const withDatabase = <T>(bytes: Buffer, continuity: boolean, read: (db: Database.Database) => T): T => {
      if (bytes.length < 100 || bytes.toString('ascii', 0, 16) !== 'SQLite format 3\0'
        || bytes[18] !== 1 || bytes[19] !== 1) throw fail();
      const db = new Database(bytes);
      try {
        db.pragma('trusted_schema = OFF');
        db.pragma('query_only = ON');
        if (continuity) sqliteVec.load(db);
        else if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='view' OR sql LIKE 'CREATE VIRTUAL TABLE%'").get()) throw fail();
        if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw fail();
        return read(db);
      } finally { db.close(); }
    };
    const agents = withDatabase(app, false, db => {
      const household = new HouseholdDatabase(db).household('/restore-validation');
      if (!household) throw fail();
      const agents = [...new Set(household.agents)];
      if (!agents.length || agents.some(agent => !agentName.test(agent))) throw fail();
      return agents;
    });
    const known = new Set(agents), expectedStores = new Set(['commons/knowledge.db', 'commons/people.db', 'ui-cookie.key']);
    for (const agent of agents) {
      expectedStores.add(`agents/${agent}/memories.db`); expectedStores.add(`agents/${agent}/notes.db`);
      if (!files.has(`agents/${agent}/IDENTITY.md`)) throw fail();
    }
    for (const path of expectedStores) if (Number(files.has(path)) + Number(absent.has(path)) !== 1) throw fail();
    for (const path of absent) if (!expectedStores.has(path)) throw fail();
    const attachments = new Map<string, number>();
    let databaseBytes = 0, documentBytes = 0, documentCount = 0;
    for (const [path, bytes] of files) {
      if (path === 'loom.db' || path === 'secrets/recovery.age' || path === 'ui-cookie.key') continue;
      if (expectedStores.has(path)) {
        databaseBytes += bytes.length;
        if (!bytes.length || bytes.length > budget.databaseImageBytes || databaseBytes > budget.databaseBytes) throw fail();
        withDatabase(bytes, true, db => {
          if (!path.endsWith('/notes.db')) return;
          db.prepare('SELECT path FROM notes LIMIT 0').all();
          for (const row of db.prepare('SELECT sha256,bytes FROM note_files').all() as {sha256: unknown; bytes: unknown}[]) {
            if (typeof row.sha256 !== 'string' || !digest.test(row.sha256) || typeof row.bytes !== 'number'
              || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 10 * MiB) throw fail();
            const key = `${path.slice(0, -'notes.db'.length)}note-files/${row.sha256.slice(0, 2)}/${row.sha256}`;
            if (attachments.has(key) && attachments.get(key) !== row.bytes) throw fail();
            attachments.set(key, row.bytes);
          }
        });
        continue;
      }
      const match = /^agents\/([a-z][a-z0-9-]{0,39})\/(IDENTITY\.md|preferences\.md|self-model\.md|(?:roles|projects)\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.md|note-files\/[a-f0-9]{2}\/[a-f0-9]{64})$/.exec(path);
      if (!match || !known.has(match[1])) throw fail();
      documentBytes += bytes.length; documentCount++;
      if (bytes.length > budget.fileBytes || documentBytes > budget.documentBytes || documentCount > budget.documentCount) throw fail();
    }
    for (const [path, bytes] of files) if (path.includes('/note-files/')) {
      if (attachments.get(path) !== bytes.length || hash(bytes) !== path.slice(path.lastIndexOf('/') + 1)) throw fail();
      attachments.delete(path);
    }
    if (attachments.size) throw fail();
    return { files, absent: [...absent], agents };
  } catch { throw fail(); }
}

/** Consume validated views within the owned decrypted buffer's lifetime. Never
 * returns plaintext itself. Even a throwing/rejecting consumer clears it. The
 * trusted consumer must not retain views or return them in its result. Native
 * crypto/SQLite/JS internal copies are outside the owned-buffer guarantee. */
export async function withHouseholdRestore<T>(ciphertext: Uint8Array, identity: string,
  consume: (bundle: ValidatedHouseholdBundle) => Promise<T> | T, inputBudget: RestoreBudget = limits): Promise<T> {
  let plain: Uint8Array | undefined;
  try {
    const budget = budgetFor(inputBudget);
    // age framing and the writer's <=101 recipients fit within this overhead.
    if (!(ciphertext instanceof Uint8Array) || ciphertext.length > budget.bundleBytes + MiB) throw fail();
    const decrypt = new Decrypter(); decrypt.addIdentity(identity);
    plain = await decrypt.decrypt(ciphertext);
    const bytes = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
    return await consume(validateHouseholdBundle(bytes, budget));
  } catch { throw fail(); }
  finally { plain?.fill(0); }
}
