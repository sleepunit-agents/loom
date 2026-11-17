import { z } from 'zod';
import { taskCreateSchema, taskEditSchema, taskAskSchema, taskLinkType } from './tasks.js';
import type { NewTask, TaskActor, TaskLinkType, TaskRow, TaskService } from './tasks.js';

/** Intent from the shared Tasks form. Identity is supplied separately by root. */
export type TaskCommand =
  | { action: 'create'; input: NewTask }
  | { action: 'edit'; id: string; input: Parameters<TaskService['edit']>[1] }
  | { action: 'claim' | 'unclaim' | 'reopen'; id: string }
  | { action: 'close'; id: string; reason: string }
  | { action: 'move'; id: string; before: string | null }
  /** The same action name, told apart by what it carries: one task and a place in the order (above), or
   * tasks and the project they go to. */
  | { action: 'move'; ids: string[]; project: string | null }
  | { action: 'comment'; id: string; text: string }
  | { action: 'link' | 'unlink'; id: string; dependsOn: string; type: TaskLinkType }
  | { action: 'answer'; id: string; question: string; answer: 'yes' | 'no' | 'words'; text?: string }
  | { action: 'ask'; id: string; input: Parameters<TaskService['ask']>[1] };

const id = z.string().trim().min(1);
const relation = { id, dependsOn: id, type: taskLinkType };
/** How many tasks one move may name. */
export const TASK_MOVE_MAX = 500;
const moveToProject = z.object({ action: z.literal('move'), ids: z.array(id).min(1).max(TASK_MOVE_MAX), project: id.nullable() }).strict();
const single = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), input: taskCreateSchema }).strict(),
  z.object({ action: z.literal('edit'), id, input: taskEditSchema }).strict(),
  z.object({ action: z.literal('claim'), id }).strict(),
  z.object({ action: z.literal('unclaim'), id }).strict(),
  z.object({ action: z.literal('reopen'), id }).strict(),
  z.object({ action: z.literal('close'), id, reason: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal('move'), id, before: id.nullable() }).strict(),
  z.object({ action: z.literal('comment'), id, text: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal('link'), ...relation }).strict(),
  z.object({ action: z.literal('unlink'), ...relation }).strict(),
  z.object({ action: z.literal('answer'), id, question: id, answer: z.enum(['yes','no','words']), text: z.string().optional() }).strict(),
  z.object({ action: z.literal('ask'), id, input: taskAskSchema }).strict(),
]);
/** Outside-door input validation; identity is never part of the command. `move` has two shapes: to a place
 * in the hand-kept order (`id`, `before`), and to a project (`ids`, `project`). Each is strict, so a
 * command is one or the other and never a mix. */
export const taskCommandSchema = z.union([single, moveToProject]);

/** Trusted dispatcher, not an outside door. Root validates the envelope, resolves
 * the current actor/access (including related records), and wraps this call in
 * its write/receipt transaction. Notify shared readers only after that commits.
 * No transport, retry, authorization decision or receipt is introduced here.
 */
export function dispatchTaskCommand(service: TaskService, command: TaskCommand, actor: TaskActor): TaskRow | { moved: string[] } | void {
  switch (command.action) {
    case 'create': return service.create(command.input, actor);
    case 'edit': return service.edit(command.id, command.input);
    case 'claim': return service.claim(command.id, actor);
    case 'unclaim': return service.unclaim(command.id);
    case 'reopen': return service.reopen(command.id);
    case 'close': return service.close(command.id, command.reason);
    case 'move': return 'ids' in command ? { moved: service.moveToProject(command.ids, command.project, actor) } : service.move(command.id, command.before);
    case 'comment': return service.comment(command.id, command.text, actor);
    case 'link': return service.link(command.id, command.dependsOn, command.type);
    case 'unlink': return service.unlink(command.id, command.dependsOn, command.type);
    case 'answer': return service.answer(command.id, command.answer, command.text ?? '', actor);
    case 'ask': return service.ask(command.id, command.input, actor);
    default: {
      const invalid: never = command;
      throw new Error('Unknown task command');
    }
  }
}
