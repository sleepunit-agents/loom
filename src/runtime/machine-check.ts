/** What this machine says about its own condition: the room on each filesystem that matters, the memory
 * available, and whether the container runtime the worker needs answers. Read with Node's own calls, on
 * the worker's own slow timer; no program is run and no model takes part.
 *
 * Only numbers and fixed words leave this file. Whether a number is a fault is loom's to decide
 * (machine-conditions.ts), and so is every sentence about it. The one name sent is the path watched, in
 * the letters `watchedPath` allows.
 *
 * One thing that cannot be read does not keep the rest from being told: it is named as unknown, and loom
 * leaves what it last learned about that thing as it was. Not knowing is not a fault. */
import { constants } from 'node:fs';
import { access, stat, statfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';

/** The kinds of thing read. The list itself is the column's (`box_readings.kind`); the worker loads no
 * household schema, and loom's side holds this to the column where it writes a reading down (machine-conditions.ts). */
export type ReadingKind = 'disk' | 'memory' | 'containers';
/** One thing read. `thing` is the watched path of a disk and absent otherwise. `unknown` names a thing this
 * machine watches and could not read this time. A disk's size is what its user can fill (used and
 * available), so that the fullness loom works out is the one `df` shows. */
export interface MachineReading { kind: ReadingKind; thing?: string; unknown?: true; sizeBytes?: number; freeBytes?: number; answers?: boolean }
/** How often a worker reads its machine, unless its configuration says. */
export const MACHINE_CHECK_MS = 5 * 60_000;
/** The longest one read may take. A filesystem that does not answer (a network mount whose server is gone) is unknown. */
export const MACHINE_READ_MS = 5_000;
/** The most paths one worker watches. */
export const WATCHED_PATHS_MAX = 16;
/** A path loom will keep and write into a notice: absolute, of plain letters, with no step upward. */
export const watchedPath = (value: string) => /^\/[A-Za-z0-9._@+:/-]{0,199}$/.test(value) && !value.split('/').includes('..');

/** Filesystems that are no disk: kept in memory or made up by the kernel (Linux's own numbers for them).
 * One that reports no blocks at all is taken for the same. */
const PSEUDO = new Set([0x9fa0 /* proc */, 0x62656572 /* sysfs */, 0x01021994 /* tmpfs */, 0x858458f6 /* ramfs */, 0x1cd1 /* devpts */,
  0x27e0eb /* cgroup */, 0x63677270 /* cgroup2 */, 0x64626720 /* debugfs */, 0x74726163 /* tracefs */, 0x73636673 /* securityfs */,
  0xcafe4a11 /* bpf */, 0x6165676c /* pstore */, 0xde5e81e4 /* efivarfs */, 0x65735543 /* fusectl */, 0x19800202 /* mqueue */,
  0x958458f6 /* hugetlbfs */, 0x62656570 /* configfs */, 0x0187 /* autofs */, 0x6e736673 /* nsfs */, 0x42494e4d /* binfmt_misc */]);

/** What is asked of the machine, so that a test can answer in its place. */
export interface MachineProbe {
  statfs(path: string): Promise<{ type: number; bsize: number; blocks: number; bfree: number; bavail: number }>;
  /** The device a path is on: two paths on one device are one filesystem. */
  device(path: string): Promise<number>;
  /** Whether the filesystem a path is on is mounted read-only. */
  unwritable(path: string): Promise<boolean>;
  memory(): { sizeBytes: number; freeBytes: number };
}
const machine: MachineProbe = {
  statfs: path => statfs(path),
  device: async path => (await stat(path)).dev,
  // Asking leave to write changes nothing. Being refused for who is asking (EACCES) is not a read-only filesystem.
  unwritable: path => access(path, constants.W_OK).then(() => false, error => (error as NodeJS.ErrnoException)?.code === 'EROFS'),
  // On Linux this is what the kernel says is available to start something new with, not what is unused.
  memory: () => ({ sizeBytes: totalmem(), freeBytes: freemem() }),
};
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A reader of this machine. `paths` are watched in the order given, the first on a filesystem standing
 * for it. `engine` asks the container runtime something small; what it answers is looked at only for
 * where it keeps its containers (`DockerRootDir`), which is then watched too. Left out, no container
 * runtime is watched. Each call reads everything again and returns every thing watched. */
export function machineReader(input: { paths: readonly string[]; engine?: (signal: AbortSignal) => Promise<unknown>; probe?: Partial<MachineProbe>; timeoutMs?: number;
  /** The worker stopping: nothing more is asked of the machine once it has. */
  signal?: AbortSignal }) {
  const probe = { ...machine, ...input.probe }, timeoutMs = input.timeoutMs ?? MACHINE_READ_MS;
  // A read that has not come back holds one of the few threads file calls share. Another is not started
  // on the same path until it has, however long ago its answer stopped being waited for.
  const busy = new Set<string>();
  // The paths that have stood for a filesystem. While an earlier path is unknown, a later one cannot be told
  // from it by its device, and is only said again if it stood for one of its own before.
  const stood = new Set<string>();
  const within = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Machine read took too long')), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
  async function disk(path: string): Promise<{ device: number; reading: MachineReading } | 'skip'> {
    const [device, found, unwritable] = await Promise.all([probe.device(path), probe.statfs(path), probe.unwritable(path)]);
    if (unwritable || PSEUDO.has(found.type) || !found.blocks) return 'skip';
    const size = (found.blocks - found.bfree + found.bavail) * found.bsize, free = found.bavail * found.bsize;
    if (!whole(size) || !whole(free) || !size || free > size) throw new Error('Filesystem numbers unreadable');
    return { device, reading: { kind: 'disk', thing: path, sizeBytes: size, freeBytes: free } };
  }
  return async function read(): Promise<MachineReading[]> {
    const readings: MachineReading[] = [], paths = [...input.paths];
    if (input.engine) {
      // An engine that refuses, is not there or takes too long is not answering: that is the reading.
      let answer: unknown, answers = true;
      try { answer = await input.engine(AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])])); } catch { answers = false; }
      readings.push({ kind: 'containers', answers });
      const root = answers && answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>).DockerRootDir : undefined;
      if (typeof root === 'string') paths.push(root);
    }
    const devices = new Set<number>(), named = new Set<string>();
    let unsure = false;
    for (const path of paths) {
      if (input.signal?.aborted) break;
      if (!watchedPath(path) || named.has(path) || named.size >= WATCHED_PATHS_MAX) continue;
      named.add(path);
      if (busy.has(path)) { readings.push({ kind: 'disk', thing: path, unknown: true }); unsure = true; continue; }
      busy.add(path);
      const work = disk(path);
      void work.catch(() => {}).finally(() => busy.delete(path));
      try {
        const found = await within(work);
        if (found === 'skip' || devices.has(found.device)) continue;
        devices.add(found.device);
        if (unsure && !stood.has(path)) { readings.push({ kind: 'disk', thing: path, unknown: true }); continue; }
        if (!unsure) stood.add(path);
        readings.push(found.reading);
      } catch (error) {
        // A path that is not there is not watched. Anything else is not knowing.
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        readings.push({ kind: 'disk', thing: path, unknown: true }); unsure = true;
      }
    }
    try {
      const memory = probe.memory();
      if (!whole(memory.sizeBytes) || !whole(memory.freeBytes) || !memory.sizeBytes) throw new Error('Memory unreadable');
      readings.push({ kind: 'memory', sizeBytes: memory.sizeBytes, freeBytes: Math.min(memory.freeBytes, memory.sizeBytes) });
    } catch { readings.push({ kind: 'memory', unknown: true }); }
    return readings;
  };
}
