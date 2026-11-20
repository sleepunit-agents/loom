import Database from 'better-sqlite3';
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql/index.js';
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

function heldSelection(update = false) {
  let release!: (value: string) => void, reject!: (error: Error) => void;
  const result = new Promise<string>((resolve, fail) => { release = resolve; reject = fail; });
  let first = true;
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    title: { type: GraphQLString, resolve: () => { if (update && first) { first = false; return 'Initial'; } return result; } },
  } }) });
  const live = new DataLive(); clean.push(() => { release('Late result'); live.close(); });
  const stream = live.watch({ schema, query: '{ title }', valid: () => true });
  return { live, stream, release, reject };
}

it.each([false, true])('releases an executing selection on return before its resolver completes (update=%s)', async update => {
  const { live, stream, release } = heldSelection(update);
  if (update) { await stream.next(); live.changed(); }
  const pending = stream.next();
  await stream.return?.();
  expect(await pending).toEqual({ done: true, value: undefined });
  release('Late result');
  expect(await stream.next()).toEqual({ done: true, value: undefined });
});

it.each([false, true])('ends an executing selection on close before its resolver completes (update=%s)', async update => {
  const { live, stream, release } = heldSelection(update);
  if (update) { await stream.next(); live.changed(); }
  const pending = stream.next().then(value => value, error => error);
  live.close();
  const outcome = await pending;
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain('access ended');
  release('Late result');
  expect(await stream.next()).toEqual({ done: true, value: undefined });
});

it('refuses a new selection after shutdown', () => {
  const { live, watch } = setup(); live.close();
  expect(() => watch()).toThrow('access ended');
});

it.each(['resolve', 'reject'])('drains an underlying %s execution after its consumer cancels', async outcome => {
  const { live, stream, release, reject } = heldSelection();
  const pending = stream.next();
  await stream.return?.();
  expect(await pending).toEqual({ done: true, value: undefined });
  let drained = false;
  const closing = live.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  if (outcome === 'resolve') release('Late result'); else reject(new Error('Late failure'));
  await closing;
  expect(drained).toBe(true);
});

it('measures only initial snapshot work and does not measure its own notification rerun or idle subscription', async () => {
  let value='first', reads=0, measurements=0;
  let live:DataLive;
  live=new DataLive(async work=>{const result=await work();measurements++;live.changed();return result;});
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:{value:{type:GraphQLString,resolve(){reads++;return value;}}}})});
  const stream=live.watch({schema,query:'{ value }',valid:()=>true});
  try {
    expect((await stream.next()).value).toEqual({revision:1,patches:[{path:[],value:{value:'first'}}]});
    expect(reads).toBe(2);expect(measurements).toBe(1);
    const changed=stream.next();value='second';live.changed();
    expect((await changed).value).toEqual({revision:2,patches:[{path:['value'],value:'second'}]});
    expect(reads).toBe(3);expect(measurements).toBe(1);
  } finally {await stream.return?.();live.close();await live.drain();}
});


it('stamp notifications wake selections without reviving a read invalidated by a private write',async()=>{
 const {live,watch}=setup(),context={};
 const stream=watch();await stream.next();
 live.captureRead(context);const version=live.readVersion(context);
 live.metadataChanged();expect(live.currentRead(version)).toBe(true);
 live.changed();expect(live.currentRead(version)).toBe(false);
 live.metadataChanged();expect(live.currentRead(version)).toBe(false);
 live.close();expect(live.currentRead(live.epoch())).toBe(false);
});

it('still ends on a resolver error when no committed change invalidated that read',async()=>{
  const {stream,reject}=heldSelection();
  const pending=stream.next();reject(new Error('Stable resolver failure'));
  await expect(pending).rejects.toThrow('Stable resolver failure');
  expect(await stream.next()).toEqual({done:true,value:undefined});
});

it('does not hide a resolver error during a stamp notification',async()=>{
  const {live,stream,reject}=heldSelection();
  const pending=stream.next();live.metadataChanged();reject(new Error('Stable resolver failure'));
  await expect(pending).rejects.toThrow('Stable resolver failure');
  expect(await stream.next()).toEqual({done:true,value:undefined});
});

it('drains initial read accounting after its consumer cancels', async () => {
  const { client } = setup();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let measured = false;
  const live = new DataLive(async work => { const result = await work(); entered(); await held; client.prepare('SELECT id FROM tasks').all(); measured = true; return result; });
  const schema = dataQueries(client, { tables: ['tasks'], visibility: taskVisibility({ kind: 'member', id: 'sam' }) });
  const stream = live.watch({ schema, query: '{tasks{id}}', valid: () => true });
  const pending = stream.next(); await started; await stream.return?.(); await pending; live.close();
  let drained = false; const closing = live.drain().then(() => { drained = true; });
  try { await Promise.resolve(); expect(drained).toBe(false); release(); await closing; expect(measured).toBe(true); }
  finally { release(); await closing; }
});
