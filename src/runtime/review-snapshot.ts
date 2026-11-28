/** A frozen review's copy (conversation.review; docs/runtime/worker.md, "Frozen reviews"): the files of one exact commit,
 * its diff against the commit the review names, and what both are, written by the worker on this machine and mounted
 * read-only into the reviewer's container at REVIEW_MOUNT. Nothing of the copy is the body's to change: the engine's
 * read-only bind refuses every write in the container, root's included (the body has no capability to remount), and
 * the worker fingerprints the copy before the body starts and after it ends, and reports both with the job's finish,
 * so loom can see that the review was of what it pinned.
 *
 * The files come from the worker's own git mirror, as a house's do (house-source.ts): fetched by full commit id,
 * written from git's objects by the worker itself (house-context.ts), so no file of the repository is interpreted
 * here. The tar the worker writes is read back by this file alone, which takes only what house-context.ts writes:
 * regular files, links and directories, with the names it checked. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { relativeName } from './house-input.js';
import type { House, HouseSource } from './house-source.js';
import { CONTEXT_FILE_MAX } from './worker-limits.js';

/** The longest diff the worker writes. A longer one is cut, and its file says so at its end. */
export const REVIEW_DIFF_MAX = CONTEXT_FILE_MAX;
/** The copy's parts, under the job's directory and under REVIEW_MOUNT in the container (core/conversations/review-brief.ts). */
export const SNAPSHOT_TREE = 'tree', SNAPSHOT_DIFF = 'change.diff', SNAPSHOT_FACTS = 'review.json';
export class ReviewSnapshotError extends Error {}

export interface ReviewSource { repository: string; head: string; base: string }
/** The address the worker fetches a reviewed repository from: GitHub, by its `owner/name`. */
export const reviewHouse = (repository: string): House => ({ repository: `https://github.com/${repository}.git`, file: '', branch: 'main' });

const BLOCK = 512;
const field = (block: Buffer, at: number, width: number) => { const end = block.indexOf(0, at); return block.subarray(at, end < 0 || end > at + width ? at + width : end); };
const octal = (block: Buffer, at: number, width: number) => {
  const text = field(block, at, width).toString('latin1').trim();
  if (!/^[0-7]{1,12}$/.test(text)) throw new ReviewSnapshotError('Review copy is not one the worker wrote');
  return parseInt(text, 8);
};
/** The pax records the worker writes: `path` and `linkpath`. */
function pax(data: Buffer): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at), length = Number(data.subarray(at, space).toString('latin1'));
    if (space < 0 || !Number.isSafeInteger(length) || length <= 0 || at + length > data.length) throw new ReviewSnapshotError('Review copy is not one the worker wrote');
    const record = data.subarray(space + 1, at + length - 1), equals = record.indexOf(0x3d);
    if (equals < 0) throw new ReviewSnapshotError('Review copy is not one the worker wrote');
    found.set(record.subarray(0, equals).toString('latin1'), Buffer.from(record.subarray(equals + 1)));
    at += length;
  }
  return found;
}

/** What a symbolic link whose target leaves the copy is written as: a small read-only text file saying where it
 * pointed. The reviewer reads that it was a link and to what; nothing under REVIEW_MOUNT leads out of the copy. */
export const outsideLinkWords = (target: string) =>
  `loom: in the reviewed commit this is a symbolic link to ${JSON.stringify(target)}, which points outside the review copy, so it is written as this file and not followed.\n`;

/** Whether a link named `name` (relative to the tree's root) with `target` stays inside the tree, wherever it leads:
 * its target is relative, never climbs above the root, and never climbs (`..`) after passing through another link
 * (`links`, the tree's link names), whose own target could put that climb anywhere. */
export function linkStaysInside(name: string, target: string, links: ReadonlySet<string>): boolean {
  if (!target || target.startsWith('/') || target.includes('\0')) return false;
  const at = name.split('/').slice(0, -1);
  let throughLink = false;
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!at.length || throughLink) return false; at.pop(); continue; }
    if (links.has([...at, part].join('/'))) throughLink = true;
    at.push(part);
  }
  return true;
}

/** Write a tar the worker made (house-context.ts) into `root`, which must not exist yet. Each name is checked again
 * here: relative, with no empty, `.` or `..` part. Files and directories are written first and links last, so no
 * entry is ever written through a link: a file is created only where nothing is, and a directory only below the
 * root. Files keep only whether they are executable and are left read-only (0444 or 0555). A link is written as a
 * link, never followed, when its target stays inside the tree (linkStaysInside); otherwise as a small text file
 * saying where it pointed (outsideLinkWords). */
export async function writeTar(stream: Readable, root: string): Promise<void> {
  await mkdir(root, { mode: 0o755 });
  let held = Buffer.alloc(0), extended: Map<string, Buffer> | undefined;
  const pieces = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const need = async (count: number) => {
    while (held.length < count) {
      const next = await pieces.next();
      if (next.done) throw new ReviewSnapshotError('Review copy ended early');
      held = held.length ? Buffer.concat([held, next.value]) : Buffer.from(next.value);
    }
    const taken = held.subarray(0, count); held = held.subarray(count); return taken;
  };
  const place = (name: Buffer) => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(name).replace(/\/$/, '');
    if (!relativeName(text)) throw new ReviewSnapshotError('Review copy has a name the worker does not take');
    return join(root, text);
  };
  const links: { name: string; path: string; target: string }[] = [];
  for (;;) {
    const block = await need(BLOCK);
    if (block.every(byte => byte === 0)) break;
    const type = String.fromCharCode(block[156]), size = octal(block, 124, 12), mode = octal(block, 100, 8);
    const data = size ? Buffer.from(await need(size)) : Buffer.alloc(0);
    if (size % BLOCK) await need(BLOCK - size % BLOCK);
    if (type === 'x') { extended = pax(data); continue; }
    const name = extended?.get('path') ?? field(block, 0, 100), link = extended?.get('linkpath') ?? field(block, 157, 100);
    extended = undefined;
    const path = place(name);
    if (type === '5') { await mkdir(path, { recursive: true, mode: 0o755 }); continue; }
    await mkdir(join(path, '..'), { recursive: true, mode: 0o755 });
    if (type === '2') { links.push({ name: path.slice(root.length + 1), path, target: link.toString('utf8') }); continue; }
    if (type !== '0') throw new ReviewSnapshotError('Review copy has an entry the worker does not take');
    await writeFile(path, data, { flag: 'wx', mode: mode & 0o111 ? 0o555 : 0o444 });
  }
  const names = new Set(links.map(one => one.name));
  for (const one of links) {
    if (linkStaysInside(one.name, one.target, names)) await symlink(one.target, one.path);
    else await writeFile(one.path, outsideLinkWords(one.target), { flag: 'wx', mode: 0o444 });
  }
}

/** One fingerprint of everything under `root`: each entry's name, kind, mode and bytes (or a link's target), in name
 * order. The same copy gives the same fingerprint; any change to it (a byte, a mode, a new or removed file) another. */
export async function snapshotFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (relative: string) => {
    const names = (await readdir(join(root, relative))).sort();
    for (const name of names) {
      const inner = relative ? `${relative}/${name}` : name, path = join(root, inner), found = await lstat(path);
      const mode = (found.mode & 0o7777).toString(8);
      if (found.isSymbolicLink()) hash.update(`L\0${inner}\0${mode}\0${await readlink(path)}\0`);
      else if (found.isDirectory()) { hash.update(`D\0${inner}\0${mode}\0`); await walk(inner); }
      else if (found.isFile()) hash.update(`F\0${inner}\0${mode}\0${found.size}\0`).update(await readFile(path)).update('\0');
      else hash.update(`O\0${inner}\0${mode}\0`);
    }
  };
  await walk('');
  return hash.digest('hex');
}

/** Write a frozen review's copy into `directory` (which must not exist): the commit's files in SNAPSHOT_TREE, the diff
 * from `base` to `head` in SNAPSHOT_DIFF, and what they are in SNAPSHOT_FACTS. `credential` is the forge credential
 * loom's bindings hold for the repository's owner (never the house's), given to git's fetch and nowhere else; the body
 * never sees it. Returns the copy's fingerprint. */
export async function writeReviewSnapshot(input: { source: HouseSource; directory: string; review: ReviewSource; credential?: Uint8Array; signal: AbortSignal;
  /** Where the repository is fetched from: GitHub unless a test of the copy names a repository of its own. */
  house?: House }): Promise<string> {
  const { source, review, signal } = input, house = input.house ?? reviewHouse(review.repository);
  if (!source.diff) throw new ReviewSnapshotError('This worker cannot write a review diff');
  // Both commits by their full ids: the copy is of what loom pinned, wherever the branches have gone since.
  if (await source.fetch(house, input.credential, signal, review.base) !== review.base) throw new ReviewSnapshotError('Review base differs from its pin');
  if (await source.fetch(house, input.credential, signal, review.head) !== review.head) throw new ReviewSnapshotError('Review source differs from its pin');
  const diff = await source.diff(house, review.base, review.head, signal, REVIEW_DIFF_MAX);
  await mkdir(input.directory, { mode: 0o755 });
  await writeTar(source.context(house, review.head, signal), join(input.directory, SNAPSHOT_TREE));
  const said = diff.cut ? Buffer.concat([diff.bytes, Buffer.from(`\n[loom: the diff was cut at ${REVIEW_DIFF_MAX} bytes; the whole commit is in ${SNAPSHOT_TREE}/]\n`)]) : diff.bytes;
  await writeFile(join(input.directory, SNAPSHOT_DIFF), said, { flag: 'wx', mode: 0o444 });
  await writeFile(join(input.directory, SNAPSHOT_FACTS), JSON.stringify({ repository: review.repository, head: review.head, base: review.base, diffCut: diff.cut }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  if (signal.aborted) throw new ReviewSnapshotError('Review copy cancelled');
  return snapshotFingerprint(input.directory);
}

/** Remove a copy. Files are read-only, their directories are not, so the worker's own user removes them. */
export const removeReviewSnapshot = (directory: string) => rm(directory, { recursive: true, force: true });
