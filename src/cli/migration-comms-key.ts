/** Offline migration-all only. Caller verifies snapshot, holds its gate and runs coordinator recovery first. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readKey } from '../pieces/comms/crypto.js';

function noSymlinks(path: string): void {
  for (let p = resolve(path);; p = dirname(p)) {
    if (lstatSync(p).isSymbolicLink()) throw Error('Symlink Comms key path');
    if (dirname(p) === p) return;
  }
}
function privateBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) throw Error('Unsafe migration Comms key');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
/** Preserve the snapshot identity. Never mint or overwrite a destination key.
 * A crash pair is intentionally rejected here: only the coordinator may recover
 * it after matching the migration receipt and verified source (separateDestination).
 */
export function publishMigrationCommsKey(source: string, home: string, controls: { sync?: typeof fsyncSync } = {}): void {
  noSymlinks(source); noSymlinks(home);
  const input = realpathSync(source), target = realpathSync(home);
  if (input === target || input.startsWith(target + '/') || target.startsWith(dirname(input) + '/')) throw Error('Overlapping Comms key homes');
  readKey(input);
  const bytes = privateBytes(input), path = join(target, 'comms.key'), sync = controls.sync ?? fsyncSync;
  const syncDirectory = () => { const dir = openSync(target, 'r'); try { sync(dir); } finally { closeSync(dir); } };
  try {
    if (!privateBytes(path).equals(bytes)) throw Error('Destination Comms key differs from snapshot');
    syncDirectory();
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = join(target, `.comms.key-import-${randomUUID()}`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, bytes); sync(fd); } finally { closeSync(fd); }
    linkSync(temp, path);
    syncDirectory();
  } finally { unlinkSync(temp); }
}
