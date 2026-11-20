/** Reading the program's private files, and the holder's generation as other pieces see it. */
import fs from 'node:fs';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const failed = () => new Error('Local secret holder unavailable');
/** Explicit private regular files only, opened without following a final symlink. */
export function privateBytes(path: string, limit = 64 * 1024): Buffer {
  let fd: number | undefined, bytes: Buffer | undefined;
  try {
    if (!isAbsolute(path) || !Number.isSafeInteger(limit) || limit < 1 || limit > 128 * 1024) throw failed();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.nlink !== 1 || s.size < 1 || s.size > limit) throw failed();
    bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (used !== s.size || used > limit || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) throw failed();
    const result = Buffer.from(bytes.subarray(0, used));
    bytes.fill(0);
    return result;
  } catch { bytes?.fill(0); throw failed(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function assertPrivateDirectory(path: string) {
  if (!isAbsolute(path)) throw failed();
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw failed();
}
/** Which holder store the values come from; it changes when the store is replaced. */
export interface HolderGeneration { generation(): Promise<string> | string }
