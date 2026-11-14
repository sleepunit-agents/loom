/** Next-mode metadata maintenance, using the installed Attention service only. */
import { randomUUID } from 'node:crypto';
import type { Ask } from './role.js';
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
    // This piece owns these rows. Owning operations recheck every service grant
    // and dependency scope; private asks never enter the unattended work list.
    const asks = (app.db.prepare('SELECT record FROM attention_asks').all() as { record: string }[])
      .map(row => JSON.parse(row.record) as Ask)
      .filter(ask => ask.state === 'open' && !ask.sourceManaged && ask.member === undefined && ask.waits_on);
    for (const ask of asks) {
      const result = app.operations.call('direct', { kind: 'service', id: 'attention' }, 'attention.checkWait', { id: ask.id }, `attention-wait:${randomUUID()}`);
      if (!result.ok) console.warn(`Attention wait check failed (${result.code})`);
    }
    if (!stopped) cancel = app.operations.clock.at(app.operations.clock.now() + 60_000, sweep);
  };
  cancel = app.operations.clock.at(app.operations.clock.now(), sweep);
  app.onClose(() => { stopped = true; cancel?.(); stop(); });
}
