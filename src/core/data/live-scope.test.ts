import Database from 'better-sqlite3';
import { execute, GraphQLObjectType, GraphQLSchema, GraphQLString, parse } from 'graphql/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataSchema, dataDatabase } from './database.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import { DataLive, wouldSkip } from './live.js';
import { liveScope, liveScopeViolations, type LiveScope, type LiveScopeViolation } from './live-scope.js';
import { installTableTracker, markUnscoped, recordReads, tableTracker } from './table-tracker.js';
import { DataWrites } from './writes.js';
import { nextData } from '../../next-data.js';
import { FakeClock } from '../clock.js';

const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).reverse().forEach(fn => fn()); vi.unstubAllEnvs(); });

function setup(scope: LiveScope = 'shadow', report?: (violation: LiveScopeViolation) => void) {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const db = createDataSchema(client);
  client.exec(`INSERT INTO members (id, role, joined_at) VALUES ('sam','member','2026-11-14T00:00:00.000Z');
    INSERT INTO projects (id,name) VALUES ('pond','Pond');
    INSERT INTO project_members (project,member) VALUES ('pond','sam');
    INSERT INTO tasks (id,title,owner_kind,owner,project,created_by_kind,created_by,created_at,changed_at)
    VALUES ('t-1','Pump','member','sam','pond','member','sam','2026-11-14T00:00:00.000Z','2026-11-14T00:00:00.000Z');`);
  const tracker = scope !== 'off' ? installTableTracker(client) : undefined;
  const schema = dataQueries(client, { tables: ['tasks', 'taskComments'], visibility: taskVisibility({ kind: 'member', id: 'sam' }) });
  const live = new DataLive(undefined, 0, 0, scope, report); clean.push(() => live.close());
  const writes = new DataWrites(db, { refreshAccess() {}, changed: written => live.changed(written) }, tracker);
  const watch = (query = '{ tasks { id title } }') => { const stream = live.watch({ schema, query, valid: () => true }); clean.push(() => { void stream.return?.(); }); return stream; };
  return { client, db, schema, live, writes, watch };
}

it('records the tables a selection reads for its viewer, the visibility policy joins included', async () => {
  const { schema } = setup();
  const { record, value } = recordReads(() => execute({ schema, document: parse('{ tasks { id title } }') }));
  expect((await value).data).toEqual({ tasks: [{ id: 't-1', title: 'Pump' }] });
  // tasks is what was asked for; project_members is how sam may see it.
  expect([...record.tables]).toEqual(expect.arrayContaining(['tasks', 'project_members']));
  expect(record.statements).toBeGreaterThan(0);
  expect(record.unscoped.size).toBe(0);
});

it('keeps concurrent readings apart', async () => {
  const { client } = setup();
  const one = recordReads(async () => { await Promise.resolve(); client.prepare('SELECT * FROM tasks').all(); });
  const two = recordReads(async () => { client.prepare('SELECT * FROM projects').all(); await Promise.resolve(); markUnscoped('test'); });
  await Promise.all([one.value, two.value]);
  expect([...one.record.tables]).toEqual(['tasks']);
  expect(one.record.unscoped.size).toBe(0);
  expect([...two.record.tables]).toEqual(['projects']);
  expect([...two.record.unscoped]).toEqual(['test']);
});

it('would skip only a reading whose tables were all known and none of them written', () => {
  const record = { tables: new Set(['tasks']), unscoped: new Set<string>(), statements: 1 };
  expect(wouldSkip(record, new Set(['boxes']))).toBe(true);
  expect(wouldSkip(record, new Set(['tasks', 'boxes']))).toBe(false);
  expect(wouldSkip(record, 'unknown')).toBe(false);
  expect(wouldSkip(undefined, new Set(['boxes']))).toBe(false);
  expect(wouldSkip({ ...record, unscoped: new Set(['the clock']) }, new Set(['boxes']))).toBe(false);
  // Nothing read from the tracked connection: in-process state, or no tracker. Never skippable.
  expect(wouldSkip({ tables: new Set(), unscoped: new Set(), statements: 0 }, new Set(['boxes']))).toBe(false);
});

it('records a violation when scoping would have skipped a reading whose answer changed', async () => {
  const violations: LiveScopeViolation[] = [];
  const { client, live, watch } = setup('shadow', violation => violations.push(violation));
  const stream = watch(); await stream.next();
  // A write that is misreported: tasks changed, the commit claims only boxes.
  client.prepare("UPDATE tasks SET title = 'New pump'").run(); live.changed(new Set(['boxes']));
  expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['tasks', 0, 'title'], value: 'New pump' }] });
  expect(violations).toEqual([{ selection: '{ tasks { id title } }', read: expect.arrayContaining(['tasks', 'project_members']), written: ['boxes'] }]);
});

it('records none when the written tables wake the reading, when the answer did not change, or when the write is unknown', async () => {
  const violations: LiveScopeViolation[] = [];
  const { client, live, writes, watch } = setup('shadow', violation => violations.push(violation));
  client.exec('CREATE TABLE side (x)');
  const stream = watch(); await stream.next();
  writes.run(() => client.prepare("UPDATE tasks SET title = 'Tracked'").run());
  expect((await stream.next()).value).toMatchObject({ revision: 2 });
  // Access through the policy join: removing sam from the project hides the task.
  writes.run(() => client.prepare('DELETE FROM project_members').run());
  expect((await stream.next()).value).toEqual({ revision: 3, patches: [{ path: ['tasks', 0] }] });
  writes.run(() => client.prepare("INSERT INTO project_members (project, member) VALUES ('pond','sam')").run());
  expect((await stream.next()).value).toMatchObject({ revision: 4 });
  // Unknown (exec): always woken, never a violation.
  client.exec("UPDATE tasks SET title = 'Script'"); live.changed();
  expect((await stream.next()).value).toMatchObject({ revision: 5 });
  // Skippable, and rightly: nothing it read was written, and the answer stays the same.
  writes.run(() => client.prepare('INSERT INTO side (x) VALUES (1)').run());
  client.prepare("UPDATE tasks SET title = 'Last'").run(); live.changed(new Set(['tasks']));
  expect((await stream.next()).value).toEqual({ revision: 6, patches: [{ path: ['tasks', 0, 'title'], value: 'Last' }] });
  expect(violations).toEqual([]);
});

it('throws a violation under vitest by default', async () => {
  const { client, live, watch } = setup('shadow');
  const stream = watch(); await stream.next();
  client.prepare("UPDATE tasks SET title = 'Unseen'").run(); live.changed(new Set(['boxes']));
  await expect(stream.next()).rejects.toThrow(/live scope violation: \{ tasks \{ id title \} \} read \[.*tasks.*\], written \[boxes\]/);
  // Taken here so test-setup.ts does not fail this test for the violation it meant to find.
  expect(liveScopeViolations()).toHaveLength(1);
});

it('takes a reading that marks itself unscoped as never skippable', async () => {
  const violations: LiveScopeViolation[] = [];
  const client = new Database(':memory:'); clean.push(() => client.close());
  client.exec("CREATE TABLE things (x); INSERT INTO things VALUES (1)");
  installTableTracker(client);
  let outside = 'a';
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    thing: { type: GraphQLString, resolve: () => { client.prepare('SELECT x FROM things').get(); markUnscoped('in-process'); return outside; } },
  } }) });
  const live = new DataLive(undefined, 0, 0, 'shadow', violation => violations.push(violation)); clean.push(() => live.close());
  const stream = live.watch({ schema, query: '{ thing }', valid: () => true }); clean.push(() => { void stream.return?.(); });
  await stream.next();
  outside = 'b'; live.changed(new Set(['elsewhere']));
  expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['thing'], value: 'b' }] });
  expect(violations).toEqual([]);
});

it('off reads and reports exactly as before, whatever the commit says it wrote', async () => {
  const violations: LiveScopeViolation[] = [];
  const { client, live, watch } = setup('off', violation => violations.push(violation));
  expect(tableTracker(client)).toBeUndefined();
  const stream = watch(); await stream.next();
  client.prepare("UPDATE tasks SET title = 'Off'").run(); live.changed(new Set(['boxes']));
  expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['tasks', 0, 'title'], value: 'Off' }] });
  expect(violations).toEqual([]);
});

it('reads LOOM_LIVE_SCOPE as off, shadow or on, on when unset, refusing anything else', () => {
  expect(liveScope({})).toBe('on');
  expect(liveScope({ LOOM_LIVE_SCOPE: '' })).toBe('on');
  expect(liveScope({ LOOM_LIVE_SCOPE: ' On ' })).toBe('on');
  expect(liveScope({ LOOM_LIVE_SCOPE: 'off' })).toBe('off');
  expect(liveScope({ LOOM_LIVE_SCOPE: ' Shadow ' })).toBe('shadow');
  expect(() => liveScope({ LOOM_LIVE_SCOPE: 'yes' })).toThrow(/must be off, shadow or on/);
});

it('installs the tracker for the shared composition unless off', async () => {
  for (const [value, installed] of [['off', false], ['shadow', true], ['on', true]] as const) {
    vi.stubEnv('LOOM_LIVE_SCOPE', value);
    const client = new Database(':memory:'); clean.push(() => client.close());
    const root = nextData(createDataSchema(client), new FakeClock(), () => true);
    expect(tableTracker(client) !== undefined).toBe(installed);
    await root.close();
  }
});

describe('on', () => {
  /** A selection over one table, counting its readings. */
  function counted(scope: LiveScope = 'on') {
    const parts = setup(scope);
    const { client } = parts;
    client.exec('CREATE TABLE side (x); CREATE TABLE things (x); INSERT INTO things VALUES (1)');
    // The script above is carried into the next commit as unknown; this one takes it, telling nobody.
    parts.writes.run(() => undefined);
    let readings = 0, outside = 'a', unscoped = false;
    const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
      thing: { type: GraphQLString, resolve: () => {
        readings++;
        const x = client.prepare('SELECT x FROM things').pluck().get();
        if (unscoped) { markUnscoped('in-process'); return outside; }
        return String(x);
      } },
    } }) });
    const stream = parts.live.watch({ schema, query: '{ thing }', valid: () => true }); clean.push(() => { void stream.return?.(); });
    return { ...parts, stream, readings: () => readings, setOutside(value: string) { outside = value; }, unscope() { unscoped = true; } };
  }
  const settled = async <T>(promise: Promise<T>) => { let done = false; void promise.then(() => { done = true; }, () => { done = true; }); await new Promise(resolve => setTimeout(resolve, 20)); return done; };

  it('does not read a selection again for a commit that wrote none of its tables, and does for one that did', async () => {
    const { client, writes, stream, readings } = counted();
    expect((await stream.next()).value).toEqual({ revision: 1, patches: [{ path: [], value: { thing: '1' } }] });
    const next = stream.next();
    writes.run(() => client.prepare('INSERT INTO side (x) VALUES (1)').run());
    expect(await settled(next)).toBe(false);
    expect(readings()).toBe(1);
    writes.run(() => client.prepare('UPDATE things SET x = 2').run());
    expect((await next).value).toEqual({ revision: 2, patches: [{ path: ['thing'], value: '2' }] });
    expect(readings()).toBe(2);
  });

  it('off reads it again for every commit', async () => {
    const { client, writes, stream, readings } = counted('off');
    await stream.next();
    const next = stream.next();
    writes.run(() => client.prepare('INSERT INTO side (x) VALUES (1)').run());
    expect(await settled(next)).toBe(false);
    expect(readings()).toBe(2);
  });

  it('wakes a selection for a write to the table its visibility rule read', async () => {
    const { client, writes, watch } = setup('on');
    const stream = watch(); await stream.next();
    writes.run(() => client.prepare('DELETE FROM project_members').run());
    expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['tasks', 0] }] });
  });

  it('wakes every selection for a write whose tables are not known: exec, an untold change, a stamp', async () => {
    const { client, live, writes, stream, readings } = counted();
    await stream.next();
    writes.run(() => client.exec('UPDATE things SET x = 3'));
    expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['thing'], value: '3' }] });
    client.prepare('UPDATE things SET x = 4').run(); live.changed();
    expect((await stream.next()).value).toEqual({ revision: 3, patches: [{ path: ['thing'], value: '4' }] });
    const before = readings();
    live.metadataChanged();
    expect(await settled(stream.next())).toBe(false);
    expect(readings()).toBe(before + 1);
  });

  it('reads a selection that depends on something no table holds again for every commit', async () => {
    const { client, writes, stream, setOutside, unscope } = counted();
    unscope();
    await stream.next();
    setOutside('b');
    writes.run(() => client.prepare('INSERT INTO side (x) VALUES (1)').run());
    expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['thing'], value: 'b' }] });
  });

  it('wakes on the commit, not the statement: a rolled-back write tells nobody, a rolled-back part of a commit over-reports', async () => {
    const { client, writes, stream, readings } = counted();
    await stream.next();
    const next = stream.next();
    expect(() => writes.run(() => { client.prepare('UPDATE things SET x = 5').run(); throw new Error('no'); })).toThrow('no');
    expect(await settled(next)).toBe(false);
    expect(readings()).toBe(1);
    // A savepoint inside the commit rolls its write back; the commit still says it wrote the table, and wakes.
    writes.run(() => {
      client.prepare('INSERT INTO side (x) VALUES (2)').run();
      try { client.transaction(() => { client.prepare('UPDATE things SET x = 6').run(); throw new Error('inner'); })(); } catch { /* rolled back */ }
    });
    expect(await settled(next)).toBe(false);
    expect(readings()).toBe(2);
    expect(client.prepare('SELECT x FROM things').pluck().get()).toBe(1);
  });

  it('carries a write nobody was told of into the next commit, so it is never lost', async () => {
    const { client, writes, stream } = counted();
    await stream.next();
    client.prepare('UPDATE things SET x = 7').run();
    writes.run(() => client.prepare('INSERT INTO side (x) VALUES (3)').run());
    expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['thing'], value: '7' }] });
  });

  it('wakes every selection after another connection wrote the file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'loom-scope-')); clean.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'data.db');
    const client = new Database(file); clean.push(() => client.close());
    client.exec('CREATE TABLE side (x); CREATE TABLE things (x); INSERT INTO things VALUES (1)');
    const tracker = installTableTracker(client);
    const live = new DataLive(undefined, 0, 0, 'on'); clean.push(() => live.close());
    const writes = new DataWrites(dataDatabase(client), { refreshAccess() {}, changed: written => live.changed(written) }, tracker);
    writes.run(() => client.prepare('INSERT INTO side (x) VALUES (0)').run());
    const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
      thing: { type: GraphQLString, resolve: () => String(client.prepare('SELECT x FROM things').pluck().get()) } } }) });
    const stream = live.watch({ schema, query: '{ thing }', valid: () => true }); clean.push(() => { void stream.return?.(); });
    await stream.next();
    const other = new Database(file); clean.push(() => other.close());
    other.prepare('UPDATE things SET x = 8').run();
    writes.run(() => client.prepare('INSERT INTO side (x) VALUES (4)').run());
    expect((await stream.next()).value).toEqual({ revision: 2, patches: [{ path: ['thing'], value: '8' }] });
  });

  it('reads again a reading during which a commit wrote what it read, and not one during which a commit wrote elsewhere', async () => {
    const { client, writes, live } = setup('on');
    client.exec('CREATE TABLE side (x); CREATE TABLE things (x); INSERT INTO things VALUES (1)');
    writes.run(() => undefined);
    // Each reading reads its table, then waits until the test lets it go; the test writes meanwhile.
    let readings = 0, reading: (() => void) | undefined, release: (() => void) | undefined;
    const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
      thing: { type: GraphQLString, resolve: async () => {
        readings++;
        const x = client.prepare('SELECT x FROM things').pluck().get();
        await new Promise<void>(resolve => { release = resolve; reading?.(); });
        return String(x);
      } },
    } }) });
    const underWay = () => new Promise<void>(resolve => { reading = resolve; });
    const context = {};
    const stream = live.watch({ schema, query: '{ thing }', valid: () => true, contextValue: context }); clean.push(() => { void stream.return?.(); });
    let paused = underWay();
    const first = stream.next();
    await paused; paused = underWay();
    writes.run(() => client.prepare('INSERT INTO side (x) VALUES (1)').run());
    release!();
    expect((await first).value).toEqual({ revision: 1, patches: [{ path: [], value: { thing: '1' } }] });
    expect(readings).toBe(1);
    // Its answer holds at the version after that commit, so the socket publishes it rather than reconnecting.
    expect(live.currentRead(live.readVersion(context))).toBe(true);
    writes.run(() => client.prepare('UPDATE things SET x = 2').run());
    const second = stream.next();
    await paused; paused = underWay();
    // The reading that saw 2 is stale before it is sent: it is made again, and the answer is 3.
    writes.run(() => client.prepare('UPDATE things SET x = 3').run());
    release!();
    await paused; release!();
    expect((await second).value).toEqual({ revision: 2, patches: [{ path: ['thing'], value: '3' }] });
    expect(readings).toBe(3);
  });

  it('answers when asked for now, whatever was written', async () => {
    const { client, live, writes } = setup('on');
    client.exec('CREATE TABLE side (x)');
    const schema = dataQueries(client, { tables: ['tasks'], visibility: taskVisibility({ kind: 'member', id: 'sam' }) });
    let now: (() => void) | undefined;
    const stream = live.watch({ schema, query: '{ tasks { id } }', valid: () => true, refresh(ask) { now = ask; return () => {}; } }); clean.push(() => { void stream.return?.(); });
    await stream.next();
    writes.run(() => client.prepare('INSERT INTO side (x) VALUES (1)').run());
    now!();
    expect((await stream.next()).value).toEqual({ revision: 2, patches: [] });
  });
});
