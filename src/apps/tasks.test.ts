import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { members, agents, inbox, inboxRefs } from '../core/data/schema.js';
import { Conversations } from '../core/conversations/index.js';
import { taskService, type TaskService } from './tasks.js';

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
