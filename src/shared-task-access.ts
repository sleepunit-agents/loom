/** Outside Tasks policy. Trusted taskService/dispatcher carry no policy.
 * Every decision here is the tasks rule from policy.ts, read for one task. */
import { and, eq } from 'drizzle-orm';
import { holds, inHousehold, mayBeAskedAbout, namesCurrent, rules, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { tasks, inbox } from './core/data/schema.js';
import type { TaskCommand } from './apps/task-command.js';
import { taskProjectRefusal, type TaskRow } from './apps/tasks.js';

export function taskCommandAllowed(db: DataDatabase, viewer: Viewer, command: TaskCommand,
  conversationVisible: (viewer: Viewer, id: string) => boolean): boolean {
  const sharing = sharedSharing(db);
  if (!inHousehold(viewer, sharing)) return false;
  const visibleTask = (id: string, who: Viewer = viewer) => {
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row && holds(rules.task, who, row, sharing) ? row : undefined;
  };
  // The labels a task would carry: its project must be one in use (apps/tasks.ts, `taskProjectRefusal`), and the
  // task so labelled must be one the caller sees.
  // A new task enters its project, which must be in use. A task edited where it is stands: retired will do.
  const labels = (task: Pick<TaskRow, 'project' | 'ownerKind' | 'owner'>, use: 'enter' | 'stand' = 'enter'): boolean =>
    !taskProjectRefusal(db, task.project, use) && holds(rules.task, viewer, task, sharing);
  if (command.action === 'create') {
    const input = command.input, person = input.owner;
    // A new task's owner must be in the household now: someone removed owns nothing new.
    if (person.kind !== 'household' && !namesCurrent(person.kind, person.id, sharing)) return false;
    return labels({ project: input.project ?? null, ownerKind: person.kind, owner: person.kind === 'household' ? null : person.id })
      && (!input.parent || !!visibleTask(input.parent))
      && (!input.source || (input.source.kind === 'conversation' && conversationVisible(viewer, input.source.id)));
  }
  // A move to another project, however it is asked for. The destination must be a project in use, as a new
  // task's must, and the task must be one this caller may move there (policy.ts, rule `moveTask`).
  const mayMove = (row: TaskRow | undefined, to: string | null): boolean =>
    !!row && !taskProjectRefusal(db, to) && holds(rules.moveTask, viewer, { ...row, to }, sharing);
  // Every task named must pass: one that does not, or is not there, refuses them all.
  if (command.action === 'moveToProject') return command.ids.every(id => mayMove(db.select().from(tasks).where(eq(tasks.id, id)).get(), command.project));
  const task = visibleTask(command.id);
  if (!task) return false;
  switch (command.action) {
    case 'answer': {
      const question = db.select().from(inbox).where(eq(inbox.id, command.question)).get();
      return !!question && holds(rules.answers, viewer, question, sharing)
        && question.source === 'task' && question.waitsOnKind === 'task' && question.waitsOnId === command.id;
    }
    // An edit that names another project is that same move. Any other edit leaves the labels as they are.
    case 'edit': return command.input.project === undefined || command.input.project === task.project ? labels(task, 'stand') : mayMove(task, command.input.project);
    case 'link': case 'unlink': return !!visibleTask(command.dependsOn);
    case 'move': return command.before === null || !!visibleTask(command.before);
    // The person asked must be able to read the task themselves (policy.ts, `mayBeAskedAbout`); someone removed reads nothing.
    case 'ask': return mayBeAskedAbout(command.input.to.id, task, sharing);
    default: return true;
  }
}

/** Why a move, or an edit that moves, cannot be made as things stand though the caller may make it: a task
 * named carries an unanswered question for a person who could not read the task where it is going
 * (policy.ts, `mayBeAskedAbout`, the rule a new question is held to). Nothing when the move may go ahead.
 * The words name nobody: a question put in someone's own thread is not the mover's to learn of. */
export function strandedQuestion(db: DataDatabase, command: TaskCommand): string | undefined {
  const moves = command.action === 'moveToProject' ? command.ids.map(id => ({ id, to: command.project }))
    : command.action === 'edit' && command.input.project !== undefined ? [{ id: command.id, to: command.input.project }] : [];
  if (!moves.length) return undefined;
  const sharing = sharedSharing(db);
  for (const { id, to } of moves) {
    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task || task.project === to) continue;
    const waiting = db.select({ to: inbox.to }).from(inbox).where(and(eq(inbox.waitsOnKind, 'task'), eq(inbox.waitsOnId, id), eq(inbox.toKind, 'person'), eq(inbox.state, 'waiting'))).all();
    if (waiting.some(question => !mayBeAskedAbout(question.to, { ...task, project: to }, sharing)))
      return `Task ${id} has an unanswered question for someone who could not read it there. Have it answered, or put the question to someone who can, first`;
  }
  return undefined;
}
