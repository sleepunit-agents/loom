/** What this machine says about its own condition: the room on each filesystem that matters, the memory
 * available, and whether the container runtime the worker needs answers. Read with Node's own calls, on
 * the worker's own slow timer; no program is run and no model takes part.
 *
 * Only numbers and fixed words leave this file. Whether a number is a fault is loom's to decide
 * (machine-conditions.ts), and so is every sentence about it. The one name sent is the path watched, in
 * the letters `watchedPath` allows.
 *
 * Absent means "no longer watched", and nothing else. A thing this worker is set to watch and cannot give
 * numbers for this time (it did not answer, it is not there, it is reached through a link, it is no disk of
 * its own) is named as unknown, and loom leaves what it last learned about it as it was. Not knowing is not
 * a fault, and it is not a thing put right either.
 *
 * A watched path is followed through no link: every step from the root down is looked at as it is and must
 * be a real directory (as unfollowed.ts does for a body's files). A directory a body can write in could
 * otherwise be swapped for a link to another filesystem, and that one's room reported under this name.
 * What is at the path is looked at again after its room is read and must be the same directory. A link put
 * in and taken out again between those two looks is not seen; nothing here can close that without opening
 * the directory, which a worker may not be allowed to do where the container runtime keeps its own. */
import { lstat, statfs } from 'node:fs/promises';
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
/** The longest one call to the machine may take. A filesystem that does not answer (a network mount whose server is gone) is unknown. */
export const MACHINE_READ_MS = 5_000;
/** The most paths one worker watches. */
export const WATCHED_PATHS_MAX = 16;
/** The most calls that have stopped being waited for and have still not come back. Each holds one of the
 * four threads every file read and name lookup in the worker shares, for as long as the filesystem under
 * it does not answer. At this many the reader asks the machine's filesystems nothing more until one has. */
export const UNANSWERED_MAX = 2;
/** The largest size sent. loom keeps sizes in whole mebibytes and serves them as a GraphQL `Int`, which ends
 * at 2^31 - 1: a size of 2^51 bytes or more would make every query that selects it fail for its reader.
 * The door refuses one (shared-machine-readings.ts); a filesystem that large is named as unknown here, so
 * that the rest of what this machine says is still taken. */
export const SIZE_BYTES_MAX = 2 ** 51 - 1;
/** The longest watched path. */
export const WATCHED_PATH_LENGTH = 120;
/** A path loom will keep and write into a notice. loom cannot know what a worker was set to watch, so this
 * shape is all that stands between a worker and the words an owner reads: absolute, at most
 * WATCHED_PATH_LENGTH long, each step beginning with a letter, a digit, a dot or an underscore and going on
 * in those and `@ + -`, with no empty step, no `.` or `..`, and no colon anywhere. */
export const watchedPath = (value: string) => value.length <= WATCHED_PATH_LENGTH &&
  (value === '/' || /^(\/[A-Za-z0-9._][A-Za-z0-9._@+-]*)+$/.test(value)) && !value.split('/').some(step => step === '.' || step === '..');

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

/** What is asked of the machine, so that a test can answer in its place. Each call of `look` and `statfs`
 * is one use of a thread the worker's file reads and name lookups share. */
export interface MachineProbe {
  /** What is at a path as it is, a link at its last step not followed. */
  look(path: string): Promise<{ directory: boolean; device: number; node: number }>;
  statfs(path: string): Promise<{ type: number; bsize: number; blocks: number; bfree: number; bavail: number }>;
  memory(): { sizeBytes: number; freeBytes: number };
}
const machine: MachineProbe = {
  look: async path => { const found = await lstat(path); return { directory: found.isDirectory() && !found.isSymbolicLink(), device: found.dev, node: found.ino }; },
  statfs: path => statfs(path),
  // On Linux this is what the kernel says is available to start something new with, not what is unused.
  memory: () => ({ sizeBytes: totalmem(), freeBytes: freemem() }),
};
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Why a path gave no numbers, where the worker says so once in its own log. Fixed words; never the path. */
const SAID = {
  link: 'Worker machine check: a watched path is not a directory reached without a link, and is not read\n',
  name: 'Worker machine check: a directory to watch has a name loom does not take, and is not watched\n',
} as const;
class NotRead extends Error { constructor(readonly why?: keyof typeof SAID) { super('Path not read'); } }

/** A reader of this machine. `paths` are watched in the order given, the first on a filesystem standing
 * for it. `engine` asks the container runtime something small; what it answers is looked at only for
 * where it keeps its containers (`DockerRootDir`), which is then watched too, and goes on being watched
 * when the engine later does not answer: the directory is on a disk whether or not the engine is up.
 * (That is remembered in memory only. A worker started while the engine is down learns the directory
 * when the engine first answers.) Left out, no container runtime is watched.
 *
 * Each call reads everything again and returns every thing watched, as numbers or as unknown.
 *
 * The filesystem is asked one thing at a time, never two at once, across every path. A call that has not
 * answered in `timeoutMs` is no longer waited for, but it is still out, holding its thread: what it asked
 * about is asked nothing more until it comes back, nor is any watched path that lies through it, and with
 * UNANSWERED_MAX such calls out nothing at all is asked. So a dead mount holds one thread for as long as
 * it is dead, however many watched paths are on it, and two dead mounts hold two and no more. */
export function machineReader(input: { paths: readonly string[]; engine?: (signal: AbortSignal) => Promise<unknown>; probe?: Partial<MachineProbe>; timeoutMs?: number;
  /** The worker stopping: nothing more is asked of the machine once it has. */
  signal?: AbortSignal;
  /** The worker's own log, for a path that will not be read however often it is tried. Each line is said once for a path. */
  say?: (line: string) => void }) {
  const probe = { ...machine, ...input.probe }, timeoutMs = input.timeoutMs ?? MACHINE_READ_MS;
  // What was asked about by each call that is out and no longer waited for: a watched path or a step on the
  // way to one. Two watched paths under one dead mount stop at the same step, so they hold one thread, not two.
  const unanswered = new Set<string>();
  // The paths that have stood for a filesystem. While an earlier path is unknown, a later one cannot be told
  // from it by its device, and is only said again if it stood for one of its own before.
  const stood = new Set<string>();
  const said = new Set<string>();
  const sayOnce = (why: keyof typeof SAID, path: string) => { if (!said.has(why + path)) { said.add(why + path); input.say?.(SAID[why]); } };
  // Where the engine last said it keeps its containers.
  let engineRoot: string | undefined;
  let reading = false;
  /** One call to the filesystem, about `path`. Never started while another is being waited for (read, below,
   * awaits each) or while an earlier call about the same path is still out, and given up on, not ended,
   * when it is slow or the worker stops. */
  const ask = <T>(path: string, call: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (unanswered.has(path)) { reject(new NotRead()); return; }
    const work = call();
    let waiting = true;
    const leave = () => { if (!waiting) return; waiting = false; unanswered.add(path); clearTimeout(timer); input.signal?.removeEventListener('abort', leave); reject(new NotRead()); };
    const timer = setTimeout(leave, timeoutMs);
    input.signal?.addEventListener('abort', leave, { once: true });
    const back = (settle: () => void) => { unanswered.delete(path); if (!waiting) return; waiting = false; clearTimeout(timer); input.signal?.removeEventListener('abort', leave); settle(); };
    work.then(value => back(() => resolve(value)), error => back(() => reject(error)));
  });
  /** The room on the filesystem under a path that is a real directory at every step, or a throw. */
  async function disk(path: string): Promise<{ device: number; reading: MachineReading } | 'no-disk'> {
    const steps = path === '/' ? [] : path.slice(1).split('/');
    let at = '/', seen = await ask('/', () => probe.look('/'));
    for (const step of steps) {
      if (!seen.directory) throw new NotRead('link');
      at = at === '/' ? `/${step}` : `${at}/${step}`;
      const here = at;
      seen = await ask(here, () => probe.look(here));
    }
    if (!seen.directory) throw new NotRead('link');
    const found = await ask(path, () => probe.statfs(path));
    const again = await ask(path, () => probe.look(path));
    if (!again.directory || again.device !== seen.device || again.node !== seen.node) throw new NotRead('link');
    if (PSEUDO.has(found.type) || !found.blocks) return 'no-disk';
    const size = (found.blocks - found.bfree + found.bavail) * found.bsize, free = found.bavail * found.bsize;
    if (!whole(size) || !whole(free) || !size || free > size || size > SIZE_BYTES_MAX) throw new NotRead();
    return { device: seen.device, reading: { kind: 'disk', thing: path, sizeBytes: size, freeBytes: free } };
  }
  return async function read(): Promise<MachineReading[]> {
    // One reading at a time: two would ask the filesystem two things at once.
    if (reading) throw new Error('Machine is being read');
    reading = true;
    try {
      const readings: MachineReading[] = [];
      if (input.engine) {
        // An engine that refuses, is not there or takes too long is not answering: that is the reading.
        let answer: unknown, answers = true;
        try { answer = await input.engine(AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])])); } catch { answers = false; }
        readings.push({ kind: 'containers', answers });
        const root = answers && answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>).DockerRootDir : undefined;
        if (typeof root === 'string') engineRoot = root;
      }
      const devices = new Set<number>(), named = new Set<string>();
      let unsure = false;
      for (const path of [...input.paths, ...(engineRoot === undefined ? [] : [engineRoot])]) {
        if (input.signal?.aborted) break;
        if (named.has(path) || named.size >= WATCHED_PATHS_MAX) continue;
        // A name loom would refuse cannot be sent, as numbers or as unknown.
        if (!watchedPath(path)) { sayOnce('name', path); continue; }
        named.add(path);
        const unknown = () => { readings.push({ kind: 'disk', thing: path, unknown: true }); };
        if (unanswered.size >= UNANSWERED_MAX) { unknown(); unsure ||= stood.has(path); continue; }
        try {
          const found = await disk(path);
          // No disk of its own: a filesystem kept in memory, or the same one an earlier path stands for.
          if (found === 'no-disk' || devices.has(found.device)) { unknown(); continue; }
          devices.add(found.device);
          if (unsure && !stood.has(path)) { unknown(); continue; }
          if (!unsure) stood.add(path);
          readings.push(found.reading);
        } catch (error) {
          if (error instanceof NotRead && error.why) sayOnce(error.why, path);
          // Only a path that stood for a filesystem can be hiding one a later path is also on. A path that never
          // gave numbers (one that is not there) must not keep every path after it from ever being told.
          unknown(); unsure ||= stood.has(path);
        }
      }
      try {
        const memory = probe.memory();
        if (!whole(memory.sizeBytes) || !whole(memory.freeBytes) || !memory.sizeBytes || memory.sizeBytes > SIZE_BYTES_MAX) throw new Error('Memory unreadable');
        readings.push({ kind: 'memory', sizeBytes: memory.sizeBytes, freeBytes: Math.min(memory.freeBytes, memory.sizeBytes) });
      } catch { readings.push({ kind: 'memory', unknown: true }); }
      return readings;
    } finally { reading = false; }
  };
}
