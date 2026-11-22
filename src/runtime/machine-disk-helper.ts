/** Read machine memory or a single configured path in this helper process. The parent runs only this fixed script
 * with its own Node binary, without a shell, and both sides validate the one argument. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statfsSync, type BigIntStats } from 'node:fs';
import { diskNumbers, watchedPath } from './machine-check.js';

/** Filesystems that are no disk: kept in memory, made up by the kernel, or an image mounted to be read
 * (Linux's own numbers for them). One that reports no blocks at all is taken for the same. A filesystem
 * mounted read-only is still a disk with room on it, and is read like any other; that it is read-only is
 * not a condition loom raises. */
const PSEUDO = new Set([0x9fa0 /* proc */, 0x62656572 /* sysfs */, 0x01021994 /* tmpfs */, 0x858458f6 /* ramfs */, 0x1cd1 /* devpts */,
  0x27e0eb /* cgroup */, 0x63677270 /* cgroup2 */, 0x64626720 /* debugfs */, 0x74726163 /* tracefs */, 0x73636673 /* securityfs */,
  0xcafe4a11 /* bpf */, 0x6165676c /* pstore */, 0xde5e81e4 /* efivarfs */, 0x65735543 /* fusectl */, 0x19800202 /* mqueue */,
  0x958458f6 /* hugetlbfs */, 0x62656570 /* configfs */, 0x0187 /* autofs */, 0x6e736673 /* nsfs */, 0x42494e4d /* binfmt_misc */,
  // An image mounted to be read: always exactly full, and nothing can be done about that.
  0x73717368 /* squashfs */, 0x9660 /* iso9660 */, 0xe0f5e1e2 /* erofs */]);

class UnsafePath extends Error {}

const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;

function walk(path: string, descriptors: number[], expected?: BigIntStats[]) {
  const steps = ['/', ...path.split('/').filter(step => step && step !== '.')];
  const stats = steps.map((step, index) => {
    // Linux procfs gives Node a directory-relative lookup. Only the next
    // component comes from the watched path, with no ancestor resolved again.
    const name = index === 0 ? step : `/proc/self/fd/${descriptors.at(-1)}/${step}`;
    const found = lstatSync(name, { bigint: true });
    if (!found.isDirectory() || (expected && !sameDirectory(expected[index], found))) throw new UnsafePath();
    const fd = openSync(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(fd);
    const opened = fstatSync(fd, { bigint: true });
    if (!sameDirectory(found, opened)) throw new UnsafePath();
    return opened;
  });
  return { fd: descriptors.at(-1)!, stats };
}

function readDisk(path: string) {
  const first: number[] = [], after: number[] = [];
  try {
    const before = walk(path, first);
    const found = statfsSync(`/proc/self/fd/${before.fd}`, { bigint: true });
    walk(path, after, before.stats);
    if (PSEUDO.has(Number(BigInt.asUintN(32, found.type))) || !found.blocks) return { unknown: true };
    const sizeBytes = Number((found.blocks - found.bfree + found.bavail) * found.bsize);
    const freeBytes = Number(found.bavail * found.bsize);
    if (diskNumbers(sizeBytes, freeBytes)) return { sizeBytes, freeBytes };
  } catch (error) {
    if (error instanceof UnsafePath) return { unknown: true, reason: 'link' };
  } finally {
    for (const fd of [...after, ...first].reverse()) closeSync(fd);
  }
  return { unknown: true };
}

function readMemory() {
  let fd: number | undefined;
  try {
    fd = openSync('/proc/meminfo', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return { unknown: true };
    const buffer = Buffer.alloc(8192);
    const length = readSync(fd, buffer);
    const info = buffer.toString('ascii', 0, length);
    const sizeBytes = Number(/^MemTotal:[ \t]+(\d+) kB$/m.exec(info)?.[1]) * 1024;
    const freeBytes = Number(/^MemAvailable:[ \t]+(\d+) kB$/m.exec(info)?.[1]) * 1024;
    if (diskNumbers(sizeBytes, freeBytes)) return { sizeBytes, freeBytes };
  } catch { /* Missing or unreadable kernel estimate. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return { unknown: true };
}

const [path, ...extra] = process.argv.slice(2);
let result: ReturnType<typeof readDisk> = { unknown: true };
if (!extra.length && path) {
  if (path === 'memory') result = readMemory();
  else if (watchedPath(path)) result = readDisk(path);
}
process.stdout.write(JSON.stringify(result) + '\n');
