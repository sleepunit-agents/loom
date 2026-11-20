import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { startLoom } from '../foundation.js';
import { fixture, fixtureSharing, installFixture } from '../fixture.js';
import { createFoundation } from './app.js';
import { FakeClock, clock as realClock, migrate, openDb, OperationError, type Result, type Viewer } from './index.js';
const homes: string[] = [];
const closes: (() => void | Promise<void>)[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'loom-foundation-')); homes.push(dir); return dir; };
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const pollock: Viewer = { kind: 'member', id: 'pollock' };
function inbox(ws: WebSocket) {
  const queue: unknown[] = [], waiting: ((v: unknown) => void)[] = [];
  ws.on('message', raw => { const v: unknown = JSON.parse(raw.toString()); const next = waiting.shift(); if (next) next(v); else queue.push(v); });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise<unknown>(resolve => waiting.push(resolve));
}
async function socket(url: string, id = 'jonathan') {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers: { authorization: `Bearer ${id}` } });
  const next = inbox(ws); await once(ws, 'open'); closes.push(() => ws.terminate()); return { ws, next };
}
describe('app database and registry', () => {
  it('schedules a thirty-day deadline without overflowing Node timers', () => {
    vi.useFakeTimers();
    try {
      const fired = vi.fn(); const stop = realClock.at(Date.now() + 30 * 86400_000, fired);
      vi.advanceTimersByTime(29 * 86400_000); expect(fired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(86400_000); expect(fired).toHaveBeenCalledTimes(1); stop();
    } finally { vi.useRealTimers(); }
  });
  it('keeps one WAL connection, applies ordered migrations once and rolls failed migrations back', () => {
    const dir = home(), store = openDb(dir); closes.push(store.close);
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
    const second = openDb(dir); expect(second.db).toBe(store.db); second.close();
    const migrations = [{ number: 2, sql: 'ALTER TABLE demo_rows ADD COLUMN title TEXT' }, { number: 1, sql: 'CREATE TABLE demo_rows (id TEXT)' }];
    migrate(store.db, 'demo', migrations); migrate(store.db, 'demo', migrations);
    expect(store.db.prepare('SELECT * FROM core_migrations').all()).toHaveLength(2);
    expect(() => migrate(store.db, 'demo', [{ number: 3, sql: 'CREATE TABLE demo_failed(id); INVALID SQL' }])).toThrow();
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'demo_failed'").get()).toBeUndefined();
    expect(() => migrate(store.db, 'demo', [{ number: 1, sql: 'changed' }])).toThrow('changed');
    expect(() => migrate(store.db, 'demo', [{ number: 3, sql: 'CREATE TABLE wrong_prefix (id TEXT)' }])).toThrow('prefix');
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='wrong_prefix'").get()).toBeUndefined();
  });
  it('retries across restart for 30 days; isolates callers; conflicts on name or input; rolls back failed writes', () => {
    const dir = home(), clock = new FakeClock();
    let app = createFoundation({ home: dir, clock }); installFixture(app);
    const input = { id: 'one', title: 'first', project: 'pond' };
    const result = app.operations.call('http', owner, 'example.put', input, 'same');
    expect(result.ok).toBe(true);
    app.close(); app = createFoundation({ home: dir, clock }); installFixture(app); closes.push(app.close);
    expect(app.operations.call('socket', owner, 'example.put', input, 'same')).toEqual(result);
    expect(app.operations.call('http', owner, 'example.put', { ...input, title: 'different' }, 'same')).toMatchObject({ code: 'conflict' });
    expect(app.operations.call('http', owner, 'example.remove', { id: 'one' }, 'same')).toMatchObject({ code: 'conflict' });
    expect(app.operations.call('http', pollock, 'example.put', { ...input, id: 'two' }, 'same').ok).toBe(true);
    app.operations.register({ name: 'example.fail', output: z.null(), input: z.object({}), write: true, may: () => true, run(ctx) { ctx.db.prepare('DELETE FROM example_records').run(); ctx.changed('example.record', 'one'); throw new OperationError('conflict', 'No'); } });
    expect(app.operations.call('direct', owner, 'example.fail', {}, 'fail')).toMatchObject({ code: 'conflict' });
    expect(app.db.prepare('SELECT count(*) AS n FROM example_records').get()).toEqual({ n: 2 });
    expect(app.db.prepare("SELECT * FROM core_operations WHERE id='fail'").get()).toBeUndefined();
    clock.advance(30 * 86400_000);
    expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual([]);
    expect(app.operations.call('http', owner, 'example.put', { ...input, title: 'different' }, 'same').ok).toBe(true);
  });
  it('replays a deletion after the record is gone without asking may again', () => {
    const app = createFoundation({ home: home() }); closes.push(app.close); installFixture(app);
    app.operations.call('direct', owner, 'example.put', { id: 'gone', title: 'Delete me' }, 'put');
    const result = app.operations.call('http', owner, 'example.remove', { id: 'gone' }, 'remove');
    expect(result.ok).toBe(true);
    expect(app.db.prepare("SELECT * FROM example_records WHERE id='gone'").get()).toBeUndefined();
    expect(app.operations.call('socket', owner, 'example.remove', { id: 'gone' }, 'remove')).toEqual(result);
    expect(app.operations.call('direct', owner, 'example.remove', { id: 'gone' }, 'fresh')).toMatchObject({ code: 'denied' });
  });
  it('returns a caller own result after permission loss; another caller runs under may; mismatches conflict', () => {
    const app = createFoundation({ home: home() }); closes.push(app.close);
    let allowed = true;
    const may = vi.fn(() => allowed), run = vi.fn((_, input: string) => input);
    app.operations.register({ name: 'example.retry', input: z.string(), output: z.string(), write: true, may, run });
    const result = app.operations.call('direct', owner, 'example.retry', 'same input', 'id');
    allowed = false;
    expect(app.operations.call('http', owner, 'example.retry', 'same input', 'id')).toEqual(result);
    expect(may).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
    expect(app.operations.call('direct', owner, 'example.retry', 'different', 'id')).toMatchObject({ code: 'conflict' });
    expect(may).toHaveBeenCalledTimes(1);
    expect(app.operations.call('direct', pollock, 'example.retry', 'same input', 'id')).toMatchObject({ code: 'denied' });
    expect(may).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledTimes(1);
    allowed = true;
    expect(app.operations.call('direct', pollock, 'example.retry', 'same input', 'id')).toEqual(result);
    expect(may).toHaveBeenCalledTimes(3); expect(run).toHaveBeenCalledTimes(2);
  });
  it('publishes nested changes only after the outer commit and suppresses rollback notifications', () => {
    const app = createFoundation({ home: home() }); closes.push(app.close); installFixture(app);
    const seen: unknown[] = [];
    const changed = app.live.changed.bind(app.live);
    app.live.changed = changes => { seen.push(changes); changed(changes); };
    app.operations.register({ name: 'example.outer', input: z.boolean(), output: z.null(), write: true, may: () => true, run(_, fail) {
      expect(app.operations.call('direct', owner, 'example.put', { id: 'nested', title: 'Nested' }, fail ? 'child-fail' : 'child-ok').ok).toBe(true);
      expect(seen).toEqual([]);
      if (fail) throw new OperationError('conflict', 'roll back');
      return null;
    } });
    expect(app.operations.call('direct', owner, 'example.outer', true, 'outer-fail')).toMatchObject({ code: 'conflict' });
    expect(seen).toEqual([]);
    expect(app.db.prepare('SELECT * FROM example_records').all()).toEqual([]);
    expect(app.operations.call('direct', owner, 'example.outer', false, 'outer-ok').ok).toBe(true);
    expect(seen).toEqual([[{ type: 'example.record', id: 'nested' }]]);
  });
  it('publishes output schemas, hashes retry input and stores only schema-approved acknowledgements', () => {
    const app = createFoundation({ home: home() }); closes.push(app.close);
    app.operations.register({ name: 'example.private', input: z.object({ words: z.string() }), output: z.object({ id: z.string() }), write: true, doors: ['socket'], may: () => true, run: (_, input) => ({ id: 'message', words: input.words }) });
    const result = app.operations.call('socket', owner, 'example.private', { words: 'private-message-words' }, 'private');
    expect(result).toEqual({ ok: true, value: { id: 'message' } });
    expect(JSON.stringify(app.db.prepare('SELECT * FROM core_operations').all())).not.toContain('private-message-words');
    expect(app.operations.offered('socket')[0].output.safeParse({ id: 'message' }).success).toBe(true);
    for (const door of ['http', 'mcp', 'direct'] as const) expect(app.operations.call(door, owner, 'example.private', { words: 'private-message-words' }, 'private')).toMatchObject({ code: 'denied' });
  });
  it('offers default operations through all four doors, including MCP hooks', () => {
    const app = createFoundation({ home: home() }); closes.push(app.close);
    app.operations.register({ name: 'example.default', input: z.string(), output: z.string(), may: () => true, run: (_, input) => input });
    for (const door of ['http', 'socket', 'mcp', 'direct'] as const) expect(app.operations.call(door, owner, 'example.default', 'hello')).toEqual({ ok: true, value: 'hello' });
    let answer: Result | undefined;
    app.operations.registerMcp((_, __, call) => { answer = call(owner, 'hello'); });
    expect(answer).toEqual({ ok: true, value: 'hello' });
  });
  it('all doors use parsing, may, run, door restrictions and the MCP hook', () => {
    const app = createFoundation({ home: home() }); closes.push(app.close);
    let runs = 0;
    app.operations.register({ name: 'example.only', output: z.string(), input: z.string(), doors: ['mcp', 'direct'], may: v => v.id === owner.id, run: (_, i) => { runs++; return i; } });
    const hooks = new Map<string, (v: Viewer, input: unknown) => Result>();
    app.operations.registerMcp((name, _, call) => hooks.set(name, call));
    expect(hooks.get('example.only')!(owner, 'yes')).toEqual({ ok: true, value: 'yes' });
    expect(hooks.get('example.only')!(pollock, 'yes')).toMatchObject({ code: 'denied' });
    expect(hooks.get('example.only')!(owner, 1)).toMatchObject({ code: 'invalid' });
    expect(app.operations.call('http', owner, 'example.only', 'yes')).toMatchObject({ code: 'denied' });
    expect(app.operations.call('direct', owner, 'missing', {})).toMatchObject({ code: 'not-found' });
    expect(runs).toBe(1);
  });
});
describe('in-process HTTP and live socket', () => {
  it('sends current sets, committed changes to a second socket, scope moves, expiry, access loss, and fresh reconnect sets', async () => {
    const clock = new FakeClock(), sharing = fixtureSharing(); let valid = true;
    const loom = await startLoom({ home: home(), clock, install: app => installFixture(app, () => sharing), authenticate: req => {
      const id = req.headers.authorization?.replace('Bearer ', '');
      return id && sharing.members[id] ? { viewer: { kind: 'member', id }, valid: () => valid && !!sharing.members[id] } : undefined;
    } }); closes.push(loom.close);
    const a = await socket(loom.url), b = await socket(loom.url, 'pollock');
    b.ws.send(JSON.stringify({ kind: 'subscribe', type: 'example.record', scope: 'first' }));
    expect(await b.next()).toMatchObject({ kind: 'set', records: [] });
    a.ws.send(JSON.stringify({ kind: 'call', request: 'r', name: 'example.put', id: 'op', input: { id: 'x', title: 'Hello', project: 'pond', parent: 'first', expires: clock.now() + 100 } }));
    expect(await a.next()).toEqual({ kind: 'pending', request: 'r' });
    expect(await a.next()).toMatchObject({ kind: 'result', result: { ok: true } });
    expect(await b.next()).toMatchObject({ kind: 'put', record: { id: 'x', title: 'Hello' } });
    const write = async (input: unknown, id: string) => {
      const response = await fetch(loom.url + '/api/example/put', { method: 'POST', headers: { authorization: 'Bearer jonathan', 'content-type': 'application/json' }, body: JSON.stringify({ input, id }) });
      return response.json();
    };
    expect(await write({ id: 'x', title: 'Moved', project: 'pond', parent: 'second' }, 'move')).toMatchObject({ ok: true });
    expect(await b.next()).toMatchObject({ kind: 'del', id: 'x' });
    b.ws.send(JSON.stringify({ kind: 'subscribe', type: 'example.record', scope: 'second' }));
    expect(await b.next()).toMatchObject({ kind: 'set', records: [{ id: 'x' }] });
    expect(await write({ id: 'x', title: 'Timed', project: 'pond', parent: 'second', expires: clock.now() + 100 }, 'timed')).toMatchObject({ ok: true });
    expect(await b.next()).toMatchObject({ kind: 'put' });
    clock.advance(100);
    expect(await b.next()).toMatchObject({ kind: 'del', id: 'x' });
    expect(await write({ id: 'x', title: 'Back', project: 'pond', parent: 'second' }, 'back')).toMatchObject({ ok: true }); await b.next();
    sharing.projects.pond.members = [];
    loom.live.refreshAccess();
    expect(await b.next()).toMatchObject({ kind: 'set', scope: 'first', records: [] });
    expect(await b.next()).toMatchObject({ kind: 'set', scope: 'second', records: [] });
    sharing.projects.pond.members = ['pollock'];
    b.ws.close(); await once(b.ws, 'close');
    const again = await socket(loom.url, 'pollock');
    again.ws.send(JSON.stringify({ kind: 'subscribe', type: 'example.record', scope: 'second' }));
    expect(await again.next()).toMatchObject({ kind: 'set', records: [{ id: 'x', title: 'Back' }] });
    const closed = once(again.ws, 'close'); valid = false; loom.live.refreshAccess(); await closed;
  });
  it('refuses anonymous HTTP/socket calls and gives value errors for invalid HTTP', async () => {
    const loom = await startLoom({ home: home(), install: installFixture, authenticate: req => req.headers.authorization === 'Bearer jonathan' ? { viewer: owner, valid: () => true } : undefined }); closes.push(loom.close);
    expect((await fetch(loom.url + '/api/example/put', { method: 'POST', body: '{}' })).status).toBe(401);
    const ws = new WebSocket(loom.url.replace('http:', 'ws:') + '/live');
    await expect(once(ws, 'open')).rejects.toThrow('401');
    const response = await fetch(loom.url + '/api/example/put', { method: 'POST', headers: { authorization: 'Bearer jonathan' }, body: '{' });
    expect(await response.json()).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('does not run HTTP operations with ended authentication and contains throwing live readers', async () => {
    let valid = true;
    const loom = await startLoom({ home: home(), install: app => {
      installFixture(app);
      app.live.register({ name: 'broken', ids: () => ['broken'], inScope: () => true, read() { throw new Error('broken'); } });
    }, authenticate: () => ({ viewer: owner, valid: () => valid }) }); closes.push(loom.close);
    const client = await socket(loom.url);
    client.ws.send(JSON.stringify({ kind: 'subscribe', type: 'broken' }));
    expect(await client.next()).toMatchObject({ ok: false, code: 'unavailable' });
    valid = false;
    expect((await fetch(loom.url + '/api/example/put', { method: 'POST', body: JSON.stringify({ id: 'ended', input: { id: 'x', title: 'No' } }) })).status).toBe(401);
    expect(loom.db.prepare('SELECT * FROM example_records').all()).toEqual([]);
  });
  it.each(['refresh', 'update', 'expiry'] as const)('closes a populated subscriber when a %s read fails', async mode => {
    const clock = new FakeClock(); let broken = false;
    const at = clock.at.bind(clock), cancelled = vi.fn();
    clock.at = (time, fn) => { const stop = at(time, fn); return () => { cancelled(); stop(); }; };
    const cancellationsAtRead: number[] = [];
    const read = vi.fn(() => {
      cancellationsAtRead.push(cancelled.mock.calls.length);
      if (broken) throw new Error('read failed');
      return { id: 'one' };
    });
    const loom = await startLoom({ home: home(), clock, authenticate: () => ({ viewer: owner, valid: () => true }), install: app => {
      app.live.register({ name: 'fragile', ids: () => ['one'], read, inScope: () => true, expires: () => clock.now() + 100 });
    } }); closes.push(loom.close);
    const client = await socket(loom.url);
    client.ws.send(JSON.stringify({ kind: 'subscribe', type: 'fragile' }));
    expect(await client.next()).toMatchObject({ kind: 'set', records: [{ id: 'one' }] });
    const ended = once(client.ws, 'close'); broken = true;
    if (mode === 'refresh') loom.live.refreshAccess();
    else if (mode === 'update') loom.live.changed([{ type: 'fragile', id: 'one' }]);
    else clock.advance(100);
    expect(await client.next()).toMatchObject({ code: 'unavailable' });
    expect((await ended)[0]).toBe(1011);
    // The replacement read still had the prior set's active deadline; failure then cancels it.
    expect(cancellationsAtRead).toEqual([0, 0]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    // Cancelled timers cannot revive the failed subscription or call its reader.
    clock.advance(1000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('fixture survives restart and refuses to overwrite a home', () => {
    const dir = home(); fixture(dir); expect(() => fixture(dir)).toThrow('empty');
    const app = createFoundation({ home: dir }); closes.push(app.close); installFixture(app);
    expect(app.db.prepare('SELECT count(*) AS n FROM example_records').get()).toEqual({ n: 6 });
  });
});

describe('post-rollback rejection audit',()=>{
  it('observes rolled back action state and cannot replace a denial with audit success or failure',()=>{
    const app=createFoundation({home:home(),clock:new FakeClock()});closes.push(app.close);
    app.db.exec('CREATE TABLE rejected_effects (id TEXT); CREATE TABLE rejected_audit (id TEXT)');
    let auditFails=false;
    app.operations.register({name:'audit.reject',write:true,input:z.object({id:z.string()}),output:z.unknown(),may:()=>true,
      run(ctx,input){ctx.db.prepare('INSERT INTO rejected_effects VALUES (?)').run(input.id);throw new OperationError('denied','No');},
      rejected(_viewer,input){
        expect(app.db.prepare('SELECT * FROM rejected_effects').all()).toEqual([]);
        app.db.prepare('INSERT INTO rejected_audit VALUES (?)').run(input.id);
        if(auditFails)throw Error('audit write interrupted');
      },
    });
    expect(app.operations.call('direct',owner,'audit.reject',{id:'first'},'first')).toEqual({ok:false,code:'denied',message:'No'});
    expect(app.db.prepare('SELECT * FROM rejected_audit').all()).toEqual([{id:'first'}]);
    auditFails=true;
    expect(app.operations.call('direct',owner,'audit.reject',{id:'second'},'second')).toEqual({ok:false,code:'denied',message:'No'});
    expect(app.db.prepare('SELECT * FROM rejected_audit').all()).toEqual([{id:'first'}]);
    expect(app.db.prepare('SELECT * FROM rejected_effects').all()).toEqual([]);
  });
});
