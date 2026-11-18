/** Reads a file the model named for a post, from the body's own working area and nowhere else.
 *
 * The model gives a path, and a body with a shell can change what is at a path at any moment. So the path
 * is opened once, and everything is then asked of the open file, which cannot be swapped:
 *  - it is opened without following a link at its last step (`O_NOFOLLOW`): a link there is refused,
 *    wherever it leads;
 *  - the open file must be a regular file with one name. A file with a second name (a hard link) is
 *    refused, because a hard link made inside the area to a file outside it cannot be told from the
 *    inside; this also refuses a file of the body's own that happens to have two names;
 *  - where the open file really is, as the kernel says (`/proc/self/fd`), must be inside one of the body's
 *    own directories: its working directory and its scratch directory. A link at any earlier step of the
 *    path that leads outside is caught here. Without `/proc` (not Linux) every file is refused;
 *  - the bytes are read from that same open file, up to the size a post may carry.
 * What this does not catch: a file outside the area that the body can already read and copies in. That is
 * the body's own reach, not this door's. The bytes go to loom with the post (bridges.say); the model never
 * sees them here.
 */
import { closeSync, constants, fstatSync, openSync, readSync, readlinkSync, realpathSync } from 'node:fs';
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
        let handle: number;
        try { handle = openSync(isAbsolute(given) ? given : resolve(cwd, given), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch { throw new BodyFileRefused(`No such file, or a link: ${given}`); }
        try {
          const stat = fstatSync(handle);
          if (!stat.isFile()) throw new BodyFileRefused(`Not a file: ${given}`);
          if (stat.nlink !== 1) throw new BodyFileRefused(`A file with more than one name is not posted: ${given}`);
          let real: string;
          try { real = readlinkSync(`/proc/self/fd/${handle}`); } catch { throw new BodyFileRefused('File not available'); }
          if (!isAbsolute(real) || !inside(real)) throw new BodyFileRefused(`Not inside this body's working area: ${given}`);
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
