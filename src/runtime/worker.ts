import { eraseBootstrap, type BodyBootstrap } from './body-bootstrap.js';
import { WORKER_EXIT } from './job-exit.js';
import { REPORT_MS, SILENCE_MS } from './silence.js';
/** Work-plane execution only. Loom's control plane supplies a claimed assignment;
 * builds and bodies run through the executor in the separate worker program. */
export interface WorkerRunPolicy {
  /** Stored tool patterns; the configured runner applies always/guest rules. */
  deniedTools: { pattern: string; guestsOnly: boolean }[];
  /** Only senders for this job, not the agent's whole people configuration. */
  people: { kind: 'person' | 'outside' | 'unknown'; person: string | null; tier: 1 | 2 | 3 | null }[];
  /** The inbox items `people` was read from, at claim. Mail the body takes that is not among them arrived
   * later and its sender was never looked up. Absent from a loom older than this field. */
  mail?: string[];
}
export interface WorkerRunOptions {
  policy?: WorkerRunPolicy;
  nestedContainers: boolean;
  gpu: boolean;
  ports: { address: string; port: number }[];
}
export interface WorkerAssignment {
  id: string;
  box: string;
  agent: string;
  conversation: string | null;
  /** Current Comms reply surface, when present; not an authority witness. */
  thread?: string | null;
  /** Saved conversation venue for selecting a receiving adapter; not authority. */
  venue?: string | null;
  model: string;
  account: string;
  /** How many accounts of this job's provider are signed in on this machine, the placed one included.
   * With more than one, a worker that has one command for the harness cannot hold the job to the placed
   * account, and refuses it (workerRunner). Absent from a loom older than this field. */
  accountChoices?: number;
  harness: string;
  brief: string;
  /** Current agent configuration at claim; absent means no extra capabilities. */
  run?: WorkerRunOptions;
  house: { repository: string; file: string; branch: string };
}
export interface WorkerBody {
  /** Resolves only after the child has actually spawned, rejects on launch failure. */
  spawned: Promise<void>;
  /** `own` is true when the body ended by itself with this code, and not because it was killed. An
   * executor that cannot tell leaves it out. */
  exited: Promise<{ exitCode: number; logTail: string; own?: boolean }>;
  /** Releases the brief only after loom acknowledges running. */
  /** Only explicit fixed-child adapters receive a private credential. */
  acceptsBootstrap?: boolean;
  release(bootstrap?: BodyBootstrap): Promise<void>;
  /** Must stop and reap every child belonging to this attempt. Idempotent. `exited` settles once this has. */
  stop(): Promise<void>;
}
export interface WorkerExecutor {
  build(job: WorkerAssignment, signal: AbortSignal, repositoryInput?: Uint8Array): Promise<string>;
  start(job: WorkerAssignment, build: string, signal: AbortSignal): WorkerBody;
}
export interface WorkerControl {
  /** Claims once on the server. An uncertain response is never retried locally. */
  next(): Promise<WorkerAssignment | undefined>;
  /** Private one-attempt input, never part of the assignment/receipt. */
  repositoryInput?(id:string,signal:AbortSignal):Promise<Uint8Array|undefined>;
  /** Parent generates raw bytes locally; the server receives only a fingerprint. */
  enrollBody?(id: string, signal: AbortSignal): Promise<BodyBootstrap>;
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
/** Thrown by an executor for a job this worker has no command for: no runner for its harness, or none it
 * can hold to the placed account. Reported as WORKER_EXIT.runner, apart from a build that failed. */
export class NoRunnerError extends Error {}

/** One assignment per invocation, never a local launch retry. The server owns
 * start retries, terminal states and placement. Transport uncertainty aborts the
 * attempt; the server's silence sweep reconciles it, rather than duplicate work.
 * That holds for every report: a poll or a finish that loom did not answer ends this
 * attempt as abandoned, never the worker. Only a body that could not be reaped throws.
 * A failed start is reported with the WORKER_EXIT code of the stage that failed.
 * A worker process can call again after this resolves, or run several independent
 * slots. Never call this from loom's server/composition root. */
export async function workOnce(input: {
  box: string; control: WorkerControl; executor: WorkerExecutor; signal: AbortSignal;
  schedule?: WorkerSchedule; heartbeatMs?: number;
}): Promise<WorkerResult> {
  const { control, executor } = input;
  const interval = input.heartbeatMs ?? REPORT_MS;
  if (!Number.isFinite(interval) || interval <= 0 || interval >= SILENCE_MS) throw new Error('Invalid worker heartbeat interval');
  if (input.signal.aborted) return 'abandoned';
  let job: WorkerAssignment | undefined;
  // An unanswered poll may have claimed a job nobody will run; the sweep finds it. Nothing is running here.
  try { job = await control.next(); } catch { return 'abandoned'; }
  if (!job) return 'idle';
  if (job.box !== input.box) throw new Error('Assignment belongs to another worker');
  // Snapshot input before giving asynchronous adapters control of it.
  const assignment = structuredClone(job);
  const abort = new AbortController();
  let bootstrap: BodyBootstrap | undefined;
  const cancel = () => { eraseBootstrap(bootstrap); abort.abort(); };
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
  // The body has ended and been reaped, so a report loom did not answer leaves nothing to undo here.
  // The job goes silent and the sweep ends it; this worker goes on to its next poll.
  const report = async (exitCode: number, logTail: string): Promise<WorkerResult> => {
    try { await control.finish(assignment.id, exitCode, logTail); return 'finished'; }
    catch { return 'abandoned'; }
  };
  try {
    let build: string;
    let stage: keyof typeof WORKER_EXIT = 'input';
    try {
      if (abort.signal.aborted) return 'abandoned';
      const repositoryInput=await control.repositoryInput?.(assignment.id,abort.signal);
      stage = 'build';
      try {
        if(abort.signal.aborted)return 'abandoned';
        build = repositoryInput?await executor.build(assignment,abort.signal,repositoryInput):await executor.build(assignment,abort.signal);
      } finally { repositoryInput?.fill(0); }
      if (abort.signal.aborted) return 'abandoned';
      if (!build.trim()) throw new Error('Build returned no artifact');
      stage = 'launch';
      body = executor.start(assignment, build, abort.signal);
      // Attach a handler immediately: a fast exit may precede spawned/started.
      void body.exited.catch(() => {});
      await body.spawned;
      if (body.acceptsBootstrap) {
        stage = 'enroll';
        if (!control.enrollBody) throw new Error('Body enrollment unavailable');
        bootstrap = await control.enrollBody(assignment.id, abort.signal);
      }
    } catch (error) {
      if (abort.signal.aborted) return 'abandoned';
      if (error instanceof NoRunnerError) stage = 'runner';
      // Reap a partly launched process before allowing the server's start retry.
      if (body) await body.stop();
      reporting = true;
      await heartbeat;
      if (abandoned || abort.signal.aborted) return 'abandoned';
      // The stage is named twice: the code survives where a private conversation's log tail is dropped.
      return await report(WORKER_EXIT[stage], `Worker could not start the body: ${stage} failed`);
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
    let result: { exitCode: number; logTail: string }, failed: 'release' | 'reap' | undefined = 'release';
    try {
      try { if (bootstrap) await body.release(bootstrap); else await body.release(); }
      finally { eraseBootstrap(bootstrap); }
      failed = 'reap';
      result = await body.exited;
      failed = undefined;
    }
    catch {
      result = { exitCode: WORKER_EXIT[failed!], logTail: `Worker lost the body: ${failed} failed` };
      // Input cannot be handed to a body that has already ended, and a body that ended before reading its
      // input did so for a reason of its own (its arguments, its body file). That reason is the one to
      // record: once the body is reaped, a non-zero exit it made by itself replaces the worker's code.
      if (failed === 'release') {
        await body.stop();
        const ended = await body.exited.catch(() => undefined);
        if (ended?.own && ended.exitCode !== 0) { result = ended; failed = undefined; }
      }
    }
    // Reap the entire process group before a terminal report can admit more work.
    await body.stop();
    reporting = true;
    await heartbeat;
    if (abort.signal.aborted) return 'abandoned';
    // A private body's output is never reported; the worker's own words about a failure are not the body's.
    return await report(result.exitCode, bootstrap && !failed ? '' : result.logTail.slice(-16_384));
  } finally {
    eraseBootstrap(bootstrap);
    dispose();
    input.signal.removeEventListener('abort', cancel);
    cancel();
    // Executor cancellation must settle build/exit; stop also reaps an already
    // exited process. Do not leave work behind when the worker loses authority.
    if (body) await body.stop();
    await heartbeat;
  }
}
