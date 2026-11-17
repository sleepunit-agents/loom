import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { members, inbox } from '../core/data/schema.js';
import { taskService, type TaskService } from './tasks.js';
import { dispatchTaskCommand, taskCommandSchema, TASK_MOVE_MAX, type TaskCommand } from './task-command.js';

let client: Database.Database, db: DataDatabase, service: TaskService;
const actor = { kind: 'member', id: 'jonathan' } as const;
const other = { kind: 'member', id: 'amelia' } as const;
const at = '2026-11-14T22:00:00.000Z';
beforeEach(() => {
  client = new Database(':memory:');
  db = createDataSchema(client, () => at);
  db.insert(members).values([actor, other].map(p => ({ id: p.id, role: 'member' as const, joinedAt: at }))).run();
  service = taskService(db, () => at);
});
afterEach(() => client.close());
const send = (command: TaskCommand) => dispatchTaskCommand(service, command, actor);
const create = (title: string) => send({ action: 'create', input: { title, goal: 'Pump works', why: 'Pond needs it', owner: { kind: 'household' } } })!;

it('executes form intents against shared rows with the root actor and explicit relation direction', () => {
  const parent = create('Restore pond'), task = create('Install pump');
  send({ action: 'edit', id: task.id, input: { priority: 0, description: 'Use the spare' } });
  send({ action: 'link', id: task.id, dependsOn: parent.id, type: 'parent-child' });
  send({ action: 'link', id: task.id, dependsOn: parent.id, type: 'blocks' });
  expect(service.get(task.id)).toMatchObject({ priority: 0, description: 'Use the spare', createdBy: actor.id, links: [
    { task: task.id, dependsOn: parent.id, type: 'blocks' },
    { task: task.id, dependsOn: parent.id, type: 'parent-child' },
  ] });
  send({ action: 'claim', id: task.id });
  expect(service.get(task.id)).toMatchObject({ status: 'in_progress', assignee: actor.id });
  send({ action: 'unclaim', id: task.id });
  expect(service.get(task.id).status).toBe('open');
  send({ action: 'comment', id: task.id, text: 'Pump ready' });
  expect(service.get(task.id).comments[0]).toMatchObject({ actor: actor.id, text: 'Pump ready' });
  send({ action: 'close', id: task.id, reason: 'Installed' });
  expect(service.get(task.id)).toMatchObject({ status: 'closed', closeReason: 'Installed' });
  send({ action: 'reopen', id: task.id });
  send({ action: 'unlink', id: task.id, dependsOn: parent.id, type: 'blocks' });
  expect(service.get(task.id)).toMatchObject({ status: 'open', closeReason: null, links: [{ task: task.id, dependsOn: parent.id, type: 'parent-child' }] });
});

it('delivers questions through shared Inbox and propagates service failure without a success result', () => {
  const task = create('Choose pump');
  send({ action: 'ask', id: task.id, input: { to: other, ask: 'Which pump?', ifYes: 'Order', ifNo: 'Wait', answers: 'words' } });
  expect(service.get(task.id)).toMatchObject({ askedBy: actor.id, assignee: other.id, ask: 'Which pump?' });
  expect(db.select().from(inbox).all()).toMatchObject([{ to: other.id, words: 'Which pump?' }]);
  expect(() => send({ action: 'claim', id: task.id })).toThrow('outstanding question');
  expect(service.get(task.id).status).toBe('open');
});

it('does not use an actor smuggled in a form command', () => {
  const task = create('Install pump');
  const command = { action: 'claim', id: task.id, actor: other } as const;
  send(command);
  expect(service.get(task.id).assignee).toBe(actor.id);
  expect(() => send({ action: 'erase', id: task.id } as unknown as TaskCommand)).toThrow('Unknown task command');
});

it('validates every form action using the service schemas and preserves defaults', () => {
  const command = taskCommandSchema.parse({ action: 'create', input: {
    title: '  Pump  ', goal: 'Water', why: 'Pond', owner: { kind: 'household' },
  } });
  expect(command).toMatchObject({ input: { title: 'Pump', priority: 2, project: null, type: 'task', doneWhen: '', description: '' } });
  const task = send(command)!;
  const commands: TaskCommand[] = [
    { action: 'edit', id: task.id, input: { priority: 1, project: null } },
    { action: 'claim', id: task.id }, { action: 'unclaim', id: task.id },
    { action: 'close', id: task.id, reason: 'Done' }, { action: 'reopen', id: task.id },
    { action: 'comment', id: task.id, text: 'Ready' },
    { action: 'link', id: task.id, dependsOn: 't-2', type: 'blocks' },
    { action: 'unlink', id: task.id, dependsOn: 't-2', type: 'parent-child' },
    { action: 'ask', id: task.id, input: { to: other, ask: 'Ready?', ifYes: 'Go', ifNo: 'Wait' } },
  ];
  for (const value of commands) expect(taskCommandSchema.safeParse(value).success).toBe(true);
  expect(taskCommandSchema.parse(commands.at(-1))).toMatchObject({ input: { answers: 'yes-no' } });
});

it.each([
  { action: 'erase', id: 't-1' },
  { action: 'claim', id: ' ' },
  { action: 'claim', id: 't-1', actor: other },
  { action: 'edit', id: 't-1', input: { owner: other } },
  { action: 'edit', id: 't-1', input: { priority: 5 } },
  { action: 'comment', id: 't-1', text: ' ' },
  { action: 'close', id: 't-1', reason: '' },
  { action: 'link', id: 't-1', dependsOn: 't-2', type: 'other' },
  { action: 'ask', id: 't-1', input: { to: { kind: 'agent', id: 'art' }, ask: 'Go?', ifYes: 'Go', ifNo: 'Wait' } },
])('rejects malformed or identity-bearing command %# before dispatch', command => {
  expect(taskCommandSchema.safeParse(command).success).toBe(false);
});

it('takes a move as a place in the order or as a project for several tasks, and never as a mix', () => {
  const ok = (command: unknown) => taskCommandSchema.safeParse(command).success;
  expect(ok({ action: 'move', id: 't-1', before: null })).toBe(true);
  expect(ok({ action: 'move', ids: ['t-1', 't-2'], project: 'pond' })).toBe(true);
  expect(ok({ action: 'move', ids: ['t-1'], project: null })).toBe(true);
  expect(ok({ action: 'move', ids: Array.from({ length: TASK_MOVE_MAX }, (_, n) => `t-${n + 1}`), project: 'pond' })).toBe(true);
  for (const bad of [{ action: 'move', ids: [], project: 'pond' }, { action: 'move', ids: Array.from({ length: TASK_MOVE_MAX + 1 }, (_, n) => `t-${n + 1}`), project: 'pond' },
    { action: 'move', ids: ['t-1'] }, { action: 'move', ids: ['t-1'], project: '' }, { action: 'move', ids: ['t-1'], before: null }, { action: 'move', id: 't-1', project: 'pond' },
    { action: 'move', ids: ['t-1'], project: 'pond', before: null }, { action: 'move', ids: 't-1', project: 'pond' }]) expect(ok(bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
  expect(TASK_MOVE_MAX).toBe(500);
  const a = create('Buy pump'), b = create('Fit pump');
  expect(send({ action: 'move', ids: [a.id, b.id], project: null })).toEqual({ moved: [] });
  expect(send({ action: 'move', id: b.id, before: a.id })).toMatchObject({ id: b.id });
});
