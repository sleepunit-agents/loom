/** Next-mode metadata maintenance, using the installed Attention service only. */
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
  app.onClose(stop);
}
