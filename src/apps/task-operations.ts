/** Tasks installed on the shared operation door; no transport or policy copy. */
import { z } from 'zod';
import { operation, type Operations } from '../core/operations/index.js';
import type { DataDatabase } from '../core/data/database.js';
import type { Viewer } from '../policy.js';
import { taskCommandAllowed } from '../shared-task-access.js';
import { taskCommandSchema, dispatchTaskCommand } from './task-command.js';
import type { TaskService } from './tasks.js';

export function installTaskCommands(operations: Operations, db: DataDatabase, service: TaskService,
  conversationVisible: (viewer: Viewer, id: string) => boolean) {
  operations.register(operation({
    name: 'tasks.command', write: true, recheckPolicy: true,
    input: taskCommandSchema, output: z.object({ id: z.string().optional() }).strict(),
    may: (viewer, command) => taskCommandAllowed(db, viewer, command, conversationVisible),
    run(ctx, command) {
      if (ctx.viewer.kind !== 'member' && ctx.viewer.kind !== 'agent') throw new Error('Task actor required');
      const result = dispatchTaskCommand(service, command, { kind: ctx.viewer.kind, id: ctx.viewer.id });
      const id = result?.id ?? (command.action === 'create' ? undefined : command.id);
      if (id) ctx.changed('tasks', id);
      if (command.action === 'comment') ctx.changed('taskComments', command.id);
      if (command.action === 'link' || command.action === 'unlink' || (command.action === 'create' && command.input.parent)) ctx.changed('taskLinks', id!);
      if (command.action === 'ask' || command.action === 'close' || command.action === 'reopen') ctx.changed('inbox', id!);
      return id ? { id } : {};
    },
  }));
}
