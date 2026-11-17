/** A house's build context: the files of one commit as a tar stream, written by the worker itself.
 *
 * git is used here as a store of objects and nothing more. The worker asks it for the commit's tree
 * (`ls-tree`) and for the bytes of each file (`cat-file --batch`), and writes the tar itself. So no file of
 * a repository is ever interpreted on this machine: no `.gitattributes` (nothing is left out, substituted
 * or converted), no `.gitmodules`, no filter, no signature check. `git archive` did all of those, and each
 * was a way for whoever can push to have git do something here.
 *
 * What goes in: every regular file, byte for byte, with whether it is executable; every symbolic link, as
 * a link with the target the commit gives it. Nothing else: a submodule's entry is skipped, and no
 * directory, owner or time of the repository's is written (every entry is root's, at time 0).
 *
 * A file's name comes from the tree and goes into a tar header, never a command line. Everything about a
 * tree that the worker will not write is found before a byte is written, and fails the build:
 *  - a name that is absolute, has a `.` or `..` part or an empty one, is not UTF-8, or is longer than
 *    CONTEXT_NAME_MAX bytes;
 *  - one name twice, or a name that passes through another entry (`a` and `a/x`, where `a` is a file or
 *    a link): what becomes of those is an unpacker's choice, and a link in the way of a file is a way out
 *    of the place a context is unpacked;
 *  - a link whose target is empty, holds a NUL, is longer than a name may be, or is not UTF-8 and too
 *    long for a plain header (a plain header carries any bytes; a pax one carries UTF-8);
 *  - a context past its limits (worker-limits.ts).
 * Names and targets longer than the 100 bytes a plain header holds are written in a pax extended header,
 * which every engine's builder reads. */
import type { ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { COMMIT } from '../apps/merge-target.js';
import { CONTEXT_ENTRIES_MAX, CONTEXT_FILE_MAX, CONTEXT_MAX, CONTEXT_NAME_MAX } from './worker-limits.js';

/** Why a context could not be written. The worker's own words: never a name from the repository. */
export class HouseContextError extends Error {}
/** Start git as an object store: these arguments, with or without a pipe to write to. Output is always read. */
export type ObjectStore = (args: readonly string[], input: 'pipe' | 'ignore') => ChildProcess;
export interface ContextLimits { file: number; whole: number; entries: number; name: number }
/** The limits a context is held to unless a test names others. `whole` counts the bytes of files and of
 * link targets, not the headers written around them. */
export const CONTEXT_LIMITS: ContextLimits = { file: CONTEXT_FILE_MAX, whole: CONTEXT_MAX, entries: CONTEXT_ENTRIES_MAX, name: CONTEXT_NAME_MAX };

const BLOCK = 512, PLAIN_NAME = 100;
/** The modes a tree gives the entries the worker writes: a file, an executable file, a symbolic link. */
const FILE = '100644', EXECUTABLE = '100755', LINK = '120000', SUBMODULE = '160000';
interface Entry { name: Buffer; oid: string; size: number; link: boolean; executable: boolean; target?: Buffer }
const utf8 = new TextDecoder('utf-8', { fatal: true });
/** These bytes as text, when they are UTF-8. */
const text = (bytes: Buffer): string | undefined => { try { return utf8.decode(bytes); } catch { return undefined; } };
/** A name that goes nowhere but down from where it starts: relative, with no part that is empty, `.` or `..`.
 * The one rule for a file's name in a context and for a Housefile's path. */
export const relativeName = (name: string): boolean => name.length > 0 && !name.startsWith('/') && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
/** End a git the worker started, and whatever it started in turn: it leads a process group of its own. */
export const endGit = (child: ChildProcess): void => {
  try { if (child.pid) { process.kill(-child.pid, 'SIGKILL'); return; } } catch { /* no such group: the one process, then */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
};

/** One 512-byte tar header. Every field the repository does not decide is fixed. */
function header(name: Buffer, type: '0' | '2' | 'x', size: number, mode: number, link?: Buffer): Buffer {
  const block = Buffer.alloc(BLOCK);
  name.copy(block, 0, 0, Math.min(name.length, PLAIN_NAME));
  const octal = (value: number, at: number, width: number) => { block.write(value.toString(8).padStart(width - 1, '0'), at, width - 1, 'latin1'); };
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  block.write(type, 156, 1, 'latin1');
  link?.copy(block, 157, 0, Math.min(link.length, PLAIN_NAME));
  block.write('ustar\0' + '00', 257, 8, 'latin1');
  // The checksum is of the header with its own field as spaces.
  block.fill(0x20, 148, 156);
  let sum = 0; for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return block;
}
const padded = (bytes: Buffer): Buffer => bytes.length % BLOCK ? Buffer.concat([bytes, Buffer.alloc(BLOCK - bytes.length % BLOCK)]) : bytes;
/** A pax record: its own length in bytes, a space, `key=value`, a newline. */
function record(key: string, value: Buffer): Buffer {
  const rest = Buffer.concat([Buffer.from(` ${key}=`), value, Buffer.from('\n')]);
  let length = rest.length + 1;
  while (String(length).length + rest.length !== length) length = String(length).length + rest.length;
  return Buffer.concat([Buffer.from(String(length)), rest]);
}
/** The headers of one entry: a pax header first when its name or its link's target does not fit a plain one. */
function headers(name: Buffer, type: '0' | '2', size: number, mode: number, link?: Buffer): Buffer {
  const long = [...(name.length > PLAIN_NAME ? [record('path', name)] : []), ...(link && link.length > PLAIN_NAME ? [record('linkpath', link)] : [])];
  const plain = header(name, type, size, mode, link);
  if (!long.length) return plain;
  const extended = Buffer.concat(long);
  return Buffer.concat([header(Buffer.from('PaxHeader'), 'x', extended.length, 0o644), padded(extended), plain]);
}

/** Read exactly what is asked from a stream, in order: a line, or so many bytes a piece at a time. */
function reader(stream: NodeJS.ReadableStream) {
  const pieces = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let held: Buffer = Buffer.alloc(0);
  const more = async () => { const next = await pieces.next(); if (next.done) throw new HouseContextError('git failed'); held = held.length ? Buffer.concat([held, next.value]) : next.value; };
  return {
    async line(limit: number): Promise<string> {
      for (;;) {
        const end = held.indexOf(0x0a);
        if (end >= 0) { const line = held.subarray(0, end).toString('latin1'); held = held.subarray(end + 1); return line; }
        if (held.length > limit) throw new HouseContextError('git failed');
        await more();
      }
    },
    async *bytes(count: number): AsyncGenerator<Buffer> {
      for (let left = count; left > 0;) {
        if (!held.length) await more();
        const piece = held.subarray(0, left); held = held.subarray(piece.length); left -= piece.length;
        yield piece;
      }
    },
  };
}

/** The entries of a commit's tree that go into a context, checked: names, count and sizes. */
function entries(listing: Buffer, limits: ContextLimits): Entry[] {
  const found: Entry[] = [], names = new Set<string>(); let whole = 0;
  for (let at = 0; at < listing.length;) {
    const end = listing.indexOf(0, at), tab = listing.indexOf(0x09, at);
    if (end < 0 || tab < 0 || tab > end) throw new HouseContextError('git failed');
    // `<mode> <type> <object> <size>`, then a tab, then the name as the tree has it, byte for byte.
    const [mode, type, oid, size, ...rest] = listing.subarray(at, tab).toString('latin1').split(/ +/);
    const name = listing.subarray(tab + 1, end); at = end + 1;
    if (rest.length || !COMMIT.test(oid ?? '')) throw new HouseContextError('git failed');
    // Another repository's commit pinned here: not this house's files, and not fetched.
    if (mode === SUBMODULE && type === 'commit') continue;
    if (type !== 'blob' || (mode !== FILE && mode !== EXECUTABLE && mode !== LINK) || !/^\d{1,15}$/.test(size ?? '')) throw new HouseContextError('git failed');
    const written = text(name);
    if (written === undefined || !relativeName(written) || name.length > limits.name || names.has(written)) throw new HouseContextError('House has a file name the worker does not take');
    names.add(written);
    const bytes = Number(size), link = mode === LINK;
    if (link ? bytes < 1 || bytes > limits.name : bytes > limits.file) throw new HouseContextError(link ? 'House has a link the worker does not take' : 'House has a file that is too large');
    whole += bytes;
    if (found.push({ name, oid: oid!, size: bytes, link, executable: mode === EXECUTABLE }) > limits.entries || whole > limits.whole) throw new HouseContextError('House is too large');
  }
  // No name passes through another entry: every entry here is a file or a link, so nothing may lie below one.
  for (const name of names) for (let cut = name.lastIndexOf('/'); cut > 0; cut = name.lastIndexOf('/', cut - 1))
    if (names.has(name.slice(0, cut))) throw new HouseContextError('House has a file name the worker does not take');
  return found;
}

/** The commit's files as a tar stream. The stream fails, and so the build does, when git fails, when the
 * context is past a limit or holds a name the worker does not take: each before a byte of it is written,
 * except a git that fails part of the way, which fails the stream where it is. Ending the stream early,
 * or the signal, ends git. */
export function houseContext(store: ObjectStore, commit: string, signal: AbortSignal,
  options: { limits?: ContextLimits; started?: (pid: number) => () => void } = {}): Readable {
  const limits = options.limits ?? CONTEXT_LIMITS, running = new Set<{ child: ChildProcess; forget?: () => void }>();
  const start = (args: readonly string[], input: 'pipe' | 'ignore') => {
    let child: ChildProcess;
    try { child = store(args, input); } catch { throw new HouseContextError('git could not be run'); }
    const one = { child, forget: child.pid ? options.started?.(child.pid) : undefined };
    running.add(one);
    child.once('error', () => {});
    child.once('close', () => { one.forget?.(); running.delete(one); });
    return child;
  };
  const stop = () => { for (const { child } of running) endGit(child); };
  // Over when it has an exit code or a signal ended it: either way `close` may already have been.
  const ended = (child: ChildProcess) => new Promise<number | null>(resolve => { if (child.exitCode !== null || (child.signalCode ?? null) !== null) resolve(child.exitCode); else { child.once('close', resolve); child.once('error', () => resolve(null)); } });
  async function* write(): AsyncGenerator<Buffer> {
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (signal.aborted) throw new HouseContextError('House context cancelled');
      // The whole tree, files only, with sizes: read to its end and checked before anything is written.
      const lister = start(['ls-tree', '-r', '-l', '-z', '--full-tree', commit], 'ignore'), parts: Buffer[] = []; let listed = 0;
      for await (const piece of lister.stdout as AsyncIterable<Buffer>) {
        listed += piece.length;
        // A name is at most so long and there are at most so many: a listing longer than that is refused unread.
        if (listed > limits.entries * (limits.name + 128)) throw new HouseContextError('House is too large');
        parts.push(piece);
      }
      if (await ended(lister) !== 0 || signal.aborted) throw new HouseContextError('git failed');
      const found = entries(Buffer.concat(parts), limits);
      parts.length = 0;
      // One git answers for every file's bytes, asked for one at a time by the object's id.
      const batch = start(['cat-file', '--batch'], 'pipe'), answers = reader(batch.stdout!);
      batch.stdin!.on('error', () => {});
      const object = async function* (entry: Entry): AsyncGenerator<Buffer> {
        batch.stdin!.write(`${entry.oid}\n`);
        if (await answers.line(256) !== `${entry.oid} blob ${entry.size}`) throw new HouseContextError('git failed');
        yield* answers.bytes(entry.size);
        // cat-file ends each object with a newline of its own.
        if (await answers.line(0) !== '') throw new HouseContextError('git failed');
        if (signal.aborted) throw new HouseContextError('House context cancelled');
      };
      // Every link's target first, read and judged before a byte is written. They are small and bounded.
      for (const entry of found) if (entry.link) {
        const pieces: Buffer[] = []; for await (const piece of object(entry)) pieces.push(Buffer.from(piece));
        const target = Buffer.concat(pieces);
        if (target.includes(0) || (text(target) === undefined && target.length > PLAIN_NAME)) throw new HouseContextError('House has a link the worker does not take');
        entry.target = target;
      }
      for (const entry of found) {
        if (entry.link) { yield headers(entry.name, '2', 0, 0o777, entry.target); continue; }
        yield headers(entry.name, '0', entry.size, entry.executable ? 0o755 : 0o644);
        for await (const piece of object(entry)) yield Buffer.from(piece);
        if (entry.size % BLOCK) yield Buffer.alloc(BLOCK - entry.size % BLOCK);
      }
      batch.stdin!.end();
      if (await ended(batch) !== 0) throw new HouseContextError('git failed');
      // The end of a tar: two empty blocks.
      yield Buffer.alloc(2 * BLOCK);
    } finally { signal.removeEventListener('abort', stop); stop(); }
  }
  return Readable.from(write(), { objectMode: false });
}
