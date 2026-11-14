import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import { DataLive, dataDiff } from './live.js';

const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).reverse().forEach(fn => fn()); });
function setup() {
  const client = new Database(':memory:'); clean.push(() => client.close());
  createDataSchema(client);
  client.exec(`INSERT INTO members (id, role, joined_at) VALUES ('sam','member','2026-11-14T00:00:00.000Z');
    INSERT INTO projects (id,name) VALUES ('pond','Pond');
    INSERT INTO project_members (project,member) VALUES ('pond','sam');
    INSERT INTO tasks (id,title,owner_kind,owner,project,created_by_kind,created_by,created_at,changed_at)
    VALUES ('t-1','Pump','member','sam','pond','member','sam','2026-11-14T00:00:00.000Z','2026-11-14T00:00:00.000Z');`);
  const schema = dataQueries(client, { tables: ['tasks', 'taskComments'], visibility: taskVisibility({ kind: 'member', id: 'sam' }) });
  const live = new DataLive(); clean.push(() => live.close());
  const watch = (query = '{ tasks { id title commentCount } }', valid = () => true) => {
    const stream = live.watch({ schema, query, valid }); clean.push(() => { void stream.return?.(); }); return stream;
  };
  return { client, live, watch };
}

it('sends selected rows once, then only changed fields and SQL joined counts', async () => {
  const { client, live, watch } = setup(), stream = watch();
  expect((await stream.next()).value).toEqual({ revision: 1, patches: [{ path: [], value: { tasks: [{ id: 't-1', title: 'Pump', commentCount: 0 }] } }] });
  client.exec("UPDATE tasks SET title='New pump'"); live.changed();
  expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['tasks', 0, 'title'], value: 'New pump' }] });
  client.exec("INSERT INTO task_comments (task,seq,actor_kind,actor,at,text) VALUES ('t-1',1,'member','sam','2026-11-14T00:00:00.000Z','Fits')"); live.changed();
  expect((await stream.next()).value).toEqual({ revision: 3, patches: [{ path: ['tasks', 0, 'commentCount'], value: 1 }] });
});

it('removes rows when project access ends, without sending their changed words', async () => {
  const { client, live, watch } = setup(), stream = watch(); await stream.next();
  client.exec("DELETE FROM project_members; UPDATE tasks SET title='Private now'"); live.changed();
  expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['tasks', 0] }] });
});

it('coalesces backpressure against the last delivered revision and respects aliases', async () => {
  const { client, live, watch } = setup(), stream = watch('{ work: tasks { name: title } }'); await stream.next();
  client.exec("UPDATE tasks SET title='Intermediate'"); live.changed();
  client.exec("UPDATE tasks SET title='Final'"); live.changed();
  expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['work', 0, 'name'], value: 'Final' }] });
});

it('does not emit an unchanged selection, and releases a waiting consumer on return', async () => {
  const { live, watch } = setup(), stream = watch(); await stream.next();
  live.changed();
  const pending = stream.next();
  await stream.return?.();
  expect(await pending).toEqual({ done: true, value: undefined });
});

it('ends a waiting selection when its authentication is revoked', async () => {
  const { live, watch } = setup(); let valid = true;
  const stream = watch(undefined, () => valid); await stream.next();
  const pending = stream.next(); valid = false; live.changed();
  await expect(pending).rejects.toThrow('access ended');
  expect(await stream.next()).toEqual({ done: true, value: undefined });
});

it('refuses invalid selections before allocating a subscription', () => {
  const { watch } = setup();
  expect(() => watch('{ tasks { unknown } }')).toThrow('unknown');
  expect(() => watch('mutation { tasks { id } }')).toThrow();
});

it('patches array removals from the end and preserves null values', () => {
  expect(dataDiff([1, 2, 3], [null])).toEqual([
    { path: [0], value: null }, { path: [2] }, { path: [1] },
  ]);
});

it('discards a result invalidated while the generator yields', async () => {
  const { client, live, watch } = setup(), stream = watch();
  const initial = stream.next();
  client.exec("UPDATE tasks SET title='Committed while reading'"); live.changed();
  expect((await initial).value?.patches).toEqual([{ path: [], value: { tasks: [{ id: 't-1', title: 'Committed while reading', commentCount: 0 }] } }]);
});

it('ends a waiting selection when the data source closes', async () => {
  const { live, watch } = setup(), stream = watch(); await stream.next();
  const pending = stream.next(); live.close();
  await expect(pending).rejects.toThrow('access ended');
});
