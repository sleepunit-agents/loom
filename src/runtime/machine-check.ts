/** The worker reports memory, container runtime availability, and every configured disk path.
 * For each disk path it runs this program's own adjacent machine-disk-helper.js with process.execPath
 * and no shell. Its only script argument is the configured path, validated here and in the helper.
 * This check runs no other program. loom evaluates each reading and decides what to say. */
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The kinds of thing read. The list itself is the column's (`box_readings.kind`); the worker loads no
 * household schema, and loom's side holds this to the column where it writes a reading down (machine-conditions.ts). */
export type ReadingKind = 'disk' | 'memory' | 'containers';
/** One thing read. `thing` is the watched path of a disk and absent otherwise. `unknown` names a thing this
 * machine watches and could not read this time. A disk's size is what its user can fill (used and
 * available): the two numbers `df` works its percentage out from, as loom then does (machine-conditions.ts). */
export interface MachineReading { kind: ReadingKind; thing?: string; unknown?: true; sizeBytes?: number; freeBytes?: number; engineStatus?: number }
/** The longest one call to the machine may take. A filesystem that does not answer (a network mount whose server is gone) is unknown. */
export const MACHINE_READ_MS = 5_000;
/** The most paths one worker watches. */
export const WATCHED_PATHS_MAX = 16;
/** The largest size sent. loom keeps sizes in whole mebibytes and serves them as a GraphQL `Int`, which ends
 * at 2^31 - 1: a size of 2^51 bytes or more would make every query that selects it fail for its reader.
 * The door refuses one (shared-machine-readings.ts); a filesystem that large is named as unknown here, so
 * that the rest of what this machine says is still taken. */
export const SIZE_BYTES_MAX = 2 ** 51 - 1;
/** The longest watched path. */
export const WATCHED_PATH_LENGTH = 120;
/** A path loom will keep and write into a notice: absolute, at most WATCHED_PATH_LENGTH long, each step
 * beginning with a letter, a digit, a dot or an underscore and going on in those and `@ + -`, with no empty
 * step, no `.` or `..`, and no colon anywhere. loom cannot know what a worker was set to watch, so it cannot
 * tell a real path from words written to look like one: `/your_disk_is_failing.call.0800-555-0199.now`
 * passes. What protects a reader is that the text is short, has no spaces or punctuation beyond those
 * letters, is shown only to that machine's owner and household owners, and that every other word of the
 * notice is loom's own. */
export const watchedPath = (value: string) => value.length <= WATCHED_PATH_LENGTH &&
  (value === '/' || /^(\/[A-Za-z0-9._][A-Za-z0-9._@+-]*)+(?![\s\S])/.test(value)) && !value.split('/').some(step => step === '.' || step === '..');

const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const diskNumbers = (size: unknown, free: unknown): boolean =>
  whole(size) && size > 0 && size <= SIZE_BYTES_MAX && whole(free) && free <= size;

type DiskResult = { sizeBytes: number; freeBytes: number } | { unknown: true; reason?: 'link' };
const unknown: DiskResult = { unknown: true };
/** The helper emits one JSON line. Reject extra keys, extra lines and numbers the door would refuse. */
export function parseDiskResult(output: string): DiskResult {
  if (!/^[^\r\n]+\n$/.test(output)) return unknown;
  try {
    const row = JSON.parse(output);
    if (JSON.stringify(row) !== output.slice(0, -1)) return unknown;
    if (row?.unknown === true && (Object.keys(row).length === 1 ||
      (Object.keys(row).length === 2 && row.reason === 'link'))) return row;
    if (row && Object.keys(row).length === 2 && diskNumbers(row.sizeBytes, row.freeBytes)) return row;
  } catch { /* An incomplete or invalid answer is unknown. */ }
  return unknown;
}

const helper = fileURLToPath(new URL('./machine-disk-helper.js', import.meta.url));
export function startDiskHelper(path: string, start = spawn) {
  if (!watchedPath(path)) throw new Error('Invalid watched path');
  return start(process.execPath, [helper, path], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NODE_OPTIONS: undefined } });
}

const SAID = {
  link: 'Worker machine check: a watched path is not a directory reached without a link, and is not read\n',
  name: 'Worker machine check: a directory to watch has a name loom does not take, and is not watched\n',
  start: 'Worker machine check: a disk helper could not be started\n',
} as const;

/** Read only the kernel's estimate of memory available for new work. */
export async function readMemory(): Promise<MachineReading> {
  const sizeBytes = os.totalmem();
  const kernel = os as typeof os & { availableMemory?: () => number };
  let available = kernel.availableMemory?.();
  if (available === undefined) {
    try {
      const file = await fs.open('/proc/meminfo', 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await file.read(buffer);
        const kib = buffer.toString('utf8', 0, bytesRead).match(/^MemAvailable:[ \t]+([0-9]+)[ \t]+kB\n/m)?.[1];
        if (kib !== undefined) available = Number(kib) * 1024;
      } finally { await file.close(); }
    } catch { /* No kernel estimate is available. */ }
  }
  const freeBytes = available === undefined ? undefined : Math.min(available, sizeBytes);
  return freeBytes !== undefined && diskNumbers(sizeBytes, freeBytes)
    ? { kind: 'memory', sizeBytes, freeBytes } : { kind: 'memory', unknown: true };
}

export function machineReader(input: {
  paths: readonly string[];
  engine?: (signal: AbortSignal) => Promise<number>;
  timeoutMs?: number;
  signal?: AbortSignal;
  say?: (line: string) => void;
  start?: typeof startDiskHelper;
}) {
  const timeoutMs = input.timeoutMs ?? MACHINE_READ_MS;
  const live = new Map<string, { child: ReturnType<typeof startDiskHelper>; stop: () => void }>();
  const said = new Set<keyof typeof SAID>();
  const sayOnce = (why: keyof typeof SAID) => {
    if (!said.has(why)) { said.add(why); input.say?.(SAID[why]); }
  };
  const paths = [...new Set(input.paths)].filter(path => {
    if (watchedPath(path)) return true;
    sayOnce('name');
    return false;
  }).slice(0, WATCHED_PATHS_MAX);

  function disk(path: string): Promise<DiskResult> {
    if (input.signal?.aborted || live.has(path)) return Promise.resolve(unknown);
    return new Promise(resolve => {
      let child: ReturnType<typeof startDiskHelper>;
      try { child = (input.start ?? startDiskHelper)(path); }
      catch { sayOnce('start'); resolve(unknown); return; }
      child.unref();
      const pipe = child.stdout!;
      let output = '';
      const detached = () => { if (live.get(path)?.child === child) live.delete(path); };
      let settled = false;
      const finish = (result: DiskResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pipe.destroy();
        resolve(result);
      };
      const stop = () => finish(unknown);
      const timer = setTimeout(stop, timeoutMs);
      live.set(path, { child, stop });
      pipe.setEncoding('utf8').on('data', (chunk: string) => {
        // Bound retained output even if an answer is malformed.
        if (output.length + chunk.length > 256) stop();
        else output += chunk;
      });
      pipe.on('error', stop);
      child.once('error', () => {
        if (child.pid === undefined) { detached(); sayOnce('start'); }
        stop();
      });
      child.once('exit', detached);
      child.once('close', code => finish(code === 0 ? parseDiskResult(output) : unknown));
    });
  }

  input.signal?.addEventListener('abort', () => {
    for (const { child, stop } of live.values()) {
      child.kill('SIGKILL');
      stop();
    }
  }, { once: true });

  return async (): Promise<MachineReading[]> => {
    const memory = readMemory();
    const disks = Promise.all(paths.map(async (thing): Promise<MachineReading> => {
      const result = await disk(thing);
      if ('sizeBytes' in result) return { kind: 'disk', thing, ...result };
      if (result.reason) sayOnce(result.reason);
      return { kind: 'disk', thing, unknown: true };
    }));
    const readings: MachineReading[] = [];
    if (input.engine) {
      try {
        const engineStatus = await input.engine(AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])]));
        readings.push({ kind: 'containers', engineStatus });
      } catch {
        readings.push({ kind: 'containers', unknown: true });
      }
    }
    return [...readings, ...await disks, await memory];
  };
}
