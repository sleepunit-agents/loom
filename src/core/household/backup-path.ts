/** Internal Linux encrypted path publication. No production caller or pruning. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync,
  readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { encryptHouseholdBundle } from './backup-bundle.js';
import { planHouseholdBackupRetention } from './backup-retention.js';

type DrilledBundle = Awaited<ReturnType<typeof encryptHouseholdBundle>>;
const maximum = 897 * 1024 * 1024;
const marker = '.loom-backup';
const failure = () => new Error('Household backup path publication failed');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Trusted local worker seam, never an operation input. produce must return the
 * actual result of the registered encrypted bundle/drill, never arbitrary bytes.
 * A structural result is not proof of encryption or authority to publish.
 * The caller owns staging holds, local arming, selected sources/Secrets recovery
 * and serialization of runs. This bracket checks ownership BEFORE producing and
 * again afterwards; saving configuration alone never calls it.
 *
 * Both paths must exist, be absolute canonical Linux paths without symlinks.
 * Target must belong to this OS user and not be group/other writable; it must be
 * empty or contain a single-link regular .loom-backup file (content irrelevant).
 * All ancestors are descriptor-pinned and rechecked after the async producer.
 * Files are exclusive 0600; a synced temp file is atomically linked into the
 * final name without replacement, then its temporary name is unlinked and the
 * directory synced. This no-clobber link replaces overwrite-capable rename.
 * Existing bundles and unrelated files are never replaced or pruned.
 *
 * On failure, owned partial temp files or a complete final publication can remain;
 * no failure result grants retention authority. A collision always refuses, even
 * for identical bytes. OS user/filesystem are trusted, not hostile same-uid code.
 * This verifies exact durable bytes, not restored-home usability or provenance.
 */
export async function publishHouseholdPathBundle(home: string, target: string, stamp: string,
  produce: () => Promise<DrilledBundle>, maxBytes = maximum): Promise<{ name: string; bytes: number; sha256: string }> {
  const held: number[] = [], edges: { parent: number; leaf: string; fd: number }[] = [];
  let result: { name: string; bytes: number; sha256: string } | undefined, failed = false;
  const at = (fd: number, leaf: string) => `/proc/self/fd/${fd}/${leaf}`;
  const same = (a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>) => a.dev === b.dev && a.ino === b.ino;
  const pin = (path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)) throw failure();
    const parts = path.split('/').slice(1);
    if (!parts.length || parts.some(p => !p || p === '.' || p === '..')) throw failure();
    let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); held.push(fd);
    for (const leaf of parts) {
      const parent = fd;
      fd = openSync(at(parent, leaf), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      held.push(fd); edges.push({ parent, leaf, fd });
    }
    return fd;
  };
  const checkEdges = () => {
    for (const e of edges) if (!same(lstatSync(at(e.parent, e.leaf)), fstatSync(e.fd))) throw failure();
  };
  const regular = (fd: number) => {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!()) throw failure();
    return st;
  };
  const absent = (dir: number, leaf: string) => {
    try { lstatSync(at(dir, leaf)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    throw failure();
  };
  const write = (dir: number, leaf: string, bytes: Buffer) => {
    const fd = openSync(at(dir, leaf), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) throw failure();
        offset += count;
      }
      if (regular(fd).size !== bytes.length) throw failure();
      fsyncSync(fd);
    } finally { closeSync(fd); }
  };
  const verify = (dir: number, leaf: string, bytes: number, expected: string) => {
    const fd = openSync(at(dir, leaf), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = regular(fd);
      if (before.size !== bytes || (before.mode & 0o7777) !== 0o600) throw failure();
      const digest = createHash('sha256'), chunk = Buffer.alloc(Math.min(bytes, 64 * 1024));
      let offset = 0;
      while (offset < bytes) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, bytes - offset), offset);
        if (!count) throw failure();
        digest.update(chunk.subarray(0, count)); offset += count;
      }
      const after = regular(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || !same(lstatSync(at(dir, leaf)), after) || digest.digest('hex') !== expected) throw failure();
    } finally { closeSync(fd); }
  };
  try {
    if (process.platform !== 'linux' || !process.getuid || typeof produce !== 'function'
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximum) throw failure();
    planHouseholdBackupRetention([stamp], 1); // share strict calendar validation
    const name = `loom-household-${stamp}.bundle`;
    const source = pin(home), destination = pin(target);
    const check = () => {
      checkEdges();
      const st = fstatSync(destination);
      if (st.uid !== process.getuid!() || (st.mode & 0o022) !== 0) throw failure();
      const h = realpathSync(`/proc/self/fd/${source}`), t = realpathSync(`/proc/self/fd/${destination}`);
      const r = relative(h, t);
      if (r === '' || !isAbsolute(r) && r !== '..' && !r.startsWith('../')) throw failure();
      const entries = readdirSync(`/proc/self/fd/${destination}`);
      if (entries.length) {
        const fd = openSync(at(destination, marker), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { regular(fd); } finally { closeSync(fd); }
      }
      absent(destination, name);
    };
    check();
    const bundle = await produce();
    check();
    if (bundle?.coverage !== 'explicit-household-inputs' || !Buffer.isBuffer(bundle.bytes) || !bundle.bytes.length
      || bundle.bytes.length > maxBytes || ['app', 'continuity', 'files', 'cookieKey', 'secrets'].some(k => bundle.drill?.[k as keyof typeof bundle.drill] !== true)) throw failure();
    const bytes = Buffer.from(bundle.bytes); // snapshot borrowed producer output
    if (!bytes.subarray(0, 22).equals(Buffer.from('age-encryption.org/v1\n'))) throw failure();
    const expected = hash(bytes);
    if (!readdirSync(`/proc/self/fd/${destination}`).length) {
      write(destination, marker, Buffer.from('loom next household encrypted backup\n')); fsyncSync(destination);
    }
    const temp = `.loom-backup-${randomUUID()}.pending`;
    write(destination, temp, bytes);
    verify(destination, temp, bytes.length, expected);
    check();
    linkSync(at(destination, temp), at(destination, name)); // atomic and EEXIST refuses
    unlinkSync(at(destination, temp));
    fsyncSync(destination);
    verify(destination, name, bytes.length, expected);
    checkEdges();
    result = { name, bytes: bytes.length, sha256: expected };
  } catch { failed = true; }
  finally { for (const fd of held.reverse()) { try { closeSync(fd); } catch { failed = true; } } }
  if (failed || !result) throw failure();
  return result;
}
