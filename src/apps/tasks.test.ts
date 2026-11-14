import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataSchema } from '../core/data/database.js';
import { members } from '../core/data/schema.js';
import { taskService, type TaskService } from './tasks.js';

let client: Database.Database, tasks: TaskService;
const actor = { kind: 'member', id: 'jonathan' } as const;
const other = { kind: 'member', id: 'amelia' } as const;
const at = '2026-11-14T20:00:00.000Z';
beforeEach(() => {
  client = new Database(':memory:');
  const db = createDataSchema(client, () => at);
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
