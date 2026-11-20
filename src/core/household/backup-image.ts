/** Offline encrypted database prerequisite, not a complete household backup.
 * No file discovery, key generation, restored daemon, publication or arming.
 */
import Database from 'better-sqlite3';
import { Decrypter, Encrypter, identityToRecipient } from 'age-encryption';
import { exportDatabaseImage } from '../db/export-image.js';
import type { Db } from '../db/index.js';
import { validBackupRecipient } from './backup-schema.js';

export interface EncryptedDatabaseImage {
  /** age ciphertext only; safe to hand to the future publication worker. */
  bytes: Buffer;
  tables: { name: string; rows: number; sha256: string }[];
  drill: { database: true };
  coverage: 'database-only';
}
/** The caller owns a dedicated machine-local drill identity and must keep it
 * outside the bundle. Require at least one independent owner recipient: a
 * drill-only bundle cannot be recovered after loss of this machine.
 * Native X25519 age keys only in this in-process prerequisite. SSH settings
 * remain valid configuration, but execution must refuse until supported.
 * Neither private keys nor source/external-holder files are discovered here.
 */
export async function encryptDatabaseImage(db: Db, recipients: readonly string[], drillIdentity: string): Promise<EncryptedDatabaseImage> {
  const owners = [...recipients];
  let plain: Buffer | undefined, opened: Uint8Array | undefined;
  try {
    if (!owners.length || owners.length > 100 || owners.some(key => !/^age1[0-9a-z]+$/.test(key) || !validBackupRecipient(key))) throw Error();
    const drillRecipient = await identityToRecipient(drillIdentity);
    if (owners.includes(drillRecipient)) throw Error();
    const encrypt = new Encrypter();
    for (const recipient of new Set([...owners, drillRecipient])) encrypt.addRecipient(recipient);
    const image = exportDatabaseImage(db);
    plain = image.bytes;
    const ciphertext = Buffer.from(await encrypt.encrypt(plain));
    // Exercise the actual ciphertext, never claim the source image's own
    // reconstruction check is an encrypted restore drill.
    const decrypt = new Decrypter(); decrypt.addIdentity(drillIdentity);
    opened = await decrypt.decrypt(ciphertext);
    const restoredBytes = Buffer.from(opened.buffer, opened.byteOffset, opened.byteLength);
    if (!restoredBytes.equals(plain)) throw Error();
    const restored = new Database(restoredBytes);
    try {
      if (restored.pragma('integrity_check', { simple: true }) !== 'ok' || (restored.pragma('foreign_key_check') as unknown[]).length) throw Error();
    } finally { restored.close(); }
    return { bytes: ciphertext, tables: image.tables, drill: { database: true }, coverage: 'database-only' };
  } catch {
    // Never return crypto diagnostics, supplied identities or database words.
    throw new Error('Encrypted database export or restore drill failed');
  } finally {
    plain?.fill(0); opened?.fill(0);
  }
}
