/** Work command installation. Current household owners answer permission cards;
 * optional trusted callbacks may narrow this rule, never broaden it. A configured
 * callback must return literal true; every other value denies. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { workAnswersAllowed } from './shared-work-access.js';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { approvals, changes } from './core/data/schema.js';
import { type Operations, type Context, OperationError } from './core/operations/index.js';
import type { approvalService, Approval } from './apps/approvals.js';
import { changeAnswers } from './apps/changes-answers.js';
import type { ChangeRow } from './apps/changes.js';

type Member = Extract<Viewer, { kind: 'member' }>;
export interface WorkAnswerAuthority {
  approval(viewer: Member, approval: Readonly<Approval>): boolean;
  /** Additional gate on the current PR, used by both merge-answer doors. */
  change(viewer: Member, change: Readonly<ChangeRow>, approval: Readonly<Approval>): boolean;
}
const id = z.string().trim().min(1);
export function registerSharedWorkCommands(operations: Operations, db: DataDatabase,
  service: ReturnType<typeof approvalService>, authority?: WorkAnswerAuthority) {
  const approval = (id: string) => db.select().from(approvals).where(eq(approvals.id, id)).get();
  const change = (id: string) => db.select().from(changes).where(eq(changes.id, id)).get();
  const answers = changeAnswers(db, service);
  const mergeTarget = (row: Approval) => {
    if (row.kind !== 'merge') return;
    const match = /^(github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9][0-9]*)@([0-9a-f]{40})$/.exec(row.target);
    if (!match) throw new OperationError('conflict', 'The merge request changed. Open it again.');
    return { id: match[1], head: match[2] };
  };
  const currentHead = (input: { id: string; head: string }) => {
    if (change(input.id)?.headCommit !== input.head) throw new OperationError('conflict', 'The change head moved. Open it again.');
  };
  const mayMerge = (viewer: Member, request: Approval, id: string) => {
    const row = change(id);
    return !!row && (!authority || authority.change(viewer, row, request) === true);
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
      if (!workAnswersAllowed(db, viewer) || !row || (authority && authority.approval(viewer, row) !== true)) return false;
      const merge = mergeTarget(row);
      return !merge || input.answer === 'deny' || mayMerge(viewer, row, merge.id);
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
    input: z.object({ id, head: z.string().regex(/^[0-9a-f]{40}$/), approval: id, answer: z.enum(['yes', 'no']) }).strict(), output: z.object({ id }).strict(),
    may(viewer, input) {
      const request = approval(input.approval);
      return workAnswersAllowed(db, viewer) && !!request && (!authority || authority.approval(viewer, request) === true) && mayMerge(viewer, request, input.id);
    },
    validateReplay(_viewer, input) { currentHead(input); },
    run(ctx, input) {
      answerMerge(ctx, { ...input, allow: input.answer === 'yes' });
      return { id: input.id };
    },
  });
}
