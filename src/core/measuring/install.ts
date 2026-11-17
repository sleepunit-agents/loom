import { z } from 'zod';
import type { approvalService } from '../../apps/approvals.js';
import { measuringValues } from './change.js';
/** Root-owned Measuring lifecycle on the household's shared connection. Its settings are
 * changed by a proposal (household.propose, change "measuring"); after an Allow
 * commits, the root calls refresh(). */
import type { Foundation } from '../app.js';
import type { DataDatabase } from '../data/database.js';
import { measuringRuntime } from './runtime.js';
import { measuringSettingsService } from './settings.js';
import { timingStore } from './store.js';

export type MeasuringHost = Pick<Foundation, 'operations' | 'onClose'> & { live: Pick<Foundation['live'], 'changed'> };
export async function installMeasuring(app: MeasuringHost, db: DataDatabase) {
  const settings = measuringSettingsService(db);
  let enabled = false;
  const store = timingStore(db);
  const runtime = measuringRuntime(settings.read, () => [
    ...app.operations.timingTargets(),
    ...['graphql', 'graphql.socket', 'api', 'mcp', 'web'].map(name => ({ kind: 'request' as const, name })),
    { kind: 'job', name: 'changes.read' }, { kind: 'job', name: 'secrets.reconcile' }, { kind: 'job', name: 'tempo.tick' }, { kind: 'job', name: 'runtime.tick' }, { kind: 'job', name: 'conversations.expire' },
  ], { add(row) { store.add(row); app.live.changed([{type:'measuring', id:'timing'}]); }, prune(beforeDay) { store.prune(beforeDay); app.live.changed([{type:'measuring', id:'timing'}]); } }, () => console.warn('Measuring could not record or export timings'), app.operations.clock);
  let signature = '';
  let generation = 0;
  let stopped = false;
  let pending = Promise.resolve();
  const reload = () => {
    if (stopped) return Promise.resolve();
    const ticket = ++generation;
    const current = settings.read();
    signature = JSON.stringify(current);
    enabled = false;
    pending = runtime.reload().then(() => { if (!stopped && ticket === generation) enabled = current.on; });
    return pending;
  };
  const refresh = () => stopped || JSON.stringify(settings.read()) === signature ? Promise.resolve() : reload();
  await reload();
  app.operations.measureWith(runtime);
  const close = () => { stopped = true; enabled = false; app.operations.measureWith(undefined); return runtime.close(); };
  app.onClose(() => { void close(); });
  return { ...runtime, reload, refresh, close, enabled: () => enabled,
    async settled() { await Promise.resolve(); await pending; } };
}
