import { setTimeout as delay } from 'node:timers/promises';
import { workOnce, type WorkerControl, type WorkerExecutor, type WorkerResult } from './worker.js';
import type { WorkerTurns } from './worker-turns.js';
/** One worker slot; a worker runs several of these side by side (worker-program.ts, `slots`). Every attempt settles and reaps before another claim.
 * Uncertain assignments back off. An exception (including failed process
 * cleanup) stops the slot; it must never admit work after uncertain reaping. */
export async function runWorker(input: {
  box: string; control: WorkerControl; executor: WorkerExecutor; signal: AbortSignal;
  idleMs?: number; pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  once?: typeof workOnce; report?: (result: WorkerResult) => void;
  /** Shared by every slot of one worker: see workOnce. */
  turns?: WorkerTurns;
}): Promise<void> {
  const idleMs = input.idleMs ?? 5_000;
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 60_000) throw new Error('Invalid worker idle interval');
  const pause = input.pause ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  while (!input.signal.aborted) {
    const result = await (input.once ?? workOnce)(input);
    input.report?.(result);
    if (input.signal.aborted) return;
    if (result !== 'finished') {
      try { await pause(idleMs, input.signal); }
      catch (error) { if (!input.signal.aborted) throw error; }
    }
  }
}
