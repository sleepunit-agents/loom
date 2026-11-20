/** Private local retention is independent of platform connections and staging.
 * Reads already enforce exact expiry; this job reclaims expired rows on startup
 * and hourly. Logical deletion only, not forensic SQLite/WAL erasure. */
import { isClosing, type Foundation } from '../../core/app.js';
import { bridgeFileStore } from './file-store.js';
const HOUR = 3600_000;
const running = new WeakSet<Foundation['db']>();
export function installBridgeFileRetention(app: Foundation): void {
  if (running.has(app.db)) return;
  running.add(app.db);
  const clock = app.operations.clock;
  const files = bridgeFileStore(app.db, () => clock.now());
  let stopped = false;
  let cancel: (() => void) | undefined;
  const sweep = () => {
    if (stopped || isClosing(app)) return;
    try { files.prune(); }
    catch { console.warn('Bridges attachment retention failed'); }
    if (!stopped && !isClosing(app)) {
      cancel = clock.at(clock.now() + HOUR, () => {
        cancel = undefined;
        // Resume from the current clock after a suspension/large advance rather
        // than synchronously replaying every missed hourly tick.
        queueMicrotask(sweep);
      });
    }
  };
  app.onClose(() => { stopped = true; cancel?.(); });
  sweep();
}
