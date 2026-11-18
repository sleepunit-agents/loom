import { mergeTargetFor } from './merge-target.js';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { changes } from '../core/data/schema.js';
import type { approvalService } from './approvals.js';

/** Trusted shared application composition. The outside door authenticates the
 * answering member and checks visibility/authority before calling this function.
 * Both services must use this database connection. No GitHub writes happen here.
 */
export function changeAnswers(db: DataDatabase, approvals: ReturnType<typeof approvalService>) {
  return {
    answer(input: { change: string; head: string; approval: string; member: string; allow: boolean; basis?: string }) {
      return db.transaction(() => {
        const change = db.select().from(changes).where(eq(changes.id, input.change)).get();
        if (!change || change.state !== 'open') throw new Error('Change is no longer open');
        if (change.headCommit !== input.head) throw new Error('Change head has changed');
        const approval = approvals.get(input.approval);
        if (!change.agent || approval.agent !== change.agent || approval.kind !== 'merge'
          || approval.target !== mergeTargetFor(change.id, input.head) || approval.operation !== null
          || approval.project !== change.project) throw new Error('Approval does not match this change');
        const result = input.allow ? approvals.allow(approval.id, input.member, input.basis) : approvals.deny(approval.id, input.member, input.basis);
        // Preserve CI/reviewer/author blockers. Only an answer-blocked or
        // merge-ready copy changes groups; the reader will refresh GitHub facts.
        if (change.waitingOn === 'you' || change.waitingOn === 'agent') {
          db.update(changes).set({ waitingOn: input.allow ? 'agent' : 'you' }).where(eq(changes.id, change.id)).run();
        }
        return result;
      });
    },
  };
}
