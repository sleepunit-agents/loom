/** Next-mode metadata maintenance, using the installed Attention service only. */
import { randomUUID } from 'node:crypto';
import { isClosing, type Foundation } from '../../core/app.js';
import { startAttentionRetention } from './retention.js';

const running = new WeakSet<Foundation['operations']>();
export function installAttentionMaintenance(app: Foundation): void {
  if (running.has(app.operations)) return;
  running.add(app.operations);
  const caller = app.operations.internal('attention');
  const stop = startAttentionRetention(app.operations, caller.viewer, result => {
    // Never log records, inputs or a refusal's potentially private wording.
    if (!result.ok) console.warn(`Attention retention failed (${result.code})`);
  }, () => !isClosing(app));
  let stopped = false;
  let cancel: (() => void) | undefined;
  let after: number | undefined;
  let pending = 0;
  let dirty = false;
  let sweeping = false;
  const sweep = () => {
    if (stopped || isClosing(app)) return;
    cancel = undefined;
    sweeping = true;
    const result = app.operations.call('direct', { kind: 'service', id: 'attention' }, 'attention.sweepWaits', after === undefined ? {} : { after }, `attention-waits:${randomUUID()}`);
    sweeping = false;
    const page = result.ok ? result.value as { pending: number; next?: number } : undefined;
    pending += page?.pending ?? 0;
    after = page?.next;
    if (!result.ok) console.warn(`Attention wait sweep failed (${result.code})`);
    // Only cursor/count state crosses turns; owning-role facts and policy never do.
    if (after !== undefined) {
      if (!stopped) cancel = app.operations.clock.at(app.operations.clock.now(), sweep);
      return;
    }
    const again = !result.ok || pending > 0 || dirty;
    const delay = result.ok && dirty ? 0 : 60_000;
    pending = 0; dirty = false;
    if (!stopped && again) cancel = app.operations.clock.at(app.operations.clock.now() + delay, sweep);
  };
  cancel = app.operations.clock.at(app.operations.clock.now(), sweep);
  const observe = app.live.observe(changes => {
    if (stopped || isClosing(app) || !changes.some(change => change.type === 'attention.ask')) return;
    if (sweeping || after !== undefined) { dirty = true; return; }
    if (!cancel) cancel = app.operations.clock.at(app.operations.clock.now(), sweep);
  });
  app.onClose(() => { stopped = true; observe(); cancel?.(); stop(); });
}
