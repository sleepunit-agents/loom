import type { NewTask, TaskActor, TaskRow, TaskService } from './tasks.js';

/** Intent from the shared Tasks form. Identity is supplied separately by root. */
export type TaskCommand =
  | { action: 'create'; input: NewTask }
  | { action: 'edit'; id: string; input: Parameters<TaskService['edit']>[1] }
  | { action: 'claim' | 'unclaim' | 'reopen'; id: string }
  | { action: 'close'; id: string; reason: string }
  | { action: 'comment'; id: string; text: string }
  | { action: 'link' | 'unlink'; id: string; dependsOn: string; type: 'blocks' | 'parent-child' }
  | { action: 'ask'; id: string; input: Parameters<TaskService['ask']>[1] };

/** Trusted dispatcher, not an outside door. Root validates the envelope, resolves
 * the current actor/access (including related records), and wraps this call in
 * its write/receipt transaction. Notify shared readers only after that commits.
 * No transport, retry, authorization decision or receipt is introduced here.
 */
export function dispatchTaskCommand(service: TaskService, command: TaskCommand, actor: TaskActor): TaskRow | void {
  switch (command.action) {
    case 'create': return service.create(command.input, actor);
    case 'edit': return service.edit(command.id, command.input);
    case 'claim': return service.claim(command.id, actor);
    case 'unclaim': return service.unclaim(command.id);
    case 'reopen': return service.reopen(command.id);
    case 'close': return service.close(command.id, command.reason);
    case 'comment': return service.comment(command.id, command.text, actor);
    case 'link': return service.link(command.id, command.dependsOn, command.type);
    case 'unlink': return service.unlink(command.id, command.dependsOn, command.type);
    case 'ask': return service.ask(command.id, command.input, actor);
    default: {
      const invalid: never = command;
      throw new Error('Unknown task command');
    }
  }
}
