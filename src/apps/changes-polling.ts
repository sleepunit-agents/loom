import type { Clock } from '../core/clock.js';
import type { changeService, PullRequestReader } from './changes.js';

type Changes = Pick<ReturnType<typeof changeService>, 'sync' | 'syncStatus'>;

/** Composition owns the reader and lifetime. No credentials, forge writes or
 * separate cache live here. A manual refresh shares any active scheduled read.
 */
export function pollChanges(service: Changes, read: PullRequestReader, clock: Clock, intervalMs = 60_000) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('Changes interval must be positive milliseconds');
  let stopped = false;
  let cancel: (() => void) | undefined;
  let active: ReturnType<Changes['sync']> | undefined;
  const arm = (at: number) => {
    cancel?.();
    if (!stopped) cancel = clock.at(at, () => { void refresh().catch(() => { /* sync records failure; next read is already armed */ }); });
  };
  const refresh = (): ReturnType<Changes['sync']> => {
    if (stopped) return Promise.reject(new Error('Changes poller is stopped'));
    if (active) return active;
    cancel?.(); cancel = undefined;
    const next = clock.now() + intervalMs;
    // Defer invocation so even a synchronously throwing injected reader/service
    // follows the same failure, coalescing and scheduling path.
    active = Promise.resolve().then(() => service.sync(read, new Date(next).toISOString())).finally(() => {
      active = undefined;
      // A slow network read must not cause a tight sequence of overdue polls.
      arm(next > clock.now() ? next : clock.now() + intervalMs);
    });
    return active;
  };
  const saved = Date.parse(service.syncStatus()?.nextAt ?? '');
  arm(Number.isFinite(saved) ? Math.max(clock.now(), saved) : clock.now());
  return {
    refresh,
    async stop() {
      stopped = true; cancel?.(); cancel = undefined;
      // Shutdown drains a read already in progress; a failed read is represented
      // by the service's persisted failed bit, rather than a shutdown failure.
      await active?.catch(() => {});
    },
  };
}
