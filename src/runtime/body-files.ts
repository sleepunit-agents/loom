/** Reads a file the model named for a post, from the body's own working area and nowhere else.
 *
 * The model gives a path. It is taken only when, with every symbolic link followed, it is a regular file
 * inside one of the body's own directories: its working directory and its scratch directory. A path
 * outside them, a directory, a device, a link that leads out, or a file over the size a post may carry is
 * refused. The bytes go to loom with the post (bridges.say); the model never sees them here.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { SEND_FILES, SEND_FILES_BYTES, sendFileName } from '../pieces/bridges/send-file-limit.js';

export class BodyFileRefused extends Error {}
export type BodyFileReader = (paths: readonly string[]) => { name: string; contents: Buffer }[];

/** A reader for one body. `areas` are the directories the body may send from; one that does not exist is no area. */
export function bodyFileReader(cwd: string, areas: readonly (string | undefined)[]): BodyFileReader {
  const roots = areas.flatMap(area => { try { return area ? [realpathSync(area)] : []; } catch { return []; } });
  const inside = (path: string) => roots.some(root => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
  return paths => {
    if (!paths.length || paths.length > SEND_FILES) throw new BodyFileRefused(`A post carries at most ${SEND_FILES} files`);
    const files: { name: string; contents: Buffer }[] = []; let total = 0;
    try {
      for (const given of paths) {
        if (typeof given !== 'string' || !given || given.includes('\0')) throw new BodyFileRefused('A file is named by its path');
        let real: string;
        try { real = realpathSync(isAbsolute(given) ? given : resolve(cwd, given)); } catch { throw new BodyFileRefused(`No such file: ${given}`); }
        if (!inside(real)) throw new BodyFileRefused(`Not inside this body's working area: ${given}`);
        // Opened once and read through that handle, so what was checked is what is read.
        const handle = openSync(real, 'r');
        try {
          const stat = fstatSync(handle);
          if (!stat.isFile()) throw new BodyFileRefused(`Not a file: ${given}`);
          if (!stat.size || total + stat.size > SEND_FILES_BYTES) throw new BodyFileRefused(`A post's files hold at most ${SEND_FILES_BYTES} bytes together, and none is empty: ${given}`);
          const contents = Buffer.alloc(stat.size); let read = 0;
          while (read < stat.size) { const n = readSync(handle, contents, read, stat.size - read, read); if (!n) break; read += n; }
          if (read !== stat.size) throw new BodyFileRefused(`Could not read: ${given}`);
          total += stat.size; files.push({ name: sendFileName(basename(real)), contents });
        } finally { closeSync(handle); }
      }
      return files;
    } catch (error) { for (const file of files) file.contents.fill(0); throw error instanceof BodyFileRefused ? error : new BodyFileRefused('File not available'); }
  };
}
