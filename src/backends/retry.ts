/**
 * SQLITE_BUSY retry ladder with exponential backoff + jitter.
 *
 * better-sqlite3 is synchronous; these retries are synchronous too.
 * Atomics.wait() provides a blocking sleep without busy-spinning — available
 * on the main thread in Node >= 22 (our minimum engine requirement).
 *
 * Reference design: Memori core/src/storage/manager.rs::write_batch —
 * retries SQLSTATE 40001 with exponential backoff + up to 50% jitter,
 * folding commit() into the retried result. t-326.
 */

export interface RetryWriteOptions {
  /** Maximum number of attempts (including the first). Default: 5. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry; doubles each round. Default: 10. */
  baseMs?: number;
}

/**
 * Run fn(), retrying on SQLITE_BUSY with exponential back-off + up-to-50%
 * random jitter. Any other error is rethrown immediately. SQLITE_BUSY after
 * all attempts are exhausted is also rethrown.
 *
 * Delays: attempt 1→2 = baseMs, 2→3 = baseMs*2, … each + [0, delay*0.5)
 * jitter. With defaults (maxAttempts=5, baseMs=10ms): 10, 20, 40, 80ms
 * before each retry (plus jitter), worst-case ~220ms total wait.
 */
export function retryWrite<T>(fn: () => T, opts?: RetryWriteOptions): T {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const baseMs = opts?.baseMs ?? 10;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      if (isSqliteBusy(err)) {
        lastErr = err;
        if (attempt < maxAttempts - 1) {
          const delay = baseMs * Math.pow(2, attempt);
          const jitter = delay * Math.random() * 0.5;
          sleepMs(Math.round(delay + jitter));
        }
        continue;
      }
      // Non-SQLITE_BUSY errors propagate immediately — never retry them.
      throw err;
    }
  }
  // Exhausted all attempts — rethrow the last SQLITE_BUSY.
  throw lastErr;
}

function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as NodeJS.ErrnoException;
  // better-sqlite3 sets .code = 'SQLITE_BUSY' on lock-contention errors.
  return e.code === 'SQLITE_BUSY' || e.message.includes('SQLITE_BUSY');
}

/** Synchronous sleep using Atomics.wait — blocks the thread without busy-spinning. */
export function sleepMs(ms: number): void {
  if (ms <= 0) return;
  // Node >= 22 allows Atomics.wait on the main thread; SharedArrayBuffer is
  // available without flags. This is the canonical sync sleep in Node.js.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
