/** Work-plane execution only. Loom's control plane supplies a claimed assignment;
 * builds and bodies run through the executor in the separate worker program. */
export interface WorkerRunOptions {
  nestedContainers: boolean;
  gpu: boolean;
  ports: { address: string; port: number }[];
}
export interface WorkerAssignment {
  id: string;
  box: string;
  agent: string;
  conversation: string | null;
  model: string;
  account: string;
  harness: string;
  brief: string;
  /** Current agent configuration at claim; absent means no extra capabilities. */
  run?: WorkerRunOptions;
  house: { repository: string; file: string; branch: string };
}
export interface WorkerBody {
  /** Resolves only after the child has actually spawned, rejects on launch failure. */
  spawned: Promise<void>;
  exited: Promise<{ exitCode: number; logTail: string }>;
  /** Releases the brief only after loom acknowledges running. */
  release(): Promise<void>;
  /** Must stop and reap every child belonging to this attempt. Idempotent. */
  stop(): Promise<void>;
}
export interface WorkerExecutor {
  build(job: WorkerAssignment, signal: AbortSignal): Promise<string>;
  start(job: WorkerAssignment, build: string, signal: AbortSignal): WorkerBody;
}
export interface WorkerControl {
  /** Claims once on the server. An uncertain response is never retried locally. */
  next(): Promise<WorkerAssignment | undefined>;
  started(id: string, build: string): Promise<void>;
  /** false means revoked/stopped/lost: cease execution without a finish report. */
  heartbeat(id: string, state: 'starting' | 'running'): Promise<boolean>;
  finish(id: string, exitCode: number, logTail: string): Promise<void>;
}
export interface WorkerSchedule {
  every(ms: number, callback: () => void): () => void;
}
const schedule: WorkerSchedule = {
  every(ms, callback) { const timer = setInterval(callback, ms); return () => clearInterval(timer); },
};
export type WorkerResult = 'idle' | 'finished' | 'abandoned';

/** One assignment per invocation, never a local launch retry. The server owns
 * start retries, terminal states and placement. Transport uncertainty aborts the
 * attempt; the server's silence sweep reconciles it, rather than duplicate work.
 * A worker process can call again after this resolves, or run several independent
 * slots. Never call this from loom's server/composition root. */
export async function workOnce(input: {
  box: string; control: WorkerControl; executor: WorkerExecutor; signal: AbortSignal;
  schedule?: WorkerSchedule; heartbeatMs?: number;
}): Promise<WorkerResult> {
  const { control, executor } = input;
  const interval = input.heartbeatMs ?? 15_000;
  if (!Number.isFinite(interval) || interval <= 0 || interval >= 120_000) throw new Error('Invalid worker heartbeat interval');
  if (input.signal.aborted) return 'abandoned';
  const job = await control.next();
  if (!job) return 'idle';
  if (job.box !== input.box) throw new Error('Assignment belongs to another worker');
  // Snapshot input before giving asynchronous adapters control of it.
  const assignment = structuredClone(job);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  input.signal.addEventListener('abort', cancel, { once: true });
  if (input.signal.aborted) cancel();
  let state: 'starting' | 'running' = 'starting';
  let body: WorkerBody | undefined;
  let reporting = false;
  let abandoned = false;
  let heartbeat: Promise<void> | undefined;
  const abandon = () => { abandoned = true; cancel(); };
  const pulse = () => {
    if (heartbeat || reporting || abort.signal.aborted) return;
    // Capture the phase at dispatch; started() waits for this report to settle.
    heartbeat = control.heartbeat(assignment.id, state).then(ok => { if (!ok) abandon(); }, abandon)
      .finally(() => { heartbeat = undefined; });
  };
  const dispose = (input.schedule ?? schedule).every(interval, pulse);
  try {
    let build: string;
    try {
      if (abort.signal.aborted) return 'abandoned';
      build = await executor.build(assignment, abort.signal);
      if (abort.signal.aborted) return 'abandoned';
      if (!build.trim()) throw new Error('Build returned no artifact');
      body = executor.start(assignment, build, abort.signal);
      // Attach a handler immediately: a fast exit may precede spawned/started.
      void body.exited.catch(() => {});
      await body.spawned;
    } catch {
      if (abort.signal.aborted) return 'abandoned';
      // Reap a partly launched process before allowing the server's start retry.
      if (body) await body.stop();
      reporting = true;
      await heartbeat;
      if (abandoned || abort.signal.aborted) return 'abandoned';
      await control.finish(assignment.id, 1, 'Worker build or body launch failed');
      return 'finished';
    }
    if (abort.signal.aborted) return 'abandoned';
    reporting = true;
    await heartbeat;
    if (abort.signal.aborted) return 'abandoned';
    // A failed/uncertain running acknowledgement must never be reported as a
    // failed start: the body already exists. Abort it and leave reconciliation
    // to the server. No second started() or finish() after that uncertainty.
    try { await control.started(assignment.id, build); }
    catch { abandon(); return 'abandoned'; }
    // Shutdown can arrive while the acknowledgement is in flight. A successful
    // reply does not restore this worker's authority to release the body.
    if (abort.signal.aborted) return 'abandoned';
    state = 'running';
    reporting = false;
    let result: { exitCode: number; logTail: string };
    try { await body.release(); result = await body.exited; }
    catch { result = { exitCode: 1, logTail: 'Worker body failed' }; }
    // Reap the entire process group before a terminal report can admit more work.
    await body.stop();
    reporting = true;
    await heartbeat;
    if (abort.signal.aborted) return 'abandoned';
    await control.finish(assignment.id, result.exitCode, result.logTail.slice(-16_384));
    return 'finished';
  } finally {
    dispose();
    input.signal.removeEventListener('abort', cancel);
    cancel();
    // Executor cancellation must settle build/exit; stop also reaps an already
    // exited process. Do not leave work behind when the worker loses authority.
    if (body) await body.stop();
    await heartbeat;
  }
}
