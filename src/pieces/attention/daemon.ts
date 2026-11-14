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
    const pending = app.operations.call('direct', { kind: 'service', id: 'attention' }, 'attention.pendingWaits', {});
    if (!pending.ok) console.warn(`Attention wait inventory failed (${pending.code})`);
    else for (const id of pending.value as string[]) {
      const result = app.operations.call('direct', { kind: 'service', id: 'attention' }, 'attention.checkWait', { id }, `attention-wait:${randomUUID()}`);
      if (!result.ok) console.warn(`Attention wait check failed (${result.code})`);
    }
    // No recurring inventory work while empty. A new/changed ask wakes it below.
    // Denied inventories keep retrying so restored grants recover without a page.
    if (!stopped && !cancel && (!pending.ok || (pending.value as string[]).length)) cancel = app.operations.clock.at(app.operations.clock.now() + 60_000, sweep);
  };
  cancel = app.operations.clock.at(app.operations.clock.now(), sweep);
  const observe = app.live.observe(changes => {
    if (!stopped && !cancel && changes.some(change => change.type === 'attention.ask')) cancel = app.operations.clock.at(app.operations.clock.now(), sweep);
  });
  app.onClose(() => { stopped = true; observe(); cancel?.(); stop(); });
}
