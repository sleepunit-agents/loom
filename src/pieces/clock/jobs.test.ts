import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer, type Sharing } from '../../core/index.js';
import { installClock, type ClockOptions } from './index.js';
import { wake, wakes, schedules, type Schedule, type Wake } from './store.js';
import type { StartResult } from './dependencies/runtime.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const sharing: Sharing = { members: { jonathan: { owner: true, agents: ['art'] }, guest: { owner: false, agents: [] } }, projects: { pond: { members: ['guest'], agents: ['art', 'pond-bot'] } }, services: {} };
const dirs: string[] = [], closes: (() => Promise<void>)[] = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), 'loom-clock-')); dirs.push(d); return d; };
afterEach(async () => { for (const c of closes.splice(0).reverse()) await c(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function loom(options: ClockOptions = {}, dir = home(), clock = new FakeClock(), access = sharing) {
  const app = await startLoom({ home: dir, clock, install(app) { const jobs = installClock(app.db, app.operations, app.live, () => access, options); app.onClose(jobs.close); }, authenticate: () => ({ viewer: owner, valid: () => true }) });
  let stopped = false;
  const close = async () => { if (!stopped) { stopped = true; await app.close(); } }; closes.push(close);
  const call = (op: string, input: object = {}, viewer = owner, id = randomUUID()) => app.operations.call('direct', viewer, `clock.${op}`, input, id);
  const value = <T = Wake>(op: string, input: object = {}, viewer = owner): T => { const r = call(op, input, viewer); if (!r.ok) throw new Error(JSON.stringify(r)); return r.value as T; };
  const set = (when = '1m') => value('in', { agent: 'art', prompt: 'Continue work', note: 'check', when });
  return { ...app, close, call, value, set, clock, dir };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
// Drain the known dispatch promise chain, without wall-clock sleeps.
const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe('durable daemon clock', () => {
  it('fires an overdue wake once after downtime and records intent before runtime', async () => {
    const dir = home(), clock = new FakeClock(), started = vi.fn(async ({ wake: w }: { wake: Wake }) => {
      expect(wake(second.db, w.id)?.state).toBe('firing');
      expect(second.db.inTransaction).toBe(false); return { state: 'started', body: 'body-1' } as const;
    });
    const first = await loom({}, dir, clock), w = first.set(); await first.close(); clock.advance(120_000);
    const second = await loom({ runtime: { startBody: started } }, dir, clock);
    clock.advance(0); await settled();
    expect(wake(second.db, w.id)?.state).toBe('fired'); expect(started).toHaveBeenCalledTimes(1);
    await second.close(); const third = await loom({ runtime: { startBody: started } }, dir, clock); clock.advance(0); await settled();
    expect(wake(third.db, w.id)?.state).toBe('fired'); expect(started).toHaveBeenCalledTimes(1);
  });
  it('holds a restart mid-fire and ignores the old daemon late result', async () => {
    const dir = home(), clock = new FakeClock(), result = deferred<StartResult>(), invoked = deferred<void>();
    const startBody = vi.fn(() => { invoked.resolve(); return result.promise; });
    const first = await loom({ runtime: { startBody } }, dir, clock), w = first.set();
    clock.advance(60_000); await invoked.promise; expect(wake(first.db, w.id)?.state).toBe('firing'); await first.close();
    const second = await loom({ runtime: { startBody } }, dir, clock); clock.advance(0);
    expect(wake(second.db, w.id)).toMatchObject({ state: 'held', hold: 'uncertain' });
    result.resolve({ state: 'started', body: 'late-body' }); await settled();
    expect(wake(second.db, w.id)).toMatchObject({ state: 'held', hold: 'uncertain' });
    expect(second.call('now', { id: w.id })).toMatchObject({ ok: false, code: 'invalid' }); expect(startBody).toHaveBeenCalledTimes(1);
  });
  it('cancels before runtime invocation and preserves an uncertain in-flight cancellation', async () => {
    const result = deferred<StartResult>(), invoked = deferred<void>(), startBody = vi.fn(() => { invoked.resolve(); return result.promise; });
    const app = await loom({ runtime: { startBody } }); const early = app.set(); app.value('cancel', { id: early.id });
    const between = app.set(); app.clock.advance(60_000); app.value('cancel', { id: between.id }); await settled(); expect(startBody).not.toHaveBeenCalled();
    const late = app.set(); app.clock.advance(60_000); await invoked.promise; app.value('cancel', { id: late.id });
    result.resolve({ state: 'started', body: 'racing-body' }); await settled();
    expect(wake(app.db, late.id)).toMatchObject({ state: 'cancelled', outcome: 'Cancellation raced dispatch; a body may have started' });
    expect(startBody).toHaveBeenCalledTimes(1);
  });
  it('holds paused due wakes and releases in order one minute apart', async () => {
    const startBody = vi.fn(async () => ({ state: 'started', body: 'b' } as const)), app = await loom({ runtime: { startBody } });
    const a = app.set('1m'), b = app.set('2m'); app.value('pause', { agent: 'art' }); app.clock.advance(120_000); await settled();
    expect(startBody).not.toHaveBeenCalled(); expect(wake(app.db, a.id)).toMatchObject({ state: 'held', hold: 'paused' });
    expect(app.value('resume', { agent: 'art' })).toMatchObject({ released: 2 });
    expect(wake(app.db, a.id)?.due).toBe(app.clock.now()+60_000); expect(wake(app.db, b.id)?.due).toBe(app.clock.now()+120_000);
    app.clock.advance(120_000); await settled(); expect(startBody).toHaveBeenCalledTimes(2);
  });
  it('stages by default, holds uncertain failures, and only retries definite not-started', async () => {
    const staged = await loom(), a = staged.set(); staged.clock.advance(60_000); await settled(); expect(wake(staged.db, a.id)).toMatchObject({ state: 'held', hold: 'staging' });
    const uncertain = await loom({ runtime: { async startBody() { throw new Error('lost response'); } } }), b = uncertain.set(); uncertain.clock.advance(60_000); await settled(); expect(wake(uncertain.db, b.id)).toMatchObject({ state: 'held', hold: 'uncertain' });
    const startBody = vi.fn(async () => ({ state: 'not-started', reason: 'no runner' } as const)), retry = await loom({ runtime: { startBody } }), c = retry.set(); retry.clock.advance(60_000); await settled();
    expect(wake(retry.db, c.id)).toMatchObject({ state: 'pending', failures: 1, due: retry.clock.now()+15*60_000 });
  });
  it('commits exactly one next schedule occurrence across the Chicago spring change', async () => {
    const clock = new FakeClock(Date.parse('2026-03-07T09:00:00Z')), app = await loom({}, home(), clock);
    app.value('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', prompt: 'Daily work', note: 'daily' });
    const first = wakes(app.db)[0]; expect(first.due).toBe(Date.parse('2026-03-07T09:31:00Z'));
    clock.advance(first.due-clock.now()); await settled();
    const next = wakes(app.db).filter(w => w.state === 'pending'); expect(next).toHaveLength(1); expect(next[0].due).toBe(Date.parse('2026-03-08T08:31:00Z'));
    app.value('cancel', { id: next[0].id }); expect(wakes(app.db).filter(w => w.state === 'pending')).toHaveLength(1);
    expect(wakes(app.db).find(w => w.state === 'pending')?.due).toBe(Date.parse('2026-03-09T08:31:00Z'));
  });
  it('does not duplicate the next occurrence when a dispatch is retried', async () => {
    const clock = new FakeClock(Date.parse('2026-03-07T09:00:00Z')), app = await loom({ runtime: { async startBody() { return { state: 'not-started', reason: 'offline' }; } } }, home(), clock);
    app.value('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', prompt: 'Daily work', note: 'daily' });
    clock.advance(31*60_000); await settled(); clock.advance(15*60_000); await settled();
    expect(wakes(app.db).filter(w => w.state === 'pending')).toHaveLength(2);
  });
  it('parks on an accessible answer and preserves its exact instructions, or times out', async () => {
    let answer: 'pending' | 'allowed' = 'pending'; const listeners = new Set<() => void>();
    const app = await loom({ approvals: { check: () => ({ state: answer, kind: 'merge', target: 'exact-head', instruction: answer === 'allowed' ? 'Spend exact-head once' : undefined }), subscribe(f) { listeners.add(f); return () => { listeners.delete(f); }; } } });
    const w = app.value('park', { agent: 'art', prompt: 'Continue', note: 'waiting', on: 'a-123' }); app.clock.advance(0);
    answer = 'allowed'; for (const f of listeners) f(); app.clock.advance(0); await settled();
    expect(wake(app.db, w.id)?.prompt).toContain('Spend exact-head once'); expect(wake(app.db, w.id)?.state).toBe('held');
    answer = 'pending'; const timeout = app.value('park', { agent: 'art', prompt: 'Continue', note: 'timeout', on: 'q-123' }); app.clock.advance(24*60*60_000); await settled();
    expect(wake(app.db, timeout.id)?.wait?.answer).toBe('expired');
  });
  it('uses central scope policy, denies foreign agents and holds revoked dispatch authority', async () => {
    const access = structuredClone(sharing), startBody = vi.fn(async () => ({ state: 'started', body: 'b' } as const)), app = await loom({ runtime: { startBody } }, home(), new FakeClock(), access);
    expect(app.call('in', { agent: 'art', project: 'pond', prompt: 'X', note: 'x', when: '1m' }, { kind: 'agent', id: 'pond-bot' })).toMatchObject({ ok: false, code: 'denied' });
    const w = app.value('in', { agent: 'art', project: 'pond', prompt: 'X', note: 'x', when: '1m' }, { kind: 'agent', id: 'art' });
    expect(app.value<Wake[]>('list', {}, { kind: 'member', id: 'guest' }).map(w => w.id)).toContain(w.id);
    expect(app.call('now', { id: w.id }, { kind: 'member', id: 'guest' })).toMatchObject({ ok: false, code: 'denied' });
    access.projects.pond.agents = []; app.clock.advance(60_000); await settled(); expect(startBody).not.toHaveBeenCalled(); expect(wake(app.db, w.id)).toMatchObject({ state: 'held', hold: 'permission' });
  });
  it('creates, patches, reassigns and removes household lanes with one pending occurrence', async () => {
    const access = structuredClone(sharing); access.members.jonathan.agents.push('bo');
    const app = await loom({}, home(), new FakeClock(), access);
    const original = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '06:05', days: 'mon-fri', text: 'Keep it tidy.', slot: 'upkeep', note: 'people cards' });
    expect(original.prompt).toContain('This is a loom lane: household work');
    expect(original.prompt).toMatch(/Keep it tidy\.$/);
    const first = wakes(app.db).find(w => w.schedule === original.id)!;
    app.value('laneSet', { name: 'upkeep', at: '07:15', days: '', local: true });
    const patched = schedules(app.db)[0];
    expect(patched).toMatchObject({ at: ['07:15'], days: '', slot: 'upkeep', note: 'people cards', laneDetails: { text: 'Keep it tidy.', local: true } });
    expect(patched.prompt).toMatch(/^<!-- house: local -->/);
    expect(wake(app.db, first.id)?.state).toBe('cancelled');
    app.value('laneAssign', { name: 'upkeep', agent: 'bo' });
    expect(app.value('laneText', { name: 'upkeep' }, { kind: 'agent', id: 'bo' })).toEqual({ text: 'Keep it tidy.' });
    expect(app.call('laneText', { name: 'upkeep' }, { kind: 'agent', id: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    expect(wakes(app.db).filter(w => w.state === 'pending')).toMatchObject([{ agent: 'bo', schedule: original.id }]);
    expect(app.value<Schedule[]>('lanes', {}, { kind: 'agent', id: 'art' })).toEqual([]);
    app.value('laneSet', { name: 'upkeep', text: 'Keep it tidier.' });
    expect(schedules(app.db)[0].prompt).toMatch(/Keep it tidier\.$/);
    app.value('laneRemove', { name: 'upkeep' });
    expect(schedules(app.db)).toEqual([]); expect(wakes(app.db).filter(w => w.state === 'pending')).toEqual([]);
  });
  it('keeps household lane administration behind central household policy and rejects bad edits atomically', async () => {
    const app = await loom();
    const input = { name: 'upkeep', agent: 'art', at: '06:05', text: 'Tidy.' };
    expect(app.call('laneSet', input, { kind: 'agent', id: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    expect(app.call('laneSet', { ...input, agent: 'unknown' })).toMatchObject({ ok: false, code: 'denied' });
    const s = app.value<Schedule>('laneSet', input);
    expect(app.call('scheduleRemove', { id: s.id }, { kind: 'agent', id: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    expect(app.call('scheduleSet', { id: s.id, agent: 'art', at: '08:00', prompt: 'Override', note: 'override' }, { kind: 'agent', id: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    const before = schedules(app.db);
    for (const patch of [{ days: 'someday' }, { at: '25:00' }, { source: '../secret.md' }, { slot: 'Bad Slot' }]) {
      expect(app.call('laneSet', { name: 'upkeep', ...patch })).toMatchObject({ ok: false, code: 'invalid' });
      expect(schedules(app.db)).toEqual(before); expect(wakes(app.db).filter(w => w.state === 'pending')).toHaveLength(1);
    }
    expect(app.call('laneAssign', { name: 'missing', agent: 'art' })).toMatchObject({ ok: false, code: 'not-found' });
  });
  it('preserves full long lane text and replaces only same-agent self-chained file work', async () => {
    const app = await loom();
    const own = app.value('in', { agent: 'art', file: 'routines/tidy.md', note: 'self chain', when: '2h' });
    const other = app.value('in', { agent: 'art', file: 'routines/other.md', note: 'other', when: '2h' });
    const text = 'x'.repeat(9000);
    const s = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '06:05', text, source: 'routines/tidy.md' });
    expect(s.prompt!.length).toBeLessThan(1000); expect(s.prompt).toContain('wake lane text upkeep');
    expect(app.value('laneText', { name: 'upkeep' })).toEqual({ text });
    expect(wake(app.db, own.id)?.state).toBe('cancelled'); expect(wake(app.db, other.id)?.state).toBe('pending');
    app.value('laneSet', { name: 'upkeep', text: 'Inline replacement' });
    expect(schedules(app.db)[0].laneDetails?.source).toBeUndefined();
  });
  it('reassignment retains an in-flight intent and cannot create an extra old-agent occurrence', async () => {
    const result = deferred<StartResult>(), invoked = deferred<void>();
    const access = structuredClone(sharing); access.members.jonathan.agents.push('bo');
    const clock = new FakeClock(Date.parse('2026-03-07T09:00:00Z'));
    const app = await loom({ runtime: { startBody() { invoked.resolve(); return result.promise; } } }, home(), clock, access);
    app.value('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.' });
    clock.advance(31*60_000); await invoked.promise;
    const firing = wakes(app.db).find(w => w.state === 'firing')!;
    app.value('laneAssign', { name: 'upkeep', agent: 'bo' });
    expect(wake(app.db, firing.id)?.state).toBe('firing');
    result.resolve({ state: 'started', body: 'old-agent-body' }); await settled();
    expect(wake(app.db, firing.id)?.state).toBe('fired');
    expect(wakes(app.db).filter(w => w.state === 'pending')).toMatchObject([{ agent: 'bo' }]);
  });
  it('removes terminal wakes from the live scope exactly a day later', async () => {
    const app = await loom(), w = app.set(); app.value('cancel', { id: w.id });
    const ws = new WebSocket(app.url.replace('http:', 'ws:')+'/live'); const messages: unknown[] = []; ws.on('message', raw => messages.push(JSON.parse(raw.toString()))); await once(ws, 'open');
    const initial = once(ws, 'message'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'wake' })); await initial;
    expect(messages).toMatchObject([{ kind: 'set', records: [{ id: w.id }] }]);
    const removed = once(ws, 'message'); app.clock.advance(86400_000); await removed; expect(messages.at(-1)).toMatchObject({ kind: 'del', id: w.id }); ws.terminate(); await once(ws, 'close');
  });
});
