import { eraseBootstrap, type BodyBootstrap } from './body-bootstrap.js';
import { WORKER_EXIT, type WorkerExitBy } from './job-exit.js';
import { CONTACT_PROBE_MS, REPORT_MS, SILENCE_MS, WORKER_FAILURE_OBSERVATION_MS } from './silence.js';
import { logTail } from './log-tail.js';
import { turnsOf, type WorkerTurns } from './worker-turns.js';
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
  /** On whose word the job works (shared-place-mail.ts, jobWord), read at claim from the mail the job is
   * offered: one asker's, since a job is formed for one asker's mail. Anybody else's holds the body to loom's tools (policy.ts, loomToolsOnly). Absent from
   * a loom older than this field, and then read as anybody else's: closed, not open. */
  word?: 'own' | 'owners' | 'others';
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
   * executor that cannot tell leaves it out. `signalled` is true when a signal ended it, so the code is
   * the executor's word for that (WORKER_EXIT.killed) and not the body's. */
  exited: Promise<{ exitCode: number; logTail: string; own?: boolean; signalled?: boolean }>;
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
  /** Told of a build this job was given and will never start a body from: the job was stopped, cancelled
   * or abandoned after `build` and before `start`. An executor that keeps something for a built job (an
   * image it will not remove meanwhile) lets go of it here. Not called once `start` has been called: what
   * the body held is let go when the body is stopped. */
  discard?(job: WorkerAssignment, build: string): void;
  /** Called once, before the worker takes any work: end every build and body a worker before this one
   * left running on this machine, and remove what they kept. A killed worker cannot stop its bodies, and
   * loom queues a lost job's work again; without this the same work would run twice side by side.
   * Rejects when something left could not be ended; the worker then does not start. `unverified` counts
   * what is still running and could not be shown to be a previous worker's, and so was left. */
  endLeft?(signal: AbortSignal): Promise<{ unverified: number }>;
  /** Give up what the executor holds for the life of the worker, when the worker stops in good order. */
  close?(): void;
}
export interface WorkerControl {
  /** Claims once on the server. An uncertain response is never retried locally. */
  next(): Promise<WorkerAssignment | undefined>;
  /** Private one-attempt input, never part of the assignment/receipt. */
  repositoryInput?(id:string,signal:AbortSignal):Promise<Uint8Array|undefined>;
  /** Parent generates raw bytes locally; the server receives only a fingerprint. */
  enrollBody?(id: string, signal: AbortSignal): Promise<BodyBootstrap>;
  started(id: string, build: string, signal?: AbortSignal): Promise<void>;
  /** false means revoked/stopped/lost: cease execution without a finish report. */
  heartbeat(id: string, state: 'starting' | 'running', signal?: AbortSignal): Promise<boolean>;
  /** `by` says whose code it is (job-exit.ts): this worker's own, or the program it ran. */
  finish(id: string, exitCode: number, logTail: string, by: WorkerExitBy): Promise<void>;
}
export interface WorkerSchedule {
  every(ms: number, callback: () => void): () => void;
}
const schedule: WorkerSchedule = {
  every(ms, callback) { const timer = setInterval(callback, ms); return () => clearInterval(timer); },
};
export type WorkerResult = 'idle' | 'finished' | 'abandoned';
/** Thrown by an executor for a job this worker is not configured to serve, for the reasons WORKER_EXIT.runner
 * lists (job-exit.ts). Reported as that code, apart from a build that failed. */
export class UnservedJobError extends Error {}
/** Thrown by an executor for a job whose house image does not meet the image contract. Reported as
 * WORKER_EXIT.house: the job fails and the worker goes on. */
export class UnmetHouseError extends Error {
  /** @param rule Which part of the image contract the image breaks: the name of one of its labels
   * (house-image.ts), or `VOLUME`. A name from the contract, never a path and never text from the image. */
  constructor(readonly rule: string) { super('House image does not meet the image contract'); }
}
/** Thrown by an executor for a job whose house was not fetched and built within the build limit. Reported
 * as WORKER_EXIT.buildTime: the job fails, with the reason that the build ran out of time. */
export class BuildTimeError extends Error {}
/** What a failed start says for a stage whose name alone would not say it. */
const STAGE_SAID: Partial<Record<keyof typeof WORKER_EXIT, string>> = {
  buildTime: 'the build ran out of time' };

/** One assignment per invocation, never a local launch retry. The server owns
 * start retries, terminal states and placement. While loom is unreachable the worker
 * gives a heartbeat one final second at the silence deadline. A late first failure cannot move
 * that deadline past the bounds of the last good reply, next pulse and first failed request.
 * A fresh positive heartbeat clears the outage. An explicit loss of authority cancels at once.
 * Only a body that could not be reaped throws.
 * A failed start is reported with the WORKER_EXIT code of the stage that failed.
 * A worker process can call again after this resolves, or run several independent
 * slots. Never call this from loom's server/composition root. */
export async function workOnce(input: {
  box: string; control: WorkerControl; executor: WorkerExecutor; signal: AbortSignal;
  schedule?: WorkerSchedule; heartbeatMs?: number;
  /** A clock that only goes forward, in milliseconds; a test names its own. */
  now?: () => number;
  /** Local observation when repeated unanswered heartbeats exhaust the grace period. */
  silenceExpired?: (elapsedMs: number) => void;
  /** Whose turn it is for what two bodies cannot have at once (worker-turns.ts), shared by every slot of
   * one worker. Left out, the job waits for nothing: right for a worker with one slot. */
  turns?: WorkerTurns;
}): Promise<WorkerResult> {
  const { control, executor } = input;
  const interval = input.heartbeatMs ?? REPORT_MS;
  if (!Number.isFinite(interval) || interval <= 0 || interval >= SILENCE_MS) throw new Error('Invalid worker heartbeat interval');
  if (input.signal.aborted) return 'abandoned';
  let job: WorkerAssignment | undefined;
  const now = input.now ?? (() => performance.now());
  let unreachableSince: number | undefined;
  // An unanswered poll may have claimed a job nobody will run; the sweep finds it. Nothing is running here.
  let lastDispatch = now();
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
  // What `build` gave this job, until `start` has been called with it: the executor is told if it never is.
  let unused: string | undefined;
  // What this job's body holds to itself (its account, its ports) from before it is started until it has ended.
  let giveUp = () => {};
  let reporting = false;
  let abandoned = false;
  let heartbeat: Promise<void> | undefined;
  const abandon = () => { abandoned = true; cancel(); };
  let probeTimer: ReturnType<typeof setTimeout>, expiryTimer: ReturnType<typeof setTimeout>;
  let beatAbort: AbortController | undefined;
  const deadline = () => Math.min(lastDispatch + SILENCE_MS + WORKER_FAILURE_OBSERVATION_MS, (unreachableSince ?? Infinity) + SILENCE_MS);
  const expire = () => {
    if (abandoned) return;
    abandon();
    input.silenceExpired?.(Math.floor(now() - (unreachableSince ?? lastDispatch)));
  };
  const expired = () => {
    if (now() < deadline() + CONTACT_PROBE_MS) return false;
    expire(); return true;
  };
  let probing = false;
  const arm = () => {
    probing = false;
    clearTimeout(probeTimer); clearTimeout(expiryTimer);
    const left = deadline() - now();
    probeTimer = setTimeout(() => {
      if (abort.signal.aborted || reporting) return;
      // A request dispatched while Loom was down can still be pending when it returns.
      pulse();
    }, Math.max(0, Math.ceil(left)));
    expiryTimer = setTimeout(() => { if (!abort.signal.aborted && !expired()) arm(); }, Math.max(0, Math.ceil(left + CONTACT_PROBE_MS)));
  };
  const pulse = () => {
    if (abort.signal.aborted || expired() || reporting || probing) return;
    const probe = now() >= deadline();
    if (probe) { probing = true; beatAbort?.abort(); }
    else if (heartbeat) return;
    const sent = now(), flight = new AbortController();
    beatAbort = flight;
    heartbeat = control.heartbeat(assignment.id, state, AbortSignal.any([abort.signal, flight.signal])).then(ok => {
      if (flight.signal.aborted || abort.signal.aborted) return;
      if (!ok) abandon();
      else if (!expired()) { lastDispatch = sent; unreachableSince = undefined; arm(); }
    }, () => {
      if (flight.signal.aborted || abort.signal.aborted) return;
      if (probe) { expire(); return; }
      if (unreachableSince === undefined) {
        unreachableSince = now();
        if (!expired()) arm();
      }
    }).finally(() => { if (beatAbort === flight) { heartbeat = undefined; beatAbort = undefined; } });
  };
  arm();
  const dispose = (input.schedule ?? schedule).every(interval, pulse);
  // The body has ended and been reaped, so a report loom did not answer leaves nothing to undo here.
  // The job goes silent and the sweep ends it; this worker goes on to its next poll.
  const report = async (exitCode: number, logTail: string, by: WorkerExitBy): Promise<WorkerResult> => {
    try { await control.finish(assignment.id, exitCode, logTail, by); return 'finished'; }
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
      // The executor's to hear of from here, whatever comes next: a cancel can land as the build is handed over.
      unused = build.trim() ? build : undefined;
      if (abort.signal.aborted) return 'abandoned';
      if (!build.trim()) throw new Error('Build returned no artifact');
      stage = 'launch';
      // Built: now the job waits its turn, reported as starting all the while. A Stop or a worker stop ends the wait.
      if (input.turns) giveUp = await input.turns.take(turnsOf(assignment), abort.signal);
      if (abort.signal.aborted) return 'abandoned';
      // From here the build is the executor's again, whether or not the start works.
      unused = undefined;
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
      if (error instanceof UnservedJobError) stage = 'runner';
      if (error instanceof UnmetHouseError) stage = 'house';
      if (error instanceof BuildTimeError) stage = 'buildTime';
      // Reap a partly launched process before allowing the server's start retry.
      if (body) await body.stop();
      giveUp();
      reporting = true;
      await heartbeat;
      if (abandoned || abort.signal.aborted) return 'abandoned';
      // The stage is named twice: the code survives where a private conversation's log tail is dropped.
      const said = error instanceof UnmetHouseError ? `the house image does not meet the image contract (${error.rule})` : STAGE_SAID[stage] ?? `${stage} failed`;
      return await report(WORKER_EXIT[stage], `Worker could not start the body: ${said}`, 'worker');
    }
    if (abort.signal.aborted) return 'abandoned';
    reporting = true;
    await heartbeat;
    if (abort.signal.aborted) return 'abandoned';
    // The HTTP control retries this report with one receipt. If it cannot establish that
    // the job is running, reap the body without releasing the brief or reporting a failed start.
    const startedAt = now();
    try { await control.started(assignment.id, build, abort.signal); if (expired()) return 'abandoned'; lastDispatch = startedAt; unreachableSince = undefined; arm(); }
    catch { abandon(); return 'abandoned'; }
    // Shutdown can arrive while the acknowledgement is in flight. A successful
    // reply does not restore this worker's authority to release the body.
    if (abort.signal.aborted) return 'abandoned';
    state = 'running';
    reporting = false;
    let result: { exitCode: number; logTail: string; signalled?: boolean }, failed: 'release' | 'reap' | undefined = 'release';
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
    // The body is gone: what it held is the next job's, without waiting for loom to answer this one's report.
    giveUp();
    reporting = true;
    await heartbeat;
    if (abort.signal.aborted) return 'abandoned';
    // A private body's output is never reported; the worker's own words about a failure are not the body's.
    // Whose code it is: the worker's own when it lost the body or a signal ended it. Otherwise the program's:
    // loom's body program is the one given a body's credential, anything else is the machine's own runner.
    const by = failed || result.signalled ? 'worker' : bootstrap ? 'body' : 'runner';
    return await report(result.exitCode, bootstrap && !failed ? '' : logTail(result.logTail), by);
  } finally {
    eraseBootstrap(bootstrap);
    clearTimeout(probeTimer!); clearTimeout(expiryTimer!);
    dispose();
    input.signal.removeEventListener('abort', cancel);
    cancel();
    // Executor cancellation must settle build/exit; stop also reaps an already
    // exited process. Do not leave work behind when the worker loses authority.
    if (body) await body.stop();
    if (unused !== undefined) executor.discard?.(assignment, unused);
    // Only once the body is known to have ended. One that could not be ended keeps what it held: the throw
    // above stops the worker, and nothing is started beside it meanwhile.
    giveUp();
    await heartbeat;
  }
}
