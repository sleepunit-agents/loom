/** Next-mode metadata maintenance, using the installed Attention service only. */
import { randomUUID } from 'node:crypto';
import type { Foundation } from '../../core/app.js';
import { startAttentionRetention } from './retention.js';

const running = new WeakSet<Foundation['operations']>();
export function installAttentionMaintenance(app: Foundation): void {
  if (running.has(app.operations)) return;
  running.add(app.operations);
  const stop = startAttentionRetention(app.operations, { kind: 'service', id: 'attention' }, result => {
    // Never log records, inputs or a refusal's potentially private wording.
    if (!result.ok) console.warn(`Attention retention failed (${result.code})`);
  });
  let stopped = false;
  let cancel: (() => void) | undefined;
  const sweep = () => {
    if (stopped) return;
    cancel = undefined;
    const result = app.operations.call('direct', { kind: 'service', id: 'attention' }, 'attention.sweepWaits', {}, `attention-waits:${randomUUID()}`);
    if (!result.ok) console.warn(`Attention wait sweep failed (${result.code})`);
    // Empty inventories stop until a live change wakes the daemon.
    if (!stopped && !cancel && (!result.ok || (result.value as { pending: number }).pending)) cancel = app.operations.clock.at(app.operations.clock.now() + 60_000, sweep);
  };
  cancel = app.operations.clock.at(app.operations.clock.now(), sweep);
  const observe = app.live.observe(changes => {
    if (!stopped && !cancel && changes.some(change => change.type === 'attention.ask')) cancel = app.operations.clock.at(app.operations.clock.now(), sweep);
  });
  app.onClose(() => { stopped = true; observe(); cancel?.(); stop(); });
}
