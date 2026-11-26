/** One registered Tasks command for browser, CLI and other outside callers. */
import { eq } from 'drizzle-orm';
import { inbox, tasks } from './core/data/schema.js';
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
  const draft = z.object({title:z.string().trim().min(1),goal:z.string().trim().min(1),why:z.string().trim().min(1),doneWhen:z.string().trim().min(1)}).strict();
  operations.register({name:'tasks.split',write:true,recheckPolicy:true,refuses:true,doors:['http'],
    input:z.object({parent:z.string().min(1),project:z.string().nullable(),drafts:z.array(draft).length(2)}).strict(),
    output:z.object({children:z.array(z.string())}).strict(),
    may(viewer,input) {
      if(viewer.kind!=='member') return false;
      const parent=db.select().from(tasks).where(eq(tasks.id,input.parent)).get();
      if(!parent || parent.project!==input.project) return false;
      return taskCommandAllowed(db,viewer,{action:'create',input:{...input.drafts[0],parent:input.parent,project:input.project,owner:{kind:'member',id:viewer.id}}},()=>false);
    },
    run(ctx,input) {
      if(ctx.viewer.kind!=='member') throw new OperationError('denied','Member approval required');
      const actor=ctx.viewer;
      const children=input.drafts.map(d=>service.create({...d,parent:input.parent,project:input.project,owner:actor},actor).id);
      service.comment(input.parent,'Approved split into '+children.join(' and '),actor);
      for(const id of [input.parent,...children]) ctx.changed('task',id);
      return {children};
    },
  });
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
