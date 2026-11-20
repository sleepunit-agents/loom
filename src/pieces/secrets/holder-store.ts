/** Holder-process storage only. Ciphertext and retry receipts share one commit;
 * neither loom.db nor the old secrets store is opened here. Not a KeyHolder:
 * callers must await this API outside a synchronous registry transaction.
 */
import Database from 'better-sqlite3';
import { Encrypter, Decrypter, identityToRecipient } from 'age-encryption';
import { createHmac, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertPrivateDirectory, privateBytes } from './local-holder.js';
import { secretName } from './input.js';

const unavailable = () => new Error('Secret holder storage unavailable');
const context = z.object({member: z.string().min(1).max(256), writeId: z.uuid()}).strict();
/** Passed by trusted composition after authenticating the member and checking
 * current household permission. Never take this object directly from a request.
 * The store binds attribution; it does not implement household authorization.
 */
export interface HolderWrite { member: string; writeId: string }
export interface HolderStore {
  set(who: HolderWrite, name: string, value: Uint8Array, mode: 'add' | 'replace'): Promise<void>;
  remove(who: HolderWrite, name: string): void;
  /** Positive evidence only: false does not exclude an in-flight commit. The
   * caller must durably bind this id to full input before using it to reconcile. */
  hasReceipt(who: HolderWrite): boolean;
  read(name: string): Promise<Uint8Array>;
  /** Opaque public lifetime marker; never derived from a value. */
  generation(): string;
  close(): void;
}

function assertPrivateFile(fd: number) {
  const s = fstatSync(fd);
  if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.nlink !== 1) throw unavailable();
}
function privateDatabase(path: string) {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { assertPrivateFile(fd); } finally { closeSync(fd); }
}

/** Explicit private directory and independent identity/fingerprint key files.
 * fingerprintKeyFile holds exactly 32 random bytes, kept separately from backups
 * of the ciphertext DB. No clear value or unkeyed value digest is persisted.
 * This API owns an internal copy of set's input; the caller still owns its bytes.
 */
export interface RetainedHolderKeys { identities?: string[]; fingerprintKeys?: string[] }
export async function openHolderStore(directory: string, identityFile: string, fingerprintKeyFile: string,
  previous: RetainedHolderKeys = {}): Promise<HolderStore> {
  let db: Database.Database | undefined;
  const keys: Buffer[] = [];
  try {
    assertPrivateDirectory(directory);
    const identityFiles = [identityFile, ...(previous.identities ?? [])];
    const keyFiles = [fingerprintKeyFile, ...(previous.fingerprintKeys ?? [])];
    if (identityFiles.length > 32 || keyFiles.length > 32) throw unavailable();
    for (const file of keyFiles) {
      const key = privateBytes(file, 32); keys.push(key);
      if (key.length !== 32) throw unavailable();
    }
    if (new Set(keys.map(key => createHmac('sha256', key).update('holder-key-identity-v1').digest('hex'))).size !== keys.length) throw unavailable();
    const encrypt = new Encrypter(), decrypt = new Decrypter();
    const recipients: string[] = [];
    for (const file of identityFiles) {
      const identity = privateBytes(file);
      try {
        const text = identity.toString('utf8').trim();
        const recipient = await identityToRecipient(text);
        decrypt.addIdentity(text); recipients.push(recipient);
      } finally { identity.fill(0); }
    }
    if (new Set(recipients).size !== recipients.length) throw unavailable();
    encrypt.addRecipient(recipients[0]);
    const path = join(directory, 'holder.db');
    privateDatabase(path);
    // Refuse unsafe existing SQLite sidecars before opening SQLite.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      let fd: number;
      try { fd = openSync(path + suffix, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      try { assertPrivateFile(fd); } finally { closeSync(fd); }
    }
    db = new Database(path, {timeout: 0});
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    const binding = (key: Buffer, recipient: string) => createHmac('sha256', key)
      .update(JSON.stringify(['holder-store-v1', recipient])).digest('hex');
    const verifier = binding(keys[0], recipients[0]);
    const supplied = new Set(keys.flatMap(key => recipients.map(recipient => binding(key, recipient))));
    const historySchema = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1);

    db.transaction(() => {
      const hadStore = !!db!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('holder_config','holder_values','holder_receipts','holder_generation','holder_key_history')").get();
      const hadHistory = !!db!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='holder_key_history'").get();
      db!.exec(`CREATE TABLE IF NOT EXISTS holder_config (id INTEGER PRIMARY KEY CHECK(id=1), verifier TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS holder_generation (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS holder_key_history (id INTEGER PRIMARY KEY CHECK(id=1), bindings TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS holder_values (name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS holder_receipts (member TEXT NOT NULL, write_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, PRIMARY KEY(member, write_id));`);
      const old = db!.prepare('SELECT verifier FROM holder_config WHERE id=1').get() as {verifier:string} | undefined;
      const saved = db!.prepare('SELECT bindings FROM holder_key_history WHERE id=1').get() as {bindings:string} | undefined;
      if ((hadStore && !old) || (hadHistory && !saved)) throw unavailable();
      const history = saved ? historySchema.parse(JSON.parse(saved.bindings)) : old ? [old.verifier] : [];
      if ((saved && (!old || !history.includes(old.verifier))) || new Set(history).size !== history.length
        || history.some(hash => !supplied.has(hash))) throw unavailable();
      if (!old) db!.prepare('INSERT INTO holder_config VALUES (1,?)').run(verifier);
      const updated = [...new Set([...history, verifier])].sort();
      db!.prepare('INSERT INTO holder_key_history VALUES (1,?) ON CONFLICT(id) DO UPDATE SET bindings=excluded.bindings')
        .run(JSON.stringify(updated));
      db!.prepare('INSERT OR IGNORE INTO holder_generation VALUES (1,?)').run(randomUUID());
    }).immediate();
    const store = db;
    let closed = false;
    const check = () => { if (closed) throw unavailable(); };
    const fingerprint = (fingerprintKey: Buffer, who: HolderWrite, action: string, name: string, mode?: string, bytes?: Uint8Array) => {
      check(); context.parse(who); secretName.parse(name);
      const hmac = createHmac('sha256', fingerprintKey);
      hmac.update(JSON.stringify([1, who.member, who.writeId, action, name, mode ?? null]));
      if (bytes) hmac.update(bytes);
      return hmac.digest('hex');
    };
    const replay = (who: HolderWrite, hashes: string[]) => {
      const old = store.prepare('SELECT fingerprint FROM holder_receipts WHERE member=? AND write_id=?')
        .get(who.member, who.writeId) as {fingerprint: string} | undefined;
      if (old && !hashes.includes(old.fingerprint)) throw unavailable();
      return !!old;
    };
    const receipt = (who: HolderWrite, hash: string) => store.prepare('INSERT INTO holder_receipts VALUES (?,?,?)')
      .run(who.member, who.writeId, hash);
    return {
      async set(who, name, value, mode) {
        let bytes: Buffer | undefined;
        try {
          check();
          if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > 65536 || !['add', 'replace'].includes(mode)) throw unavailable();
          // Snapshot all caller-owned mutable input before the first await.
          who = context.parse(who); bytes = Buffer.from(value);
          const hashes = keys.map(key => fingerprint(key, who, 'set', name, mode, bytes));
          if (replay(who, hashes)) return;
          const ciphertext = await encrypt.encrypt(bytes);
          check();
          store.transaction(() => {
            // Another request/process may have committed during encryption.
            if (replay(who, hashes)) return;
            const exists = !!store.prepare('SELECT 1 FROM holder_values WHERE name=?').get(name);
            if (exists !== (mode === 'replace')) throw unavailable();
            store.prepare('INSERT INTO holder_values VALUES (?,?) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext').run(name, ciphertext);
            receipt(who, hashes[0]);
            store.prepare('UPDATE holder_generation SET generation=? WHERE id=1').run(randomUUID());
          }).immediate();
        } catch { throw unavailable(); }
        finally { bytes?.fill(0); }
      },
      remove(who, name) {
        try {
          who = context.parse(who);
          const hashes = keys.map(key => fingerprint(key, who, 'remove', name));
          store.transaction(() => {
            if (replay(who, hashes)) return;
            if (!store.prepare('DELETE FROM holder_values WHERE name=?').run(name).changes) throw unavailable();
            receipt(who, hashes[0]);
            store.prepare('UPDATE holder_generation SET generation=? WHERE id=1').run(randomUUID());
          }).immediate();
        } catch { throw unavailable(); }
      },
      hasReceipt(who) {
        try {
          check(); who = context.parse(who);
          return !!store.prepare('SELECT 1 FROM holder_receipts WHERE member=? AND write_id=?').get(who.member, who.writeId);
        } catch { throw unavailable(); }
      },
      generation() {
        try {
          check();
          return (store.prepare('SELECT generation FROM holder_generation WHERE id=1').get() as {generation:string}).generation;
        } catch { throw unavailable(); }
      },
      async read(name) {
        let bytes: Uint8Array | undefined;
        try {
          check(); secretName.parse(name);
          const row = store.prepare('SELECT ciphertext FROM holder_values WHERE name=?').get(name) as {ciphertext: Buffer} | undefined;
          if (!row || row.ciphertext.length > 128 * 1024) throw unavailable();
          // Bound raw age STREAM payload before allocating decrypted plaintext.
          const separator = row.ciphertext.indexOf('\n--- ');
          const end = separator < 0 ? -1 : row.ciphertext.indexOf(10, separator + 5);
          const payload = row.ciphertext.length - end - 1 - 16;
          if (end < 0 || end >= 16384 || payload <= 16 || payload > 65536 + 16) throw unavailable();
          bytes = await decrypt.decrypt(row.ciphertext);
          check();
          if (!bytes.length || bytes.length > 65536) throw unavailable();
          return bytes;
        } catch { bytes?.fill(0); throw unavailable(); }
      },
      close() { if (!closed) { closed = true; for (const key of keys) key.fill(0); store.close(); } },
    };
  } catch { for (const key of keys) key.fill(0); db?.close(); throw unavailable(); }
}
