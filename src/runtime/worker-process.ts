/** Configured commands run ONLY in a worker process, never in loom. Commands
 * have fixed argv, explicit environment and no shell interpolation. A builder
 * reads {job,house} JSON on stdin and emits {build:string} JSON on stdout. A
 * runner reads {job,build} JSON on stdin after the running acknowledgement.
 * Harness/provider/model roles stay configuration, not hard-coded CLI guesses. */
import { BUILD_DEADLINE_DEFAULT_MS, BUILD_DEADLINE_MAX_MS, STEP_DEADLINE_MAX_MS, validDeadline } from './worker-limits.js';
import { bodyInput } from './body-bootstrap.js';
import { BODY_SCRATCH } from './body-harness.js';
import { harnessLeftovers } from './body-harnesses.js';
import { workerLeft } from './worker-left.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { quotaWindows } from './account-observation.js';
import type { UsageProvider } from './account-windows.js';
import { StringDecoder } from 'node:string_decoder';
import { NoRunnerError, type WorkerAssignment, type WorkerBody, type WorkerExecutor } from './worker.js';
export interface WorkerCommand {
  /** This configured child understands the private bootstrap stdin envelope. */
  bodyBootstrap?: boolean;
  /** This runner reads the account from its startup envelope and signs in to that account itself, so one
   * command can serve several accounts. loom's own body program does not. */
  selectsAccount?: boolean;
  command: string;
  args: readonly string[];
  cwd: string;
  /** Explicit environment; the worker's ambient credentials are not inherited. */
  env: Readonly<Record<string, string>>;
}
export interface ProcessRuntime {
  spawn(command: WorkerCommand): ChildProcessWithoutNullStreams;
  kill(child: ChildProcessWithoutNullStreams): void;
}
const native: ProcessRuntime = {
  spawn: plan => {
    if (process.platform === 'win32') throw new Error('Worker process groups require POSIX (use WSL on Windows)');
    return spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: { ...plan.env },
      shell: false, detached: true, stdio: 'pipe' });
  },
  kill: child => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  },
};
function command(plan: WorkerCommand): WorkerCommand {
  if (!plan.command || !plan.cwd || [plan.command, plan.cwd, ...plan.args, ...Object.keys(plan.env), ...Object.values(plan.env)].some(value => value.includes('\0')))
    throw new Error('Invalid worker command');
  return { ...plan, args: [...plan.args], env: { ...plan.env } };
}
export interface WorkerRunnerConfig {
  /** One command per harness. Such a command is signed in to one account by its own environment, and
   * nothing here can check which. That is right while the machine has one account of the job's provider:
   * it is then the account loom placed the job on. When loom says several are signed in on this machine
   * (WorkerAssignment.accountChoices), the job is refused unless the command says it picks the account
   * itself (selectsAccount): it needs accountRunners. See docs/accepted-tradeoffs.md, "The placed
   * account is taken on trust". */
  runners: Readonly<Record<string, WorkerCommand>>;
  /** When present, every job requires an exact account/harness binding. */
  accountRunners?: Readonly<Record<string, Readonly<Record<string, WorkerCommand>>>>;
}
/** Freeze local plans once. Never fall back to another account's credentials. */
export function workerRunner(config: WorkerRunnerConfig) {
  const plans = (values: Readonly<Record<string, WorkerCommand>>) => new Map(Object.entries(values).map(([name, plan]) => [name, command(plan)]));
  const shared = plans(config.runners);
  const accounts = config.accountRunners === undefined ? undefined
    : new Map(Object.entries(config.accountRunners).map(([account, values]) => [account, plans(values)]));
  return (job: Pick<WorkerAssignment, 'account' | 'harness' | 'accountChoices'>) => {
    const selected = accounts ? accounts.get(job.account)?.get(job.harness) : shared.get(job.harness);
    if (!selected) throw new NoRunnerError('Worker has no configured runner for account');
    // One command cannot be on two accounts. Running the job anyway would spend an account loom did not
    // pick, perhaps one with no room, so the job fails here and says so (WORKER_EXIT.runner).
    if (!accounts && !selected.selectsAccount && (job.accountChoices ?? 1) > 1) throw new NoRunnerError('Several accounts need a runner each');
    return selected;
  };
}
/** One retained-output boundary shared by command execution and private bodies. */
export function commandOutput() {
  let tail = '', stdout = '', bytes = 0, overflow = false, discarded = false;
  const append = (text: string) => { if (!discarded) tail = (tail + text).slice(-16_384); };
  return {
    stdout(text: string, count: number) {
      if (discarded) return;
      append(text);
      if (!overflow) { bytes += count; if (bytes > 65_536) { stdout = ''; overflow = true; } else stdout += text; }
    },
    stderr: append,
    tail: () => tail,
    value: () => { if (overflow) throw new Error('Build output exceeded limit'); return stdout; },
    discard: () => { discarded = true; tail = ''; stdout = ''; bytes = 0; overflow = false; },
  };
}
function launch(plan: WorkerCommand, signal: AbortSignal, runtime: ProcessRuntime, closePipesOnKill = false) {
  if (signal.aborted) throw new Error('Worker attempt cancelled');
  const child = runtime.spawn(plan);
  let spawned = false, closed = false, stopRequested = false;
  const retained = commandOutput();
  let spawnResolve!: () => void, spawnReject!: (error: Error) => void;
  let exitResolve!: (result: { exitCode: number; logTail: string; own: boolean }) => void;
  let exitReject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => { spawnResolve = yes; spawnReject = no; });
  void ready.catch(() => {});
  const exited = new Promise<{ exitCode: number; logTail: string; own: boolean }>((yes, no) => { exitResolve = yes; exitReject = no; });
  void exited.catch(() => {});
  let killed = false;
  let cleanupError: Error | undefined;
  const kill = () => {
    if (closePipesOnKill && signal.aborted) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
    if (killed || !child.pid) return;
    killed = true;
    try { runtime.kill(child); } catch {
      killed = false;
      // Abort/exit listeners must not throw into the event loop. Failed cleanup
      // still rejects the attempt; it must never become a successful report.
      cleanupError = new Error('Worker cleanup failed');
      spawnReject(cleanupError); exitReject(cleanupError);
    }
  };
  signal.addEventListener('abort', kill, { once: true });
  const outDecoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8');
  child.stdout.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    retained.stdout(outDecoder.write(bytes), bytes.length);
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    retained.stderr(errorDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  });
  // An early child exit can close stdin before release. Never emit an unhandled
  // stream error or misclassify it as another launch attempt.
  child.stdin.on('error', () => {});
  child.once('spawn', () => {
    spawned = true;
    if (signal.aborted || stopRequested) kill();
    spawnResolve();
  });
  child.once('error', () => { spawnReject(new Error('Worker command could not start')); });
  let leaderExit: number | undefined, own = false;
  // close waits for inherited pipes. Kill descendants at leader exit, otherwise
  // an orphan holding stdout can keep both close and terminal reporting stuck.
  child.once('exit', (code) => { leaderExit = code ?? 1; own = code !== null; kill(); });
  child.once('close', (code, _signal) => {
    closed = true;
    retained.stdout(outDecoder.end(), 0); retained.stderr(errorDecoder.end());
    signal.removeEventListener('abort', kill);
    if (!spawned) spawnReject(new Error('Worker command did not spawn'));
    exitResolve({ exitCode: leaderExit ?? code ?? 1, logTail: retained.tail(), own });
  });
  // Covers cancellation during the injected spawn operation/listener setup.
  if (signal.aborted) kill();
  let released = false;
  let stopping: Promise<void> | undefined;
  return {
    /** The process group's id once the system has given one: at once for a real spawn. */
    pid: () => child.pid,
    spawned: ready, exited,
    discardOutput: retained.discard,
    output: retained.value,
    release: async (input: unknown) => {
      if (released || signal.aborted || stopRequested || closed) throw new Error('Worker input unavailable');
      released = true;
      await new Promise<void>((yes, no) => child.stdin.end(JSON.stringify(input) + '\n', (error?: Error | null) => error ? no(error) : yes()));
    },
    stop: () => {
      // Retain cancellation until a pending spawn has a PID to reap.
      stopRequested = true;
      return stopping ??= (async () => { kill(); if (cleanupError) throw cleanupError; await exited; })();
    },
  };
}
export function commandWorkerExecutor(config: WorkerRunnerConfig & {
  build: WorkerCommand;
  /** Maximum build time; running bodies have their own lifecycle. */
  buildTimeoutMs?: number;
  /** The worker's own directory, where the process groups this executor starts are recorded so that a
   * later worker can end them if this one is killed (worker-left.ts). The worker program always names
   * one; it is held from here until close(). */
  state?: string;
}, runtime: ProcessRuntime = native, open: typeof workerLeft = workerLeft): WorkerExecutor {
  const buildPlan = command(config.build);
  const buildTimeoutMs = config.buildTimeoutMs ?? BUILD_DEADLINE_DEFAULT_MS;
  if (!validDeadline(buildTimeoutMs, BUILD_DEADLINE_MAX_MS))
    throw new Error('Invalid worker build deadline');
  const runner = workerRunner(config), left = config.state === undefined ? undefined : open(config.state);
  const noted = (attempt: ReturnType<typeof launch>, job: WorkerAssignment, scratch?: string) => {
    const pid = attempt.pid();
    return left && pid ? left.note(pid, { job: job.id, harness: job.harness, account: job.account }, scratch) : () => {};
  };
  return {
    close() { left?.close(); },
    async endLeft() {
      if (!left) return { unverified: 0 };
      const { unverified } = await left.reap((record, scratch) => {
        if (!scratch || !record.harness || !record.account) return;
        // The same tidying as after a body this worker reaped, with the environment its runner has now.
        harnessLeftovers(record.harness, scratch, runner({ harness: record.harness, account: record.account }).env);
      });
      return { unverified };
    },
    async build(job, signal, repositoryInput) {
      runner(job);
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = setTimeout(cancel, buildTimeoutMs);
      let attempt: ReturnType<typeof launch> | undefined, forget = () => {};
      try {
        attempt = launch(buildPlan, abort.signal, runtime);
        forget = noted(attempt, job);
        await attempt.spawned;
        await attempt.release({ job: job.id, house: job.house, ...(repositoryInput?{repositoryInput:{encoding:'base64',value:Buffer.from(repositoryInput.buffer,repositoryInput.byteOffset,repositoryInput.byteLength).toString('base64')}}:{}) });
        const result = await attempt.exited;
        if (abort.signal.aborted || result.exitCode !== 0) throw new Error('Worker build failed');
        const output: unknown = JSON.parse(attempt.output());
        if (!output || typeof output !== 'object' || !('build' in output) || typeof output.build !== 'string' || !output.build.trim()) throw new Error('Builder returned no artifact');
        return output.build;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (attempt) await attempt.stop();
        forget();
      }
    },
    start(job: WorkerAssignment, build: string, signal: AbortSignal): WorkerBody {
      const plan = runner(job);
      // Each body gets a directory of its own (mode 0700, named to it in BODY_SCRATCH) for files a harness
      // can only be configured through. The worker removes it once the body's whole process group is gone,
      // so what was written there does not outlive the job when the body is killed and cannot tidy up.
      // If the worker itself is killed, the directory and the record beside it are what the next worker
      // finds the body by (endLeft), and it removes them then.
      const scratch = left ? left.scratch() : mkdtempSync(join(tmpdir(), 'loom-body-'));
      let removed = false, forget = () => {};
      const remove = () => {
        if (removed) return; removed = true;
        try { harnessLeftovers(job.harness, scratch, plan.env); } catch { /* best effort, as in the harness itself */ }
        try { rmSync(scratch, { recursive: true, force: true }); } catch { /* nothing in it is live once the body is dead */ }
        forget();
      };
      let attempt: ReturnType<typeof launch>;
      try { attempt = launch({ ...plan, env: { ...plan.env, [BODY_SCRATCH]: scratch } }, signal, runtime); }
      catch (error) { remove(); throw error; }
      // A body that could not be recorded could not be found again: it is not run.
      try { forget = noted(attempt, job, scratch); }
      catch (error) { void attempt.stop().then(remove, remove); throw error; }
      const exited = attempt.exited.finally(remove);
      void exited.catch(() => {});
      return { acceptsBootstrap: plan.bodyBootstrap === true, spawned: attempt.spawned, exited,
        release: bootstrap => {
          const payload = bodyInput(job, build, bootstrap, plan.bodyBootstrap === true);
          if (bootstrap) attempt.discardOutput();
          return attempt.release(payload);
        }, stop: async () => { try { await attempt.stop(); } finally { remove(); } } };
    },
  };
}



/** Worker-side configured private quota reader. It reads {account,owner,provider}
 * JSON on stdin and returns the complete QuotaWindow[] JSON on stdout. Provider
 * credentials stay in the configured command's environment/files. Never run this
 * in loom's control process. Feed the returned provider to refreshAccountWindows;
 * that function owns account identity, stale completion and admission checks.
 * No command output is exposed in failures. Every read has a bounded deadline.
 * Cancellation kills the group and closes local pipes; if OS reaping remains
 * pending, the read still fails at its deadline rather than waiting for close.
 */
export function commandUsageProvider(plan: WorkerCommand, options: {
  signal: AbortSignal; timeoutMs?: number;
}, runtime: ProcessRuntime = native): UsageProvider {
  const fixed = command(plan), timeoutMs = options.timeoutMs ?? 30_000;
  if (!validDeadline(timeoutMs, STEP_DEADLINE_MAX_MS))
    throw new Error('Invalid quota reader deadline');
  return async identity => {
    const abort = new AbortController();
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, no) => { rejectCancelled = no; });
    void cancelled.catch(() => {});
    const cancel = () => { abort.abort(); rejectCancelled(new Error('Quota reader unavailable')); };
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    const timer = setTimeout(cancel, timeoutMs);
    let attempt: ReturnType<typeof launch> | undefined;
    try {
      attempt = launch(fixed, abort.signal, runtime, true);
      const reading = attempt;
      return await Promise.race([cancelled, (async () => {
        await reading.spawned;
        await reading.release({ account: identity.account, owner: identity.owner, provider: identity.provider });
        const result = await reading.exited;
        if (abort.signal.aborted || result.exitCode !== 0) throw new Error('Quota reader failed');
        return quotaWindows.parse(JSON.parse(reading.output()));
      })()]);
    } catch { throw new Error('Quota reader unavailable'); }
    finally {
      try {
        if (attempt) await Promise.race([attempt.stop(), cancelled]);
      } catch { throw new Error('Quota reader unavailable'); }
      finally {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', cancel);
      }
    }
  };
}
