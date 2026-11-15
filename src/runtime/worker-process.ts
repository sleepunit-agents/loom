/** Configured commands run ONLY in a worker process, never in loom. Commands
 * have fixed argv, explicit environment and no shell interpolation. A builder
 * reads {job,house} JSON on stdin and emits {build:string} JSON on stdout. A
 * runner reads {job,build} JSON on stdin after the running acknowledgement.
 * Harness/provider/model roles stay configuration, not hard-coded CLI guesses. */
import { bodyInput } from './body-bootstrap.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { quotaWindows } from './account-observation.js';
import type { UsageProvider } from './account-windows.js';
import { StringDecoder } from 'node:string_decoder';
import type { WorkerAssignment, WorkerBody, WorkerExecutor } from './worker.js';
export interface WorkerCommand {
  /** This configured child understands the private bootstrap stdin envelope. */
  bodyBootstrap?: boolean;
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
  /** Shared commands may choose the account from the startup envelope themselves. */
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
  return (job: Pick<WorkerAssignment, 'account' | 'harness'>) => {
    const selected = accounts ? accounts.get(job.account)?.get(job.harness) : shared.get(job.harness);
    if (!selected) throw new Error('Worker has no configured runner for account');
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
  let exitResolve!: (result: { exitCode: number; logTail: string }) => void;
  let exitReject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => { spawnResolve = yes; spawnReject = no; });
  void ready.catch(() => {});
  const exited = new Promise<{ exitCode: number; logTail: string }>((yes, no) => { exitResolve = yes; exitReject = no; });
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
  let leaderExit: number | undefined;
  // close waits for inherited pipes. Kill descendants at leader exit, otherwise
  // an orphan holding stdout can keep both close and terminal reporting stuck.
  child.once('exit', (code) => { leaderExit = code ?? 1; kill(); });
  child.once('close', (code, _signal) => {
    closed = true;
    retained.stdout(outDecoder.end(), 0); retained.stderr(errorDecoder.end());
    signal.removeEventListener('abort', kill);
    if (!spawned) spawnReject(new Error('Worker command did not spawn'));
    exitResolve({ exitCode: leaderExit ?? code ?? 1, logTail: retained.tail() });
  });
  // Covers cancellation during the injected spawn operation/listener setup.
  if (signal.aborted) kill();
  let released = false;
  let stopping: Promise<void> | undefined;
  return {
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
}, runtime: ProcessRuntime = native): WorkerExecutor {
  const buildPlan = command(config.build);
  const buildTimeoutMs = config.buildTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(buildTimeoutMs) || buildTimeoutMs < 1 || buildTimeoutMs > 3_600_000)
    throw new Error('Invalid worker build deadline');
  const runner = workerRunner(config);
  return {
    async build(job, signal, repositoryInput) {
      runner(job);
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = setTimeout(cancel, buildTimeoutMs);
      let attempt: ReturnType<typeof launch> | undefined;
      try {
        attempt = launch(buildPlan, abort.signal, runtime);
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
      }
    },
    start(job: WorkerAssignment, build: string, signal: AbortSignal): WorkerBody {
      const plan = runner(job);
      const attempt = launch(plan, signal, runtime);
      return { acceptsBootstrap: plan.bodyBootstrap === true, spawned: attempt.spawned, exited: attempt.exited,
        release: bootstrap => {
          const payload = bodyInput(job, build, bootstrap, plan.bodyBootstrap === true);
          if (bootstrap) attempt.discardOutput();
          return attempt.release(payload);
        }, stop: attempt.stop };
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
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
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
