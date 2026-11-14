import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../core/data/database.js';
import { tasks, taskComments, taskLinks } from '../core/data/schema.js';

const person = z.object({ kind: z.enum(['member', 'agent']), id: z.string().trim().min(1) });
export type TaskActor = z.infer<typeof person>;
const summary = {
  title: z.string().trim().min(1), goal: z.string().trim().min(1), why: z.string().trim().min(1),
  doneWhen: z.string(), description: z.string(), priority: z.number().int().min(0).max(4),
  project: z.string().min(1).nullable(),
};
const create = z.object({
  ...summary, doneWhen: summary.doneWhen.default(''), description: summary.description.default(''),
  priority: summary.priority.default(2), project: summary.project.default(null),
  type: z.enum(['task', 'bug', 'feature', 'epic']).default('task'),
  owner: z.discriminatedUnion('kind', [person.extend({ kind: z.literal('member') }), person.extend({ kind: z.literal('agent') }), z.object({ kind: z.literal('household') })]),
  source: z.object({ kind: z.string().min(1), id: z.string().min(1) }).optional(),
  parent: z.string().min(1).optional(),
});
export type NewTask = z.input<typeof create>;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskDetail = TaskRow & { comments: (typeof taskComments.$inferSelect)[]; links: (typeof taskLinks.$inferSelect)[] };
export interface TaskService {
  create(input: NewTask, actor: TaskActor): TaskRow;
  get(id: string): TaskDetail;
  ready(): TaskRow[];
  list(status?: TaskRow['status']): TaskRow[];
  edit(id: string, input: Partial<Pick<TaskRow, keyof typeof summary>>): TaskRow;
  claim(id: string, actor: TaskActor): TaskRow;
  unclaim(id: string): TaskRow;
  close(id: string, reason: string): TaskRow;
  reopen(id: string): TaskRow;
  comment(id: string, text: string, actor: TaskActor): void;
  link(id: string, dependsOn: string, type: 'blocks' | 'parent-child'): void;
  unlink(id: string, dependsOn: string, type: 'blocks' | 'parent-child'): void;
  ask(id: string, input: { to: TaskActor; ask: string; ifYes: string; ifNo: string; answers?: 'yes-no' | 'words' }, actor: TaskActor): TaskRow;
  answer(id: string, answer: 'yes' | 'no' | 'words', text: string, actor: TaskActor): TaskRow;
}

/** Trusted application operations. The outside door owns visibility and authorization.
 * Every write is atomic; all facts live in the approved shared tables. No importer,
 * alternate database, record JSON or background process is involved.
 */
export function taskService(db: DataDatabase, now: () => string = () => new Date().toISOString()): TaskService {
  const row = (id: string): TaskRow => {
    const found = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!found) throw new Error('Task not found');
    return found;
  };
  const touch = (id: string, patch: Partial<typeof tasks.$inferInsert>) => {
    row(id);
    db.update(tasks).set({ ...patch, changedAt: now() }).where(eq(tasks.id, id)).run();
    return row(id);
  };
  const addComment = (id: string, text: string, actor: TaskActor) => {
    person.parse(actor); row(id);
    z.string().trim().min(1).parse(text);
    const seq = db.select({ n: sql<number>`coalesce(max(${taskComments.seq}), 0) + 1` }).from(taskComments).where(eq(taskComments.task, id)).get()!.n;
    db.insert(taskComments).values({ task: id, seq, actorKind: actor.kind, actor: actor.id, at: now(), text }).run();
    touch(id, {});
  };
  const link = (id: string, dependsOn: string, type: 'blocks' | 'parent-child') => {
    z.enum(['blocks', 'parent-child']).parse(type); row(id); row(dependsOn);
    if (id === dependsOn) throw new Error('A task cannot depend on itself');
    // Reject cycles of the same relationship; parents and blockers have independent meaning.
    const seen = new Set<string>(), pending = [dependsOn];
    while (pending.length) {
      const next = pending.pop()!;
      if (next === id) throw new Error('Task dependency would form a cycle');
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...db.select({ id: taskLinks.dependsOn }).from(taskLinks).where(and(eq(taskLinks.task, next), eq(taskLinks.type, type))).all().map(r => r.id));
    }
    db.insert(taskLinks).values({ task: id, dependsOn, type }).onConflictDoNothing().run();
    // A second parent must not silently replace the first.
    if (type === 'parent-child' && !db.select().from(taskLinks).where(and(eq(taskLinks.task, id), eq(taskLinks.dependsOn, dependsOn), eq(taskLinks.type, type))).get()) throw new Error('A task can have only one parent');
    touch(id, {});
  };
  return {
    create(input, actor) {
      const value = create.parse(input); person.parse(actor);
      return db.transaction(() => {
        // Tasks are never deleted by this app, so even cancelled IDs remain reserved.
        const n = db.select({ n: sql<number>`coalesce(max(cast(substr(${tasks.id}, 3) as integer)), 0) + 1` }).from(tasks).get()!.n;
        const at = now(), id = `t-${n}`;
        db.insert(tasks).values({ id, title: value.title, goal: value.goal, why: value.why, doneWhen: value.doneWhen,
          description: value.description, priority: value.priority, type: value.type, project: value.project,
          ownerKind: value.owner.kind, owner: value.owner.kind === 'household' ? null : value.owner.id,
          createdByKind: actor.kind, createdBy: actor.id, createdAt: at, changedAt: at, position: n,
          sourceKind: value.source?.kind, sourceId: value.source?.id }).run();
        if (value.parent) link(id, value.parent, 'parent-child');
        return row(id);
      });
    },
    get(id) { return { ...row(id), comments: db.select().from(taskComments).where(eq(taskComments.task, id)).orderBy(asc(taskComments.seq)).all(), links: db.select().from(taskLinks).where(eq(taskLinks.task, id)).all() }; },
    ready() {
      const blocked = db.select({ id: taskLinks.task }).from(taskLinks).innerJoin(tasks, eq(tasks.id, taskLinks.dependsOn))
        .where(and(eq(taskLinks.type, 'blocks'), ne(tasks.status, 'closed')));
      return db.select().from(tasks).where(and(eq(tasks.status, 'open'), ne(tasks.type, 'epic'), sql`${tasks.id} not in (${blocked})`))
        .orderBy(asc(tasks.priority), asc(tasks.position), asc(tasks.id)).all();
    },
    list(status) { return db.select().from(tasks).where(status ? eq(tasks.status, status) : undefined).orderBy(asc(tasks.priority), asc(tasks.position), asc(tasks.id)).all(); },
    edit(id, input) { const patch = z.object(summary).partial().strict().parse(input); return db.transaction(() => touch(id, patch)); },
    claim(id, actor) { person.parse(actor); return db.transaction(() => { if (row(id).status !== 'open') throw new Error('Only open work can be claimed'); return touch(id, { status: 'in_progress', assigneeKind: actor.kind, assignee: actor.id, startedAt: now() }); }); },
    unclaim(id) { return db.transaction(() => { if (row(id).status !== 'in_progress') throw new Error('Task is not in progress'); return touch(id, { status: 'open', assigneeKind: null, assignee: null, startedAt: null }); }); },
    close(id, reason) { z.string().trim().min(1).parse(reason); return db.transaction(() => touch(id, { status: 'closed', closeReason: reason, closedAt: now() })); },
    reopen(id) { return db.transaction(() => touch(id, { status: 'open', closeReason: null, closedAt: null, startedAt: null, assigneeKind: null, assignee: null })); },
    comment(id, text, actor) { db.transaction(() => addComment(id, text, actor)); },
    link(id, dependsOn, type) { db.transaction(() => link(id, dependsOn, type)); },
    unlink(id, dependsOn, type) { z.enum(['blocks', 'parent-child']).parse(type); db.transaction(() => { row(id); row(dependsOn); db.delete(taskLinks).where(and(eq(taskLinks.task, id), eq(taskLinks.dependsOn, dependsOn), eq(taskLinks.type, type))).run(); touch(id, {}); }); },
    ask(id, input, actor) {
      const value = z.object({ to: person.extend({ kind: z.literal('member') }), ask: z.string().trim().min(1), ifYes: z.string().trim().min(1), ifNo: z.string().trim().min(1), answers: z.enum(['yes-no', 'words']).default('yes-no') }).parse(input); person.parse(actor);
      return db.transaction(() => { if (row(id).status === 'closed') throw new Error('Closed work cannot ask a question'); return touch(id, { assigneeKind: value.to.kind, assignee: value.to.id, ask: value.ask, ifYes: value.ifYes, ifNo: value.ifNo, answers: value.answers, askedByKind: actor.kind, askedBy: actor.id }); });
    },
    answer(id, answer, text, actor) {
      person.parse(actor); z.enum(['yes', 'no', 'words']).parse(answer);
      return db.transaction(() => {
        const task = row(id);
        if (task.status === 'closed' || !task.ask || task.assigneeKind !== actor.kind || task.assignee !== actor.id) throw new Error('No question for this person');
        if (task.answers === 'words' && answer !== 'words') throw new Error('This question needs words');
        if (answer === 'words') z.string().trim().min(1).parse(text);
        addComment(id, answer === 'words' ? text : `${answer === 'yes' ? 'Yes' : 'No'}, to: ${task.ask}\n${answer === 'yes' ? task.ifYes : task.ifNo}`, actor);
        return touch(id, { assigneeKind: task.askedByKind, assignee: task.askedBy, ask: null, ifYes: null, ifNo: null, answers: null, askedByKind: null, askedBy: null });
      });
    },
  };
}
