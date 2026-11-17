/** Lane words come from a trusted configured checkout, never the runtime home.
 * Descriptor-relative walks refuse links even if a directory is replaced while
 * reading. Linux /proc is required; unsupported hosts fail closed. */
import fs, { constants as F } from 'node:fs';

export const MAX_LANE_FILE_BYTES = 1_048_576;
/** Which files of the checkout a lane may name: a relative path of plain names. No `.` or `..`, no empty
 * part, no backslash, and no hidden file or directory (`.git`, `.env`): a lane's words are routine files,
 * and whoever may set a trigger must not be able to read the checkout's settings through one. The one rule,
 * asked when a trigger is set and again when its file is read. */
export const laneFile = (file: string): boolean =>
  !!file && !file.includes('\\') && file.split('/').every(part => !!part && !part.startsWith('.') && !part.includes('\0'));
export function repositoryInstructions(repository: string): (file: string) => string {
  return file => {
    const roots = repository.split('/'), parts = file.split('/');
    if (process.platform !== 'linux' || roots.shift() !== '' || !roots.length ||
      roots.some(p => !p || p === '.' || p === '..') ||
      !laneFile(file))
      throw new Error('Lane instructions need a relative file in the configured repository');
    const opened: number[] = [];
    try {
      let directory = fs.openSync('/', F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
      opened.push(directory);
      for (const part of [...roots, ...parts.slice(0, -1)]) {
        directory = fs.openSync(`/proc/self/fd/${directory}/${part}`, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
        opened.push(directory);
      }
      const fd = fs.openSync(`/proc/self/fd/${directory}/${parts.at(-1)!}`, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
      opened.push(fd);
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_LANE_FILE_BYTES)) throw new Error('Unsafe file');
      const bytes = Buffer.alloc(MAX_LANE_FILE_BYTES + 1);
      let used = 0;
      while (used < bytes.length) {
        const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
        if (!count) break;
        used += count;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (used > MAX_LANE_FILE_BYTES || BigInt(used) !== before.size || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('File changed');
      const words = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used));
      if (!words.trim() || words.includes('\0')) throw new Error('Invalid text');
      return words;
    } catch {
      // Filesystem error paths and contents do not belong in a shared log.
      throw new Error('Lane instruction file is unavailable or unsafe');
    } finally {
      for (const fd of opened.reverse()) fs.closeSync(fd);
    }
  };
}
