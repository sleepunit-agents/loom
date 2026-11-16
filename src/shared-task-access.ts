/** Outside Tasks policy. Trusted taskService/dispatcher carry no policy. */
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { agents, members, memberAgents, projects, tasks, inbox } from './core/data/schema.js';
import { taskVisibility } from './core/data/visibility.js';
import type { TaskCommand } from './apps/task-command.js';
import type { TaskRow } from './apps/tasks.js';

export function taskCommandAllowed(db: DataDatabase, viewer: Viewer, command: TaskCommand,
  conversationVisible: (viewer: Viewer, id: string) => boolean): boolean {
  if (viewer.kind !== 'member' && viewer.kind !== 'agent') return false;
  const actor = viewer.kind === 'member' ? db.select().from(members).where(eq(members.id, viewer.id)).get()
    : db.select().from(agents).where(eq(agents.id, viewer.id)).get();
  if (!actor) return false;
  const owner = viewer.kind === 'member' && 'role' in actor && actor.role === 'owner';
  const visibleTask = (id: string, who: Viewer = viewer) => db.select().from(tasks)
    .where(and(eq(tasks.id, id), taskVisibility(who).tasks!(getTableColumns(tasks)))).get();
  const labels = (task: Pick<TaskRow, 'project' | 'ownerKind' | 'owner'>): boolean => {
    if (task.project) return !!db.select().from(projects).where(and(eq(projects.id, task.project), sql`(${taskVisibility(viewer).projects!(getTableColumns(projects))})`)).get();
    if (owner) return true;
    if (task.ownerKind === 'member') return viewer.kind === 'member' && task.owner === viewer.id;
    if (task.ownerKind !== 'agent' || !task.owner) return false;
    return viewer.kind === 'agent' ? task.owner === viewer.id : !!db.select().from(memberAgents)
      .where(and(eq(memberAgents.agent, task.owner), eq(memberAgents.member, viewer.id))).get();
  };
  if (command.action === 'create') {
    const input = command.input, person = input.owner;
    if (person.kind === 'member' && !db.select().from(members).where(eq(members.id, person.id)).get()) return false;
    if (person.kind === 'agent' && !db.select().from(agents).where(eq(agents.id, person.id)).get()) return false;
    return labels({ project: input.project ?? null, ownerKind: person.kind, owner: person.kind === 'household' ? null : person.id })
      && (!input.parent || !!visibleTask(input.parent))
      && (!input.source || (input.source.kind === 'conversation' && conversationVisible(viewer, input.source.id)));
  }
  const task = visibleTask(command.id);
  if (!task) return false;
  switch (command.action) {
    case 'answer': {
      const question = db.select().from(inbox).where(eq(inbox.id, command.question)).get();
      return viewer.kind === 'member' && !!question && question.toKind === 'person' && question.to === viewer.id
        && question.source === 'task' && question.waitsOnKind === 'task' && question.waitsOnId === command.id;
    }
    case 'edit': return labels({ ...task, project: command.input.project === undefined ? task.project : command.input.project });
    case 'link': case 'unlink': return !!visibleTask(command.dependsOn);
    case 'move': return command.before === null || !!visibleTask(command.before);
    case 'ask': return !!db.select().from(members).where(eq(members.id, command.input.to.id)).get()
      && !!visibleTask(command.id, { kind: 'member', id: command.input.to.id });
    default: return true;
  }
}
