/** Work command installation. The outside door supplies current authority;
 * these bindings never infer write permission from a readable projection. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
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
  change(viewer: Member, change: Readonly<ChangeRow>, approval: Readonly<Approval>): boolean;
}
const id = z.string().trim().min(1);
export function registerSharedWorkCommands(operations: Operations, db: DataDatabase,
  service: ReturnType<typeof approvalService>, authority: WorkAnswerAuthority) {
  const approval = (id: string) => db.select().from(approvals).where(eq(approvals.id, id)).get();
  const change = (id: string) => db.select().from(changes).where(eq(changes.id, id)).get();
  const answers = changeAnswers(db, service);
  const notify = (ctx: Context, id: string) => {
    ctx.changed('approvals', id); ctx.changed('approvalRecord', id); ctx.changed('inbox', id);
  };
  operations.register({ name: 'approvals.answer', write: true, recheckPolicy: true,
    input: z.object({ id, answer: z.enum(['allow', 'deny']) }).strict(), output: z.object({ id }).strict(),
    may(viewer, input) { const row = approval(input.id); return viewer.kind === 'member' && !!row && authority.approval(viewer, row); },
    run(ctx, input) {
      if (ctx.viewer.kind !== 'member') throw new OperationError('denied', 'A member is required');
      try { input.answer === 'allow' ? service.allow(input.id, ctx.viewer.id) : service.deny(input.id, ctx.viewer.id); }
      catch (error) {
        if (error instanceof Error && ['Approval is already answered', 'Approval cannot be denied now'].includes(error.message))
          throw new OperationError('conflict', 'This approval cannot be answered now. Open it again.');
        throw error;
      }
      notify(ctx, input.id); return { id: input.id };
    },
  });
  const currentHead = (input: { id: string; head: string }) => {
    if (change(input.id)?.headCommit !== input.head) throw new OperationError('conflict', 'The change head moved. Open it again.');
  };
  operations.register({ name: 'changes.answer', write: true, recheckPolicy: true,
    input: z.object({ id, head: z.string().regex(/^[0-9a-f]{40}$/), approval: id, answer: z.enum(['yes', 'no']) }).strict(), output: z.object({ id }).strict(),
    may(viewer, input) { const row = change(input.id), request = approval(input.approval); return viewer.kind === 'member' && !!row && !!request && authority.change(viewer, row, request); },
    validateReplay(_viewer, input) { currentHead(input); },
    run(ctx, input) {
      if (ctx.viewer.kind !== 'member') throw new OperationError('denied', 'A member is required');
      currentHead(input);
      try { answers.answer({ change: input.id, head: input.head, approval: input.approval, member: ctx.viewer.id, allow: input.answer === 'yes' }); }
      catch (error) {
        if (error instanceof Error && ['Change is no longer open', 'Change head has changed', 'Approval does not match this change', 'Approval is already answered', 'Approval cannot be denied now'].includes(error.message))
          throw new OperationError('conflict', 'The merge request changed. Open it again.');
        throw error;
      }
      notify(ctx, input.approval); ctx.changed('changes', input.id); return { id: input.id };
    },
  });
}
