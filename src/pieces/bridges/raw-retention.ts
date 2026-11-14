/** Local expiry of raw words, including unreachable receiving identities.
 * Never retires a binding, cursor, tombstone, normalized receipt or Runtime job.
 * Logical SQLite erasure only; in-flight attempts may already hold a copy. */
import { isClosing, type Foundation } from '../../core/app.js';
const HOUR = 3_600_000;
const MINUTE = 60_000;
const running = new WeakSet<Foundation['db']>();
export function installBridgeRawRetention(app: Foundation): void {
  if (running.has(app.db)) return;
  running.add(app.db);
  const clock = app.operations.clock;
  let stopped = false, cancel: (() => void) | undefined;
  const expire = app.db.transaction(() => {
    const cutoff = clock.now() - HOUR;
    // At most 64 rows per platform per pass, oldest first. Preserve ids and
    // immutable receipt ages so a repeated platform event cannot renew its life.
    for (const platform of ['discord', 'slack']) {
      app.db.prepare(`UPDATE bridges_${platform}_receipts SET event=NULL,state='consumed'
        WHERE id IN (SELECT id FROM bridges_${platform}_receipts
          WHERE state='pending' AND received<? ORDER BY received,id LIMIT 64)`).run(cutoff);
    }
  });
  const sweep = () => {
    if (stopped || isClosing(app)) return;
    try {
      if (app.db.inTransaction) throw Error('Raw expiry requires its own transaction');
      expire();
    } catch { console.warn('Bridges raw receipt retention failed'); }
    if (!stopped && !isClosing(app)) cancel = clock.at(clock.now() + MINUTE, () => {
      cancel = undefined;
      // Coalesce missed ticks; do not drain an unbounded backlog in one turn.
      queueMicrotask(sweep);
    });
  };
  app.onClose(() => { stopped = true; cancel?.(); });
  sweep();
}
