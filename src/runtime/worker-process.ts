/** Configured commands run ONLY in a worker process, never in loom. Commands
 * have fixed argv, explicit environment and no shell interpolation. A builder
 * reads {job,house} JSON on stdin and emits {build:string} JSON on stdout. A
 * runner reads {job,build} JSON on stdin after the running acknowledgement.
 * Harness/provider/model roles stay configuration, not hard-coded CLI guesses. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { WorkerAssignment, WorkerBody, WorkerExecutor } from './worker.js';
export interface WorkerCommand {
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
  if (!plan.command || !plan.cwd) throw new Error('Worker command and directory are required');
  return { ...plan, args: [...plan.args], env: { ...plan.env } };
}
function launch(plan: WorkerCommand, signal: AbortSignal, runtime: ProcessRuntime) {
  if (signal.aborted) throw new Error('Worker attempt cancelled');
  const child = runtime.spawn(plan);
  let spawned = false, closed = false, stopRequested = false, logTail = '', stdout = '', overflow = false;
  let spawnResolve!: () => void, spawnReject!: (error: Error) => void;
  let exitResolve!: (result: { exitCode: number; logTail: string }) => void;
  const ready = new Promise<void>((yes, no) => { spawnResolve = yes; spawnReject = no; });
  void ready.catch(() => {});
  const exited = new Promise<{ exitCode: number; logTail: string }>(yes => { exitResolve = yes; });
  let killed = false;
  const kill = () => {
    if (killed || !child.pid) return;
    killed = true;
    try { runtime.kill(child); } catch (error) { killed = false; throw error; }
  };
  signal.addEventListener('abort', kill, { once: true });
  const outDecoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8');
  let outputBytes = 0;
  const append = (text: string) => { logTail = (logTail + text).slice(-16_384); };
  const output = (text: string, bytes: number) => {
    append(text);
    if (!overflow) {
      outputBytes += bytes;
      if (outputBytes > 65_536) { stdout = ''; overflow = true; }
      else stdout += text;
    }
  };
  child.stdout.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    output(outDecoder.write(bytes), bytes.length);
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    append(errorDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
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
    output(outDecoder.end(), 0); append(errorDecoder.end());
    signal.removeEventListener('abort', kill);
    if (!spawned) spawnReject(new Error('Worker command did not spawn'));
    exitResolve({ exitCode: leaderExit ?? code ?? 1, logTail });
  });
  // Covers cancellation during the injected spawn operation/listener setup.
  if (signal.aborted) kill();
  let released = false;
  let stopping: Promise<void> | undefined;
  return {
    spawned: ready, exited,
    output: () => { if (overflow) throw new Error('Build output exceeded limit'); return stdout; },
    release: async (input: unknown) => {
      if (released || signal.aborted || stopRequested || closed) throw new Error('Worker input unavailable');
      released = true;
      await new Promise<void>((yes, no) => child.stdin.end(JSON.stringify(input) + '\n', (error?: Error | null) => error ? no(error) : yes()));
    },
    stop: () => {
      // A pending spawn may not have a PID yet. Retain the stop request so its
      // spawn listener kills it, and no caller can release input while reaping.
      stopRequested = true;
      return stopping ??= (async () => { kill(); await exited; })();
    },
  };
}
export function commandWorkerExecutor(config: {
  build: WorkerCommand;
  /** Configured harness name -> runner command; a model name implies nothing. */
  runners: Readonly<Record<string, WorkerCommand>>;
}, runtime: ProcessRuntime = native): WorkerExecutor {
  const buildPlan = command(config.build);
  const runners = new Map(Object.entries(config.runners).map(([name, plan]) => [name, command(plan)]));
  return {
    async build(job, signal) {
      if (!runners.has(job.harness)) throw new Error('Worker has no configured runner');
      const attempt = launch(buildPlan, signal, runtime);
      try {
        await attempt.spawned;
        await attempt.release({ job: job.id, house: job.house });
        const result = await attempt.exited;
        if (signal.aborted || result.exitCode !== 0) throw new Error('Worker build failed');
        const output: unknown = JSON.parse(attempt.output());
        if (!output || typeof output !== 'object' || !('build' in output) || typeof output.build !== 'string' || !output.build.trim()) throw new Error('Builder returned no artifact');
        return output.build;
      } finally { await attempt.stop(); }
    },
    start(job: WorkerAssignment, build: string, signal: AbortSignal): WorkerBody {
      const plan = runners.get(job.harness);
      if (!plan) throw new Error('Worker has no configured runner');
      const attempt = launch(plan, signal, runtime);
      return { spawned: attempt.spawned, exited: attempt.exited,
        release: () => attempt.release({ job, build }), stop: attempt.stop };
    },
  };
}
