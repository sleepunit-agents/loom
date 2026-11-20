/** One registered Tasks command for browser, CLI and other outside callers. */
import { eq } from 'drizzle-orm';
import { inbox } from './core/data/schema.js';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { type Operations, OperationError } from './core/operations/index.js';
import { taskCommandSchema, dispatchTaskCommand } from './apps/task-command.js';
import type { TaskService } from './apps/tasks.js';
import { strandedQuestion, taskCommandAllowed } from './shared-task-access.js';
import { canReadSharedConversation } from './shared-sharing.js';
import type { Viewer } from './policy.js';

/** `held` answers why this caller changes no task, in words for the caller: the body of a job on anybody else's word
 * (shared-place-mail.ts, heldRefusal). Every task change comes through this one command, so it is asked once here. What
 * such a body reads of tasks is what visibility gives its agent, as before. */
export function registerSharedTaskCommands(operations: Operations, db: DataDatabase, service: TaskService, held: (viewer: Viewer) => string | undefined = () => undefined) {
  operations.register({ name: 'tasks.command', write: true, recheckPolicy: true, refuses: true,
    input: taskCommandSchema, output: z.object({ id: z.string().optional(), moved: z.array(z.string()).optional() }).strict(),
    may: (viewer, command) => taskCommandAllowed(db, viewer, command, (actor, id) => canReadSharedConversation(db, actor, id)),
    run(ctx, command) {
      if (ctx.viewer.kind !== 'member' && ctx.viewer.kind !== 'agent') throw new OperationError('denied', 'A person or agent is required');
      const refused = held(ctx.viewer); if (refused) throw new OperationError('denied', refused);
      if (command.action === 'answer') {
        const question = db.select().from(inbox).where(eq(inbox.id, command.question)).get();
        if (question?.state !== 'waiting') throw new OperationError('conflict', 'This question has already been answered or replaced');
      }
      // A move the caller may make is still refused, in words, while it would strand a question.
      const stranded = strandedQuestion(db, command);
      if (stranded) throw new OperationError('conflict', stranded);
      const row = dispatchTaskCommand(service, command, ctx.viewer);
      // moveToProject answers with the tasks it moved; one already there is not among them.
      if (row && 'moved' in row) { for (const id of row.moved) ctx.changed('task', id); return { moved: row.moved }; }
      const id = row?.id ?? ('id' in command ? command.id : undefined);
      if (id) ctx.changed('task', id);
      if (command.action === 'link' || command.action === 'unlink') ctx.changed('task', command.dependsOn);
      return id ? { id } : {};
    },
  });
}
