/** What two bodies on one worker cannot have at once, and whose turn it is.
 *
 * A worker runs several jobs side by side (`slots`). Two things are one body's at a time:
 *  - an **account**. A body is signed in to its job's account through files the provider's program
 *    rewrites when it renews (a sign-in directory mounted read-write, or the runner's own profile).
 *    Nothing makes two programs renewing one sign-in at once safe, so they are not run at once;
 *  - a **port** the job publishes on this machine: two containers cannot listen on one.
 *
 * A job takes its turn before its body is started and gives it up when the body has ended. A job that is
 * still building holds nothing. Turns are first come, first served, and a job takes everything it needs at
 * once or waits: it never holds one thing while it waits for another, so two jobs cannot wait on each other. */
import type { WorkerAssignment } from './worker.js';

export interface WorkerTurns {
  /** Wait until every one of these is free and no job that asked earlier wants any of them, then hold them.
   * Resolves to what gives them up; safe to call more than once. Rejects when the signal ends the wait. */
  take(keys: readonly string[], signal: AbortSignal): Promise<() => void>;
}
/** What a job's body needs to itself: its account, and every port it publishes, on whatever address. */
export const turnsOf = (job: Pick<WorkerAssignment, 'account' | 'run'>): string[] =>
  [...new Set([`account:${job.account}`, ...(job.run?.ports ?? []).map(({ port }) => `port:${port}`)])];

export function workerTurns(): WorkerTurns {
  const held = new Set<string>();
  const waiting: { keys: readonly string[]; go: () => void }[] = [];
  const grant = () => {
    // In the order they asked. One that must wait keeps its place: a later job wanting the same thing waits behind it.
    const wanted = new Set<string>();
    for (const waiter of [...waiting]) {
      if (waiter.keys.some(key => held.has(key) || wanted.has(key))) { for (const key of waiter.keys) wanted.add(key); continue; }
      waiting.splice(waiting.indexOf(waiter), 1);
      for (const key of waiter.keys) held.add(key);
      waiter.go();
    }
  };
  return {
    take(keys, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('Worker turn cancelled')); return; }
        const own = [...new Set(keys)];
        let given = false, done = false;
        const release = () => { if (!given || done) return; done = true; for (const key of own) held.delete(key); grant(); };
        const waiter = { keys: own, go: () => { given = true; signal.removeEventListener('abort', leave); resolve(release); } };
        const leave = () => { const at = waiting.indexOf(waiter); if (at >= 0) { waiting.splice(at, 1); reject(new Error('Worker turn cancelled')); grant(); } };
        signal.addEventListener('abort', leave, { once: true });
        waiting.push(waiter); grant();
      });
    },
  };
}
