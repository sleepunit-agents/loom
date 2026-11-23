import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { eq } from 'drizzle-orm';
import { members, agents, inbox, inboxRefs, projects, tasks as taskRows } from '../core/data/schema.js';
import { Conversations } from '../core/conversations/index.js';
import { preserveImportedTaskSequence, taskService, type TaskService } from './tasks.js';

let client: Database.Database, db: DataDatabase, tasks: TaskService;
const actor = { kind: 'member', id: 'jonathan' } as const;
const other = { kind: 'member', id: 'amelia' } as const;
const at = '2026-11-14T20:00:00.000Z';
beforeEach(() => {
  client = new Database(':memory:');
  db = createDataSchema(client, () => at);
  db.insert(members).values([actor, other].map(p => ({ id: p.id, role: 'member' as const, joinedAt: at }))).run();
  tasks = taskService(db, () => at);
});
afterEach(() => client.close());
const file = (title: string, priority = 2, type: 'task' | 'epic' = 'task') => tasks.create({ title, priority, type, goal: 'The pump works', why: 'Keep the pond healthy', owner: { kind: 'household' } }, actor);

it('reserves previously issued archive IDs across imports, retries and failed transactions', () => {
  expect(file('Before import').id).toBe('t-1');
  preserveImportedTaskSequence(db, 150);
  expect(file('After import').id).toBe('t-151');
  preserveImportedTaskSequence(db, 100);
  preserveImportedTaskSequence(db, 150);
  expect(() => db.transaction(() => {
    preserveImportedTaskSequence(db, 200);
    throw new Error('Import failed');
  })).toThrow('Import failed');
  expect(file('After retry').id).toBe('t-152');
  expect(() => preserveImportedTaskSequence(db, -1)).toThrow();
  preserveImportedTaskSequence(db, Number.MAX_SAFE_INTEGER);
  expect(() => file('Overflow')).toThrow('Task ID space exhausted');
});

it('finds ready work by urgency, excludes epics and waits for every blocker to close', () => {
  const epic = file('Restore pond', 0, 'epic'), buy = file('Buy pump', 1), install = file('Install pump', 0), checklist = file('Write checklist', 3);
  tasks.link(buy.id, epic.id, 'parent-child');
  tasks.link(install.id, buy.id, 'blocks');
  expect(tasks.ready().map(t => t.id)).toEqual([buy.id, checklist.id]);
  tasks.claim(buy.id, actor);
  expect(tasks.ready().map(t => t.id)).toEqual([checklist.id]);
  tasks.close(buy.id, 'The pump arrived');
  expect(tasks.ready().map(t => t.id)).toEqual([install.id, checklist.id]);
  tasks.reopen(buy.id);
  expect(tasks.ready().map(t => t.id)).toEqual([buy.id, checklist.id]);
  expect(tasks.get(buy.id).links).toEqual([{ task: buy.id, dependsOn: epic.id, type: 'parent-child' }]);
});

it('keeps plain summaries, source, claims, cancellation and comments as named fields', () => {
  const task = tasks.create({ title: 'Choose pump', goal: 'A pump chosen', why: 'Old pump failed', owner: actor, source: { kind: 'conversation', id: 'cv-pond' } }, actor);
  expect(task).toMatchObject({ ownerKind: 'member', owner: actor.id, sourceKind: 'conversation', sourceId: 'cv-pond' });
  expect(() => tasks.edit(task.id, { title: ' ' })).toThrow();
  tasks.edit(task.id, { doneWhen: 'Model and price in a comment', priority: 0 });
  expect(tasks.claim(task.id, actor)).toMatchObject({ status: 'in_progress', startedAt: at, assignee: actor.id });
  expect(() => tasks.claim(task.id, other)).toThrow('Only open');
  tasks.unclaim(task.id);
  tasks.comment(task.id, 'Compared three models', actor);
  tasks.comment(task.id, 'Choose the middle one', other);
  expect(tasks.get(task.id).comments.map(c => [c.seq, c.actor, c.text])).toEqual([[1, 'jonathan', 'Compared three models'], [2, 'amelia', 'Choose the middle one']]);
  expect(tasks.close(task.id, 'cancelled')).toMatchObject({ status: 'closed', closeReason: 'cancelled' });
  expect(file('Next task').id).toBe('t-2');
});

it('rejects cycles, a second parent and a missing parent atomically', () => {
  const a = file('First'), b = file('Second'), c = file('Third');
  tasks.link(a.id, b.id, 'blocks'); tasks.link(b.id, c.id, 'blocks');
  expect(() => tasks.link(c.id, a.id, 'blocks')).toThrow('cycle');
  tasks.link(a.id, b.id, 'parent-child');
  expect(() => tasks.link(a.id, c.id, 'parent-child')).toThrow();
  expect(tasks.get(a.id).links.filter(l => l.type === 'parent-child')).toHaveLength(1);
  expect(() => tasks.create({ title: 'Bad parent', goal: 'Done', why: 'Needed', owner: actor, parent: 't-missing' }, actor)).toThrow('not found');
  expect(tasks.list()).toHaveLength(3);
  tasks.unlink(a.id, b.id, 'blocks');
  expect(tasks.ready().map(t => t.id)).toEqual([a.id, c.id]);
});

it('records a person’s answer and returns the work to whoever asked', () => {
  const task = file('Order pump');
  tasks.ask(task.id, { to: other, ask: 'Spend up to $180?', ifYes: 'I order it', ifNo: 'I find a cheaper one' }, actor);
  expect(() => tasks.answer(task.id, 'yes', '', actor)).toThrow('No question');
  expect(tasks.get(task.id).comments).toHaveLength(0);
  expect(tasks.answer(task.id, 'yes', '', other)).toMatchObject({ assignee: actor.id, assigneeKind: actor.kind, ask: null });
  expect(tasks.get(task.id).comments[0]).toMatchObject({ actor: other.id, text: 'Yes, to: Spend up to $180?\nI order it' });
  expect(() => tasks.answer(task.id, 'yes', '', other)).toThrow('No question');
  tasks.ask(task.id, { to: other, ask: 'Which model?', ifYes: 'I order it', ifNo: 'I wait', answers: 'words' }, actor);
  expect(() => tasks.answer(task.id, 'yes', '', other)).toThrow('needs words');
  tasks.answer(task.id, 'words', 'The middle model', other);
  expect(tasks.get(task.id).comments.map(c => c.text)).toEqual(['Yes, to: Spend up to $180?\nI order it', 'The middle model']);
});

it('puts a task question in Inbox, resolves it at the source and delivers the answer back to its conversation', () => {
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const mail = new Conversations(db, () => at);
  const conversation = mail.open({ agent: 'art', venue: 'loom', place: 'pond', label: 'Pond' });
  const asker = { kind: 'agent', id: 'art' } as const;
  tasks = taskService(db, () => at, () => true);
  const task = tasks.create({ title: 'Order pump', goal: 'Pump ordered', why: 'Old pump failed', owner: asker, source: { kind: 'conversation', id: conversation.id } }, asker);
  tasks.ask(task.id, { to: actor, ask: 'Spend $180?', ifYes: 'I order it', ifNo: 'I look again' }, asker);
  const question = db.select().from(inbox).get()!;
  expect(question).toMatchObject({ toKind: 'person', to: actor.id, source: 'task', conversation: conversation.id, words: 'Spend $180?', answers: 'yes-no', ifYes: 'I order it', waitsOnKind: 'task', waitsOnId: task.id, state: 'waiting' });
  expect(db.select().from(inboxRefs).all()).toEqual([{ item: question.id, ref: task.id }]);
  expect(() => mail.answer(question.id, actor.id, 'yes')).toThrow('linked source');
  expect(() => tasks.answer(task.id, 'yes', '', other)).toThrow('No question');
  expect(mail.item(question.id).state).toBe('waiting');
  tasks.answer(task.id, 'yes', '', actor);
  expect(mail.item(question.id)).toMatchObject({ state: 'resolved', resolution: 'yes' });
  expect(db.select().from(inbox).all()[1]).toMatchObject({ toKind: 'agent', to: 'art', source: 'answer', sourceId: question.id, conversation: conversation.id, words: 'Yes, to: Spend $180?\nI order it', state: 'waiting' });
  expect(() => tasks.answer(task.id, 'yes', '', actor)).toThrow('No question');
  expect(db.select().from(inbox).all()).toHaveLength(2);
});

it('retires replaced and closed task questions, keeping old Inbox history', () => {
  const task = file('Order pump');
  const ask = (text: string) => tasks.ask(task.id, { to: other, ask: text, ifYes: 'Order it', ifNo: 'Wait' }, actor);
  ask('First choice?'); ask('Second choice?');
  expect(db.select().from(inbox).all().map(i => [i.words, i.state, i.resolution])).toEqual([
    ['First choice?', 'resolved', 'Question replaced'], ['Second choice?', 'waiting', null],
  ]);
  expect(() => tasks.claim(task.id, actor)).toThrow('outstanding question');
  tasks.close(task.id, 'cancelled');
  expect(db.select().from(inbox).all()[1]).toMatchObject({ state: 'resolved', resolution: 'cancelled' });
  expect(() => tasks.answer(task.id, 'yes', '', other)).toThrow('No question');
  tasks.reopen(task.id);
  expect(tasks.get(task.id).ask).toBeNull();
  expect(() => tasks.answer(task.id, 'yes', '', other)).toThrow('No question');
});

it('rolls back the task edit and prior question resolution when Inbox delivery fails', () => {
  const task = file('Order pump');
  tasks.ask(task.id, { to: other, ask: 'First?', ifYes: 'Order', ifNo: 'Wait' }, actor);
  client.exec("CREATE TRIGGER reject_question BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'delivery failed'); END");
  expect(() => tasks.ask(task.id, { to: actor, ask: 'Replacement?', ifYes: 'Order', ifNo: 'Wait' }, other)).toThrow('delivery failed');
  expect(tasks.get(task.id)).toMatchObject({ ask: 'First?', assignee: other.id, askedBy: actor.id });
  expect(db.select().from(inbox).all()).toHaveLength(1);
  expect(db.select().from(inbox).get()).toMatchObject({ state: 'waiting', words: 'First?' });
});

it('rolls back an answer and its comment if delivering the answer fails', () => {
  const task = file('Choose model');
  tasks.claim(task.id, actor);
  tasks.ask(task.id, { to: other, ask: 'Which model?', ifYes: 'Order', ifNo: 'Wait', answers: 'words' }, actor);
  expect(() => tasks.unclaim(task.id)).toThrow('outstanding question');
  client.exec("CREATE TRIGGER reject_answer BEFORE INSERT ON inbox WHEN NEW.source = 'answer' BEGIN SELECT RAISE(ABORT, 'answer delivery failed'); END");
  expect(() => tasks.answer(task.id, 'words', 'Middle model', other)).toThrow('answer delivery failed');
  expect(tasks.get(task.id)).toMatchObject({ ask: 'Which model?', assignee: other.id, comments: [] });
  expect(db.select().from(inbox).get()).toMatchObject({ state: 'waiting' });
  client.exec('DROP TRIGGER reject_answer');
  tasks.answer(task.id, 'words', 'Middle model', other);
  expect(db.select().from(inbox).all()[1]).toMatchObject({ to: actor.id, toKind: 'person', conversation: null, words: 'Middle model' });
});

it('moves a task in the hand-kept order, which breaks ties within a priority, and keeps everyone else in order', () => {
  const a = file('A'), b = file('B'), c = file('C'), urgent = file('Urgent', 0);
  expect(tasks.ready().map(t => t.title)).toEqual(['Urgent', 'A', 'B', 'C']);
  tasks.move(c.id, a.id);
  expect(tasks.ready().map(t => t.title)).toEqual(['Urgent', 'C', 'A', 'B']);
  tasks.move(c.id, null);
  expect(tasks.ready().map(t => t.title)).toEqual(['Urgent', 'A', 'B', 'C']);
  tasks.move(a.id, c.id);
  expect(tasks.ready().map(t => t.title)).toEqual(['Urgent', 'B', 'A', 'C']);
  // Priority still comes first: the hand-kept order only breaks ties.
  tasks.move(urgent.id, null);
  expect(tasks.ready().map(t => t.title)).toEqual(['Urgent', 'B', 'A', 'C']);
  expect(() => tasks.move(a.id, a.id)).toThrow('before itself');
  expect(() => tasks.move(a.id, 't-999')).toThrow();
  expect(new Set(tasks.list().map(t => t.position)).size).toBe(4);
});
it('records the line of a spec a task implements, one task per line', () => {
  const spec = { item: 'tasks.html#ready', criterion: 'A blocked task waits' };
  const made = tasks.create({ title: 'Hold back blocked work', goal: 'g', why: 'w', owner: { kind: 'household' }, spec }, actor);
  expect(tasks.get(made.id)).toMatchObject({ specItem: spec.item, criterion: spec.criterion });
  expect(() => tasks.create({ title: 'Again', goal: 'g', why: 'w', owner: { kind: 'household' }, spec }, actor)).toThrow('already implements');
  expect(tasks.create({ title: 'Next line', goal: 'g', why: 'w', owner: { kind: 'household' }, spec: { ...spec, criterion: 'An epic is never ready' } }, actor).specItem).toBe(spec.item);
  expect(file('No spec').specItem).toBeNull();
});

const makeProjects = (...ids: string[]) => db.insert(projects).values(ids.map(id => ({ id, name: id }))).run();
it('moves tasks to another project, and records on each who moved it and from where to where', () => {
  makeProjects('pond', 'shed');
  const a = tasks.create({ title: 'Buy pump', goal: 'A pump', why: 'Pond', owner: actor, project: 'pond' }, actor), b = file('Sweep shed');
  const c = tasks.create({ title: 'Paint shed', goal: 'Painted', why: 'Shed', owner: { kind: 'household' }, project: 'shed' }, actor);
  tasks.link(b.id, a.id, 'parent-child');
  tasks.comment(a.id, 'The old one failed in March', other);
  expect(tasks.moveToProject([a.id, b.id, c.id, a.id], 'shed', other)).toEqual([a.id, b.id]);
  expect([a, b, c].map(task => tasks.get(task.id).project)).toEqual(['shed', 'shed', 'shed']);
  // One comment on each moved task, by the mover. What was said before stays, and so does the link.
  expect(tasks.get(a.id).comments.map(row => [row.actorKind, row.actor, row.text])).toEqual([['member', other.id, 'The old one failed in March'], ['member', other.id, 'Moved from project pond to project shed']]);
  expect(tasks.get(b.id).comments.map(row => [row.actor, row.text])).toEqual([[other.id, 'Moved from no project to project shed']]);
  expect(tasks.get(b.id).links).toEqual([{ task: b.id, dependsOn: a.id, type: 'parent-child' }]);
  // A task already there is left alone: no comment, and nothing about it changes.
  expect(tasks.get(c.id).comments).toEqual([]);
  expect(tasks.moveToProject([a.id, b.id, c.id], 'shed', actor)).toEqual([]);
  expect(tasks.get(a.id).comments).toHaveLength(2);
  // Out of every project. A parent and its child may now be in different places.
  expect(tasks.moveToProject([b.id], null, actor)).toEqual([b.id]);
  expect(tasks.get(b.id)).toMatchObject({ project: null, links: [{ dependsOn: a.id }] });
  expect(tasks.get(b.id).comments.at(-1)).toMatchObject({ actor: actor.id, text: 'Moved from project shed to no project' });
});

it('moves every task named or none, and refuses a project that is removed or not there', () => {
  makeProjects('pond', 'shed', 'shut');
  db.update(projects).set({ removedAt: at }).where(eq(projects.id, 'shut')).run();
  const a = file('Buy pump'), b = file('Sweep shed');
  const untouched = () => db.select().from(taskRows).all().map(row => [row.project, row.changedAt]);
  const before = untouched();
  expect(() => tasks.moveToProject([a.id, 't-999', b.id], 'pond', actor)).toThrow('Task not found');
  expect(() => tasks.moveToProject([a.id, b.id], 'shut', actor)).toThrow('Project shut is removed');
  expect(() => tasks.moveToProject([a.id, b.id], 'nowhere', actor)).toThrow('No project has the id nowhere');
  expect(untouched()).toEqual(before);
  expect([a, b].flatMap(task => tasks.get(task.id).comments)).toEqual([]);
});

it('takes the labels of mail filed under a task’s own labels with the task, and leaves mail filed in a conversation alone', () => {
  makeProjects('pond', 'shed');
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const mail = new Conversations(db, () => at), asker = { kind: 'agent', id: 'art' } as const;
  const labelsOf = (id: string) => { const { project, agent, member, conversation } = mail.item(id); return { project, agent, member, conversation }; };
  // A member's own task with no project: its mail is private to that member.
  const own = tasks.create({ title: 'Order pump', goal: 'Pump ordered', why: 'Old pump failed', owner: actor }, actor);
  tasks.ask(own.id, { to: actor, ask: 'Spend $180?', ifYes: 'I order it', ifNo: 'I look again' }, actor);
  const first = db.select().from(inbox).where(eq(inbox.waitsOnId, own.id)).get()!;
  expect(labelsOf(first.id)).toEqual({ project: null, agent: null, member: actor.id, conversation: null });
  tasks.answer(own.id, 'yes', '', actor);
  const answered = db.select().from(inbox).where(eq(inbox.sourceId, first.id)).get()!;
  expect(labelsOf(answered.id)).toEqual({ project: null, agent: null, member: actor.id, conversation: null });
  tasks.ask(own.id, { to: actor, ask: 'Which shop?', ifYes: 'I go', ifNo: 'I wait' }, asker);
  const second = db.select().from(inbox).where(eq(inbox.words, 'Which shop?')).get()!;
  // Into a project: every one of them is the project's now, the answered one and the waiting one alike.
  tasks.moveToProject([own.id], 'pond', actor);
  for (const item of [first, answered, second]) expect(labelsOf(item.id)).toEqual({ project: 'pond', agent: null, member: null, conversation: null });
  tasks.moveToProject([own.id], 'shed', actor);
  for (const item of [first, answered, second]) expect(labelsOf(item.id).project).toBe('shed');
  // An answer on its way to the agent that asked, outside any thread, carries the task's project and nothing else.
  tasks.answer(own.id, 'no', '', actor);
  const toAgent = db.select().from(inbox).where(eq(inbox.sourceId, second.id)).get()!;
  expect(toAgent).toMatchObject({ toKind: 'agent', to: 'art', project: 'shed', member: null, agent: null, conversation: null });
  // Out of every project again: the mail is its owner's alone, as the task is.
  tasks.moveToProject([own.id], null, actor);
  for (const item of [first, answered, second]) expect(labelsOf(item.id)).toEqual({ project: null, agent: null, member: actor.id, conversation: null });
  expect(labelsOf(toAgent.id)).toEqual({ project: null, agent: null, member: null, conversation: null });
  expect(db.select().from(inbox).all().filter(item => item.project === 'pond' || item.project === 'shed')).toEqual([]);

  // A task from a conversation its people read: the question is filed there, under the conversation's labels.
  // The room is the shed's and the task is the pond's, so what came from which can be told apart.
  const room = mail.open({ agent: 'art', venue: 'loom', place: 'shed', label: 'Shed', project: 'shed' });
  tasks = taskService(db, () => at, () => true);
  const sourced = tasks.create({ title: 'Clean filter', goal: 'Clean', why: 'Clogged', owner: asker, project: 'pond', source: { kind: 'conversation', id: room.id } }, asker);
  tasks.ask(sourced.id, { to: actor, ask: 'Today?', ifYes: 'I do it', ifNo: 'Tomorrow' }, asker);
  const inRoom = db.select().from(inbox).where(eq(inbox.waitsOnId, sourced.id)).get()!;
  tasks.answer(sourced.id, 'yes', '', actor);
  const back = db.select().from(inbox).where(eq(inbox.sourceId, inRoom.id)).get()!;
  expect([labelsOf(inRoom.id), labelsOf(back.id)]).toEqual([{ project: 'shed', agent: 'art', member: null, conversation: room.id }, { project: 'pond', agent: 'art', member: null, conversation: room.id }]);
  // Something else in the same conversation that only mentions the task is not the task's mail.
  const mention = mail.send({ toKind: 'agent', to: 'art', conversation: room.id, source: 'answer', sourceId: 'in-elsewhere', fromKind: 'person', fromId: actor.id, words: `See ${sourced.id}`, refs: [sourced.id] });
  tasks.moveToProject([sourced.id], null, actor);
  // The question keeps its room's labels. The answer to the agent took its project from the task, so it follows.
  expect(labelsOf(inRoom.id)).toEqual({ project: 'shed', agent: 'art', member: null, conversation: room.id });
  expect(labelsOf(back.id)).toEqual({ project: null, agent: 'art', member: null, conversation: room.id });
  expect(labelsOf(mention.id).project).toBe('shed');

  // A member's own thread with the agent: the answer sent on there carries the thread's labels, the member's
  // among them, and none of the task's. It is private to that member wherever the task goes.
  const own2 = mail.open({ agent: 'art', venue: 'loom', place: 'own', label: 'Own', project: 'shed', member: actor.id });
  const privately = tasks.create({ title: 'Test water', goal: 'Tested', why: 'Cloudy', owner: asker, project: 'pond', source: { kind: 'conversation', id: own2.id } }, asker);
  tasks.ask(privately.id, { to: actor, ask: 'Now?', ifYes: 'I test', ifNo: 'Later' }, asker);
  const asked = db.select().from(inbox).where(eq(inbox.waitsOnId, privately.id)).get()!;
  tasks.answer(privately.id, 'yes', '', actor);
  const reply = db.select().from(inbox).where(eq(inbox.sourceId, asked.id)).get()!;
  const threads = { project: 'shed', agent: 'art', member: actor.id, conversation: own2.id };
  expect([labelsOf(asked.id), labelsOf(reply.id)]).toEqual([threads, threads]);
  tasks.moveToProject([privately.id], null, actor);
  expect([labelsOf(asked.id), labelsOf(reply.id)]).toEqual([threads, threads]);
});

it('changes a task’s project one way: an edit that names another project is the same move', () => {
  makeProjects('pond', 'shed', 'shut');
  db.update(projects).set({ removedAt: at }).where(eq(projects.id, 'shut')).run();
  const task = tasks.create({ title: 'Order pump', goal: 'Pump ordered', why: 'Old pump failed', owner: actor }, actor);
  tasks.ask(task.id, { to: actor, ask: 'Spend $180?', ifYes: 'I order it', ifNo: 'I look again' }, actor);
  const question = db.select().from(inbox).where(eq(inbox.waitsOnId, task.id)).get()!;
  tasks.answer(task.id, 'yes', '', actor);
  const answered = db.select().from(inbox).where(eq(inbox.sourceId, question.id)).get()!;
  // The edit moves the task, takes its mail along and leaves the record, and still makes the rest of the edit.
  expect(tasks.edit(task.id, { project: 'pond', priority: 0 }, other)).toMatchObject({ project: 'pond', priority: 0 });
  for (const item of [question, answered]) expect(db.select().from(inbox).where(eq(inbox.id, item.id)).get()).toMatchObject({ project: 'pond', member: null });
  expect(tasks.get(task.id).comments.at(-1)).toMatchObject({ actorKind: 'member', actor: other.id, text: 'Moved from no project to project pond' });
  // Naming the project it is already in is no move: no comment. An edit of something else needs nobody named.
  const comments = tasks.get(task.id).comments.length;
  tasks.edit(task.id, { project: 'pond', title: 'Order the pump' }, other);
  tasks.edit(task.id, { priority: 1 });
  expect(tasks.get(task.id)).toMatchObject({ project: 'pond', title: 'Order the pump', priority: 1 });
  expect(tasks.get(task.id).comments).toHaveLength(comments);
  // Refused as a move is, with nothing of the edit kept: a removed or missing project, and a move by nobody.
  expect(() => tasks.edit(task.id, { project: 'shut', title: 'Never' }, other)).toThrow('Project shut is removed');
  expect(() => tasks.edit(task.id, { project: 'nowhere', title: 'Never' }, other)).toThrow('No project has the id nowhere');
  expect(() => tasks.edit(task.id, { project: null, title: 'Never' })).toThrow('A change of project needs to say who made it');
  expect(tasks.get(task.id)).toMatchObject({ project: 'pond', title: 'Order the pump' });
  expect(db.select().from(inbox).where(eq(inbox.id, answered.id)).get()).toMatchObject({ project: 'pond' });
  expect(tasks.get(task.id).comments).toHaveLength(comments);
});

it('preserves the current Inbox question and claim when an old reopen is repeated', () => {
  const task = file('Inspect the pond');
  tasks.close(task.id, 'Inspection complete');
  tasks.reopen(task.id);
  tasks.ask(task.id, { to: other, ask: 'Order a filter?', ifYes: 'Order it', ifNo: 'Wait' }, actor);
  expect(tasks.reopen(task.id)).toMatchObject({ status: 'open', ask: 'Order a filter?', assignee: other.id });
  tasks.answer(task.id, 'yes', '', other);
  expect(db.select().from(inbox).where(eq(inbox.source, 'task')).get()).toMatchObject({ state: 'resolved', resolution: 'yes' });
  tasks.claim(task.id, actor);
  expect(() => tasks.reopen(task.id)).toThrow('in progress');
  expect(tasks.get(task.id)).toMatchObject({ status: 'in_progress', assignee: actor.id, startedAt: at });
});
