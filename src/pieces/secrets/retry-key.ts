/** Daemon retry material, independent of the holder's identity and receipt key.
 * No discovery, creation, replacement or rotation of key files at startup. */
import {createHmac,createSecretKey,type KeyObject} from 'node:crypto';
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
export interface SecretRetryKeyRing { active: Uint8Array; previous: readonly Uint8Array[] }
export type SecretRetryKeyMaterial = Uint8Array | SecretRetryKeyRing;
const ringBinding = 'daemon-retry-keys-v1';
/** All historical verifiers are retained. Rotation is an explicit startup choice;
 * no process may silently discard a key or roll the manifest back to one key. */
export function bindSecretRetryKey(db: Db, material: SecretRetryKeyMaterial): readonly KeyObject[] {
  try {
    if (db.inTransaction) throw unavailable();
    const supplied = material instanceof Uint8Array ? [material] : [material.active,...material.previous];
    if (supplied.some(k => !(k instanceof Uint8Array) || k.byteLength !== 32)) throw unavailable();
    const keys = supplied.map(k=>createSecretKey(k));
    const verifiers = keys.map(k=>createHmac('sha256',k).update('loom-secrets-daemon-retry-key-v1\0').digest('hex'));
    if (new Set(verifiers).size !== verifiers.length) throw unavailable();
    db.transaction(() => {
      const old = db.prepare('SELECT value FROM secrets_meta WHERE key=?').get(binding) as {value:string}|undefined;
      const manifest = db.prepare('SELECT value FROM secrets_meta WHERE key=?').get(ringBinding) as {value:string}|undefined;
      if (manifest) {
        const required: unknown = JSON.parse(manifest.value);
        if (!old || !Array.isArray(required) || !required.length || required.some(v=>typeof v!=='string' || !/^[a-f0-9]{64}$/.test(v))
          || new Set(required).size!==required.length || !required.includes(old.value) || required.some(v=>!verifiers.includes(v))) throw unavailable();
      } else if (old) {
        if (!verifiers.includes(old.value)) throw unavailable();
      } else {
        if (db.prepare('SELECT sequence FROM secrets_write_intents LIMIT 1').get()) throw unavailable();
        db.prepare('INSERT INTO secrets_meta (key,value) VALUES (?,?)').run(binding,verifiers[0]);
      }
      // Sorted history makes file ordering irrelevant; active selection is explicit
      // in configuration, not authority that is inferred from database contents.
      db.prepare('INSERT INTO secrets_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(ringBinding,JSON.stringify([...verifiers].sort()));
    }).immediate();
    return keys;
  } catch { throw unavailable(); }
}

/** Explicit daemon composition only. The parent must be private, and the file
 * must be an owned single-link regular file with no group/world access. Read
 * from one O_NOFOLLOW descriptor with a strict allocation bound. O_NONBLOCK
 * keeps a misconfigured FIFO from hanging startup before fstat can reject it.
 * The installer copies the key; this function erases its file buffer on exit. */
export interface SecretRetryKeyFiles { active: string; previous: readonly string[] }
export function installAsyncSecretValuesFromFile(db: Db, operations: Operations, sharing: () => Sharing,
  holder: AsyncSecretMutations, keyFile: string | SecretRetryKeyFiles, attention?: GrantAttention): void {
  const buffers: Buffer[] = [];
  function read(path: string): Uint8Array {
    let fd: number|undefined;
    try {
      if (!isAbsolute(path)) throw unavailable();
      assertPrivateDirectory(dirname(path));
      fd = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = fstatSync(fd);
      if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.nlink !== 1 || s.size !== 32) throw unavailable();
      const bytes = Buffer.alloc(33); buffers.push(bytes);
      let used = 0, count: number;
      while (used < bytes.length && (count = readSync(fd,bytes,used,bytes.length-used,null)) > 0) used += count;
      if (used !== 32) throw unavailable();
      return bytes.subarray(0,32);
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  try {
    const paths = typeof keyFile === 'string' ? {active:keyFile,previous:[]} : keyFile;
    const active = read(paths.active), previous = paths.previous.map(read);
    installAsyncSecretValues(db,operations,sharing,holder,{active,previous},attention);
  } catch { throw unavailable(); }
  finally { for (const bytes of buffers) bytes.fill(0); }
}
