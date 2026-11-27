import Database from 'better-sqlite3';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, parse, subscribe, type ExecutionResult } from 'graphql/index.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import { dataSubscriptions } from './subscriptions.js';
import { ExecutionDrain } from './execution.js';
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

it('shares resolver wrappers only inside the same live subscription schema', async () => {
  const live = new DataLive();
  const source = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    label: { type: GraphQLString, args: { suffix: { type: GraphQLString } },
      resolve: (_source, args, context) => context.label + args.suffix },
  } }) });
  let firstActive = true;
  const build = vi.spyOn(ExecutionDrain.prototype, 'schema');
  const first = dataSubscriptions(source, live, () => true, () => firstActive);
  const second = dataSubscriptions(source, live, () => true);
  const document = parse(`subscription($query: String!, $name: String!, $variables: DataValue) {
    observe(query: $query, operationName: $name, variables: $variables) { patches { value } }
  }`);
  const query = 'query A($s: String) { a: label(suffix:$s) } query B($s: String) { b: label(suffix:$s) }';
  const open = async (schema: GraphQLSchema, label: string) => {
    const name = label === 'one' ? 'A' : 'B';
    const variableValues = { query, name, variables: { s: '-' + label } };
    const stream = await subscribe({ schema, document, variableValues, contextValue: { label } });
    if (!(Symbol.asyncIterator in stream)) throw Error('Expected a live subscription');
    return stream[Symbol.asyncIterator]();
  };
  const read = async (schema: GraphQLSchema, label: string) => {
    const stream = await open(schema, label);
    try {
      const { value } = await stream.next();
      expect((value as ExecutionResult).data).toEqual({ observe: { patches: [{ value: { [label === 'one' ? 'a' : 'b']: label + '-' + label } }] } });
    } finally { await stream.return?.(); }
  };
  try {
    expect(build).not.toHaveBeenCalled();
    await read(first, 'one');
    await read(first, 'two');
    expect(build).toHaveBeenCalledTimes(1);
    await read(second, 'other socket');
    expect(build).toHaveBeenCalledTimes(2);
    firstActive = false;
    const ended = await open(first, 'withheld');
    await expect(ended.next()).rejects.toThrow('Data access ended');
    await read(second, 'still active');
    expect(build).toHaveBeenCalledTimes(2);
  } finally { build.mockRestore(); live.close(); await live.drain(); }
});

it('keeps distinct source schemas for a transport and preserves standalone method guards', async () => {
  const live = new DataLive();
  const schema = (value: string) => new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    value: { type: GraphQLString, resolve: () => value },
  } }) });
  const a = schema('a'), b = schema('b');
  const guard = live.transportGuard(() => true);
  const build = vi.spyOn(ExecutionDrain.prototype, 'schema');
  const query = '{ value }';
  try {
    for (const [source, expected] of [[a, 'a'], [b, 'b'], [a, 'a']] as const) {
      const stream = live.watch({ schema: source, query, valid: () => true, active: guard });
      expect((await stream.next()).value.patches[0].value).toEqual({ value: expected });
      await stream.return?.();
    }
    expect(build).toHaveBeenCalledTimes(2);
    const standalone = live.watch({ schema: a, query, valid: () => true, active() { return this.valid(); } });
    expect((await standalone.next()).value.patches[0].value).toEqual({ value: 'a' });
    await standalone.return?.();
  } finally { build.mockRestore(); live.close(); await live.drain(); }
});

function settling(settleMs: number) {
  const client = new Database(':memory:'); clean.push(() => client.close());
  createDataSchema(client);
  client.exec(`INSERT INTO members (id, role, joined_at) VALUES ('sam','member','2026-11-14T00:00:00.000Z');
    INSERT INTO tasks (id,title,owner_kind,owner,created_by_kind,created_by,created_at,changed_at)
    VALUES ('t-1','Pump','member','sam','member','sam','2026-11-14T00:00:00.000Z','2026-11-14T00:00:00.000Z');`);
  let reads = 0;
  const schema = dataQueries(client, { tables: ['tasks'], visibility: taskVisibility({ kind: 'member', id: 'sam' }), fields: { probe: { type: GraphQLString, resolve: () => { reads++; return null; } } } });
  const live = new DataLive(undefined, settleMs); clean.push(() => live.close());
  const stream = live.watch({ schema, query: '{ probe tasks { title } }', valid: () => true }); clean.push(() => { void stream.return?.(); });
  const title = (words: string) => { client.prepare('UPDATE tasks SET title=?').run(words); live.changed(); };
  const turn = () => new Promise(resolve => setImmediate(resolve));
  return { live, stream, title, turn, reads: () => reads };
}

/** The settle time is counted on a clock these tests move by hand, so none of them depends on how fast it runs. */
const clockInHand = () => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); clean.push(() => vi.useRealTimers()); };

it('reads a lone commit at once, and commits that come faster than the settle time together, ending on the last', async () => {
  clockInHand();
  const { stream, title, turn, reads } = settling(1000);
  await stream.next();
  expect(reads()).toBe(1);
  // A commit that comes alone, longer after the last reading than the settle time, does not wait: no time passes here.
  vi.advanceTimersByTime(1001);
  title('One');
  expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['tasks', 0, 'title'], value: 'One' }] });
  expect(reads()).toBe(2);
  // Ten more, each in its own turn of the loop, inside the settle time: none is read until the time is up, then
  // all are read together, once, and the answer is the last of them.
  const pending = stream.next();
  for (let i = 0; i < 10; i++) { title('Burst ' + i); await turn(); }
  await vi.advanceTimersByTimeAsync(999);
  expect(reads()).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).value).toEqual({ revision: 3, patches: [{ path: ['tasks', 0, 'title'], value: 'Burst 9' }] });
  expect(reads()).toBe(3);
});

it('reads again for a commit that lands while a selection is being read or waits its turn, so the last commit is always answered', async () => {
  clockInHand();
  const { stream, title, turn, reads } = settling(1000);
  await stream.next();
  vi.advanceTimersByTime(1001);
  title('First');
  const pending = stream.next();
  // The reading has begun and has not answered: this commit makes it stale. It is not sent, and the selection
  // is read again when its turn comes.
  title('During the reading');
  await turn();
  expect(reads()).toBe(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).value).toEqual({ revision: 2, patches: [{ path: ['tasks', 0, 'title'], value: 'During the reading' }] });
  // One that lands while the next reading waits its turn is in that reading, and so is the one after it.
  title('Waiting its turn');
  const next = stream.next();
  await turn();
  title('Last');
  await vi.advanceTimersByTimeAsync(1000);
  expect((await next).value).toEqual({ revision: 3, patches: [{ path: ['tasks', 0, 'title'], value: 'Last' }] });
  expect(reads()).toBe(4);
});

it('does not hold an ending selection or a closing source for the settle time', async () => {
  clockInHand();
  // A commit just after a reading waits its turn, and here the clock never moves. Ending the selection, or closing
  // the source, does not wait for it.
  const { stream, title, turn } = settling(1000);
  await stream.next();
  title('One');
  const waiting = stream.next();
  await turn();
  await stream.return?.();
  expect(await waiting).toEqual({ done: true, value: undefined });
  const second = settling(1000);
  await second.stream.next();
  second.title('One');
  const held = second.stream.next();
  await second.turn();
  second.live.close();
  await expect(held).rejects.toThrow('access ended');
});

it('reads every commit on its own when no settle time is set, as before', async () => {
  const { stream, title, turn, reads } = settling(0);
  await stream.next();
  const got: unknown[] = [];
  for (let i = 0; i < 5; i++) { title('Each ' + i); got.push((await stream.next()).value?.patches[0]?.value); await turn(); }
  expect(got).toEqual(['Each 0', 'Each 1', 'Each 2', 'Each 3', 'Each 4']);
  expect(reads()).toBe(6);
});
