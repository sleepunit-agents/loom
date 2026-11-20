/** Reading, listing, writing and removing files under a directory without following a link at any step.
 *
 * For a place a body shares with a model that has a shell: the model can make any name in it a link, and
 * swap one in between two looks. So nothing here trusts a path. Every step from the root down is looked
 * at as it is (`lstat`) and must be a real directory. A file is opened without following a link at its last
 * step, and the open file is then asked where the kernel says it is (`/proc/self/fd`), which catches a
 * directory step swapped for a link after it was looked at. Without `/proc` (not Linux) nothing is read.
 * No imports of loom's own: an adapter and the session keeper both use it.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readlinkSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join, sep } from 'node:path';

const realDirectory = (path: string): boolean => { try { const found = lstatSync(path); return found.isDirectory() && !found.isSymbolicLink(); } catch { return false; } };
/** Whether `root` and every step of `relative` under it is a real directory. `relative` may be empty. */
export function directoriesUnfollowed(root: string, relative: string): boolean {
  let at = root;
  if (!realDirectory(at)) return false;
  for (const part of relative ? relative.split(sep) : []) { at = join(at, part); if (!realDirectory(at)) return false; }
  return true;
}
/** The names in a directory under `root`, sorted; none when any step to it is not a real directory. */
export function listUnfollowed(root: string, relative: string): string[] {
  if (!directoriesUnfollowed(root, relative)) return [];
  try { return readdirSync(join(root, relative)).sort(); } catch { return []; }
}
/** What is at a path under `root`, as it is: a file, a directory, or nothing this will touch (a link, a
 * device, a missing name, or a path with a step that is not a real directory). */
export function kindUnfollowed(root: string, relative: string): 'file' | 'directory' | undefined {
  const parts = relative.split(sep);
  if (!directoriesUnfollowed(root, parts.slice(0, -1).join(sep))) return undefined;
  try { const found = lstatSync(join(root, relative)); return found.isSymbolicLink() ? undefined : found.isFile() ? 'file' : found.isDirectory() ? 'directory' : undefined; } catch { return undefined; }
}
/** Every file under a file-or-directory at `relative`, as paths under `root`, following nothing. */
export function filesUnfollowed(root: string, relative: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    if (found.length > limit) return;
    const kind = kindUnfollowed(root, at);
    if (kind === 'file') found.push(at);
    else if (kind === 'directory') for (const name of listUnfollowed(root, at)) walk(join(at, name));
  };
  walk(relative);
  return found;
}
/** The bytes of a file under `root`, read through one open file that is checked to be that file and no
 * other. `root` must be the directory's real path. Throws for anything else, and past `max` bytes. */
export function readUnfollowed(root: string, relative: string, max: number): Buffer {
  const parts = relative.split(sep);
  if (!directoriesUnfollowed(root, parts.slice(0, -1).join(sep))) throw Error('Not a file of this directory');
  const handle = openSync(join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > max || readlinkSync(`/proc/self/fd/${handle}`) !== join(root, relative)) throw Error('Not a file of this directory');
    const bytes = Buffer.alloc(stat.size); let read = 0;
    while (read < stat.size) { const n = readSync(handle, bytes, read, stat.size - read, read); if (!n) break; read += n; }
    if (read !== stat.size) throw Error('File changed while it was read');
    return bytes;
  } finally { closeSync(handle); }
}
/** Writes a new file under `root`. Each directory on the way that is there must be a real directory; one
 * that is not is made, one level at a time. The file is made new and never through a link (`O_EXCL`,
 * `O_NOFOLLOW`): a file or link already at its place throws. `made` is told every directory and file this
 * call created, as it creates them, so a caller that gives up can take exactly those away again. */
export function writeUnfollowed(root: string, relative: string, bytes: Buffer, made: { directories: string[]; files: string[] }): void {
  const parts = relative.split(sep); let at = root;
  if (!realDirectory(at)) throw Error('Not a directory');
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    let found; try { found = lstatSync(at); } catch { found = undefined; }
    if (!found) { mkdirSync(at, { mode: 0o700 }); made.directories.push(at); found = lstatSync(at); }
    if (!found.isDirectory() || found.isSymbolicLink()) throw Error('Not a directory');
  }
  const path = join(at, parts.at(-1)!);
  const handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  made.files.push(path);
  try { let written = 0; while (written < bytes.byteLength) written += writeSync(handle, bytes, written, bytes.byteLength - written); }
  finally { closeSync(handle); }
}
/** Takes away what `writeUnfollowed` reported making: the files, then the directories, newest first. Each
 * is removed as a name (a link put in its place since is removed, not followed) and only if empty. */
export function unmake(made: { directories: string[]; files: string[] }): void {
  for (const file of made.files.splice(0).reverse()) { try { unlinkSync(file); } catch { /* gone already */ } }
  for (const directory of made.directories.splice(0).reverse()) { try { rmdirSync(directory); } catch { /* not empty, or gone: left */ } }
}
/** Removes one file under `root` by its name, following nothing: a path with a step that is not a real
 * directory is left alone, and a link at the last step is removed itself, never what it points at. */
export function removeUnfollowed(root: string, relative: string): void {
  const parts = relative.split(sep);
  if (!directoriesUnfollowed(root, parts.slice(0, -1).join(sep))) return;
  try { const found = lstatSync(join(root, relative)); if (found.isDirectory() && !found.isSymbolicLink()) rmdirSync(join(root, relative)); else unlinkSync(join(root, relative)); } catch { /* not there */ }
}
