import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { agents, members, conversations } from '../data/schema.js';
import { approvalService } from '../../apps/approvals.js';
import { measuringSettingsProposals } from './proposal.js';
import { measuringValues } from './change.js';
import { MEASURING_SETTINGS_OPERATION } from './settings.js';
/** Root-owned Measuring lifecycle on the household's shared connection. */
import type { Foundation } from '../app.js';
import type { DataDatabase } from '../data/database.js';
import { measuringRuntime } from './runtime.js';
import { measuringSettingsService } from './settings.js';
import { timingStore } from './store.js';

export async function installMeasuring(app: Foundation, db: DataDatabase) {
  const settings = measuringSettingsService(db);
  let enabled = false;
  const proposals = measuringSettingsProposals(db);
  const approvals = approvalService(db, new Map([proposals.operation]), () => new Date(app.operations.clock.now()).toISOString());
  const owner = (viewer: { kind: string; id: string }) => viewer.kind === 'member' && db.select().from(members).where(eq(members.id, viewer.id)).get()?.role === 'owner';
  app.operations.register({
    name: 'measuring.propose', write: true, recheckPolicy: true,
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
  app.operations.register({
    name: 'measuring.answer', write: true, recheckPolicy: true,
    input: z.object({ id: z.string().min(1), allow: z.boolean() }).strict(), output: z.unknown(),
    may: viewer => owner(viewer),
    run(ctx, input) {
      const card = approvals.get(input.id);
      if (card.operation !== MEASURING_SETTINGS_OPERATION) throw new Error('Not a Measuring card');
      const result = input.allow ? approvals.allow(input.id, ctx.viewer.id) : approvals.deny(input.id, ctx.viewer.id);
      ctx.changed('measuring', input.id); return result;
    },
    after() { queueMicrotask(() => { void refresh().catch(() => console.warn('Measuring settings could not reload')); }); },
  });
  const store = timingStore(db);
  const runtime = measuringRuntime(settings.read, [
    ...app.operations.timingTargets(),
    ...['graphql', 'api', 'mcp', 'web'].map(name => ({ kind: 'request' as const, name })),
    { kind: 'job', name: 'changes.read' },
  ], { add(row) { store.add(row); app.live.changed([{type:'measuring', id:'timing'}]); }, prune: store.prune }, () => console.warn('Measuring could not record or export timings'), app.operations.clock);
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
  return { ...runtime, reload, close, enabled: () => enabled,
    async settled() { await Promise.resolve(); await pending; } };
}
