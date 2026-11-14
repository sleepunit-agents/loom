import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { taskService } from '../../apps/tasks.js';
import { createDataSchema } from './database.js';
import { DataLive } from './live.js';
import { dataQueries } from './queries.js';
import { members, projectMembers, projects } from './schema.js';
import { taskVisibility } from './visibility.js';
import { DataWrites } from './writes.js';

const at = '2026-11-14T00:00:00.000Z';
const actor = { kind: 'member', id: 'sam' } as const;
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));

/** A new fake household, with the actual service, query and commit boundary.
 * No HTTP fixture, legacy stores, timers or filesystem home are involved. */
function household() {
  const reads: string[] = [];
  const client = new Database(':memory:', { verbose(statement) {
    if (/^select\b/i.test(statement)) reads.push(statement);
  } });
  cleanup.push(() => client.close());
  const db = createDataSchema(client, () => at);
  db.insert(members).values([
    { id: 'sam', role: 'member', joinedAt: at },
    { id: 'owner', role: 'owner', joinedAt: at },
  ]).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run();
  const tasks = taskService(db, () => at);
  const task = tasks.create({ title: 'Pump', goal: 'Water flows', why: 'Pond needs water', project: 'pond', owner: actor }, actor);
  const live = new DataLive();
  cleanup.push(() => live.close());
  const refreshAccess = vi.fn(() => { expect(client.inTransaction).toBe(false); });
  const changed = vi.fn(() => {
    expect(client.inTransaction).toBe(false);
    live.changed();
  });
  const writes = new DataWrites(db, { refreshAccess, changed });
  const watch = (id = 'sam') => {
    const schema = dataQueries(client, {
      tables: ['tasks', 'taskComments', 'projects'],
      visibility: taskVisibility({ kind: 'member', id }),
    });
    const stream = live.watch({ schema, query: '{ tasks { id title commentCount projectRow { name } } }', valid: () => true });
    cleanup.push(() => { void stream.return?.(); });
    return stream;
  };
  return { db, reads, tasks, task, writes, watch, refreshAccess, changed };
}

it('streams a committed service transaction as one selected delta with SQL joined counts', async () => {
  const home = household(), stream = home.watch();
  home.reads.length = 0;
  expect((await stream.next()).value).toEqual({ revision: 1, patches: [{ path: [], value: {
    tasks: [{ id: home.task.id, title: 'Pump', commentCount: 0, projectRow: { name: 'Pond' } }],
  } }] });
  expect(home.reads).toHaveLength(1);
  expect(home.reads[0]).toContain('count(*)');
  const pending = stream.next();
  const result = home.writes.run(() => {
    home.tasks.edit(home.task.id, { title: 'New pump' });
    home.writes.run(() => home.tasks.comment(home.task.id, 'Fits', actor));
    expect(home.changed).not.toHaveBeenCalled();
    return home.task.id;
  });
  expect(result).toEqual({ value: home.task.id, notificationErrors: [] });
  home.reads.length = 0;
  expect((await pending).value).toEqual({ revision: 2, patches: [
    { path: ['tasks', 0, 'title'], value: 'New pump' },
    { path: ['tasks', 0, 'commentCount'], value: 1 },
  ] });
  expect(home.reads).toHaveLength(1);
  expect(home.refreshAccess).toHaveBeenCalledOnce();
  expect(home.changed).toHaveBeenCalledOnce();
});

it('keeps nested service writes and sharing changes out of the stream when the outer transaction fails', async () => {
  const home = household(), stream = home.watch();
  await stream.next();
  const pending = stream.next();
  expect(() => home.writes.run(() => {
    home.tasks.edit(home.task.id, { title: 'Never committed' });
    home.tasks.comment(home.task.id, 'Never published', actor);
    home.db.delete(projectMembers).run();
    throw new Error('command receipt failed');
  })).toThrow('command receipt failed');
  expect(home.refreshAccess).not.toHaveBeenCalled();
  expect(home.changed).not.toHaveBeenCalled();
  home.writes.run(() => home.tasks.comment(home.task.id, 'Committed', actor));
  expect((await pending).value).toEqual({ revision: 2, patches: [
    { path: ['tasks', 0, 'commentCount'], value: 1 },
  ] });
  expect(home.tasks.get(home.task.id).title).toBe('Pump');
  expect(home.tasks.get(home.task.id).comments.map(comment => comment.text)).toEqual(['Committed']);
});

it('rechecks sharing in retained schemas while the owner continues receiving committed fields', async () => {
  const home = household(), member = home.watch(), owner = home.watch('owner');
  await member.next(); await owner.next();
  const memberChange = member.next(), ownerChange = owner.next();
  home.writes.run(() => {
    home.db.delete(projectMembers).where(eq(projectMembers.member, 'sam')).run();
    home.tasks.edit(home.task.id, { title: 'Private now' });
    home.tasks.comment(home.task.id, 'Private comment', actor);
  });
  expect((await memberChange).value).toEqual({ revision: 2, patches: [{ path: ['tasks', 0] }] });
  expect((await ownerChange).value).toEqual({ revision: 2, patches: [
    { path: ['tasks', 0, 'title'], value: 'Private now' },
    { path: ['tasks', 0, 'commentCount'], value: 1 },
  ] });
  const restored = member.next();
  home.writes.run(() => home.db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run());
  expect((await restored).value).toEqual({ revision: 3, patches: [{ path: ['tasks', 0], value: {
    id: home.task.id, title: 'Private now', commentCount: 1, projectRow: { name: 'Pond' },
  } }] });
});
