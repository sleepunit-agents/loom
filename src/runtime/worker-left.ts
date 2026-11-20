/** What a worker keeps on its machine so that the worker after it can end what it left running.
 *
 * A worker that is killed cannot stop its bodies: each is a process group of its own and goes on running,
 * while loom takes the job for lost and queues the same work again. So before it takes any work, a
 * worker ends whatever the worker before it left (WorkerExecutor.endLeft). For bodies that are processes
 * this directory is the record that makes that possible:
 *
 *   <dir>/worker             who holds the directory: the running worker's pid and birth
 *   <dir>/body-XXXXXX/       one body's scratch directory (named to it in BODY_SCRATCH)
 *   <dir>/body-XXXXXX.json   that body's process group, job, harness and account
 *   <dir>/build-XXXXXX.json  a build command's process group
 *
 * A record and its scratch directory are removed when the body ends; what is still here when a worker
 * starts was left. The directory is this user's alone (0700). Containers need no record: they carry
 * labels (worker-container.ts).
 *
 * Telling a recorded process from a stranger. The system reuses a pid once its process is gone, so a
 * record is acted on only when the process now holding the pid was born when the record says. Two things
 * are ended:
 *   - the whole process group, when its leader is still that process;
 *   - on Linux, every process whose environment names the body's scratch directory. The path is random
 *     and each body's own, so this finds a body's descendants wherever they went, also after the leader
 *     has gone and when the record was never written.
 * What neither finds is left alone and counted: see docs/accepted-tradeoffs.md, "Bodies a killed worker
 * left that cannot be told from a stranger". */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BODY_SCRATCH } from './body-harness.js';
import { WorkerStop } from './worker-stop.js';

/** The few questions asked of the machine's process table; tests supply their own. */
export interface ProcessTable {
  /** When the live process holding this pid was born, as text that is equal only for the same process.
   * Undefined when there is none, it has already ended, or the machine cannot say. */
  born(pid: number): string | undefined;
  /** Whether the process group this pid leads still has a live member. */
  groupAlive(pid: number): boolean;
  /** Kill every member of the process group this pid leads. */
  killGroup(pid: number): void;
  /** The live processes whose environment names this scratch directory. Empty where the machine cannot say. */
  holding(scratch: string): number[];
  kill(pid: number): void;
}
const send = (target: number, signal: 'SIGKILL' | 0): boolean => {
  try { process.kill(target, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
};
/** One line of /proc/<pid>/stat: the fields after the command name, which may itself hold spaces and brackets. */
function procStat(pid: number | string): string[] | undefined {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' '); }
  catch { return undefined; }
}
// A process that has ended and only waits to be collected still has an entry; it is not alive.
const ended = (fields: string[]) => fields[0] === 'Z' || fields[0] === 'X';
const procPids = () => readdirSync('/proc').filter(name => /^\d+$/.test(name));
function linuxTable(): ProcessTable | undefined {
  let boot: string;
  try { boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); if (!procStat(process.pid)) return undefined; } catch { return undefined; }
  return {
    // Field 22 of stat is the start time in clock ticks since boot; with the boot's id it never repeats.
    born(pid) { const fields = procStat(pid); return fields && !ended(fields) && fields[19] ? `${boot}:${fields[19]}` : undefined; },
    // Field 5 is the process group.
    groupAlive: pid => procPids().some(name => { const fields = procStat(name); return !!fields && !ended(fields) && fields[2] === String(pid); }),
    killGroup(pid) { send(-pid, 'SIGKILL'); },
    holding(scratch) {
      const marker = Buffer.from(`${BODY_SCRATCH}=${scratch}\0`);
      return procPids().map(Number).filter(pid => {
        if (pid === process.pid) return false;
        try {
          const environment = readFileSync(`/proc/${pid}/environ`);
          const at = environment.indexOf(marker);
          return (at === 0 || at > 0 && environment[at - 1] === 0) && !ended(procStat(pid) ?? ['Z']);
        } catch { return false; }
      });
    },
    kill(pid) { send(pid, 'SIGKILL'); },
  };
}
/** Any other POSIX system: `ps` gives a start time to the second, and nothing reads another process's environment. */
const portableTable: ProcessTable = {
  born(pid) {
    try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || undefined; }
    catch { return undefined; }
  },
  groupAlive: pid => send(-pid, 0),
  killGroup(pid) { send(-pid, 'SIGKILL'); },
  holding: () => [],
  kill(pid) { send(pid, 'SIGKILL'); },
};

const record = z.object({ pid: z.number().int().min(2), born: z.string().min(1).nullable(), job: z.string(),
  harness: z.string().optional(), account: z.string().optional() }).strict();
export type LeftRecord = z.infer<typeof record>;
const holder = z.object({ pid: z.number().int().min(2), born: z.string().min(1).nullable() }).strict();
const read = <T>(path: string, schema: z.ZodType<T>): T | undefined => {
  try { return schema.parse(JSON.parse(readFileSync(path, 'utf8'))); } catch { return undefined; }
};

export interface WorkerLeft {
  /** A fresh directory for one body, private to this user. */
  scratch(): string;
  /** Record a process group this worker started: a body's with its scratch directory, a build's without.
   * Returns what forgets it again, for when the group has been reaped. */
  note(pid: number, entry: Omit<LeftRecord, 'pid' | 'born'>, scratch?: string): () => void;
  /** End every process a previous worker recorded here and remove its record and scratch directory.
   * `tidy` runs for each once its processes are gone, before its directory is removed. Rejects when
   * something recorded would not die, so that the caller takes no work beside it. `unverified` counts
   * the groups that are still alive and could not be shown to be the recorded ones; those are left. */
  reap(tidy?: (left: LeftRecord, scratch: string | undefined) => void): Promise<{ ended: number; unverified: number }>;
  /** Give the directory up, for a worker that stops in good order. */
  close(): void;
}
/** Where a worker keeps this when its configuration names no place: under the temporary directory, by user and machine id. */
export function defaultWorkerState(box: string): string {
  return join(tmpdir(), `loom-worker-${userInfo().uid}-${createHash('sha256').update(box).digest('hex').slice(0, 16)}`);
}
/** Open the directory for this worker. Throws when it is not this user's private directory, or when
 * the worker that holds it is still running: two workers on one directory would end each other's bodies. */
export function workerLeft(dir: string, options: { table?: ProcessTable; waitMs?: number } = {}): WorkerLeft {
  if (process.platform === 'win32') throw new Error('Worker process groups require POSIX (use WSL on Windows)');
  const table = options.table ?? linuxTable() ?? portableTable, waitMs = options.waitMs ?? 10_000;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new WorkerStop('state');
  const lock = join(dir, 'worker'), held = read(lock, holder);
  if (held && held.pid !== process.pid && held.born && table.born(held.pid) === held.born) throw new WorkerStop('held');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, born: table.born(process.pid) ?? null }), { mode: 0o600 });
  const gone = async (alive: () => boolean) => {
    for (const until = performance.now() + waitMs; alive();) {
      if (performance.now() > until) throw new WorkerStop('left');
      await delay(50);
    }
  };
  const endHolders = async (scratch: string): Promise<number> => {
    const found = table.holding(scratch);
    for (const pid of found) table.kill(pid);
    await gone(() => table.holding(scratch).length > 0);
    return found.length;
  };
  return {
    scratch: () => mkdtempSync(join(dir, 'body-')),
    note(pid, entry, scratch) {
      const file = scratch ? `${scratch}.json` : join(dir, `build-${randomBytes(6).toString('hex')}.json`);
      writeFileSync(file, JSON.stringify(record.parse({ ...entry, pid, born: table.born(pid) ?? null })), { mode: 0o600 });
      return () => { rmSync(file, { force: true }); };
    },
    async reap(tidy) {
      let endedCount = 0, unverified = 0;
      const names = readdirSync(dir);
      for (const name of names.filter(name => /^(?:body|build)-[A-Za-z0-9_-]+\.json$/.test(name))) {
        const id = name.slice(0, -'.json'.length), scratch = id.startsWith('body-') && names.includes(id) ? join(dir, id) : undefined;
        const left = read(join(dir, name), record);
        const ours = !!left?.born && table.born(left.pid) === left.born;
        if (ours) { table.killGroup(left!.pid); await gone(() => table.groupAlive(left!.pid)); }
        const strays = scratch ? await endHolders(scratch) : 0;
        if (ours || strays) endedCount++;
        // The leader is gone, or is another process by now. Members that are still alive and were not found by
        // their environment cannot be shown to be this record's: the group's number may have been given out again.
        else if (left && table.born(left.pid) === undefined && table.groupAlive(left.pid)) unverified++;
        if (left) try { tidy?.(left, scratch); } catch { /* best effort, as when the body ends by itself */ }
        if (scratch) rmSync(scratch, { recursive: true, force: true });
        rmSync(join(dir, name), { force: true });
      }
      // A worker killed between making a body's directory and writing its record leaves only the directory.
      for (const name of readdirSync(dir).filter(name => /^body-[A-Za-z0-9_-]+$/.test(name))) {
        if (await endHolders(join(dir, name))) endedCount++;
        rmSync(join(dir, name), { recursive: true, force: true });
      }
      return { ended: endedCount, unverified };
    },
    close() { if (read(lock, holder)?.pid === process.pid) rmSync(lock, { force: true }); },
  };
}
