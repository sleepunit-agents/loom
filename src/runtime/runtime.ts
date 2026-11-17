/** The server's own part in the runtime: the periodic sweep for silent jobs and machines, and for jobs
 * queued past their deadline. Execution stays
 * in the separate worker program, and a worker's reports arrive as operations (shared-runtime.ts); the
 * root supplies post-commit Tempo/subscription callbacks and owns shutdown. */
import type { Clock } from '../core/clock.js';
import type { DataDatabase } from '../core/data/database.js';
import { Jobs, agentMailAdmission } from './jobs.js';
import { Machines } from './machines.js';
import { SILENCE_MS } from './silence.js';

export interface RuntimeOptions {
  /** Whatever else runs out of time and is closed on the same tick (an account sign-in nobody finished). */
  expire?(): void;
  /** Notify Tempo and live queries only after database transactions commit. */
  changed(): void;
  /** Feed TempoSources.job(id); it reads the committed terminal record. */
  jobEnded(id: string): void;
  /** The root reports errors; one failed sweep must not disable future checks. */
  error(error: unknown): void;
  sweepMs?: number;
}

export function createRuntime(db: DataDatabase, clock: Clock, options: RuntimeOptions) {
  const interval = options.sweepMs ?? 30_000;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('Invalid runtime sweep interval');
  const now = () => new Date(clock.now()).toISOString();
  const jobs = new Jobs(db, now), machines = new Machines(db, now);
  let started = false, closed = false;
  let cancel: (() => void) | undefined;
  const available = () => { if (closed) throw new Error('Runtime is closed'); };
  // Source notifications happen before admission: waiting mail can immediately
  // create a successor, but watchers must still see the job that just ended.
  const ended = (ids: readonly string[]) => {
    try { for (const id of ids) options.jobEnded(id); }
    finally { options.changed(); }
  };
  const admission = agentMailAdmission(jobs, options.changed);
  // Silence is judged by this server's clock, so the server must have been watching for the silence it
  // judges. A sweep that comes much later than it was due, or before the one that preceded it, means the
  // clock was stepped or the program stood still: every stamp then looks old (or new) at once, though
  // the workers may never have stopped reporting. After that nothing is called silent until they have
  // had one whole interval to report against the clock as it now is. The first sweep after a start is
  // not held back: what went silent while loom was down is found at once.
  let sweptAt: number | undefined, judgeFrom = -Infinity;
  const sweep = () => {
    available();
    const at = clock.now();
    if (sweptAt !== undefined && (at < sweptAt || at - sweptAt > interval + SILENCE_MS / 2)) judgeFrom = at + SILENCE_MS;
    sweptAt = at;
    const judge = at >= judgeFrom;
    const over = judge ? jobs.sweep() : [];
    // These services commit separately. Publish ended-job events even if the
    // machine notice pass fails, so a later tick need not rediscover them.
    try { try { if (judge) machines.sweep(); } finally { options.expire?.(); } }
    finally { ended(over.map(job => job.id)); }
  };
  const tick = () => {
    if (closed) return;
    try { sweep(); } catch (error) { options.error(error); }
    finally { if (!closed) cancel = clock.at(clock.now() + interval, tick); }
  };
  return {
    /** The same admission Tempo is installed with (shared-tempo.ts); here for callers that hold the runtime. */
    admit: ((who, items) => { available(); return admission(who, items); }) satisfies typeof admission,
    /** The same stop the owner's command makes (shared-job-control.ts), with the ended job published. */
    stop(job: string, member: string, reason: 'reset' | 'write-off') {
      available();
      const result = jobs.stop(job, member, reason);
      ended([result.id]);
      return result;
    },
    sweep,
    /** Install callbacks and Tempo first; recovery then reconciles offline jobs. */
    start() { available(); if (!started) { started = true; tick(); } },
    close() { if (closed) return; closed = true; cancel?.(); },
  };
}
