/** Explicit daemon composition only. The supplied holder must already be the
 * authenticated transport (or a staging fixture). No discovery or activation. */
import type {Foundation} from '../../core/app.js';
import type {installAsyncSecretValues} from './async-values.js';

export function startSecretReconciliation(app: Foundation, recovery: ReturnType<typeof installAsyncSecretValues>, interval = 60_000) {
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('Invalid secret recovery interval');
  let stopped = false, running: Promise<void>|undefined, cancel: (()=>void)|undefined;
  const schedule = () => { if (!stopped) cancel = app.operations.clock.at(app.operations.clock.now()+interval,()=>{void run();}); };
  function run(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    cancel?.();
    running = (async()=>{try {await recovery.reconcilePending();} catch { /* Durable reservation remains; retry later without logging holder errors. */ }})()
      .finally(()=>{running=undefined;schedule();});
    return running;
  }
  const close = () => {stopped=true;cancel?.();recovery.close();};
  app.onClose(close);
  // At most one check per interval, even after a large clock advance. Restart
  // checks immediately; failed/negative evidence never releases the lock.
  cancel = app.operations.clock.at(app.operations.clock.now(),()=>{void run();});
  return {run,close};
}
