import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { agents, members, conversations } from '../data/schema.js';
import type { approvalService } from '../../apps/approvals.js';
import { measuringSettingsProposals } from './proposal.js';
import { measuringValues } from './change.js';
/** Root-owned Measuring lifecycle on the household's shared connection.
 * A settings change is only proposed here. It is answered like any other card,
 * through the Approvals service the root passes in, whose operation map must
 * hold measuringSettingsProposals(db).operation. After an Allow commits, the
 * root calls refresh(). */
import type { Foundation } from '../app.js';
import type { DataDatabase } from '../data/database.js';
import { measuringRuntime } from './runtime.js';
import { measuringSettingsService } from './settings.js';
import { timingStore } from './store.js';

export type MeasuringHost = Pick<Foundation, 'operations' | 'onClose'> & { live: Pick<Foundation['live'], 'changed'> };
export async function installMeasuring(app: MeasuringHost, db: DataDatabase, approvals: Pick<ReturnType<typeof approvalService>, 'request'>) {
  const settings = measuringSettingsService(db);
  let enabled = false;
  const proposals = measuringSettingsProposals(db);
  const owner = (viewer: { kind: string; id: string }) => viewer.kind === 'member' && db.select().from(members).where(eq(members.id, viewer.id)).get()?.role === 'owner';
  app.operations.register({
    name: 'measuring.propose', doors: ['http', 'direct'], write: true, recheckPolicy: true,
    input: z.object({ after: measuringValues, agent: z.string().min(1), conversation: z.string().min(1).optional(), why: z.string().trim().min(1) }).strict(), output: z.unknown(),
    may: (viewer, input) => !!db.select().from(agents).where(eq(agents.id, input.agent)).get() &&
      (owner(viewer) || viewer.kind === 'agent' && viewer.id === input.agent) &&
      (!input.conversation || db.select().from(conversations).where(eq(conversations.id, input.conversation)).get()?.agent === input.agent),
    run(ctx, input) {
      const thread = input.conversation ? db.select().from(conversations).where(eq(conversations.id, input.conversation)).get() : undefined;
      const card = proposals.request(approvals, input.after, { agent: input.agent,
        conversation: thread?.id, project: thread?.project, member: thread?.member,
        askedFrom: 'loom', actingFor: owner(ctx.viewer) ? ctx.viewer.id : 'unknown', why: input.why });
      ctx.changed('measuring', card.id); return card;
    },
  });
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
