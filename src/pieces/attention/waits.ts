import { statement } from '../../core/db/index.js';
/** Wait facts come from owning read roles under the operation's original viewer. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mayAct, maySee, operation as coreOperation, OperationError, type Db, type Operations, type Sharing, type Viewer, type Context } from '../../core/index.js';
import { operation } from './commands.js';
import type { Ask } from './role.js';

export interface AttentionWaits {
  /** Scoped facts for one synchronous sweep under its original viewer. */
  batch?(asks: readonly Ask[], viewer: Viewer): AttentionWaits;
  /** Undefined means absent, invisible or unavailable; never means gone. */
  approval?(id: string, viewer: Viewer): { state: string } | undefined;
  task?(id: string, viewer: Viewer): { status: string } | undefined;
  /** Only an owning role's matching, attributed answer since this ask. */
  taskAnswered?(id: string, ask: string, since: number, viewer: Viewer): boolean | undefined;
}
const approvalReasons: Readonly<Record<string, string>> = {
  allowed: 'the approval was allowed', used: 'the approval was allowed and used',
  denied: 'the approval was denied', expired: 'the approval was allowed, and expired unused',
  withdrawn: 'the approval was withdrawn unanswered (asked again with an up-to-date list)',
};
/** Shared with the single resolve operation; background work never bypasses it. */
export function canResolveAsk(ask: Ask, viewer: Viewer, sharing: Sharing): boolean {
  return !ask.privateQuestion && !ask.sourceManaged && mayAct(viewer, { type: 'attention.ask', ...ask }, sharing, 'act', 'attention.resolve');
}
export function resolveAsk(ctx: Context, ask: Ask, reason: string, save: (ask: Ask) => void): Ask {
  if (ask.state !== 'open') return ask;
  ask.state = 'resolved'; ask.changedAt = ctx.now; ask.resolution = reason;
  save(ask); ctx.changed('attention.ask', ask.id); return ask;
}
export function installWaitChecks(db: Db, operations: Operations, sharing: () => Sharing, waits: AttentionWaits) {
  const read = (id: string): Ask | undefined => {
    const row = statement(db, 'SELECT record FROM attention_asks WHERE id=?').get(id) as {record: string} | undefined;
    return row && JSON.parse(row.record) as Ask;
  };
  const reasonFor = (ask: Ask, viewer: Viewer, facts: AttentionWaits): string | undefined => {
    if (!ask.waits_on) return;
    try {
      if ('approval' in ask.waits_on) {
        const result = facts.approval?.(ask.waits_on.approval, viewer);
        return result && Object.hasOwn(approvalReasons, result.state) ? approvalReasons[result.state] : undefined;
      }
      const task = facts.task?.(ask.waits_on.task, viewer);
      if (task?.status === 'closed') return `${ask.waits_on.task} is closed`;
      if (task && ['open', 'in_progress'].includes(task.status) && facts.taskAnswered?.(ask.waits_on.task, ask.ask, ask.createdAt, viewer) === true) return `you answered it on ${ask.waits_on.task}`;
    } catch { /* Owning role unavailable: hold. */ }
  };
  operations.register(coreOperation({ name: 'attention.sweepWaits', doors: ['direct'], write: true,
    input: z.object({ after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict(), output: z.object({ pending: z.number(), resolved: z.number(), next: z.number().optional() }),
    may: viewer => mayAct(viewer, { type: 'attention.ask' }, sharing(), 'act', 'attention.sweepWaits')
      && mayAct(viewer, { type: 'attention.ask' }, sharing(), 'act', 'attention.pendingWaits'),
    run(ctx, input) {
      const held = sharing();
      // Bound raw inventory too: hidden, resolved and managed rows cannot make a turn unbounded.
      const rows = statement(db, 'SELECT rowid AS cursor, record FROM attention_asks WHERE rowid > ? ORDER BY rowid LIMIT 1001').all(input.after ?? 0) as { cursor: number; record: string }[];
      const page = rows.slice(0, 1000);
      const continuation = rows.length > 1000 ? { next: page[page.length - 1].cursor } : {};
      const pending = page
        .map(row => JSON.parse(row.record) as Ask)
        .filter(ask => ask.state === 'open' && !ask.sourceManaged && !!ask.waits_on && maySee(ctx.viewer, { type: 'attention.ask', ...ask }, held));
      const eligible = pending.filter(ask => !ask.privateQuestion && mayAct(ctx.viewer, { type: 'attention.ask', ...ask }, held, 'act', 'attention.checkWait')
        && canResolveAsk(ask, ctx.viewer, held));
      // No cross-operation cache: all facts and policy share this transaction.
      let facts: AttentionWaits;
      try { facts = waits.batch?.(eligible, ctx.viewer) ?? {}; } catch { return { pending: pending.length, resolved: 0, ...continuation }; }
      const save = statement(db, 'UPDATE attention_asks SET record=? WHERE id=?');
      let resolved = 0;
      for (const ask of eligible) {
        const reason = reasonFor(ask, ctx.viewer, facts);
        if (!reason) continue;
        resolveAsk(ctx, ask, reason, record => { save.run(JSON.stringify(record), record.id); }); resolved++;
      }
      return { pending: pending.length, resolved, ...continuation };
    },
  }));
  operations.register(operation({ name: 'attention.checkWait', write: true,
    input: z.object({ id: z.string().min(1).max(200) }).strict(), output: z.unknown(),
    may(viewer, input) {
      const ask = read(input.id);
      return !!ask && !ask.sourceManaged && mayAct(viewer, { type: 'attention.ask', ...ask }, sharing(), 'act', 'attention.checkWait');
    },
    run(ctx, input) {
      const ask = read(input.id)!;
      if (ask.state !== 'open' || !ask.waits_on) return ask;
      const reason = reasonFor(ask, ctx.viewer, waits);
      if (!reason) return ask;
      // Use the existing operation so policy, transaction, live changes and rollback stay central.
      const nestedId = createHash('sha256').update(`attention-check-wait:${ctx.receipt!.id}`).digest('hex');
      const resolved = operations.call('direct', ctx.viewer, 'attention.resolve', { id: ask.id, reason }, nestedId);
      if (!resolved.ok) throw new OperationError(resolved.code, resolved.message);
      return resolved.value;
    },
  }));
}
