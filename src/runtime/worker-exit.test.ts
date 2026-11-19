/** How the worker process ends, held against real processes: the claim is about what Node and the kernel do
 * with a call that never comes back, and a fake would only repeat the claim. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { WORKER_EXIT_GRACE_MS, endWorker } from './worker-exit.js';

const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
const module = fileURLToPath(new URL('./worker-exit.ts', import.meta.url));
/** A process that opens a pipe nobody writes to, which holds one of its file threads as a call to a dead
 * mount does, and then ends the way `how` says. Resolves with how it ended and how long that took. */
function ended(how: string, boundMs = WORKER_EXIT_GRACE_MS + 6_000): Promise<{ code: number | null; signal: string | null; ms: number }> {
  const home = mkdtempSync(join(tmpdir(), 'loomexit')); made.push(home);
  const pipe = join(home, 'pipe');
  execFileSync('mkfifo', [pipe]);
  const script = `
    const { open } = await import('node:fs/promises');
    const { endWorker } = await import(${JSON.stringify(module)});
    if (process.argv[1] !== 'nothing-out') void open(${JSON.stringify(pipe)}, 'r').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    ${how}`;
  const started = performance.now();
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, how.includes('nothing-out') ? 'nothing-out' : 'call-out'], { stdio: 'ignore', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
  return new Promise(resolve => {
    // The test's own bound: a process still there after this was not ended by what it did.
    const giveUp = setTimeout(() => child.kill('SIGKILL'), boundMs);
    child.once('exit', (code, signal) => { clearTimeout(giveUp); resolve({ code, signal, ms: performance.now() - started }); });
  });
}

it('is not ended by its exit code or by process.exit while a call to a filesystem is out: the reason this file exists', async () => {
  const [byCode, byExit] = await Promise.all([ended('process.exitCode = 3;', 3_000), ended('process.exit(3);', 3_000)]);
  // Both were still there three seconds on, when the test gave up on them and killed them.
  expect(byCode).toMatchObject({ code: null, signal: 'SIGKILL' }); expect(byCode.ms).toBeGreaterThanOrEqual(3_000);
  expect(byExit).toMatchObject({ code: null, signal: 'SIGKILL' }); expect(byExit.ms).toBeGreaterThanOrEqual(3_000);
}, 30_000);

it('ends a worker that has a call out, by the signal a supervisor reads rightly: stopped after a clean stop, failed after any other', async () => {
  const [clean, failed] = await Promise.all([ended('endWorker(0, 1);'), ended('endWorker(45, 2);')]);
  expect(clean).toMatchObject({ code: null, signal: 'SIGTERM' });
  expect(failed).toMatchObject({ code: null, signal: 'SIGKILL' });
  // After the moment it is given to end by itself, and not long after: well before the test would have killed it.
  for (const how of [clean, failed]) { expect(how.ms).toBeGreaterThanOrEqual(WORKER_EXIT_GRACE_MS); expect(how.ms).toBeLessThan(WORKER_EXIT_GRACE_MS + 4_000); }
}, 30_000);

it('lets a worker with no call out end by itself, with its own code and without waiting', async () => {
  const [clean, failed] = await Promise.all([ended('endWorker(0, 0); // nothing-out'), ended('endWorker(45, 0); // nothing-out')]);
  expect(clean).toMatchObject({ code: 0, signal: null });
  expect(failed).toMatchObject({ code: 45, signal: null });
  for (const how of [clean, failed]) expect(how.ms).toBeLessThan(WORKER_EXIT_GRACE_MS);
}, 30_000);

it('arms nothing at all when no call is out, and with one out waits its moment, takes away any listener and signals itself', () => {
  vi.useFakeTimers();
  const host = { pid: 4321, exitCode: undefined as number | undefined, kill: vi.fn(), removeAllListeners: vi.fn() };
  endWorker(7, 0, host as never);
  expect(host.exitCode).toBe(7); expect(vi.getTimerCount()).toBe(0);
  endWorker(0, 1, host as never);
  expect(host.exitCode).toBe(0);
  vi.advanceTimersByTime(WORKER_EXIT_GRACE_MS - 1); expect(host.kill).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(host.removeAllListeners).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(host.kill).toHaveBeenCalledExactlyOnceWith(4321, 'SIGTERM');
  endWorker(46, 3, host as never); vi.advanceTimersByTime(WORKER_EXIT_GRACE_MS);
  expect(host.kill).toHaveBeenLastCalledWith(4321, 'SIGKILL');
});
