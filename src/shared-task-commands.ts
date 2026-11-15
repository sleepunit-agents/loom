/** One registered Tasks command for browser, CLI and other outside callers. */
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { type Operations, OperationError } from './core/operations/index.js';
import { taskCommandSchema, dispatchTaskCommand } from './apps/task-command.js';
import type { TaskService } from './apps/tasks.js';
import { taskCommandAllowed } from './shared-task-access.js';
import { canReadSharedConversation } from './shared-sharing.js';

export function registerSharedTaskCommands(operations: Operations, db: DataDatabase, service: TaskService) {
  operations.register({ name: 'tasks.command', write: true, recheckPolicy: true,
    input: taskCommandSchema, output: z.object({ id: z.string().optional() }).strict(),
    may: (viewer, command) => taskCommandAllowed(db, viewer, command, (actor, id) => canReadSharedConversation(db, actor, id)),
    run(ctx, command) {
      if (ctx.viewer.kind !== 'member' && ctx.viewer.kind !== 'agent') throw new OperationError('denied', 'A person or agent is required');
      const row = dispatchTaskCommand(service, command, ctx.viewer);
      const id = row?.id ?? ('id' in command ? command.id : undefined);
      if (id) ctx.changed('task', id);
      if (command.action === 'link' || command.action === 'unlink') ctx.changed('task', command.dependsOn);
      return id ? { id } : {};
    },
  });
}
