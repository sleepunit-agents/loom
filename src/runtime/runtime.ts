/** Trusted runtime composition. Execution stays in the separate worker program;
 * the root supplies post-commit Tempo/subscription callbacks and owns shutdown. */
import type { Clock } from '../core/clock.js';
import type { DataDatabase } from '../core/data/database.js';
import type { AdmitInbox } from '../core/tempo/settle.js';
import { Dispatcher } from './dispatcher.js';
import type { ModelRole } from './placement.js';

export interface RuntimeOptions {
  roles(): readonly ModelRole[];
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
  const dispatcher = new Dispatcher(db, () => new Date(clock.now()).toISOString(), options.roles);
  let started = false, closed = false;
  let cancel: (() => void) | undefined;
  const available = () => { if (closed) throw new Error('Runtime is closed'); };
  // Source notifications happen before admission: waiting mail can immediately
  // create a successor, but watchers must still see the job that just ended.
  const ended = (ids: readonly string[]) => {
    try { for (const id of ids) options.jobEnded(id); }
    finally { options.changed(); }
  };
  const admit: AdmitInbox = (who, items) => {
    available();
    if (who.kind !== 'agent') return false;
    const conversations = new Set(items.filter(item => item.toKind === 'agent' && item.to === who.id)
      .flatMap(item => item.conversation ? [item.conversation] : []));
    // Each conversation gets its own job, even when one settled recipient group
    // contains mail from several places. Jobs.admit is durable/idempotent.
    let admitted = 0;
    for (const id of conversations) if (dispatcher.jobs.admit(id)) admitted++;
    if (admitted) options.changed();
    return admitted > 0 && admitted === conversations.size;
  };
  const sweep = () => {
    available();
    const lost = dispatcher.jobs.sweep();
    // These services commit separately. Publish lost-job events even if the
    // machine notice pass fails, so a later tick need not rediscover the loss.
    try { dispatcher.machines.sweep(); }
    finally { ended(lost.map(job => job.id)); }
  };
  const tick = () => {
    if (closed) return;
    try { sweep(); } catch (error) { options.error(error); }
    finally { if (!closed) cancel = clock.at(clock.now() + interval, tick); }
  };
  return {
    admit,
    next(box: string) {
      available();
      try { return dispatcher.next(box); }
      finally { options.changed(); }
    },
    started(box: string, job: string, build: string) {
      available();
      try { return dispatcher.started(box, job, build); }
      finally { options.changed(); }
    },
    heartbeat(box: string, job: string, state: 'starting' | 'running') {
      available();
      try { return dispatcher.heartbeat(box, job, state); }
      finally { options.changed(); }
    },
    finish(box: string, job: string, exitCode: number, logTail: string) {
      available();
      const result = dispatcher.finish(box, job, exitCode, logTail);
      ended([result.job.id]);
      return result;
    },
    stop(job: string, member: string, reason: 'reset' | 'write-off') {
      available();
      const result = dispatcher.jobs.stop(job, member, reason);
      ended([result.id]);
      return result;
    },
    sweep,
    /** Install callbacks and Tempo first; recovery then reconciles offline jobs. */
    start() { available(); if (!started) { started = true; tick(); } },
    close() { if (closed) return; closed = true; cancel?.(); },
  };
}
