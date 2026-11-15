import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import * as s from './schema.js';
import { DataLive } from './live.js';
import { DataWrites } from './writes.js';

const at = '2026-11-14T00:00:00.000Z';
const clients: Database.Database[] = [];
afterEach(() => clients.splice(0).forEach(client => client.close()));
function fixture() {
  const statements: string[] = [];
  const client = new Database(':memory:', { verbose: sql => { if (/^select\b/i.test(sql)) statements.push(sql); } });
  clients.push(client);
  const db = createDataSchema(client, () => at);
  db.insert(s.members).values({ id: 'sam', role: 'member', joinedAt: at }).run();
  db.insert(s.projects).values([{ id: 'pond', name: 'Pond' }, { id: 'hidden', name: 'Hidden' }]).run();
  db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run();
  for (const [id, status, type, project] of [
    ['a-blocked', 'open', 'task', 'pond'], ['b-ready', 'open', 'task', 'pond'],
    ['c-ready', 'open', 'task', 'pond'], ['epic', 'open', 'epic', 'pond'],
    ['closed', 'closed', 'task', 'pond'], ['held', 'in_progress', 'task', 'pond'],
    ['secret-blocker', 'in_progress', 'task', 'hidden'], ['0-secret-ready', 'open', 'task', 'hidden'],
  ] as const) db.insert(s.tasks).values({ id, title: id, status, type, project, ownerKind: 'household', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
  db.insert(s.taskLinks).values([
    { task: 'a-blocked', dependsOn: 'secret-blocker', type: 'blocks' },
    { task: 'a-blocked', dependsOn: 'closed', type: 'blocks' },
    { task: 'b-ready', dependsOn: 'closed', type: 'blocks' },
    { task: 'c-ready', dependsOn: 'epic', type: 'parent-child' },
  ]).run();
  const schema = dataQueries(client, { tables: ['tasks', 'projects'], visibility: taskVisibility({ kind: 'member', id: 'sam' }) });
  statements.length = 0;
  return { client, db, schema, statements };
}
it('filters readiness and hidden blockers in SQL before pagination, keeping ordinary Tasks unchanged', async () => {
  const { schema, statements } = fixture();
  const result = await graphql({ schema, source: '{ readyTasks(orderBy:{id:{direction:asc,priority:0}},limit:1,offset:1) { id } }' });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ readyTasks: [{ id: 'c-ready' }] });
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('not exists');
  const ordinary = await graphql({ schema, source: '{ tasks(where:{id:{eq:"a-blocked"}}) { id } }' });
  expect(ordinary.errors).toBeUndefined();
  expect(ordinary.data).toEqual({ tasks: [{ id: 'a-blocked' }] });
});
it('rechecks retained schemas on blocker closure, reopening and membership withdrawal', async () => {
  const { db, schema } = fixture();
  const read = () => graphql({ schema, source: '{ readyTasks(orderBy:{id:{direction:asc,priority:0}}) { id } }' });
  expect((await read()).data).toEqual({ readyTasks: [{ id: 'b-ready' }, { id: 'c-ready' }] });
  db.update(s.tasks).set({ status: 'closed' }).where(eq(s.tasks.id, 'secret-blocker')).run();
  expect((await read()).data).toEqual({ readyTasks: [{ id: 'a-blocked' }, { id: 'b-ready' }, { id: 'c-ready' }] });
  db.update(s.tasks).set({ status: 'open' }).where(eq(s.tasks.id, 'closed')).run();
  expect((await read()).data).toEqual({ readyTasks: [{ id: 'c-ready' }, { id: 'closed' }] });
  db.delete(s.projectMembers).run();
  expect((await read()).data).toEqual({ readyTasks: [] });
});
it('does not change nested Tasks selections inside ready rows', async () => {
  const { schema, statements } = fixture();
  const result = await graphql({ schema, source: '{ readyTasks(where:{id:{eq:"c-ready"}}) { id projectRow { tasksByProject(where:{id:{eq:"epic"}}) { id } } } }' });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ readyTasks: [{ id: 'c-ready', projectRow: { tasksByProject: [{ id: 'epic' }] } }] });
  expect(statements).toHaveLength(1);
});

it('streams readiness changes after a hidden blocker commits without disclosing its row', async () => {
  const { db, schema } = fixture();
  const live = new DataLive();
  const writes = new DataWrites(db, { refreshAccess() {}, changed: () => live.changed() });
  const stream = live.watch({ schema, query: '{ selected: readyTasks(where:{id:{eq:"a-blocked"}}) { id } tasks(where:{id:{eq:"a-blocked"}}) { id } }', valid: () => true });
  const second = live.watch({ schema, query: '{ readyTasks(where:{id:{eq:"a-blocked"}}) { id } }', valid: () => true });
  try {
    expect((await second.next()).value.patches).toEqual([{ path: [], value: { readyTasks: [] } }]);
    expect((await stream.next()).value.patches).toEqual([{ path: [], value: { selected: [], tasks: [{ id: 'a-blocked' }] } }]);
    const pending = stream.next(), secondPending = second.next();
    writes.run(() => db.update(s.tasks).set({ status: 'closed' }).where(eq(s.tasks.id, 'secret-blocker')).run());
    expect((await pending).value.patches).toEqual([{ path: ['selected', 0], value: { id: 'a-blocked' } }]);
    expect((await secondPending).value.patches).toEqual([{ path: ['readyTasks', 0], value: { id: 'a-blocked' } }]);
    const revoked = stream.next(), secondRevoked = second.next();
    writes.run(() => db.delete(s.projectMembers).run());
    expect((await revoked).value.patches).toEqual([{ path: ['selected', 0] }, { path: ['tasks', 0] }]);
    expect((await secondRevoked).value.patches).toEqual([{ path: ['readyTasks', 0] }]);
  } finally { await stream.return?.(); await second.return?.(); live.close(); }
});

it('allows installed services to read readiness with an explicit unrestricted SQL policy', async () => {
  const { client, db, statements } = fixture();
  db.delete(s.projectMembers).run();
  const schema = dataQueries(client, { tables: ['tasks'], visibility: { tasks: () => sql`true` } });
  statements.length = 0;
  const result = await graphql({ schema, source: '{ readyTasks(orderBy:{id:{direction:asc,priority:0}}) { id } }' });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ readyTasks: [{ id: '0-secret-ready' }, { id: 'b-ready' }, { id: 'c-ready' }] });
  expect(statements).toHaveLength(1);
});
