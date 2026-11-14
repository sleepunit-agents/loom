/** Portable non-database input for a future encrypted household bundle.
 * Never walk a context recursively. Artwork on the new side is in loom.db;
 * continuity databases and independent Secrets recovery are separate inputs.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface ContextFileSelection {
  agent: string;
  /** Only hashes referenced by the owning notes snapshot, not directory contents. */
  noteHashes: readonly string[];
}
export interface PortableFile { path: string; bytes: Buffer; sha256: string }
const documents = ['IDENTITY.md', 'preferences.md', 'self-model.md'] as const;
const name = /^[a-z][a-z0-9-]{0,39}$/;
const section = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.md$/;
const digest = /^[a-f0-9]{64}$/;
const MAX_FILE = 10 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024, MAX_FILES = 4096;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** Linux worker prerequisite: descriptor-relative traversal through procfs pins
 * every ancestor even if it is renamed/replaced during capture. Refuse other
 * platforms rather than fall back to a symlink-racy pathname walk. All source
 * components must be real directories; aliases (including HOME aliases) refuse.
 * The caller supplies a selection from its captured household/notes metadata.
 * Returned plaintext belongs to the caller and MUST be cleared after encryption.
 * On failure this allocator clears all buffers before losing ownership.
 * No writes, database opens, key discovery, recursive globs or process calls.
 */
export function capturePortableFiles(home: string, selection: readonly ContextFileSelection[]): PortableFile[] {
  const out: PortableFile[] = [], held: number[] = [];
  let total = 0;
  const directory = (parent: number | undefined, leaf: string, optional = false): number | undefined => {
    try {
      const fd = openSync(parent === undefined ? leaf : `/proc/self/fd/${parent}/${leaf}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      held.push(fd); return fd;
    } catch (e) { if (optional && missing(e)) return undefined; throw e; }
  };
  const file = (parent: number, leaf: string, path: string, optional = false, expectedHash?: string) => {
    let fd: number | undefined, bytes: Buffer | undefined;
    try {
      try { fd = openSync(`/proc/self/fd/${parent}/${leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if (optional && missing(e)) return; throw e; }
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_FILE) || total + Number(before.size) > MAX_TOTAL || out.length >= MAX_FILES) throw Error();
      bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw Error();
        offset += count;
      }
      const after = fstatSync(fd, { bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n) throw Error();
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (expectedHash !== undefined && sha256 !== expectedHash) throw Error();
      out.push({ path, bytes, sha256 }); total += bytes.length;
      bytes = undefined; // ownership transfers only after every check
    } finally { bytes?.fill(0); if (fd !== undefined) closeSync(fd); }
  };
  try {
    if (process.platform !== 'linux' || !isAbsolute(home) || home.includes('\\') || home.includes('\0')) throw Error();
    const parts = home.split('/').filter(Boolean);
    if (parts.some(p => p === '.' || p === '..') || !parts.length) throw Error();
    if (selection.length > 100 || new Set(selection.map(s => s.agent)).size !== selection.length) throw Error();
    // Validate the entire selection before opening the home.
    for (const item of selection) if (!name.test(item.agent) || item.noteHashes.length > MAX_FILES || item.noteHashes.some(h => !digest.test(h))) throw Error();
    let root = directory(undefined, '/')!;
    for (const part of parts) root = directory(root, part)!;
    const agents = directory(root, 'agents')!;
    for (const item of [...selection].sort((a, b) => a.agent.localeCompare(b.agent))) {
      const agent = directory(agents, item.agent)!;
      const prefix = `agents/${item.agent}`;
      // Creed is required; the other fixed documents may be deliberately absent.
      for (const doc of documents) file(agent, doc, `${prefix}/${doc}`, doc !== 'IDENTITY.md');
      for (const group of ['roles', 'projects'] as const) {
        const dir = directory(agent, group, true);
        if (dir === undefined) continue;
        const leaves = readdirSync(`/proc/self/fd/${dir}`).filter(leaf => section.test(leaf)).sort();
        for (const leaf of leaves) file(dir, leaf, `${prefix}/${group}/${leaf}`);
      }
      const hashes = [...new Set(item.noteHashes)].sort();
      if (hashes.length) {
        const notes = directory(agent, 'note-files')!;
        const buckets = new Map<string, number>();
        for (const hash of hashes) {
          const shard = hash.slice(0, 2);
          let bucket = buckets.get(shard);
          if (bucket === undefined) { bucket = directory(notes, shard)!; buckets.set(shard, bucket); }
          file(bucket, hash, `${prefix}/note-files/${shard}/${hash}`, false, hash);
        }
      }
    }
    return out;
  } catch {
    for (const captured of out) captured.bytes.fill(0);
    throw new Error('Portable household file capture failed');
  } finally { for (const fd of held.reverse()) closeSync(fd); }
}
