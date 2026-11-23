import { randomUUID } from 'node:crypto';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import { and, asc, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../core/data/database.js';
import { tasks, taskComments, taskLinks, inbox, importedTaskSequence } from '../core/data/schema.js';
import { projectRefusal, projectRetired, taskShelved, type ProjectUse } from '../core/data/project-in-use.js';
import { taskId } from '../slug.js';

// Offline importers call this within the same transaction as the archived tasks.
export function preserveImportedTaskSequence(db: DataDatabase, lastIssued: number) {
  if (!Number.isSafeInteger(lastIssued) || lastIssued < 0) throw new Error('Invalid imported task sequence');
  db.insert(importedTaskSequence).values({singleton: 1, lastIssued}).onConflictDoUpdate({
    target: importedTaskSequence.singleton, set: {lastIssued},
    setWhere: sql`${importedTaskSequence.lastIssued} < ${lastIssued}`,
  }).run();
}

const person = z.object({ kind: z.enum(['member', 'agent']), id: z.string().trim().min(1) });
export type TaskActor = z.infer<typeof person>;
const summary = {
  title: z.string().trim().min(1), goal: z.string().trim().min(1), why: z.string().trim().min(1),
  doneWhen: z.string(), description: z.string(), priority: z.number().int().min(0).max(4),
  project: z.string().min(1).nullable(),
};
export const taskCreateSchema = z.object({
  ...summary, doneWhen: summary.doneWhen.default(''), description: summary.description.default(''),
  priority: summary.priority.default(2), project: summary.project.default(null),
  type: z.enum(tasks.type.enumValues).default('task'),
  owner: z.discriminatedUnion('kind', [person.extend({ kind: z.literal('member') }), person.extend({ kind: z.literal('agent') }), z.object({ kind: z.literal('household') })]),
  source: z.object({ kind: z.string().min(1), id: z.string().min(1) }).optional(),
  parent: z.string().min(1).optional(),
  // The line of a spec this task implements. One task per line.
  spec: z.object({ item: z.string().trim().min(1).max(500), criterion: z.string().trim().min(1).max(2000) }).strict().optional(),
});
export const taskEditSchema = z.object(summary).partial().strict();
export const taskAskSchema = z.object({ to: person.extend({ kind: z.literal('member') }), ask: z.string().trim().min(1), ifYes: z.string().trim().min(1), ifNo: z.string().trim().min(1), answers: z.enum(['yes-no', 'words']).default('yes-no') });
/** How one task may depend on another. */
export const taskLinkType = z.enum(['blocks', 'parent-child']);
export type TaskLinkType = z.infer<typeof taskLinkType>;
export type NewTask = z.input<typeof taskCreateSchema>;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskDetail = TaskRow & { comments: (typeof taskComments.$inferSelect)[]; links: (typeof taskLinks.$inferSelect)[] };
export interface TaskService {
  create(input: NewTask, actor: TaskActor): TaskRow;
  get(id: string): TaskDetail;
  ready(): TaskRow[];
  list(status?: TaskRow['status']): TaskRow[];
  /** `actor` is who is making the edit. A change of project is a move (moveToProject) and needs one. */
  edit(id: string, input: Partial<Pick<TaskRow, keyof typeof summary>>, actor?: TaskActor): TaskRow;
  claim(id: string, actor: TaskActor): TaskRow;
  unclaim(id: string): TaskRow;
  close(id: string, reason: string): TaskRow;
  reopen(id: string): TaskRow;
  /** Place a task just before another in the household's hand-kept order, or last. */
  move(id: string, before: string | null): TaskRow;
  /** Move tasks to another project, or to none. Every task named is moved or none is; the answer is the
   * ones that were not already there. */
  moveToProject(ids: readonly string[], project: string | null, actor: TaskActor): string[];
  comment(id: string, text: string, actor: TaskActor): void;
  link(id: string, dependsOn: string, type: TaskLinkType): void;
  unlink(id: string, dependsOn: string, type: TaskLinkType): void;
  ask(id: string, input: { to: TaskActor; ask: string; ifYes: string; ifNo: string; answers?: 'yes-no' | 'words' }, actor: TaskActor): TaskRow;
  answer(id: string, answer: 'yes' | 'no' | 'words', text: string, actor: TaskActor): TaskRow;
}

/** Trusted application operations. The outside door owns visibility and authorization.
 * Every write is atomic; all facts live in the approved shared tables. No importer,
 * alternate database, record JSON or background process is involved.
 */
/** The member a task is private to. A task in a project is shared by its project whoever owns it; only a
 * task with no project is its owner's alone (policy.ts, the tasks rule). */
const privateTo = (task: Pick<TaskRow, 'project' | 'ownerKind' | 'owner'>): string | null =>
  !task.project && task.ownerKind === 'member' ? task.owner : null;
/** The labels on mail to a person about a task: the task's own, so that whoever reads the task reads the
 * mail (policy.ts, the inbox rule). Naming the owner of a project task as its member would mark the mail
 * private to them and hide it from the project member it is addressed to. */
const labels = (task: Pick<TaskRow, 'project' | 'ownerKind' | 'owner'>) =>
  ({ project: task.project, agent: task.ownerKind === 'agent' ? task.owner : null, member: privateTo(task) });
/** May this person read this conversation? Root supplies it from policy.ts; the service holds no rule. */
export type ReadsConversation = (person: string, conversation: string) => boolean;
/** `reads` decides where mail to a person about a task is filed: in the task's conversation, under that
 * conversation's labels, when the person reads it; otherwise outside any thread, under the task's labels.
 * Either way the person it is addressed to can read it. Without `reads`, only a person's own thread with
 * the agent counts as one they read. */
export function taskService(db: DataDatabase, now: () => string = () => new Date().toISOString(), reads?: ReadsConversation): TaskService {
  const filedFor = (task: TaskRow, conversation: { id: string; member: string | null } | null, person: string) =>
    conversation && (reads ? reads(person, conversation.id) : conversation.member === person) ? { conversation: conversation.id } : { conversation: null, ...labels(task) };
  const mail = new Conversations(db, now, lateMailWaits);
  /** The labels a stored item about a task took from the task when it was sent, read again from the task as
   * it is now; nothing for an item that carries its conversation's labels instead. This is the other half
   * of `filedFor` and of how `answer` files what it sends: what they copy from the task, this gives again
   * once the task's own labels have changed. A change to how either files mail is a change here. */
  const takenFromTask = (task: TaskRow, item: typeof inbox.$inferSelect) =>
    // Outside any thread: a person's mail carries all of the task's labels, an agent's its project.
    item.conversation === null ? item.toKind === 'person' ? labels(task) : { project: task.project }
    // In the thread of the agent that asked: the thread's labels, with the task's project, unless the thread is a member's own.
    : item.source === 'answer' && item.toKind === 'agent' && !mail.conversation(item.conversation).member ? { project: task.project } : undefined;
  /** Mail about a task that this service sent: its questions, and the answers sent on from them. Other mail
   * that only names the task is not the task's. */
  const mailAbout = (id: string) => {
    const questions = db.select().from(inbox).where(and(eq(inbox.source, 'task'), eq(inbox.waitsOnKind, 'task'), eq(inbox.waitsOnId, id))).all();
    const answers = db.select().from(inbox).where(and(eq(inbox.source, 'answer'),
      or(like(inbox.sourceId, `${id}:%`), questions.length ? inArray(inbox.sourceId, questions.map(question => question.id)) : undefined))).all();
    return [...questions, ...answers];
  };
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
  const link = (id: string, dependsOn: string, type: TaskLinkType) => {
    taskLinkType.parse(type); row(id); row(dependsOn);
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
  /** The trusted layer's own guard: a task goes nowhere a task may not be (`taskProjectRefusal`). */
  const requireUsable = (project: string | null) => { const refused = taskProjectRefusal(db, project); if (refused) throw new Error(refused); };
  /** The one place a task changes project, inside the caller's transaction. Says whether it moved: a task
   * already there is left alone, with no comment. */
  const moveOne = (id: string, project: string | null, actor: TaskActor): boolean => {
    const from = row(id).project;
    if (from === project) return false;
    const task = touch(id, { project });
    // Everything that took its labels from the task goes with it. Links and comments stay as they are.
    for (const item of mailAbout(id)) { const taken = takenFromTask(task, item); if (taken) mail.relabel(item.id, taken); }
    const named = (value: string | null) => value === null ? 'no project' : `project ${value}`;
    addComment(id, `Moved from ${named(from)} to ${named(project)}`, actor);
    return true;
  };
  return {
    create(input, actor) {
      const value = taskCreateSchema.parse(input); person.parse(actor);
      return db.transaction(() => {
        requireUsable(value.project);
        // Tasks are never deleted by this app, so even cancelled IDs remain reserved.
        const imported = db.select({lastIssued: importedTaskSequence.lastIssued}).from(importedTaskSequence);
        const n = db.select({id: sql<number>`max(coalesce(max(cast(substr(${tasks.id}, 3) as integer)), 0), coalesce((${imported}), 0)) + 1`})
          .from(tasks).get()!.id;
        if (!Number.isSafeInteger(n)) throw new Error('Task ID space exhausted');
        const at = now(), id = taskId(n);
        if (value.spec && db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.specItem, value.spec.item), eq(tasks.criterion, value.spec.criterion))).get()) throw new Error('A task already implements that line of the spec');
        db.insert(tasks).values({ id, title: value.title, goal: value.goal, why: value.why, doneWhen: value.doneWhen,
          description: value.description, priority: value.priority, type: value.type, project: value.project,
          ownerKind: value.owner.kind, owner: value.owner.kind === 'household' ? null : value.owner.id,
          createdByKind: actor.kind, createdBy: actor.id, createdAt: at, changedAt: at, position: n,
          sourceKind: value.source?.kind, sourceId: value.source?.id, specItem: value.spec?.item, criterion: value.spec?.criterion }).run();
        if (value.parent) link(id, value.parent, 'parent-child');
        return row(id);
      });
    },
    get(id) { return { ...row(id), comments: db.select().from(taskComments).where(eq(taskComments.task, id)).orderBy(asc(taskComments.seq)).all(), links: db.select().from(taskLinks).where(eq(taskLinks.task, id)).all() }; },
    ready() {
      const blocked = db.select({ id: taskLinks.task }).from(taskLinks).innerJoin(tasks, eq(tasks.id, taskLinks.dependsOn))
        .where(and(eq(taskLinks.type, 'blocks'), ne(tasks.status, 'closed')));
      // A shelved task is not work (core/data/project-in-use.ts).
      return db.select().from(tasks).where(and(eq(tasks.status, 'open'), ne(tasks.type, 'epic'), sql`${tasks.id} not in (${blocked})`, sql`not ${taskShelved(tasks)}`))
        .orderBy(asc(tasks.priority), asc(tasks.position), asc(tasks.id)).all();
    },
    list(status) { return db.select().from(tasks).where(status ? eq(tasks.status, status) : undefined).orderBy(asc(tasks.priority), asc(tasks.position), asc(tasks.id)).all(); },
    edit(id, input, actor) {
      const { project, ...patch } = taskEditSchema.parse(input);
      return db.transaction(() => {
        // A task changes project one way: an edit that names another project is a move, with its record and its mail.
        if (project !== undefined && project !== row(id).project) {
          if (!actor) throw new Error('A change of project needs to say who made it');
          requireUsable(project); moveOne(id, project, person.parse(actor));
        }
        return touch(id, patch);
      });
    },
    claim(id, actor) {
      person.parse(actor);
      return db.transaction(() => {
        const task = row(id);
        if (projectRetired(db, task.project)) throw new Error(`Project ${task.project} is retired: its tasks are shelved until it is revived`);
        if (task.ask) throw new Error('Answer the outstanding question first');
        if (task.status !== 'open') throw new Error('Only open work can be claimed');
        return touch(id, { status: 'in_progress', assigneeKind: actor.kind, assignee: actor.id, startedAt: now() });
      });
    },
    unclaim(id) { return db.transaction(() => { if (row(id).ask) throw new Error('Answer the outstanding question first'); if (row(id).status !== 'in_progress') throw new Error('Task is not in progress'); return touch(id, { status: 'open', assigneeKind: null, assignee: null, startedAt: null }); }); },
    close(id, reason) { z.string().trim().min(1).parse(reason); return db.transaction(() => { const task = touch(id, { status: 'closed', closeReason: reason, closedAt: now(), ask: null, ifYes: null, ifNo: null, answers: null, askedByKind: null, askedBy: null }); mail.resolve('task', id, reason); return task; }); },
    move(id, before) {
      return db.transaction(() => {
        row(id);
        if (before === id) throw new Error('A task cannot go before itself');
        // Positions are whole numbers. Open a gap at the target and step into it;
        // every other task keeps its place relative to the rest.
        const target = before === null ? db.select({ n: sql<number>`coalesce(max(${tasks.position}), 0) + 1` }).from(tasks).get()!.n : row(before).position;
        if (before !== null) db.update(tasks).set({ position: sql`${tasks.position} + 1` }).where(sql`${tasks.position} >= ${target} and ${tasks.id} <> ${id}`).run();
        return touch(id, { position: target });
      });
    },
    moveToProject(ids, project, actor) {
      person.parse(actor);
      return db.transaction(() => { requireUsable(project); return [...new Set(ids)].filter(id => moveOne(id, project, actor)); });
    },
    reopen(id) {
      return db.transaction(() => {
        const task = row(id);
        if (task.status === 'open') return task;
        if (task.status === 'in_progress') throw new Error('Task is in progress');
        return touch(id, { status: 'open', closeReason: null, closedAt: null, startedAt: null, assigneeKind: null, assignee: null });
      });
    },
    comment(id, text, actor) { db.transaction(() => addComment(id, text, actor)); },
    link(id, dependsOn, type) { db.transaction(() => link(id, dependsOn, type)); },
    unlink(id, dependsOn, type) { taskLinkType.parse(type); db.transaction(() => { row(id); row(dependsOn); db.delete(taskLinks).where(and(eq(taskLinks.task, id), eq(taskLinks.dependsOn, dependsOn), eq(taskLinks.type, type))).run(); touch(id, {}); }); },
    ask(id, input, actor) {
      const value = taskAskSchema.parse(input); person.parse(actor);
      return db.transaction(() => {
        if (row(id).status === 'closed') throw new Error('Closed work cannot ask a question');
        mail.resolve('task', id, 'Question replaced', {kind:'person',id:value.to.id});
        const task = touch(id, { assigneeKind: value.to.kind, assignee: value.to.id, ask: value.ask, ifYes: value.ifYes, ifNo: value.ifNo, answers: value.answers, askedByKind: actor.kind, askedBy: actor.id });
        mail.send({ toKind: 'person', to: value.to.id, source: 'task', sourceId: `${id}:${randomUUID()}`,
          fromKind: actor.kind === 'member' ? 'person' : 'agent', fromId: actor.id,
          ...filedFor(task, task.sourceKind === 'conversation' && task.sourceId ? mail.conversation(task.sourceId) : null, value.to.id),
          words: value.ask, answers: value.answers, ifYes: value.ifYes, ifNo: value.ifNo,
          waitsOnKind: 'task', waitsOnId: id, refs: [id] });
        return task;
      });
    },
    answer(id, answer, text, actor) {
      person.parse(actor); z.enum(['yes', 'no', 'words']).parse(answer);
      return db.transaction(() => {
        const task = row(id);
        if (task.status === 'closed' || !task.ask || task.assigneeKind !== actor.kind || task.assignee !== actor.id) throw new Error('No question for this person');
        if (task.answers === 'words' && answer !== 'words') throw new Error('This question needs words');
        if (answer === 'words') z.string().trim().min(1).parse(text);
        addComment(id, answer === 'words' ? text : `${answer === 'yes' ? 'Yes' : 'No'}, to: ${task.ask}\n${answer === 'yes' ? task.ifYes : task.ifNo}`, actor);
        const resolved = mail.resolve('task', id, answer === 'words' ? text : answer);
        if (task.askedByKind && task.askedBy) {
          // A task can be asked outside a thread; its answer still reaches its asker.
          const conversation = task.sourceKind === 'conversation' && task.sourceId ? mail.conversation(task.sourceId) : null;
          const destination=conversation && conversation.agent === task.askedBy ? conversation.id : null;
          const filed=task.askedByKind==='member'?filedFor(task,conversation,task.askedBy)
            :{conversation:destination,...(mail.answerScope(destination,task.askedBy,{project:task.project,member:privateTo(task)})??{project:task.project})};
          mail.send({ toKind: task.askedByKind === 'member' ? 'person' : 'agent', to: task.askedBy,
            source: 'answer', sourceId: resolved[0]?.id ?? `${id}:${randomUUID()}`,
            fromKind: actor.kind === 'member' ? 'person' : 'agent', fromId: actor.id,
            ...filed, words: answer === 'words' ? text : `${answer === 'yes' ? 'Yes' : 'No'}, to: ${task.ask}\n${answer === 'yes' ? task.ifYes : task.ifNo}`, refs: [id] });
        }
        return touch(id, { assigneeKind: task.askedByKind, assignee: task.askedBy, ask: null, ifYes: null, ifNo: null, answers: null, askedByKind: null, askedBy: null });
      });
    },
  };
}

/** A task may have no project, or one that is in use (core/data/project-in-use.ts, where that is stated).
 * The outside door asks this for a new task, an edit and a move (shared-task-access.ts), and the service
 * asks it again before it files or moves anything. A new task and a task moved in `enter` the project, which
 * must not be retired; a task edited where it is `stand`s, and a retired project will do. The answer is why not, in the words a caller is told, or nothing
 * when the project will do. */
export function taskProjectRefusal(db: DataDatabase, project: string | null, use: ProjectUse = 'enter'): string | undefined {
  return project === null ? undefined : projectRefusal(db, project, use)?.message;
}

/** Every task filed under one project is filed under another: for a merge of the two (shared-projects.ts).
 * Nothing else about a task changes, and no comment is left: the household change card is the record. */
export function refileTasks(db: DataDatabase, from: string, into: string): void {
  db.update(tasks).set({ project: into }).where(eq(tasks.project, from)).run();
}
