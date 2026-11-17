/** Outside Tasks policy. Trusted taskService/dispatcher carry no policy.
 * Every decision here is the tasks rule from policy.ts, read for one task. */
import { eq } from 'drizzle-orm';
import { addressee, holds, inHousehold, namesCurrent, rules, type Viewer } from './policy.js';
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
  const labels = (task: Pick<TaskRow, 'project' | 'ownerKind' | 'owner'>): boolean =>
    !taskProjectRefusal(db, task.project) && holds(rules.task, viewer, task, sharing);
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
    case 'edit': return command.input.project === undefined || command.input.project === task.project ? labels(task) : mayMove(task, command.input.project);
    case 'link': case 'unlink': return !!visibleTask(command.dependsOn);
    case 'move': return command.before === null || !!visibleTask(command.before);
    // The person asked must be able to see the task themselves; someone removed sees nothing.
    case 'ask': return !!visibleTask(command.id, addressee(command.input.to.id));
    default: return true;
  }
}
