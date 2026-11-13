import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer, type Sharing } from '../../core/index.js';
import { installClock, type ClockOptions } from './index.js';
import { wake, wakes, schedules, type Schedule, type Wake } from './store.js';
import type { StartResult } from './dependencies/runtime.js';
vi.mock('node:fs', { spy: true });
vi.mock('node:child_process', { spy: true });
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
  it('creates an owner wake now without a lane, preserving attribution and bypassing pause', async () => {
    const startBody = vi.fn(async () => ({ state: 'started', body: 'now-body' } as const));
    const app = await loom({ runtime: { startBody } });
    app.value('pause', { agent: 'art' });
    const future = app.set();
    const w = app.value('now', { agent: 'art' });
    expect(w).toMatchObject({ agent: 'art', by: owner, due: app.clock.now(), state: 'pending', bypassPause: true, note: 'woken now from loom' });
    expect(w.prompt).toBe("Woken now: jonathan asked for a wake from loom's Clock page, with no lane. Look at what deserves attention: your work queue, recent loom memory, Your call, the state of the machine. Do something useful or file what you find.");
    expect(w.file).toBeUndefined(); expect(w.schedule).toBeUndefined();
    expect(wake(app.db, future.id)?.due).toBe(app.clock.now() + 60_000);
    app.clock.advance(0); await settled();
    expect(wake(app.db, w.id)).toMatchObject({ state: 'fired', outcome: 'now-body' });
    expect(startBody).toHaveBeenCalledTimes(1);
    expect(startBody.mock.calls[0]).toEqual([{ wake: expect.objectContaining({ id: w.id, by: owner }), viewer: owner, intent: expect.any(String) }]);
    expect(app.value('now', { agent: 'art', note: 'look into the queue' }).note).toBe('look into the queue');
  });
  it('refuses unauthorized or ambiguous fresh wake-now calls without creating work', async () => {
    const access = structuredClone(sharing);
    access.members.helper = { owner: false, agents: ['art'] };
    access.members.otherOwner = { owner: true, agents: [] };
    const app = await loom({}, home(), new FakeClock(), access);
    for (const viewer of [{ kind: 'agent', id: 'art' }, { kind: 'member', id: 'helper' }, { kind: 'member', id: 'otherOwner' },
      { kind: 'member', id: 'unknown' }, { kind: 'runner', id: 'art' }, { kind: 'service', id: 'art' }] as Viewer[])
      expect(app.call('now', { agent: 'art' }, viewer)).toMatchObject({ ok: false, code: 'denied' });
    expect(app.call('now', { agent: 'unknown' })).toMatchObject({ ok: false, code: 'denied' });
    expect(app.call('now', { id: 'w-missing', agent: 'art' }).ok).toBe(false);
    expect(wakes(app.db)).toEqual([]);
    const w = app.value('now', { agent: 'art' }); app.clock.advance(0); await settled();
    expect(wake(app.db, w.id)).toMatchObject({ state: 'held', hold: 'staging' });
  });
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
  it.each(['replace', 'remove'] as const)('does not retry an in-flight ordinary schedule after %s', async action => {
    const result = deferred<StartResult>(), invoked = deferred<void>();
    const clock = new FakeClock(Date.parse('2026-03-07T09:00:00Z'));
    const startBody = vi.fn(() => { invoked.resolve(); return result.promise; });
    const app = await loom({ runtime: { startBody } }, home(), clock);
    const input = { id: 'daily', agent: 'art', at: '03:31', prompt: 'Old work', note: 'daily' };
    app.value('scheduleSet', input);
    clock.advance(31*60_000); await invoked.promise;
    const firing = wakes(app.db).find(w => w.state === 'firing')!;
    if (action === 'replace') app.value('scheduleSet', { ...input, prompt: 'New work' });
    else app.value('scheduleRemove', { id: input.id });
    expect(wake(app.db, firing.id)).toEqual(firing);
    result.resolve({ state: 'not-started', reason: 'runner offline' }); await settled();
    expect(wake(app.db, firing.id)).toMatchObject({ state: 'cancelled', outcome: 'Superseded schedule did not start: runner offline' });
    clock.advance(15*60_000); await settled();
    expect(startBody).toHaveBeenCalledTimes(1);
    expect(wakes(app.db).filter(w => w.state === 'pending')).toMatchObject(action === 'replace' ? [{ prompt: 'New work', schedule: input.id }] : []);
  });
  it.each(['replace', 'remove'] as const)('preserves an uncertain ordinary schedule through %s', async action => {
    const clock = new FakeClock(Date.parse('2026-03-07T09:00:00Z'));
    const app = await loom({ runtime: { async startBody() { return { state: 'uncertain', reason: 'response lost' }; } } }, home(), clock);
    const input = { id: 'daily', agent: 'art', at: '03:31', prompt: 'Old work', note: 'daily' };
    app.value('scheduleSet', input); clock.advance(31*60_000); await settled();
    const uncertain = wakes(app.db).find(w => w.hold === 'uncertain')!;
    expect(uncertain).toBeDefined();
    if (action === 'replace') app.value('scheduleSet', { ...input, prompt: 'New work' });
    else app.value('scheduleRemove', { id: input.id });
    expect(wake(app.db, uncertain.id)).toEqual(uncertain);
    expect(app.call('now', { id: uncertain.id })).toMatchObject({ ok: false, code: 'invalid' });
    expect(wakes(app.db).filter(w => w.state === 'pending')).toMatchObject(action === 'replace' ? [{ prompt: 'New work', schedule: input.id }] : []);
  });
  it('keeps an ordinary run-now independent of later schedule removal', async () => {
    const startBody = vi.fn(async () => ({ state: 'not-started', reason: 'offline' } as const));
    const app = await loom({ runtime: { startBody } });
    const s = app.value<Schedule>('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', prompt: 'Run once', note: 'daily' });
    const immediate = app.value('scheduleRun', { id: s.id });
    app.value('scheduleRemove', { id: s.id }); app.clock.advance(0); await settled();
    expect(wake(app.db, immediate.id)).toMatchObject({ state: 'pending', failures: 1, due: app.clock.now()+15*60_000 });
    app.clock.advance(15*60_000); await settled(); expect(startBody).toHaveBeenCalledTimes(2);
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
    const original = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '06:05', days: 'mon-fri', text: 'Keep it tidy.', slot: 'upkeep', model: 'test-model', note: 'people cards' });
    expect(app.value<Schedule[]>('lanes')).toEqual([original]);
    expect(original.prompt).toContain('This is a loom lane: household work');
    expect(original.prompt).toMatch(/Keep it tidy\.$/);
    const first = wakes(app.db).find(w => w.schedule === original.id)!;
    app.value('laneSet', { name: 'upkeep', at: '07:15', days: '', local: true });
    const patched = schedules(app.db)[0];
    expect(patched).toMatchObject({ at: ['07:15'], days: '', slot: 'upkeep', model: 'test-model', note: 'people cards', laneDetails: { text: 'Keep it tidy.', local: true } });
    expect(patched.prompt).toMatch(/^<!-- house: local -->/);
    expect(wake(app.db, first.id)?.state).toBe('cancelled');
    app.value('laneAssign', { name: 'upkeep', agent: 'bo' });
    expect(app.value('laneText', { name: 'upkeep' }, { kind: 'agent', id: 'bo' })).toEqual({ text: 'Keep it tidy.' });
    expect(app.call('laneText', { name: 'upkeep' }, { kind: 'agent', id: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    expect(wakes(app.db).filter(w => w.state === 'pending')).toMatchObject([{ agent: 'bo', schedule: original.id }]);
    expect(app.value<Schedule[]>('lanes', {}, { kind: 'agent', id: 'art' })).toEqual([]);
    expect(schedules(app.db)[0]).toMatchObject({ agent: 'bo', model: 'test-model', slot: 'upkeep', laneDetails: { local: true } });
    app.value('laneSet', { name: 'upkeep', text: 'Keep it tidier.' });
    expect(schedules(app.db)[0].prompt).toMatch(/Keep it tidier\.$/);
    app.value('laneRemove', { name: 'upkeep' });
    expect(schedules(app.db)).toEqual([]); expect(wakes(app.db).filter(w => w.state === 'pending')).toEqual([]);
  });
  it('keeps household lane administration behind central household policy and rejects bad edits atomically', async () => {
    const access = structuredClone(sharing), app = await loom({}, home(), new FakeClock(), access);
    const input = { name: 'upkeep', agent: 'art', at: '06:05', text: 'Tidy.' };
    expect(app.call('laneSet', { ...input, local: true }, { kind: 'agent', id: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    expect(app.call('laneSet', { ...input, agent: 'unknown' })).toMatchObject({ ok: false, code: 'denied' });
    const s = app.value<Schedule>('laneSet', input);
    expect(app.call('scheduleRemove', { id: s.id }, { kind: 'agent', id: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    expect(app.call('scheduleSet', { id: s.id, agent: 'art', at: '08:00', prompt: 'Override', note: 'override' }, { kind: 'agent', id: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    access.members.otherOwner = { owner: true, agents: [] };
    try {
      for (const [verb, input] of [['laneRemove', { name: 'upkeep' }], ['scheduleRemove', { id: s.id }], ['scheduleRun', { id: s.id }]] as const)
        expect(app.call(verb, input, { kind: 'member', id: 'otherOwner' })).toMatchObject({ ok: false, code: 'denied' });
    } finally { delete access.members.otherOwner; }
    expect(app.call('laneAssign', { name: 'upkeep', agent: 'unknown' })).toMatchObject({ ok: false, code: 'denied' });
    for (const viewer of [{ kind: 'agent', id: 'art' }, { kind: 'member', id: 'delegate' }] as const) {
      access.members.delegate = { owner: false, agents: ['art'] };
      expect(app.call('laneAssign', { name: 'upkeep', agent: 'art' }, viewer)).toMatchObject({ ok: false, code: 'denied' });
      expect(app.call('laneRemove', { name: 'upkeep' }, viewer)).toMatchObject({ ok: false, code: 'denied' });
    }
    const before = schedules(app.db);
    for (const patch of [{ days: 'someday' }, { at: '25:00' }, { source: '../secret.md' }, { slot: 'Bad Slot' }]) {
      expect(app.call('laneSet', { name: 'upkeep', ...patch })).toMatchObject({ ok: false, code: 'invalid' });
      expect(schedules(app.db)).toEqual(before); expect(wakes(app.db).filter(w => w.state === 'pending')).toHaveLength(1);
    }
    expect(app.call('laneAssign', { name: 'missing', agent: 'art' })).toMatchObject({ ok: false, code: 'not-found' });
  });
  it('preserves full long lane text and replaces only same-agent self-chained file work', async () => {
    const access = structuredClone(sharing); access.members.jonathan.agents.push('bo');
    const app = await loom({ approvals: { check: () => ({ state: 'pending' }), subscribe: () => () => {} } }, home(), new FakeClock(), access);
    const foreign = app.value('in', { agent: 'bo', file: 'routines/tidy.md', note: 'foreign chain', when: '2h' });
    const own = app.value('in', { agent: 'art', file: 'routines/tidy.md', note: 'self chain', when: '2h' }, { kind: 'agent', id: 'art' });
    const member = app.value('in', { agent: 'art', file: 'routines/tidy.md', note: 'member work', when: '2h' });
    const parked = app.value('park', { agent: 'art', file: 'routines/tidy.md', note: 'waiting', on: 'a-123' }, { kind: 'agent', id: 'art' });
    const other = app.value('in', { agent: 'art', file: 'routines/other.md', note: 'other', when: '2h' });
    const text = 'x'.repeat(9000);
    const s = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '06:05', text, source: 'routines/tidy.md' });
    app.value('laneSet', { name: 'upkeep', note: 'new note' });
    expect(schedules(app.db)[0].laneDetails?.source).toBe('routines/tidy.md');
    expect(wake(app.db, foreign.id)?.state).toBe('pending');
    expect(wake(app.db, member.id)?.state).toBe('pending'); expect(wake(app.db, parked.id)?.state).toBe('parked');
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
    const startBody = vi.fn(() => { invoked.resolve(); return result.promise; });
    const app = await loom({ runtime: { startBody } }, home(), clock, access);
    app.value('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.' });
    clock.advance(31*60_000); await invoked.promise;
    const firing = wakes(app.db).find(w => w.state === 'firing')!;
    app.value('laneAssign', { name: 'upkeep', agent: 'bo' });
    expect(wake(app.db, firing.id)).toMatchObject({ state: 'firing', agent: 'art', by: owner, attempt: firing.attempt });
    expect(startBody).toHaveBeenCalledWith(expect.objectContaining({ viewer: owner, intent: firing.attempt, wake: expect.objectContaining({ agent: 'art', by: owner }) }));
    result.resolve({ state: 'started', body: 'old-agent-body' }); await settled();
    expect(wake(app.db, firing.id)).toMatchObject({ state: 'fired', agent: 'art', by: owner, attempt: firing.attempt });
    expect(wakes(app.db).filter(w => w.state === 'pending')).toMatchObject([{ agent: 'bo' }]);
  });
  it('cancels an immediate lane run when reassigned before dispatch and rolls back interrupted assignment', async () => {
    const access = structuredClone(sharing); access.members.jonathan.agents.push('bo');
    const startBody = vi.fn(async () => ({ state: 'started', body: 'b' } as const));
    const app = await loom({ runtime: { startBody } }, home(), new FakeClock(), access);
    const s = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '06:05', text: 'Tidy.' });
    const immediate = app.value('scheduleRun', { id: s.id });
    expect(immediate.schedule).toBe(s.id);
    const beforeWakes = wakes(app.db), beforeSchedules = schedules(app.db);
    app.db.exec(`CREATE TEMP TRIGGER fail_lane_move BEFORE INSERT ON clock_schedules
      WHEN json_extract(NEW.record, '$.agent') = 'bo'
      BEGIN SELECT RAISE(ABORT, 'injected lane failure'); END;`);
    expect(app.call('laneAssign', { name: 'upkeep', agent: 'bo' })).toMatchObject({ ok: false });
    expect(wakes(app.db)).toEqual(beforeWakes); expect(schedules(app.db)).toEqual(beforeSchedules);
    app.db.exec('DROP TRIGGER fail_lane_move');
    app.value('laneAssign', { name: 'upkeep', agent: 'bo' });
    expect(wake(app.db, immediate.id)?.state).toBe('cancelled');
    app.clock.advance(0); await settled(); expect(startBody).not.toHaveBeenCalled();
    expect(wakes(app.db).filter(w => w.state === 'pending')).toMatchObject([{ agent: 'bo', schedule: s.id }]);
  });
  it('dispatches local and file-backed lanes only through the runtime without reading source files', async () => {
    const clock = new FakeClock(Date.parse('2026-03-07T09:00:00Z'));
    const startBody = vi.fn(async () => ({ state: 'held', reason: 'staging hold' } as const));
    const app = await loom({ runtime: { startBody } }, home(), clock);
    app.value('laneSet', { name: 'local-lane', agent: 'art', at: '03:31', text: 'Local words', local: true });
    app.value('laneSet', { name: 'file-lane', agent: 'art', at: '03:31', text: 'File words', source: 'routines/does-not-exist.md' });
    const guards = [vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'openSync'), vi.spyOn(childProcess, 'spawn'), vi.spyOn(childProcess, 'execFile'), vi.spyOn(childProcess, 'execSync')];
    for (const guard of guards) guard.mockClear().mockImplementation(() => { throw new Error('Forbidden lane filesystem/process access'); });
    try {
      clock.advance(31*60_000); await settled();
      expect(startBody).toHaveBeenCalledTimes(2);
      expect(wakes(app.db).filter(w => w.state === 'held')).toHaveLength(2);
      expect(wakes(app.db).find(w => w.prompt?.includes('Local words'))?.prompt).toMatch(/^<!-- house: local -->/);
      for (const guard of guards) expect(guard).not.toHaveBeenCalled();
    } finally { for (const guard of guards) guard.mockRestore(); }
  });
  it.each(['laneAssign', 'laneRemove'] as const)('does not retry superseded in-flight lane work after %s', async verb => {
    const result = deferred<StartResult>(), invoked = deferred<void>();
    const access = structuredClone(sharing); access.members.jonathan.agents.push('bo');
    const clock = new FakeClock(Date.parse('2026-03-07T09:00:00Z'));
    const app = await loom({ runtime: { startBody() { invoked.resolve(); return result.promise; } } }, home(), clock, access);
    app.value('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.' });
    clock.advance(31*60_000); await invoked.promise;
    const firing = wakes(app.db).find(w => w.state === 'firing')!;
    app.value(verb, { name: 'upkeep', agent: 'bo' });
    result.resolve({ state: 'not-started', reason: 'runner offline' }); await settled();
    expect(wake(app.db, firing.id)).toMatchObject({ state: 'cancelled', outcome: 'Superseded lane did not start: runner offline' });
    expect(wakes(app.db).filter(w => w.state === 'pending' && w.agent === 'art')).toEqual([]);
  });
  it.each(['laneAssign', 'laneRemove', 'scheduleRemove'] as const)('preserves uncertain lane intent and attribution through %s', async verb => {
    const access = structuredClone(sharing); access.members.jonathan.agents.push('bo');
    const clock = new FakeClock(Date.parse('2026-03-07T09:00:00Z'));
    const app = await loom({ runtime: { async startBody() { return { state: 'uncertain', reason: 'response lost' }; } } }, home(), clock, access);
    const s = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.' });
    clock.advance(31*60_000); await settled();
    const uncertain = wakes(app.db).find(w => w.hold === 'uncertain')!;
    expect(uncertain).toBeDefined();
    app.value(verb, { name: 'upkeep', agent: 'bo', id: s.id });
    expect(wake(app.db, uncertain.id)).toEqual(uncertain);
    expect(app.call('now', { id: uncertain.id })).toMatchObject({ ok: false, code: 'invalid' });
    expect(wakes(app.db).filter(w => w.state === 'pending')).toHaveLength(verb === 'laneAssign' ? 1 : 0);
  });
  it('removes terminal wakes from the live scope exactly a day later', async () => {
    const app = await loom(), w = app.set(); app.value('cancel', { id: w.id });
    const ws = new WebSocket(app.url.replace('http:', 'ws:')+'/live'); const messages: unknown[] = []; ws.on('message', raw => messages.push(JSON.parse(raw.toString()))); await once(ws, 'open');
    const initial = once(ws, 'message'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'wake' })); await initial;
    expect(messages).toMatchObject([{ kind: 'set', records: [{ id: w.id }] }]);
    const removed = once(ws, 'message'); app.clock.advance(86400_000); await removed; expect(messages.at(-1)).toMatchObject({ kind: 'del', id: w.id }); ws.terminate(); await once(ws, 'close');
  });
});
