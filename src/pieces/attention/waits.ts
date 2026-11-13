/** Wait facts come from owning read roles under the operation's original viewer. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mayAct, OperationError, type Db, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { operation } from './commands.js';
import type { Ask } from './role.js';

export interface AttentionWaits {
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
export function installWaitChecks(db: Db, operations: Operations, sharing: () => Sharing, waits: AttentionWaits) {
  const read = (id: string): Ask | undefined => {
    const row = db.prepare('SELECT record FROM attention_asks WHERE id=?').get(id) as {record: string} | undefined;
    return row && JSON.parse(row.record) as Ask;
  };
  operations.register(operation({ name: 'attention.checkWait', write: true,
    input: z.object({ id: z.string().min(1).max(200) }).strict(), output: z.unknown(),
    may(viewer, input) {
      const ask = read(input.id);
      return !!ask && !ask.sourceManaged && mayAct(viewer, { type: 'attention.ask', ...ask }, sharing(), 'act', 'attention.checkWait');
    },
    run(ctx, input) {
      const ask = read(input.id)!;
      if (ask.state !== 'open' || !ask.waits_on) return ask;
      let reason: string | undefined;
      // A failed read holds the ask; no failure wording or foreign records escape.
      try {
        if ('approval' in ask.waits_on) {
          const result = waits.approval?.(ask.waits_on.approval, ctx.viewer);
          if (result && Object.hasOwn(approvalReasons, result.state)) reason = approvalReasons[result.state];
        } else {
          const task = waits.task?.(ask.waits_on.task, ctx.viewer);
          if (task?.status === 'closed') reason = `${ask.waits_on.task} is closed`;
          else if (task && ['open', 'in_progress'].includes(task.status) && waits.taskAnswered?.(ask.waits_on.task, ask.ask, ask.createdAt, ctx.viewer) === true) reason = `you answered it on ${ask.waits_on.task}`;
        }
      } catch { return ask; }
      if (!reason) return ask;
      // Use the existing operation so policy, transaction, live changes and rollback stay central.
      const nestedId = createHash('sha256').update(`attention-check-wait:${ctx.receipt!.id}`).digest('hex');
      const resolved = operations.call('direct', ctx.viewer, 'attention.resolve', { id: ask.id, reason }, nestedId);
      if (!resolved.ok) throw new OperationError(resolved.code, resolved.message);
      return resolved.value;
    },
  }));
}
