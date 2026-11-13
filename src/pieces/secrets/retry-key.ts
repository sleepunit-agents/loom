/** Daemon retry material, independent of the holder's identity and receipt key.
 * No discovery, creation, replacement or rotation of key files at startup. */
import {createHmac} from 'node:crypto';
import {closeSync, constants, fstatSync, openSync, readSync} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';
import type {Db, Operations, Sharing} from '../../core/index.js';
import type {GrantAttention} from './index.js';
import {assertPrivateDirectory} from './local-holder.js';
import {installAsyncSecretValues, type AsyncSecretMutations} from './async-values.js';

const unavailable = () => new Error('Secret retry key unavailable');
const binding = 'daemon-retry-key-v1';
/** Called before registration, even by explicit in-memory fixture composition.
 * Pinning is separate from operation transactions and retained indefinitely,
 * just like the write journal. An older unbound journal cannot be adopted on
 * trust: none of its full input is available to establish which key made it. */
export function bindSecretRetryKey(db: Db, key: Uint8Array): void {
  try {
    if (db.inTransaction || !(key instanceof Uint8Array) || key.byteLength !== 32) throw unavailable();
    const verifier = createHmac('sha256', key).update('loom-secrets-daemon-retry-key-v1\0').digest('hex');
    db.transaction(() => {
      const old = db.prepare('SELECT value FROM secrets_meta WHERE key=?').get(binding) as {value:string}|undefined;
      if (old) { if (old.value !== verifier) throw unavailable(); return; }
      if (db.prepare('SELECT sequence FROM secrets_write_intents LIMIT 1').get()) throw unavailable();
      db.prepare('INSERT INTO secrets_meta (key,value) VALUES (?,?)').run(binding,verifier);
    }).immediate();
  } catch { throw unavailable(); }
}

/** Explicit daemon composition only. The parent must be private, and the file
 * must be an owned single-link regular file with no group/world access. Read
 * from one O_NOFOLLOW descriptor with a strict allocation bound. O_NONBLOCK
 * keeps a misconfigured FIFO from hanging startup before fstat can reject it.
 * The installer copies the key; this function erases its file buffer on exit. */
export function installAsyncSecretValuesFromFile(db: Db, operations: Operations, sharing: () => Sharing,
  holder: AsyncSecretMutations, keyFile: string, attention?: GrantAttention): void {
  let fd: number|undefined, bytes: Buffer|undefined;
  try {
    if (!isAbsolute(keyFile)) throw unavailable();
    assertPrivateDirectory(dirname(keyFile));
    fd = openSync(keyFile,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.nlink !== 1 || s.size !== 32) throw unavailable();
    bytes = Buffer.alloc(33);
    let used = 0, count: number;
    while (used < bytes.length && (count = readSync(fd,bytes,used,bytes.length-used,null)) > 0) used += count;
    if (used !== 32) throw unavailable();
    installAsyncSecretValues(db,operations,sharing,holder,bytes.subarray(0,32),attention);
  } catch { throw unavailable(); }
  finally { bytes?.fill(0); if (fd !== undefined) closeSync(fd); }
}
