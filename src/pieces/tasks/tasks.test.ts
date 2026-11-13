import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { runOps } from './fixture-runner.js';
import { apply, emptyState, type Command } from './domain.js';
import { importTasks } from './importer.js';
import { load } from './store.js';
import { runApiClient } from '../../cli/api-client.js';
import { taskCommands } from './commands.js';
import { Readable } from 'node:stream';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const member: Viewer = { kind: 'member', id: 'pollock' };
const dirs: string[] = [], closes: (() => Promise<void>)[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'loom-tasks-')); dirs.push(dir); return dir; };
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
async function loom(dir = home(), clock = new FakeClock(), sharing = fixtureSharing) {
  const app = await startLoom({ home: dir, clock, sharing, authenticate: req => ({ viewer: req.headers.authorization === 'Bearer pollock' ? member : owner, valid: () => true }) });
  closes.push(app.close);
  let seq = 0;
  const call = (op: string, input: Record<string, unknown> = {}, viewer = owner, id = `op-${++seq}`) => {
    const answer = app.operations.call('direct', viewer, `tasks.${op}`, input, id);
    if (!answer.ok) return answer;
    return (answer.value as { result: Record<string, unknown> }).result;
  };
  const command = (op: string, input: Record<string, unknown> = {}, viewer = owner) => call(op, { actor: 'art', at: new Date(clock.now()).toISOString(), ...input }, viewer);
  return { ...app, call, command, clock };
}
const fixtures = readFileSync(new URL('../../../spec/taskstore-core/fixtures.jsonl', import.meta.url), 'utf8').trim().split('\n').map(s => JSON.parse(s));
describe('unchanged taskstore contract on the persisted piece', () => {
  for (const fx of fixtures.filter(f => f.format === 'taskstore/op-sequence@0')) it(fx.id, async () => {
    const app = await loom();
    expect(runOps(fx.input.ops, undefined, c => app.call('command', c))).toEqual(fx.expected.results);
  });
  it('runs every fixture format', () => expect(new Set(fixtures.map(f => f.format))).toEqual(new Set(['taskstore/op-sequence@0', 'taskstore/concurrent-writers@0'])));
  for (const fx of fixtures.filter(f => f.format === 'taskstore/concurrent-writers@0')) it(fx.id, async () => {
    const app = await loom(), { writers, opsPerWriter, sharedTasks } = fx.input;
    const make = (title: string) => app.command('create', { title }).id as string;
    const shared = Array.from({ length: sharedTasks }, (_, i) => make(`Shared ${i}`));
    const plans = Array.from({ length: writers }, (_, w) => {
      const own = make(`Writer ${w}`);
      return Array.from({ length: opsPerWriter }, (_, i) => ({ op: ['comment', 'update', 'close'][i % 3], id: i % 3 === 0 ? shared[(w+i) % shared.length] : i % 3 === 1 ? own : make(`Close ${w} ${i}`), value: `w${w}-i${i}` }));
    });
    const acknowledged: typeof plans[number] = [];
    await Promise.all(plans.map(async (ops, w) => {
      for (const [i, p] of ops.entries()) {
        const input = { id: p.id, actor: `writer-${w}`, at: new Date(app.clock.now()).toISOString(), ...(p.op === 'comment' ? { text: p.value } : p.op === 'close' ? { reason: p.value } : { set: { description: p.value } }) };
        const r = await fetch(`${app.url}/api/tasks/${p.op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, id: `w${w}-${i}` }) }).then(r => r.json()) as { ok: boolean; value: { result: { ok: boolean } } };
        expect(r.ok && r.value.result.ok).toBe(true); acknowledged.push(p);
      }
    }));
    const tasks = load(app.db).tasks;
    const lost = acknowledged.filter(p => {
      const task = tasks.find(t => t.id === p.id)!;
      if (p.op === 'comment') return task.comments.filter(c => c.text === p.value).length !== 1;
      if (p.op === 'close') return task.status !== 'closed' || task.closeReason !== p.value;
      const last = acknowledged.filter(a => a.op === 'update' && a.id === p.id).at(-1)!;
      return task.description !== last.value;
    }).map(p => p.value);
    expect(acknowledged).toHaveLength(writers * opsPerWriter);
    expect({ lost }).toEqual(fx.expected);
  }, 30000);
});
function inbox(ws: WebSocket) {
  const q: any[] = [], waiting: ((v: any) => void)[] = [];
  ws.on('message', raw => { const v = JSON.parse(raw.toString()); const waiter = waiting.shift(); if (waiter) waiter(v); else q.push(v); });
  return () => q.length ? Promise.resolve(q.shift()) : new Promise<any>(resolve => waiting.push(resolve));
}
async function socket(app: { url: string }, viewer = 'jonathan') {
  const ws = new WebSocket(`${app.url.replace('http:', 'ws:')}/live`, { headers: { authorization: `Bearer ${viewer}` } });
  const next = inbox(ws); await once(ws, 'open');
  closes.push(async () => { if (ws.readyState === WebSocket.CLOSED) return; const closed = once(ws, 'close'); ws.terminate(); await closed; });
  ws.send(JSON.stringify({ kind: 'subscribe', type: 'task' }));
  return { ws, next };
}
describe('policy, live records, retry and role binding', () => {
  it('filters every collection, inherits parent scope, denies hidden references and checks both sides of moves', async () => {
    const app = await loom();
    const pond = app.command('create', { title: 'Pond work', type: 'epic', project: 'pond', agent: 'art' }).id;
    const child = app.command('create', { title: 'Child', parent: pond }).id;
    const hidden = app.command('create', { title: 'Hidden', project: 'other', agent: 'pond-bot', specItemRef: 'secret' }).id;
    const privateTask = app.command('create', { title: 'Personal', agent: 'pond-bot' }).id;
    expect(app.call('show', { id: child }, member)).toMatchObject({ task: { project: 'pond' } });
    expect(app.call('show', { id: child }, member).task).not.toHaveProperty('agent');
    const explicit = app.command('create', { title: 'Explicit agent', parent: pond, agent: 'pond-bot' }).id;
    expect(app.call('show', { id: explicit }, member)).toMatchObject({ task: { agent: 'pond-bot' } });
    expect(app.call('show', { id: hidden }, member)).toMatchObject({ code: 'denied' });
    expect(app.command('close', { id: hidden }, member)).toMatchObject({ code: 'denied' });
    expect(app.command('update', { id: hidden, set: { project: 'pond' } }, member)).toMatchObject({ code: 'denied' });
    expect(app.call('show', { id: hidden })).toMatchObject({ task: { project: 'other' } });
    expect(app.command('create', { title: 'Leak id', project: 'pond', specItemRef: 'secret' }, member)).toMatchObject({ code: 'denied' });
    expect(app.command('create', { title: 'Smuggle agent', project: 'pond', agent: 'art' }, member)).toMatchObject({ code: 'denied' });
    expect(app.command('update', { id: child, set: { project: 'other' } }, member)).toMatchObject({ code: 'denied' });
    expect(app.call('show', { id: privateTask }, member)).toMatchObject({ ok: true });
    expect(app.command('link', { id: hidden, dependsOn: privateTask, type: 'blocks' }, member)).toMatchObject({ code: 'denied' });
    expect(app.command('unlink', { id: privateTask, dependsOn: hidden, type: 'blocks' }, member)).toMatchObject({ code: 'denied' });
    expect(app.command('link', { id: privateTask, dependsOn: hidden, type: 'blocks' }, member)).toMatchObject({ code: 'denied' });
    for (const op of ['list', 'ready', 'search', 'report', 'export']) {
      const result = app.call(op, op === 'search' ? { q: '' } : {}, member);
      expect(JSON.stringify(result)).not.toContain('Hidden');
      expect(JSON.stringify(result)).not.toContain(String(hidden));
    }
    app.command('link', { id: child, dependsOn: hidden, type: 'blocks' });
    expect((app.call('ready', {}, member).entries as { id: string }[]).map(t => t.id)).not.toContain(child);
    expect(app.call('show', { id: child }, member)).toMatchObject({ task: { dependsOn: [] } });
    expect(app.command('update', { id: child, set: { project: 'other' } })).toMatchObject({ ok: true });
    expect(app.call('show', { id: child }, member)).toMatchObject({ code: 'denied' });
  });
  it('preserves malformed generic discriminator errors as domain values', async () => {
    const app = await loom();
    expect(app.call('command', { op: { toString: null } })).toEqual({ ok: false, errors: ['E_BAD_FIELD'] });
    for (const input of [null, 'create', 42, []]) expect(app.operations.call('direct', owner, 'tasks.command', input, 'malformed')).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('creates after deleting the first task without ordinal collisions', async () => {
    const app = await loom();
    app.command('create', { title: 'First' }); app.command('create', { title: 'Second' });
    expect(app.command('delete', { id: 't-1' })).toMatchObject({ ok: true });
    expect(app.command('create', { title: 'Third' })).toMatchObject({ ok: true, id: 't-3' });
    expect((app.call('list').entries as {id:string}[]).map(t => t.id)).toEqual(['t-2', 't-3']);
  });
  it('requires service type and operation grants; runners see no tasks', async () => {
    const app = await loom();
    const task = app.command('create', { title: 'Household' }).id;
    expect(app.call('show', { id: task }, { kind: 'service', id: 'keyholder' })).toMatchObject({ code: 'denied' });
    expect(app.call('show', { id: task }, { kind: 'runner', id: 'one' })).toMatchObject({ code: 'denied' });
  });
  it('checks imported scopes and both service grant dimensions; role calls use the same policy', async () => {
    const app = await loom(home(), new FakeClock(), () => ({ ...fixtureSharing(), services: {
      typed: { types: ['task'], operations: [] }, operation: { types: [], operations: ['tasks.list'] },
      allowed: { types: ['task'], operations: ['tasks.list', 'tasks.show'] },
    } }));
    const record = { id: 'imported', title: 'Imported', type: 'task', status: 'open', priority: 2, createdAt: '2026-11-01T12:00:00Z', createdBy: 'art', project: 'other' };
    expect(app.command('import', { tasks: [record] }, member)).toMatchObject({ code: 'denied' });
    expect(app.command('import', { tasks: [{ ...record, project: 'pond', agent: 'art' }] }, member)).toMatchObject({ code: 'denied' });
    expect(app.command('import', { tasks: [{ ...record, project: 'pond' }] }, member)).toMatchObject({ ok: true });
    for (const id of ['typed','operation']) expect(app.call('list', {}, { kind: 'service', id })).toMatchObject({ code: 'denied' });
    expect(app.call('list', {}, { kind: 'service', id: 'allowed' })).toMatchObject({ ok: true, entries: [{ id: 'imported' }] });
    const { tasksRole } = await import('./role.js');
    expect(tasksRole(app.operations).call(member, 'show', { id: 'imported' })).toMatchObject({ ok: true, value: { result: { task: { id: 'imported' } } } });
  });
  it('publishes after commit and never publishes a task rolled back by retry-storage failure', async () => {
    const app = await loom();
    const changed = vi.spyOn(app.live, 'changed');
    changed.mockImplementation(changes => { expect(app.db.inTransaction).toBe(false); for (const c of changes) expect(app.db.prepare('SELECT id FROM tasks_tasks WHERE id=?').get(c.id)).toBeDefined(); });
    app.command('create', { title: 'Committed' }); expect(changed).toHaveBeenCalledOnce(); changed.mockClear();
    app.db.exec("CREATE TRIGGER fail_retry BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    expect(app.command('create', { title: 'Rolled back' })).toMatchObject({ code: 'unavailable' });
    expect(changed).not.toHaveBeenCalled(); expect(load(app.db).tasks).toHaveLength(1);
  });
  it('sends committed changes to two windows and ages closed tasks out exactly at one week', async () => {
    const app = await loom(), a = await socket(app), b = await socket(app, 'pollock');
    expect(await a.next()).toMatchObject({ kind: 'set', records: [] });
    expect(await b.next()).toMatchObject({ kind: 'set', records: [] });
    const id = app.command('create', { title: 'Shared', project: 'pond' }).id;
    expect(await a.next()).toMatchObject({ kind: 'put', record: { id } });
    expect(await b.next()).toMatchObject({ kind: 'put', record: { id } });
    app.command('close', { id });
    expect(await a.next()).toMatchObject({ record: { status: 'closed' } }); await b.next();
    app.clock.advance(7 * 86400_000 - 1);
    const liveBoundary = await socket(app);
    expect(await liveBoundary.next()).toMatchObject({ kind: 'set', records: [{ id }] });
    expect(app.call('list').entries).toHaveLength(1);
    app.clock.advance(1);
    expect(await a.next()).toMatchObject({ kind: 'del', id }); expect(await b.next()).toMatchObject({ kind: 'del', id });
    expect(await liveBoundary.next()).toMatchObject({ kind: 'del', id });
    expect(app.call('show', { id })).toMatchObject({ task: { status: 'closed' } });
    app.command('comment', { id, text: 'Recent change' });
    expect(await a.next()).toMatchObject({ kind: 'put', record: { id, comments: [{ text: 'Recent change' }] } });
  });
  it('refreshes relation projections when a referenced task moves out of view', async () => {
    const app = await loom();
    const child = app.command('create', { title: 'Child', project: 'pond' }).id;
    const blocker = app.command('create', { title: 'Blocker', project: 'pond' }).id;
    app.command('link', { id: child, dependsOn: blocker, type: 'blocks' });
    const watcher = await socket(app, 'pollock');
    expect(await watcher.next()).toMatchObject({ kind: 'set', records: [{ id: child, dependsOn: [blocker] }, { id: blocker }] });
    app.command('update', { id: blocker, set: { project: 'other' } });
    expect(await watcher.next()).toMatchObject({ kind: 'del', id: blocker });
    expect(await watcher.next()).toMatchObject({ kind: 'put', record: { id: child, dependsOn: [] } });
  });
  it('retains unchanged task timestamps, rolls failures back, and retries a write across restart once', async () => {
    const dir = home(); let app = await loom(dir);
    const first = app.command('create', { title: 'First' }).id;
    const before = app.db.prepare('SELECT changed_at FROM tasks_tasks WHERE id=?').get(first);
    app.clock.advance(1000); app.command('create', { title: 'Second' });
    expect(app.db.prepare('SELECT changed_at FROM tasks_tasks WHERE id=?').get(first)).toEqual(before);
    const input = { id: first, actor: 'art', at: new Date(app.clock.now()).toISOString(), text: 'Exactly once' };
    const answer = app.call('comment', input, owner, 'retry');
    await app.close(); closes.pop(); app = await loom(dir);
    expect(app.call('comment', input, owner, 'retry')).toEqual(answer);
    expect(app.call('show', { id: first })).toMatchObject({ task: { comments: [{ text: 'Exactly once' }] } });
    expect(app.command('update', { id: first, set: { priority: 999 } })).toMatchObject({ ok: false });
    expect(app.call('show', { id: first })).toMatchObject({ task: { priority: 2 } });
  });
});
function source(path: string) {
  const db = new Database(path); db.exec('CREATE TABLE tasks(ord INTEGER PRIMARY KEY,id TEXT,record TEXT); CREATE TABLE links(ord INTEGER PRIMARY KEY,record TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
  const seed = apply(emptyState(), { op: 'import', tasks: [
    { id: 't-10', title: 'Epic', type: 'epic', status: 'open', priority: 1, createdAt: '2026-11-01T12:00:00Z', createdBy: 'art', project: 'pond' },
    { id: 't-12', title: 'Child', type: 'task', status: 'closed', priority: 2, createdAt: '2026-11-01T12:00:00Z', createdBy: 'art', closedAt: '2026-11-02T12:00:00Z', comments: [{ actor: 'art', at: '2026-11-01T12:00:00Z', text: 'Keep me' }] },
    { id: 'loose', title: 'Unfiled', type: 'task', status: 'open', priority: 2, createdAt: '2026-11-01T12:00:00Z', createdBy: 'art', project: 'other', agent: 'art' },
  ], links: [{ id: 't-12', dependsOn: 't-10', type: 'parent-child' }], actor: 'art', at: '2026-11-01T12:00:00Z' }).state;
  Object.assign(seed.tasks[0], { project: 'pond' }); Object.assign(seed.tasks[2], { project: 'other', agent: 'art' });
  seed.tasks.forEach((t,i) => db.prepare('INSERT INTO tasks VALUES (?,?,?)').run(i,t.id,JSON.stringify(t)));
  seed.links.forEach((l,i) => db.prepare('INSERT INTO links VALUES (?,?)').run(i,JSON.stringify(l)));
  db.prepare("INSERT INTO meta VALUES ('seq','19')").run(); db.close(); return { ...seed, seq: 19 };
}
describe('offline transactional importer', () => {
  it('copies ids/counts/content, infers epic projects, repeats by checksum, refuses another source, and rolls interruption back', async () => {
    const dir = home(), path = join(dir, 'source.db'), original = source(path), app = await loom();
    expect(() => importTasks(app.db, path, app.clock.now(), { interrupt: () => { throw new Error('power lost'); } })).toThrow('power lost');
    expect(load(app.db)).toEqual(emptyState());
    expect(app.db.prepare("SELECT * FROM tasks_meta WHERE key='source-checksum'").get()).toBeUndefined();
    expect(importTasks(app.db, path, app.clock.now())).toMatchObject({ ok: true, imported: true, tasks: 3, links: 1 });
    expect(load(app.db)).toEqual({ ...original, tasks: [original.tasks[0], { ...original.tasks[1], project: 'pond' }, Object.fromEntries(Object.entries(original.tasks[2]).filter(([k]) => k !== 'project'))] });
    const held = load(app.db), timestamps = app.db.prepare('SELECT id, changed_at FROM tasks_tasks ORDER BY ord').all();
    expect(importTasks(app.db, path, app.clock.now())).toMatchObject({ imported: false });
    expect(load(app.db)).toEqual(held);
    expect(app.db.prepare('SELECT id, changed_at FROM tasks_tasks ORDER BY ord').all()).toEqual(timestamps);
    const sourceDb = new Database(path); sourceDb.prepare("UPDATE meta SET value='20' WHERE key='seq'").run(); sourceDb.close();
    expect(() => importTasks(app.db, path, app.clock.now())).toThrow('different tasks source');
  });
  it('reads one WAL snapshot while a second source connection commits between reads', async () => {
    const path = join(home(), 'source.db'), original = source(path), app = await loom();
    const writer = new Database(path); writer.pragma('journal_mode = WAL');
    try {
      expect(importTasks(app.db, path, app.clock.now(), { afterSourceTasks: () => {
        writer.transaction(() => { writer.prepare("UPDATE meta SET value='20' WHERE key='seq'").run(); writer.exec('DELETE FROM links'); })();
      } })).toMatchObject({ imported: true });
      expect(load(app.db)).toMatchObject({ seq: original.seq, links: original.links });
    } finally { writer.close(); }
  });
  it('refuses a comparison mismatch, invalid sequence and mapping changes; explicit epic maps work', async () => {
    const dir = home(), path = join(dir, 'source.db'); source(path); const app = await loom();
    app.db.exec("CREATE TABLE example_sentinel (value TEXT); INSERT INTO example_sentinel VALUES ('untouched')");
    expect(() => importTasks(app.db, path, app.clock.now(), { interrupt: () => { app.db.prepare("UPDATE tasks_tasks SET record='{}' WHERE id='t-12'").run(); } })).toThrow('comparison failed');
    expect(load(app.db)).toEqual(emptyState());
    const raw = new Database(path); raw.prepare("UPDATE meta SET value='1' WHERE key='seq'").run(); raw.close();
    expect(() => importTasks(app.db, path, app.clock.now())).toThrow('reuse');
    const fixed = new Database(path); fixed.prepare("UPDATE meta SET value='19' WHERE key='seq'").run(); fixed.close();
    expect(() => importTasks(app.db, path, app.clock.now(), { projects: { 't-10': 'other' } })).toThrow('conflicts');
    const legacy = new Database(path); const epic = JSON.parse((legacy.prepare("SELECT record FROM tasks WHERE id='t-10'").get() as {record:string}).record); delete epic.project; legacy.prepare("UPDATE tasks SET record=? WHERE id='t-10'").run(JSON.stringify(epic)); legacy.close();
    expect(importTasks(app.db, path, app.clock.now(), { projects: { 't-10': 'other' } })).toMatchObject({ imported: true });
    expect(app.db.prepare('SELECT value FROM example_sentinel').all()).toEqual([{ value: 'untouched' }]);
    expect(load(app.db).tasks.find(t => t.id === 't-12')).toMatchObject({ project: 'other' });
    expect(() => importTasks(app.db, path, app.clock.now(), { projects: { 't-10': 'pond' } })).toThrow('different tasks source');
  });

});

import { legacyFixture } from './legacy.fixture.js';
describe('generated client parity against the frozen legacy binding', () => {
  it('matches JSON, stderr and exit code for every verb, misses, warnings, refusal, usage and file comments', async () => {
    const app = await loom(), tokenFile = join(home(), 'token'); writeFileSync(tokenFile, 'jonathan');
    const env = { LOOM_URL: `${app.url}/mcp`, LOOM_TOKEN_FILE: tokenFile, TASKSTORE_ACTOR: 'art' };
    const old = legacyFixture();
    const file = join(home(), 'comment.txt'); writeFileSync(file, 'A long comment\nwith `quotes` and $dollars.\n');
    const payload = join(home(), 'import.json'); writeFileSync(payload, JSON.stringify({ at: 'invalid payload timestamp', actor: 'intruder', cli: false, tasks: [{ id: 'legacy', title: 'Imported', type: 'task', status: 'open', priority: 1, createdAt: '2026-11-01T12:00:00Z', createdBy: 'art' }], links: [] }));
    const cases = [
      ['create','First','--goal','It works','--why','Needed'], ['create','Second','--goal','It works','--why','Needed'],
      ['ready'], ['show','t-1'], ['claim','t-1'], ['unclaim','t-1'],
      ['link','t-2','t-1','--type','blocks'], ['link','t-2','t-1','--type','blocks'], ['ready'],
      ['unlink','t-2','t-1','--type','blocks'], ['unlink','t-2','t-1','--type','blocks'], ['unlink','t-2','t-1'], ['unlink'],
      ['update','t-1','--title','Changed','--priority','0','--description','Details'],
      ['comment','t-1','Words'], ['comment','t-1','--file',file],
      ['close','t-1','--reason','Done'], ['close','t-1'], ['reopen','t-1'],
      ['list'], ['list','--status','open'], ['search','Changed'], ['report'], ['export'],
      ['import',payload], ['delete','legacy'],
      ['create','Needs summary'], ['update','t-1','--assignee','jonathan'],
      ['create','t-42: jitter wake r2'], ['create','--bogus','x'], ['frobnicate'], [], ['show','unknown'], ['update','t-1','--priority','9'],
    ];
    for (const args of cases) {
      const legacy = old(args, new Date(app.clock.now()).toISOString(), env);
      let stdout = '', stderr = '';
      const status = await runApiClient('tasks', taskCommands, args, { env, stdin: Readable.from([]), stdinIsTTY: false, stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
      expect({ stdout, stderr, status }, args.join(' ')).toEqual(legacy);
    }
  });
  it('stamps conversation sources, accepts stdin, and never falls back to TASKSTORE_DB', async () => {
    const app = await loom(), dir = home(), token = join(dir, 'token'); writeFileSync(token,'jonathan');
    const env = { LOOM_URL: app.url, LOOM_TOKEN_FILE: token, TASKSTORE_DB: join(dir,'must-not-exist.db'), LOOM_BODY_CONVERSATION: 'cv-0123456789ab' };
    const run = async (argv: string[], text = '') => {
      let output = ''; const status = await runApiClient('tasks', taskCommands, argv, { env, stdin: Readable.from([text]), stdinIsTTY: false, stdout: s => { output += s; }, stderr: () => {} }, { request: fetch, retry: async ms => { app.clock.advance(ms); } }); return { status, result: JSON.parse(output) };
    };
    expect((await run(['create','From conversation','--goal','Ready'])).status).toBe(0);
    expect((await run(['comment','t-1','--file','-'],'Hello\n')).status).toBe(0);
    expect((await run(['show','t-1'])).result.task).toMatchObject({ source: 'conversation:cv-0123456789ab', comments: [{ text: 'Hello' }] });
    const { existsSync } = await import('node:fs'); expect(existsSync(env.TASKSTORE_DB)).toBe(false);
    await app.close(); closes.pop();
    expect((await run(['list'])).result).toMatchObject({ ok: false, errors: ['E_UNAVAILABLE'] });
    expect(existsSync(env.TASKSTORE_DB)).toBe(false);
  });
});

describe('client retry transport', () => {
  it('keeps one id across a lost committed response, bounds retries, and handles null responses', async () => {
    const app = await loom(), token = join(home(),'token'); writeFileSync(token,'jonathan');
    const requests: string[] = [], waits: number[] = []; let out = '';
    const io = { env: { LOOM_URL: app.url, LOOM_TOKEN_FILE: token }, stdin: Readable.from([]), stdinIsTTY: false, stdout: (s:string) => { out += s; }, stderr: () => {} };
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); requests.push(body.id);
      const answer = app.operations.call('http', owner, 'tasks.create', body.input, body.id);
      if (requests.length === 1) throw new Error('response lost after commit');
      return Response.json(answer);
    }) as unknown as typeof fetch;
    const retry = async (ms:number) => { waits.push(ms); app.clock.advance(ms); };
    expect(await runApiClient('tasks', taskCommands, ['create','Retry once','--goal','Saved once'], io, { request, retry })).toBe(0);
    expect(requests).toHaveLength(2); expect(new Set(requests).size).toBe(1); expect(load(app.db).tasks).toHaveLength(1); expect(waits).toEqual([100]);
    const failing = vi.fn(async () => { throw new Error('offline'); }); waits.length = 0; out = '';
    expect(await runApiClient('tasks', taskCommands, ['list'], io, { request: failing, retry })).toBe(1);
    expect(failing).toHaveBeenCalledTimes(4); expect(waits).toEqual([100,200,300]); expect(JSON.parse(out)).toMatchObject({ errors: ['E_UNAVAILABLE'] });
    out = '';
    expect(await runApiClient('tasks', taskCommands, ['list'], io, { request: async () => Response.json(null), retry })).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, errors: ['E_UNAVAILABLE'] });
  });
});
