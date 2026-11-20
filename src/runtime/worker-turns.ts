/** What two bodies on one worker cannot have at once, and whose turn it is.
 *
 * A worker runs several jobs side by side (`slots`). Two things are one body's at a time:
 *  - an **account's sign-in for one harness**, beyond so many bodies at once (`accountSlots`). A body is
 *    signed in to its job's account through files the harness's program rewrites when it renews (a
 *    sign-in directory mounted read-write, or the runner's own profile): one set for each account and
 *    harness. Several bodies share them, as several sessions of one person do; two programs renewing at
 *    the same moment can leave one of them refused (docs/accepted-tradeoffs.md, "Two bodies on one
 *    account share one sign-in directory"). The limit is how many may run together, and each harness has
 *    its own; at 1 they never do;
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
const ACCOUNT = 'account:';
/** What a job's body needs to itself: its account's sign-in for its harness, and every port it publishes,
 * on whatever address. The harness comes first and holds no colon of its own in any name loom gives one. */
export const turnsOf = (job: Pick<WorkerAssignment, 'account' | 'harness' | 'run'>): string[] =>
  [...new Set([`${ACCOUNT}${job.harness}:${job.account}`, ...(job.run?.ports ?? []).map(({ port }) => `port:${port}`)])];
/** The harness an account's turn is for. */
const harnessOf = (key: string) => key.slice(ACCOUNT.length, Math.max(ACCOUNT.length, key.indexOf(':', ACCOUNT.length)));

/** @param room How many bodies may run on one account at once: one number, or one for each harness (the
 * worker's `accountSlots`; the defaults are the configuration's, not this file's). A port is always one body's. */
export function workerTurns(room: { accounts: number | ((harness: string) => number) }): WorkerTurns {
  const accounts = (harness: string) => {
    const count = typeof room.accounts === 'number' ? room.accounts : room.accounts(harness);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid account slots');
    return count;
  };
  if (typeof room.accounts === 'number') accounts('');
  /** How many bodies hold each thing now. */
  const held = new Map<string, number>();
  const full = (key: string) => (held.get(key) ?? 0) >= (key.startsWith(ACCOUNT) ? accounts(harnessOf(key)) : 1);
  const waiting: { keys: readonly string[]; go: () => void }[] = [];
  const grant = () => {
    // In the order they asked. One that must wait keeps its place: a later job wanting the same thing waits behind it.
    const wanted = new Set<string>();
    for (const waiter of [...waiting]) {
      if (waiter.keys.some(key => full(key) || wanted.has(key))) { for (const key of waiter.keys) wanted.add(key); continue; }
      waiting.splice(waiting.indexOf(waiter), 1);
      for (const key of waiter.keys) held.set(key, (held.get(key) ?? 0) + 1);
      waiter.go();
    }
  };
  return {
    take(keys, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('Worker turn cancelled')); return; }
        const own = [...new Set(keys)];
        let given = false, done = false;
        const release = () => {
          if (!given || done) return; done = true;
          for (const key of own) { const left = (held.get(key) ?? 1) - 1; if (left > 0) held.set(key, left); else held.delete(key); }
          grant();
        };
        const waiter = { keys: own, go: () => { given = true; signal.removeEventListener('abort', leave); resolve(release); } };
        const leave = () => { const at = waiting.indexOf(waiter); if (at >= 0) { waiting.splice(at, 1); reject(new Error('Worker turn cancelled')); grant(); } };
        signal.addEventListener('abort', leave, { once: true });
        waiting.push(waiter); grant();
      });
    },
  };
}
