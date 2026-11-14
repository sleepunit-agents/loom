/** Internal explicit-input bundle and drill. No source acquisition, public restore,
 * publication, daemon startup or machine-local arming. */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { Decrypter, Encrypter, identityToRecipient } from 'age-encryption';
import type { Db } from '../db/index.js';
import { exportDatabaseImage } from '../db/export-image.js';
import { captureHouseholdContinuity, type ContinuitySources } from './backup-continuity.js';
import { selectRegisteredContinuity } from './backup-selection.js';
import type { PortableFile } from './backup-files.js';
import { validBackupRecipient } from './backup-schema.js';

/** Temporary internal interface until the owning Secrets recovery role lands.
 * export returns OWNED opaque owner-encrypted recovery bytes, including holder,
 * identities and historical fingerprint/receipt keys, recoverable with each
 * supplied owner recipient. verifyRestore restores
 * into its own isolated scratch state, compares recovery with the captured part,
 * and cleans up before resolving. It must never change the live holder. Core
 * never learns its keys, opens its files, or interprets its ciphertext.
 * Both methods must reject errors; there is no optional/missing-part success.
 */
export interface HouseholdSecretsRecovery {
  export(ownerRecipients: readonly string[]): Promise<Buffer>;
  verifyRestore(bytes: Buffer): Promise<void>;
}
export interface HouseholdBundleInput {
  db: Db;
  home: string;
  continuity: ContinuitySources;
  /** Bind explicit handles to registration in the captured app image. */
  registeredAgents?: true;
  /** Exact optional imported cookie-key file. null records deliberate absence.
   * Next sign-in CSRF key is already in the filtered app rows. Borrowed. */
  cookieKey: Buffer | null;
  secrets: HouseholdSecretsRecovery;
  recipients: readonly string[];
  /** Dedicated machine-local identity; never part of the archive. */
  drillIdentity: string;
}
export interface HouseholdBundleBudget { appBytes: number; secretsBytes: number; bundleBytes: number }
const limits: HouseholdBundleBudget = { appBytes: 256 * 1024 * 1024, secretsBytes: 256 * 1024 * 1024, bundleBytes: 896 * 1024 * 1024 };
const magic = Buffer.from('loom-next-household\0\x01');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface Manifest {
  format: 'loom-next-household'; version: 1;
  files: { path: string; bytes: number; sha256: string }[];
  absent: string[];
}
/** Native age recipients only. Output is ciphertext only plus a bounded drill
 * summary. This is not a production source selector or a restored-daemon test.
 * Each source database has its own snapshot; mutable files are not simultaneous.
 * All owned plaintext is wiped, including failed encryption/decryption/drills.
 * SQLite/JS/crypto internal copies are outside this buffer-ownership guarantee.
 */
export async function encryptHouseholdBundle(input: HouseholdBundleInput, budget: HouseholdBundleBudget = limits) {
  const owned: Buffer[] = [];
  let plain: Buffer | undefined, opened: Uint8Array | undefined;
  const own = (bytes: Buffer) => { if (!Buffer.isBuffer(bytes)) throw Error(); owned.push(bytes); return bytes; };
  try {
    budget = { ...budget };
    for (const key of Object.keys(limits) as (keyof HouseholdBundleBudget)[])
      if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0 || budget[key] > limits[key]) throw Error();
    const recipients = [...input.recipients];
    if (!recipients.length || recipients.length > 100 || recipients.some(key => !/^age1[0-9a-z]+$/.test(key) || !validBackupRecipient(key))) throw Error();
    if ((input.cookieKey !== null && (!Buffer.isBuffer(input.cookieKey) || input.cookieKey.length !== 32))
      || typeof input.secrets?.export !== 'function' || typeof input.secrets.verifyRestore !== 'function') throw Error();
    // Pin the borrowed key and role before the first asynchronous boundary.
    const cookieKey = input.cookieKey === null ? null : own(Buffer.from(input.cookieKey)), secrets = input.secrets;
    const identity = input.drillIdentity;
    const home = input.home, db = input.db, registered = input.registeredAgents;
    const sources: ContinuitySources = { agents: input.continuity.agents.map(item => ({ ...item })),
      knowledge: input.continuity.knowledge, people: input.continuity.people };
    const drillRecipient = await identityToRecipient(identity);
    if (recipients.includes(drillRecipient)) throw Error();
    const encrypt = new Encrypter();
    for (const recipient of new Set([...recipients, drillRecipient])) encrypt.addRecipient(recipient);
    const app = exportDatabaseImage(db); own(app.bytes);
    if (app.bytes.length > budget.appBytes) throw Error();
    let selected = sources;
    if (registered) {
      const captured = new Database(app.bytes);
      try { selected = selectRegisteredContinuity(captured, home, sources); }
      finally { captured.close(); }
    }
    const continuity = captureHouseholdContinuity(home, selected);
    for (const file of [...continuity.databases, ...continuity.files]) own(file.bytes);
    const file = (path: string, bytes: Buffer): PortableFile => ({ path, bytes, sha256: sha256(bytes) });
    const files = [file('loom.db', app.bytes), ...continuity.databases, ...continuity.files, ...(cookieKey ? [file('ui-cookie.key', cookieKey)] : [])];
    let total = files.reduce((sum, item) => sum + item.bytes.length, 0);
    if (total > budget.bundleBytes) throw Error();
    const recovery = own(await secrets.export(Object.freeze([...recipients])));
    if (!Buffer.isBuffer(recovery) || !recovery.length || recovery.length > budget.secretsBytes) throw Error();
    files.push(file('secrets/recovery.age', recovery)); total += recovery.length;
    // Stable length-prefixed binary envelope: no tar extraction, recursion,
    // base64 expansion, path execution, or plaintext staging directory.
    const manifest: Manifest = { format: 'loom-next-household', version: 1,
      files: files.map(item => ({ path: item.path, bytes: item.bytes.length, sha256: item.sha256 })), absent: [...continuity.absent, ...(cookieKey === null ? ['ui-cookie.key'] : [])] };
    const header = own(Buffer.from(JSON.stringify(manifest)));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    total += magic.length + length.length + header.length;
    if (total > budget.bundleBytes) throw Error();
    plain = Buffer.concat([magic, length, header, ...files.map(item => item.bytes)], total);
    const ciphertext = Buffer.from(await encrypt.encrypt(plain));
    const decrypt = new Decrypter(); decrypt.addIdentity(identity);
    opened = await decrypt.decrypt(ciphertext);
    const restored = Buffer.from(opened.buffer, opened.byteOffset, opened.byteLength);
    if (!restored.equals(plain)) throw Error();
    // Read the ACTUAL decrypted envelope, including its manifest and every byte.
    const start = magic.length + 4, end = start + restored.readUInt32BE(magic.length);
    const decoded = JSON.parse(restored.toString('utf8', start, end)) as Manifest;
    if (JSON.stringify(decoded) !== JSON.stringify(manifest)) throw Error();
    let offset = end;
    for (const item of decoded.files) {
      const bytes = restored.subarray(offset, offset + item.bytes); offset += item.bytes;
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw Error();
      if (item.path === 'loom.db' || continuity.databases.some(db => db.path === item.path)) {
        const db = new Database(bytes);
        try {
          if (item.path !== 'loom.db') sqliteVec.load(db);
          if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw Error();
        } finally { db.close(); }
      } else if (item.path === 'secrets/recovery.age') {
        // Owned copy isolates the envelope from a role mutating its borrowed input.
        const copy = own(Buffer.from(bytes));
        await secrets.verifyRestore(copy);
        if (sha256(copy) !== item.sha256) throw Error();
      }
    }
    if (offset !== restored.length) throw Error();
    return { bytes: ciphertext, coverage: 'explicit-household-inputs' as const,
      drill: { app: true, continuity: true, files: true, cookieKey: true, secrets: true } as const,
      files: files.length, absent: manifest.absent.length };
  } catch {
    throw new Error('Encrypted household bundle or restore drill failed');
  } finally {
    plain?.fill(0); opened?.fill(0);
    for (const bytes of owned) bytes.fill(0);
  }
}
