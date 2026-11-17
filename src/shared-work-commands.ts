/** Work command installation. A current household owner answers permission cards
 * (workAnswersAllowed); there is no narrower rule per card or per change, because an
 * owner already sees every change. What is checked beyond that is that the card and
 * the change it names still exist; the exact head is checked when the answer runs. */
import { COMMIT, parseMergeTarget } from './apps/merge-target.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { workAnswersAllowed } from './shared-work-access.js';
import type { DataDatabase } from './core/data/database.js';
import { approvals, changes } from './core/data/schema.js';
import { type Operations, type Context, OperationError } from './core/operations/index.js';
import type { approvalService, Approval } from './apps/approvals.js';
import { changeAnswers } from './apps/changes-answers.js';
import { readsRepository, type ChangeRow } from './apps/changes.js';

const id = z.string().trim().min(1);
export function registerSharedWorkCommands(operations: Operations, db: DataDatabase,
  service: ReturnType<typeof approvalService>) {
  const approval = (id: string) => db.select().from(approvals).where(eq(approvals.id, id)).get();
  const change = (id: string) => db.select().from(changes).where(eq(changes.id, id)).get();
  const answers = changeAnswers(db, service);
  const mergeTarget = (row: Approval) => {
    if (row.kind !== 'merge') return;
    const target = parseMergeTarget(row.target);
    if (!target) throw new OperationError('conflict', 'The merge request changed. Open it again.');
    // For a repository loom does not read there is no change to hold the card to: it is answered on its words.
    return readsRepository(db, target.repository) ? { id: target.change, head: target.head } : undefined;
  };
  const currentHead = (input: { id: string; head: string }) => {
    if (change(input.id)?.headCommit !== input.head) throw new OperationError('conflict', 'The change head moved. Open it again.');
  };
  const answerMerge = (ctx: Context, input: { id: string; head: string; approval: string; allow: boolean }) => {
    if (ctx.viewer.kind !== 'member') throw new OperationError('denied', 'A member is required');
    // A no is always possible. When the pull request has moved on, closed or gone,
    // there is nothing left to compare the card with: deny the card itself.
    const row = change(input.id);
    if (!input.allow && (!row || row.state !== 'open' || row.headCommit !== input.head)) {
      try { service.deny(input.approval, ctx.viewer.id); }
      catch (error) { if (error instanceof Error && ['Approval is already answered', 'Approval cannot be denied now'].includes(error.message)) throw new OperationError('conflict', 'This approval cannot be answered now. Open it again.'); throw error; }
      ctx.changed('approvals', input.approval); if (row) ctx.changed('changes', input.id);
      return;
    }
    currentHead(input);
    try { answers.answer({ change: input.id, head: input.head, approval: input.approval, member: ctx.viewer.id, allow: input.allow }); }
    catch (error) {
      if (error instanceof Error && ['Change is no longer open', 'Change head has changed', 'Approval does not match this change', 'Approval is already answered', 'Approval cannot be denied now'].includes(error.message))
        throw new OperationError('conflict', 'The merge request changed. Open it again.');
      throw error;
    }
    // DataWrites publishes all audit/Inbox effects in this same transaction.
    ctx.changed('approvals', input.approval); ctx.changed('changes', input.id);
  };
  operations.register({ name: 'approvals.answer', write: true, recheckPolicy: true,
    input: z.object({ id, answer: z.enum(['allow', 'deny']), confirm: z.literal(true).optional() }).strict(), output: z.object({ id }).strict(),
    may(viewer, input) {
      const row = approval(input.id);
      if (!workAnswersAllowed(db, viewer) || !row) return false;
      const merge = mergeTarget(row);
      // A yes to a merge needs its change to still be here; a no is always possible.
      return !merge || input.answer === 'deny' || !!change(merge.id);
    },
    validateReplay(_viewer, input) {
      const row = approval(input.id);
      if (!row) throw new OperationError('conflict', 'The approval changed. Open it again.');
      const merge = mergeTarget(row); if (merge && input.answer !== 'deny') currentHead(merge);
    },
    run(ctx, input) {
      if (ctx.viewer.kind !== 'member') throw new OperationError('denied', 'A member is required');
      const row = approval(input.id);
      if (!row) throw new OperationError('conflict', 'The approval changed. Open it again.');
      // A dangerous action cannot be put back, so allowing one takes a second, explicit yes.
      if (row.kind === 'dangerous' && input.answer === 'allow' && input.confirm !== true)
        throw new OperationError('invalid', 'This cannot be undone. To allow it, answer again with confirm set to true.');
      const merge = mergeTarget(row);
      if (merge) answerMerge(ctx, { ...merge, approval: row.id, allow: input.answer === 'allow' });
      else {
        try { input.answer === 'allow' ? service.allow(input.id, ctx.viewer.id) : service.deny(input.id, ctx.viewer.id); }
        catch (error) {
          if (error instanceof Error && ['Approval is already answered', 'Approval cannot be denied now'].includes(error.message))
            throw new OperationError('conflict', 'This approval cannot be answered now. Open it again.');
          throw error;
        }
        ctx.changed('approvals', input.id);
      }
      return { id: input.id };
    },
  });
  operations.register({ name: 'changes.answer', write: true, recheckPolicy: true,
    input: z.object({ id, head: z.string().regex(COMMIT), approval: id, answer: z.enum(['yes', 'no']) }).strict(), output: z.object({ id }).strict(),
    may(viewer, input) {
      const request = approval(input.approval);
      return workAnswersAllowed(db, viewer) && !!request && !!change(input.id);
    },
    validateReplay(_viewer, input) { currentHead(input); },
    run(ctx, input) {
      answerMerge(ctx, { ...input, allow: input.answer === 'yes' });
      return { id: input.id };
    },
  });
}
