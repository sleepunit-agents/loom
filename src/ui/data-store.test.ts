import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { installFixture } from '../fixture.js';
import { describe, it, expect } from 'vitest';
import { DataStore, optimistic, type Socket } from '../../web/src/data/store.js';
class FakeSocket implements Socket {
  readyState = 0;
  onopen: Socket['onopen'] = null;
  onmessage: Socket['onmessage'] = null;
  onclose: Socket['onclose'] = null;
  onerror: Socket['onerror'] = null;
  sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  close(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
function fixture() {
  const sockets: FakeSocket[] = [], timers: { ms: number; fn(): void }[] = [];
  let sequence = 0;
  const store = new DataStore({ socket: () => { const s = new FakeSocket(); sockets.push(s); return s; }, id: () => `id-${++sequence}`, after: (ms, fn) => { const timer = { ms, fn }; timers.push(timer); return () => { timers.splice(timers.indexOf(timer), 1); }; } });
  const watch = (scope?: string) => store.subscribe('item', scope, () => {});
  const snapshot = (scope?: string) => store.getSnapshot('item', scope);
  const next = () => timers.shift()!.fn();
  return { store, sockets, timers, watch, snapshot, next };
}
describe('one live data store', () => {
  it('shares one socket, stable snapshots and ordered changes across overlapping scopes', () => {
    const f = fixture(); f.watch(); f.watch('a'); f.watch('b');
    expect(f.sockets).toHaveLength(1);
    const socket = f.sockets[0]; socket.open();
    expect(socket.sent).toEqual([undefined, 'a', 'b'].map(scope => ({ kind: 'subscribe', type: 'item', ...(scope ? { scope } : {}) })));
    socket.message({ kind: 'set', type: 'item', records: [{ id: '1', parent: 'a' }] });
    socket.message({ kind: 'set', type: 'item', scope: 'a', records: [{ id: '1', parent: 'a' }] });
    socket.message({ kind: 'set', type: 'item', scope: 'b', records: [] });
    expect(f.snapshot()).toBe(f.snapshot());
    // Move to b. A del carries no record, and must remove only a's membership.
    socket.message({ kind: 'put', type: 'item', scope: 'b', record: { id: '1', parent: 'b' } });
    socket.message({ kind: 'del', type: 'item', scope: 'a', id: '1' });
    expect(f.snapshot('a').records).toEqual([]);
    expect(f.snapshot().records).toEqual([{ id: '1', parent: 'b' }]);
    expect(f.snapshot('b').records).toEqual([{ id: '1', parent: 'b' }]);
    // Hidden records are deleted from every scope by its own del, regardless of order.
    socket.message({ kind: 'del', type: 'item', id: '1' });
    socket.message({ kind: 'del', type: 'item', scope: 'b', id: '1' });
    expect(f.snapshot().records).toEqual([]); expect(f.snapshot('b').records).toEqual([]);
    f.store.close();
  });
  it('replaces on reconnect and ignores old socket frames; backs off without polling', () => {
    const f = fixture(); f.watch(); const old = f.sockets[0]; old.open();
    old.message({ kind: 'set', type: 'item', records: [{ id: 'old' }] }); old.close();
    expect(f.snapshot()).toEqual({ status: 'offline', records: [] }); expect(f.timers[0].ms).toBe(250);
    f.next(); f.sockets[1].close(); expect(f.timers[0].ms).toBe(500); f.next();
    const socket = f.sockets[2]; socket.open();
    expect(socket.sent).toEqual([{ kind: 'subscribe', type: 'item' }]);
    old.message({ kind: 'put', type: 'item', record: { id: 'ghost' } });
    socket.message({ kind: 'set', type: 'item', records: [{ id: 'new' }] });
    expect(f.snapshot()).toEqual({ status: 'live', records: [{ id: 'new' }] });
    socket.message({ kind: 'set', type: 'item', records: [] }); expect(f.snapshot().records).toEqual([]);
    f.store.close(); expect(f.timers).toEqual([]);
  });
  it('retries immutable calls with the same id and accepts the stored result once', async () => {
    const f = fixture(); const input = { id: 'record', title: 'first' };
    const call = f.store.call('example.put', input); input.title = 'changed';
    const preview = optimistic(call, false, () => true); expect(preview()).toBe(true);
    const socket = f.sockets[0]; socket.open(); const wire = socket.sent[0];
    expect(wire.input.title).toBe('first'); expect(wire.id).toBe(call.id);
    socket.message({ kind: 'pending', request: call.id }); expect(call.getSnapshot().status).toBe('pending');
    socket.close(); expect(call.getSnapshot().status).toBe('offline'); f.next(); f.sockets[1].open();
    expect(f.sockets[1].sent).toEqual([wire]);
    const result = { ok: true, value: { id: 'record' } };
    f.sockets[1].message({ kind: 'result', request: call.id, result });
    expect(await call.result).toEqual(result); expect(call.getSnapshot().pending).toBe(false); expect(preview()).toBe(false);
    f.sockets[1].close(); f.next(); f.sockets[2].open(); expect(f.sockets[2].sent).toEqual([]); f.store.close();
  });
  it('isolates a mutating optimistic projection from authoritative records', () => {
    const f = fixture(); const before = [{ id: '1', title: 'old' }];
    const request = f.store.call('example.put', {});
    const preview = optimistic(request, before, rows => { rows[0].title = 'new'; return rows; });
    expect(preview()[0].title).toBe('new'); expect(before[0].title).toBe('old'); f.store.close();
  });
  it('exposes every operation error as a value', async () => {
    const f = fixture(); f.watch(); const socket = f.sockets[0]; socket.open();
    for (const code of ['denied', 'not-found', 'invalid', 'conflict', 'unavailable']) {
      const call = f.store.call('example.put', {});
      socket.message({ kind: 'result', request: call.id, result: { ok: false, code, message: code } });
      expect(await call.result).toEqual({ ok: false, code, message: code });
    }
    f.store.close();
  });
  it('clears denied sessions and settles calls without reconnecting', async () => {
    const f = fixture(); f.watch(); const socket = f.sockets[0]; socket.open();
    socket.message({ kind: 'set', type: 'item', records: [{ id: 'private' }] });
    const call = f.store.call('example.put', {}); socket.close(1008);
    expect(f.snapshot()).toEqual({ records: [], status: 'denied' }); expect(f.timers).toEqual([]);
    expect(await call.result).toMatchObject({ ok: false, code: 'denied' });
    expect(await f.store.call('example.put', {}).result).toMatchObject({ ok: false, code: 'denied' });
    f.store.close();
  });
});

it('a dropped result replays the stored result from the real operation registry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-data-replay-'));
  const loom = await startLoom({ home, clock: new FakeClock(), install: installFixture });
  const f = fixture();
  try {
    const request = f.store.call('example.put', { id: 'once', title: 'Created once' });
    f.sockets[0].open();
    const wire = f.sockets[0].sent[0];
    const stored = loom.operations.call('socket', { kind: 'member', id: 'jonathan' }, wire.name, wire.input, wire.id);
    expect(stored.ok).toBe(true);
    // Lose the reply, then alter the record independently. Replay must return the first result.
    loom.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'example.put', { id: 'once', title: 'Later edit' }, 'later');
    f.sockets[0].close(); f.next(); f.sockets[1].open();
    const retry = f.sockets[1].sent[0]; expect(retry).toEqual(wire);
    const result = loom.operations.call('socket', { kind: 'member', id: 'jonathan' }, retry.name, retry.input, retry.id);
    f.sockets[1].message({ kind: 'result', request: retry.request, result });
    expect(await request.result).toEqual(stored);
    expect(loom.db.prepare('SELECT title FROM example_records WHERE id=?').get('once')).toEqual({ title: 'Later edit' });
  } finally { f.store.close(); await loom.close(); rmSync(home, { recursive: true, force: true }); }
});

it('subscription failures are visible values rather than an endless loading state', () => {
  const f = fixture(); f.watch(); f.sockets[0].open();
  f.sockets[0].message({ ok: false, code: 'not-found', message: 'Unknown record type' });
  expect(f.snapshot()).toEqual({ records: [], status: 'offline', error: { ok: false, code: 'not-found', message: 'Unknown record type' } });
  f.store.close();
});
