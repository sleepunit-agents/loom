/** Read a single configured path in this helper process. The parent runs only this fixed script
 * with its own Node binary, without a shell, and both sides validate the one path argument. */
import { lstatSync, statfsSync } from 'node:fs';
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

function walk(path: string) {
  const steps = ['/'];
  for (const step of path === '/' ? [] : path.slice(1).split('/')) {
    steps.push(steps.at(-1) === '/' ? `/${step}` : `${steps.at(-1)}/${step}`);
  }
  return steps.map(step => {
    const found = lstatSync(step, { bigint: true });
    if (!found.isDirectory()) throw new UnsafePath();
    return found;
  });
}

function read(path: string) {
  try {
    const before = walk(path);
    const found = statfsSync(path, { bigint: true });
    if (walk(path).some((step, index) => step.dev !== before[index].dev || step.ino !== before[index].ino)) throw new UnsafePath();
    if (PSEUDO.has(Number(BigInt.asUintN(32, found.type))) || !found.blocks) return { unknown: true };
    const device = Number(before.at(-1)!.dev);
    const sizeBytes = Number((found.blocks - found.bfree + found.bavail) * found.bsize);
    const freeBytes = Number(found.bavail * found.bsize);
    if (diskNumbers(device, sizeBytes, freeBytes)) return { device, sizeBytes, freeBytes };
  } catch (error) {
    if (error instanceof UnsafePath) return { unknown: true, reason: 'link' };
  }
  return { unknown: true };
}

const [path, ...extra] = process.argv.slice(2);
process.stdout.write(JSON.stringify(path && !extra.length && watchedPath(path) ? read(path) : { unknown: true }) + '\n');
