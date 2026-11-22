/** The worker reports memory, container runtime availability, and every configured disk path.
 * For memory and each disk path it runs the adjacent machine-disk-helper.js with process.execPath
 * and no shell. Its only argument is the fixed word memory or a path validated here and in the helper.
 * This check runs no other program. loom evaluates each reading and decides what to say. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The kinds of thing read. The list itself is the column's (`box_readings.kind`); the worker loads no
 * household schema, and loom's side holds this to the column where it writes a reading down (machine-conditions.ts). */
export type ReadingKind = 'disk' | 'memory' | 'containers';
/** One thing read. `thing` names a disk by its path, except for an unknown state directory whose name
 * cannot be reported. `unknown` names a thing this
 * machine watches and could not read this time. A disk's size is what its user can fill (used and
 * available): the two numbers `df` works its percentage out from, as loom then does (machine-conditions.ts). */
export interface MachineReading { kind: ReadingKind; thing?: string; unknown?: true; sizeBytes?: number; freeBytes?: number; engineStatus?: number; reason?: 'state-path' }
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
/** A short absolute path, safe to show as text. The helper walks it without following links.
 * A worker can still name a path its owner did not configure. */
export const watchedPath = (value: string) => value.startsWith('/') && Array.from(value).length <= WATCHED_PATH_LENGTH &&
  !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) && !value.split('/').includes('..');

export const WATCHED_THING_LIMIT_ERROR = 'Machine watched thing limit exceeded';

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
export function startMachineHelper(path: string, start = spawn) {
  if (path !== 'memory' && !watchedPath(path)) throw new Error('Invalid watched path');
  return start(process.execPath, [helper, path], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NODE_OPTIONS: undefined } });
}

const SAID = {
  link: 'Worker machine check: a watched path is not a directory reached without a link, and is not read\n',
  name: 'Worker machine check: a directory to watch has a name loom does not take, and is not watched\n',
  'state-path': 'Worker machine check: the state directory path is outside the watched path bounds\n',
  start: 'Worker machine check: a machine helper could not be started\n',
} as const;

export function machineReader(input: {
  paths: readonly string[];
  statePath?: string;
  engine?: (signal: AbortSignal) => Promise<number>;
  timeoutMs?: number;
  signal?: AbortSignal;
  say?: (line: string) => void;
  start?: typeof startMachineHelper;
}) {
  const timeoutMs = input.timeoutMs ?? MACHINE_READ_MS;
  const live = new Map<string, { child: ReturnType<typeof startMachineHelper>; stop: () => void }>();
  const said = new Set<keyof typeof SAID>();
  const sayOnce = (why: keyof typeof SAID) => {
    if (!said.has(why)) { said.add(why); input.say?.(SAID[why]); }
  };
  const invalidStatePath = input.statePath !== undefined && !watchedPath(input.statePath);
  if (invalidStatePath) sayOnce('state-path');
  const paths = [...new Set([
    ...input.paths.slice(0, 1),
    ...(input.statePath !== undefined && !invalidStatePath ? [input.statePath] : []),
    ...input.paths.slice(1),
  ])].filter(path => {
    if (watchedPath(path)) return true;
    sayOnce('name');
    return false;
  }).slice(0, WATCHED_PATHS_MAX - Number(invalidStatePath));

  function sample(path: string): Promise<DiskResult> {
    if (input.signal?.aborted || live.has(path)) return Promise.resolve(unknown);
    return new Promise(resolve => {
      let child: ReturnType<typeof startMachineHelper>;
      try { child = (input.start ?? startMachineHelper)(path); }
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
    const disks = Promise.all(paths.map(async (thing): Promise<MachineReading> => {
      const result = await sample(thing);
      if ('sizeBytes' in result) return { kind: 'disk', thing, ...result };
      if (result.reason) sayOnce(result.reason);
      return { kind: 'disk', thing, unknown: true };
    }));
    const memory = sample('memory');
    const readings: MachineReading[] = [];
    if (input.engine) {
      try {
        const engineStatus = await input.engine(AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])]));
        readings.push({ kind: 'containers', engineStatus });
      } catch {
        readings.push({ kind: 'containers', unknown: true });
      }
    }
    readings.push(...await disks);
    if (invalidStatePath) readings.push({ kind: 'disk', unknown: true, reason: 'state-path' });
    const result = await memory;
    readings.push('sizeBytes' in result ? { kind: 'memory', ...result } : { kind: 'memory', unknown: true });
    return readings;
  };
}
