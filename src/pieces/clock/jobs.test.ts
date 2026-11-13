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
import { deskJobs, agentNext } from './desk.js';
import { clockRole } from './role.js';
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
  it('reports complete desk jobs in due order with waiting work and no finished entries', async () => {
    const app = await loom({ approvals: { check: () => ({ state: 'pending' }), subscribe: () => () => {} } });
    const later = app.value('in', { agent: 'art', prompt: 'Later', note: 't-2201 finish t-2201 and t-2190', when: '2h' });
    const parked = app.value('park', { agent: 'art', prompt: 'Wait', note: 'Await an answer', on: 'a-test' });
    const first = app.set();
    expect(app.value('jobs', { agent: 'art' })).toEqual([
      { id: parked.id, wake: parked.id, agent: 'art', status: 'waiting', text: 'Await an answer', at: parked.due, tasks: [], href: '/p/clock-preview' },
      { id: first.id, wake: first.id, agent: 'art', status: 'scheduled', text: 'check', at: first.due, tasks: [], href: '/p/clock-preview' },
      { id: later.id, wake: later.id, agent: 'art', status: 'scheduled', text: 't-2201 finish t-2201 and t-2190', at: later.due, tasks: ['t-2201', 't-2190'], href: '/p/clock-preview' },
    ]);
    expect(app.value('agentNext', { agent: 'art' })).toEqual({ agent: 'art', paused: false, held: 0, next: { id: first.id, due: first.due, text: 'check' } });
    for (const w of [first, later, parked]) app.value('cancel', { id: w.id });
    expect(app.value('jobs', { agent: 'art' })).toEqual([]);
    expect(app.value('agentNext', { agent: 'art' })).toEqual({ agent: 'art', paused: false, held: 0, next: null });
  });
  it('reports paused and staging-held work without promising another wake, including after restart', async () => {
    const app = await loom();
    const first = app.set();
    app.value('pause', { agent: 'art' });
    expect(app.value('agentNext', { agent: 'art' })).toEqual({ agent: 'art', paused: true, held: 0, next: null });
    expect(app.value<Array<{ status: string }>>('jobs', { agent: 'art' })[0].status).toBe('waiting');
    app.clock.advance(60_000); await settled();
    expect(app.value('agentNext', { agent: 'art' })).toEqual({ agent: 'art', paused: true, held: 1, next: null });
    app.value('resume', { agent: 'art' });
    app.clock.advance(60_000); await settled();
    expect(wake(app.db, first.id)?.hold).toBe('staging');
    await app.close();
    const restarted = await loom({}, app.dir, app.clock);
    expect(restarted.value('agentNext', { agent: 'art' })).toEqual({ agent: 'art', paused: false, held: 1, next: null });
    expect(restarted.value<Array<{ status: string }>>('jobs', { agent: 'art' })[0].status).toBe('waiting');
  });
  it('filters desk reads per wake and rechecks current visibility without exposing words or imported provenance', async () => {
    const access = structuredClone(sharing);
    access.members.helper = { owner: false, agents: ['art'] };
    const app = await loom({}, home(), new FakeClock(), access);
    const privateWake = app.value('in', { agent: 'art', member: 'jonathan', prompt: 'Private words', note: 'Private note', when: '1m' });
    const publicWake = app.set('2m');
    const helper: Viewer = { kind: 'member', id: 'helper' };
    for (const viewer of [helper, { kind: 'agent', id: 'art' } as Viewer]) {
      expect(app.value<Array<{ id: string }>>('jobs', { agent: 'art' }, viewer).map(w => w.id)).toEqual([publicWake.id]);
      expect(clockRole(app.operations).agentNext(viewer, { agent: 'art' })).toMatchObject({ ok: true, value: { next: { id: publicWake.id } } });
      expect(clockRole(app.operations).jobs(viewer, { agent: 'art' })).toMatchObject({ ok: true, value: [{ id: publicWake.id }] });
    }
    expect(app.value('agentNext', { agent: 'art' })).toMatchObject({ next: { id: privateWake.id } });
    expect(JSON.stringify(app.value('jobs', { agent: 'art' }))).not.toContain('Private words');
    for (const verb of ['jobs', 'agentNext']) {
      expect(app.call(verb, { agent: 'art' }, { kind: 'member', id: 'guest' })).toMatchObject({ ok: false, code: 'denied' });
      expect(app.call(verb, { agent: 'art' }, { kind: 'agent', id: 'stranger' })).toMatchObject({ ok: false, code: 'denied' });
    }
    privateWake.state = 'held'; privateWake.hold = 'permission';
    app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(privateWake), privateWake.id);
    expect(clockRole(app.operations).agentNext(helper, { agent: 'art' })).toMatchObject({ ok: true, value: { held: 0, next: { id: publicWake.id } } });
    access.members.helper.agents = [];
    expect(app.call('jobs', { agent: 'art' }, helper)).toMatchObject({ ok: false, code: 'denied' });
  });

  it('exposes the desk role without writes and distinguishes running jobs from scheduled occurrences', async () => {
    const starting = deferred<StartResult>();
    const app = await loom({ runtime: { startBody: () => starting.promise } });
    const role = clockRole(app.operations);
    const s = app.value<Schedule>('scheduleSet', { id: 'nightly-upkeep', agent: 'art', at: '03:31', prompt: 'Secret routine words', note: 't-2201 upkeep' });
    const occurrence = wakes(app.db)[0];
    app.clock.advance(occurrence.due - app.clock.now()); await settled();
    const before = app.db.prepare('SELECT * FROM clock_wakes ORDER BY id').all();
    expect(role.jobs(owner, { agent: 'art' })).toMatchObject({ ok: true, value: [
      { id: occurrence.id, status: 'running', text: 'nightly upkeep' },
      { status: 'scheduled', text: 'nightly upkeep' },
    ] });
    const future = wakes(app.db).find(w => w.schedule === s.id && w.state === 'pending')!;
    expect(role.agentNext(owner, { agent: 'art' })).toMatchObject({ ok: true, value: { next: { id: future.id } } });
    expect(app.db.prepare('SELECT * FROM clock_wakes ORDER BY id').all()).toEqual(before);
    app.value('pause', { agent: 'art' });
    expect(role.jobs(owner, { agent: 'art' })).toMatchObject({ ok: true, value: [{ id: occurrence.id, status: 'running' }, { status: 'waiting' }] });
    // Central type grants permit collection reads but never private member rows.
    const access = structuredClone(sharing);
    access.services.desk = { types: ['wake'], operations: [] };
    const other = await loom({}, home(), new FakeClock(), access);
    other.set();
    other.value('in', { agent: 'art', member: 'jonathan', prompt: 'Private', note: 'Private', when: '1m' });
    expect(other.value<unknown[]>('jobs', { agent: 'art' }, { kind: 'service', id: 'desk' })).toHaveLength(1);
    for (const viewer of [{ kind: 'service', id: 'unknown' }, { kind: 'runner', id: 'box' }] as Viewer[])
      expect(other.call('agentNext', { agent: 'art' }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  });
  it('bounds desk labels, uses empty-note file fallbacks and breaks equal-deadline ties by id', async () => {
    const app = await loom();
    const long = app.value('in', { agent: 'art', prompt: 'Words stay private', note: 'x'.repeat(301), when: '1m' });
    expect(clockRole(app.operations).jobs(owner, { agent: 'art' })).toMatchObject({ ok: true, value: [{ text: 'x'.repeat(300) }] });
    expect(clockRole(app.operations).agentNext(owner, { agent: 'art' })).toMatchObject({ ok: true, value: { next: { text: 'x'.repeat(300) } } });
    // Construct an imported-format row without granting its opaque provenance.
    const file: Wake = { ...long, id: 'w-imported', prompt: undefined, file: 'routines/upkeep.md', note: '', legacy: { for_in: 'cv-0123456789ab', continuation: 'untrusted' } };
    app.db.prepare('DELETE FROM clock_wakes').run();
    app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(file.id, JSON.stringify(file), file.changedAt);
    expect(clockRole(app.operations).jobs(owner, { agent: 'art' })).toMatchObject({ ok: true, value: [{ text: file.file }] });
    expect(clockRole(app.operations).agentNext(owner, { agent: 'art' })).toMatchObject({ ok: true, value: { next: { text: file.file } } });
    expect(JSON.stringify(clockRole(app.operations).jobs(owner, { agent: 'art' }))).not.toMatch(/cv-0123456789ab|untrusted|legacy|continuation/);
    const a = { ...file, id: 'w-a' }, z = { ...file, id: 'w-z' };
    expect(deskJobs([z, a], false).map(w => w.id)).toEqual(['w-a', 'w-z']);
    expect(agentNext('art', [z, a], false).next?.id).toBe('w-a');
  });
  it('excludes other agents and every terminal state from desk selection and counts', async () => {
    const access = structuredClone(sharing);
    access.members.jonathan.agents.push('mark');
    const app = await loom({}, home(), new FakeClock(), access);
    const art = app.set('2h');
    const mark = app.value('in', { agent: 'mark', prompt: 'Other agent', note: 'Other agent', when: '1m' });
    const held: Wake = { ...mark, id: 'w-other-held', state: 'held', hold: 'permission' };
    const terminal: Wake[] = (['fired', 'failed', 'cancelled'] as const).map(state => ({ ...art, id: `w-${state}`, due: mark.due, state }));
    for (const w of [held, ...terminal]) app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(w.id, JSON.stringify(w), w.changedAt);
    const role = clockRole(app.operations);
    expect(role.jobs(owner, { agent: 'art' })).toMatchObject({ ok: true, value: [{ id: art.id }] });
    const jobs = role.jobs(owner, { agent: 'art' });
    expect(jobs.ok && (jobs.value as unknown[])).toHaveLength(1);
    expect(role.agentNext(owner, { agent: 'art' })).toEqual({ ok: true, value: { agent: 'art', paused: false, held: 0, next: { id: art.id, due: art.due, text: art.note } } });
    expect(role.agentNext(owner, { agent: 'mark' })).toMatchObject({ ok: true, value: { held: 1, next: { id: mark.id } } });
  });
  it('answers a file lane self-rearm within six hours without creating another wake, even at capacity', async () => {
    const app = await loom();
    const s = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.', source: 'routines/upkeep.md' });
    const occurrence = wakes(app.db).find(w => w.schedule === s.id)!;
    for (let n = 0; n < 50; n++) app.set('2d');
    const before = wakes(app.db);
    for (const delta of [-6, 0, 6]) {
      const r = app.value('in', { agent: 'art', file: 'routines/upkeep.md', note: 'rearm', when: `${(occurrence.due + delta * 3600_000 - app.clock.now()) / 1000}s` }, { kind: 'agent', id: 'art' });
      expect(r).toEqual({ alreadyScheduled: true, schedule: s.id, due: occurrence.due });
    }
    expect(wakes(app.db)).toEqual(before);
  });
  it('keeps an extra file run outside the six-hour boundary and suppresses only live matching occurrences', async () => {
    const app = await loom();
    const s = app.value<Schedule>('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', file: 'routines/upkeep.md', note: 'daily' });
    const occurrence = wakes(app.db).find(w => w.schedule === s.id)!;
    const input = { agent: 'art', file: 'routines/upkeep.md', note: 'rearm', when: `${(occurrence.due - app.clock.now()) / 1000}s` };
    const agent: Viewer = { kind: 'agent', id: 'art' };
    expect(app.value('in', input, agent)).toEqual({ alreadyScheduled: true, schedule: s.id, due: occurrence.due });
    expect(app.value('in', { ...input, when: `${(occurrence.due + 6 * 3600_000 + 1000 - app.clock.now()) / 1000}s` }, agent).state).toBe('pending');
    expect(app.value('in', { ...input, when: `${(occurrence.due - 6 * 3600_000 - 1000 - app.clock.now()) / 1000}s` }, agent).state).toBe('pending');
    expect(app.value('in', { ...input, file: 'routines/other.md' }, agent).state).toBe('pending');
    for (const file of ['./routines/upkeep.md', 'routines//upkeep.md'])
      expect(app.value('in', { ...input, file }, agent).state).toBe('pending');
    app.value('pause', { agent: 'art' });
    app.clock.advance(occurrence.due - app.clock.now()); await settled();
    expect(wake(app.db, occurrence.id)?.hold).toBe('paused');
    // A held occurrence is no promise of a future run.
    expect(app.value('in', { ...input, when: '1m' }, agent).state).toBe('pending');
  });
  it('never substitutes unproven or another scope schedule for work or approval continuations', async () => {
    const access = structuredClone(sharing);
    access.members.helper = { owner: false, agents: ['art'] };
    const app = await loom({}, home(), new FakeClock(), access);
    const agent: Viewer = { kind: 'agent', id: 'art' };
    const input = { agent: 'art', file: 'routines/upkeep.md', note: 'rearm', when: '12h' };
    app.value('scheduleSet', { id: 'agent', agent: 'art', at: '03:31', file: input.file, note: 'agent' }, agent);
    expect(app.value('in', input, agent).state).toBe('pending');
    app.value('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.', source: input.file });
    for (const fields of [{ project: 'pond' }, { continuation: 'opaque' }, { approval: 'a-local' }, { place: 'conversation' }])
      expect(app.value('in', { ...input, ...fields }, agent).state).toBe('pending');
    expect(app.value('in', input, { kind: 'member', id: 'helper' }).state).toBe('pending');
    // Invalid work and unauthorized callers cannot turn the no-op into success.
    expect(app.call('in', { ...input, prompt: 'Both' }, agent)).toMatchObject({ ok: false, code: 'invalid' });
    expect(app.call('in', input, { kind: 'agent', id: 'stranger' })).toMatchObject({ ok: false, code: 'denied' });
    access.members.jonathan.owner = false;
    expect(app.value('in', input, agent).state).toBe('pending');
  });
  it('answers the authoring owner through clock.at and retains the result after restart', async () => {
    const app = await loom();
    const s = app.value<Schedule>('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', file: 'routines/upkeep.md', note: 'daily' });
    const occurrence = wakes(app.db)[0];
    const input = { agent: 'art', file: 'routines/upkeep.md', note: 'rearm', when: '03:31' };
    const expected = { alreadyScheduled: true, schedule: s.id, due: occurrence.due };
    expect(app.value('at', input)).toEqual(expected);
    await app.close();
    const restarted = await loom({}, app.dir, app.clock);
    expect(restarted.value('at', input)).toEqual(expected);
    expect(wakes(restarted.db)).toEqual([occurrence]);
  });
  it.each([
    'schedule continuation', 'schedule approval', 'schedule place',
    'occurrence continuation', 'occurrence approval', 'occurrence place',
    'disabled', 'stale revision', 'stale lane', 'nonfuture', 'held', 'firing', 'run-now', 'bypass pause', 'paused agent',
    'author lost create', 'other owner', 'agent scope', 'member scope',
  ])('keeps independent work when the candidate has %s', async scenario => {
    const access = structuredClone(sharing);
    access.members.jonathan.agents.push('pond-bot');
    access.members.other = { owner: true, agents: ['art'] };
    const app = await loom({}, home(), new FakeClock(), access);
    const s = app.value<Schedule>('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', file: 'routines/upkeep.md', note: 'daily' });
    const occurrence = wakes(app.db)[0];
    let viewer: Viewer = owner;
    const input = { agent: 'art', file: 'routines/upkeep.md', note: 'rearm', when: '12h', ...(scenario === 'member scope' ? { member: 'jonathan' } : {}) };
    const [which, field] = scenario.split(' ');
    if (which === 'schedule' || which === 'occurrence') Object.assign(which === 'schedule' ? s : occurrence, { [field]: 'capability-or-place' });
    if (scenario === 'disabled') s.enabled = false;
    if (scenario === 'stale revision') occurrence.scheduleRevision = 'old';
    if (scenario === 'stale lane') occurrence.laneVersion = 'old';
    if (scenario === 'nonfuture') occurrence.due = app.clock.now();
    if (scenario === 'held') { occurrence.state = 'held'; occurrence.hold = 'uncertain'; }
    if (scenario === 'firing') occurrence.state = 'firing';
    if (scenario === 'run-now') occurrence.runNow = true;
    if (scenario === 'bypass pause') occurrence.bypassPause = true;
    if (scenario === 'paused agent') app.value('pause', { agent: 'art' });
    if (scenario === 'author lost create') { access.members.jonathan.agents = []; viewer = { kind: 'agent', id: 'art' }; }
    if (scenario === 'other owner') viewer = { kind: 'member', id: 'other' };
    if (scenario === 'agent scope') { s.agent = 'pond-bot'; occurrence.agent = 'pond-bot'; }
    app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(s), s.id);
    app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(occurrence), occurrence.id);
    expect(app.value('in', input, viewer).state).toBe('pending');
    expect(wakes(app.db)).toHaveLength(2);
    expect(wake(app.db, occurrence.id)).toEqual(occurrence);
  });
  it('uses the next occurrence rather than a later current occurrence for the same schedule', async () => {
    const app = await loom();
    app.value('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', file: 'routines/upkeep.md', note: 'daily' });
    const first = wakes(app.db)[0];
    const later = { ...first, id: 'w-later', due: first.due + 86400_000 };
    app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(later.id, JSON.stringify(later), later.changedAt);
    const before = wakes(app.db);
    const extra = app.value('in', { agent: 'art', file: 'routines/upkeep.md', note: 'extra', when: '36h' }, { kind: 'agent', id: 'art' });
    expect(extra.state).toBe('pending');
    expect(wakes(app.db).filter(w => w.id !== extra.id)).toEqual(before);
  });
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
  it('requires target give-work permission for ordinary schedule run-now', async () => {
    const access = structuredClone(sharing);
    access.members.otherOwner = { owner: true, agents: [] };
    const app = await loom({}, home(), new FakeClock(), access);
    app.value('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', prompt: 'Daily', note: 'daily' });
    const before = wakes(app.db);
    expect(app.call('scheduleRun', { id: 'daily' }, { kind: 'member', id: 'otherOwner' })).toMatchObject({ ok: false, code: 'denied' });
    expect(wakes(app.db)).toEqual(before);
    expect(app.call('now', { id: before[0].id }, { kind: 'member', id: 'otherOwner' })).toMatchObject({ ok: false, code: 'denied' });
    expect(app.call('scheduleRun', { id: 'daily' }).ok).toBe(true);
  });
  it('holds member work when target ownership is revoked while project visibility remains', async () => {
    const access = structuredClone(sharing);
    access.members.helper = { owner: false, agents: ['art'] };
    access.projects.pond.members.push('helper');
    const startBody = vi.fn(async () => ({ state: 'started', body: 'b' } as const));
    const app = await loom({ runtime: { startBody } }, home(), new FakeClock(), access);
    const w = app.value('in', { agent: 'art', project: 'pond', prompt: 'X', note: 'x', when: '1m' }, { kind: 'member', id: 'helper' });
    access.members.helper.agents = [];
    expect(app.value<Wake[]>('list', {}, { kind: 'member', id: 'helper' }).map(w => w.id)).toContain(w.id);
    app.clock.advance(60_000); await settled();
    expect(startBody).not.toHaveBeenCalled();
    expect(wake(app.db, w.id)).toMatchObject({ state: 'held', hold: 'permission' });
  });
  it('shares the one-off cap between timed wakes, parking and ordinary run-now', async () => {
    const app = await loom({ approvals: { check: () => ({ state: 'pending' }), subscribe: () => () => {} } });
    const schedule = app.value<Schedule>('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', prompt: 'Daily', note: 'daily' });
    for (let n = 0; n < 49; n++) app.set('2h');
    const parked = app.value('park', { agent: 'art', prompt: 'Continue', note: 'waiting', on: 'a-cap' });
    const before = wakes(app.db);
    for (const [op, input] of [
      ['in', { agent: 'art', prompt: 'More', note: 'more', when: '2h' }],
      ['park', { agent: 'art', prompt: 'More', note: 'more', on: 'a-cap' }],
      ['scheduleRun', { id: schedule.id }],
    ] as const) expect(app.call(op, input)).toMatchObject({ ok: false, code: 'invalid' });
    expect(wakes(app.db)).toEqual(before);
    app.value('cancel', { id: parked.id });
    const run = app.value('scheduleRun', { id: schedule.id });
    expect(run.schedule).toBeUndefined();
    expect(app.call('park', { agent: 'art', prompt: 'More', note: 'more', on: 'a-cap' })).toMatchObject({ ok: false, code: 'invalid' });
    // Recurrences have their own slot; another agent has its own one-off budget.
    expect(wakes(app.db).filter(w => w.schedule === schedule.id && w.state === 'pending')).toHaveLength(1);
    expect(app.call('in', { agent: 'pond-bot', project: 'pond', prompt: 'Other', note: 'other', when: '2h' }, { kind: 'agent', id: 'pond-bot' }).ok).toBe(true);
  });
  it('counts lane run-now against the shared one-off budget while retaining its lane link', async () => {
    const app = await loom();
    const lane = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.' });
    for (let n = 0; n < 49; n++) app.set('2h');
    const run = app.value('scheduleRun', { id: lane.id });
    expect(run.schedule).toBe(lane.id);
    const before = wakes(app.db);
    expect(app.call('scheduleRun', { id: lane.id })).toMatchObject({ ok: false, code: 'invalid' });
    expect(app.call('in', { agent: 'art', prompt: 'More', note: 'more', when: '2h' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(wakes(app.db)).toEqual(before);
    app.value('cancel', { id: run.id });
    expect(app.call('scheduleRun', { id: lane.id }).ok).toBe(true);
    expect(wakes(app.db).filter(w => w.schedule === lane.id && w.state === 'pending')).toHaveLength(2);
    expect(app.call('now', { agent: 'art' }).ok).toBe(true); // fresh owner wake keeps its exemption at full capacity
  });
  it('counts persisted lane run-now from before the marker was introduced', async () => {
    const dir = home(), clock = new FakeClock(), app = await loom({}, dir, clock);
    const lane = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.' });
    for (let n = 0; n < 49; n++) app.set('2h');
    const run = app.value('scheduleRun', { id: lane.id });
    // Construct the previous on-disk format, retaining its lane link and pause bypass.
    delete run.runNow;
    app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(run), run.id);
    await app.close();
    const restarted = await loom({}, dir, clock);
    expect(restarted.call('scheduleRun', { id: lane.id })).toMatchObject({ ok: false, code: 'invalid' });
    expect(restarted.call('in', { agent: 'art', prompt: 'More', note: 'more', when: '2h' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(restarted.call('now', { agent: 'art' }).ok).toBe(true);
  });
  it.each(['ordinary', 'lane'] as const)('does not count an accelerated %s recurring occurrence as a new one-off', async kind => {
    const app = await loom();
    for (let n = 0; n < 49; n++) app.set('2h');
    const s = kind === 'lane'
      ? app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.' })
      : app.value<Schedule>('scheduleSet', { id: 'daily', agent: 'art', at: '03:31', prompt: 'Daily', note: 'daily' });
    const occurrence = wakes(app.db).find(w => w.schedule === s.id)!;
    app.value('now', { id: occurrence.id });
    expect(app.call('in', { agent: 'art', prompt: 'Last', note: 'last', when: '2h' }).ok).toBe(true);
    expect(app.call('in', { agent: 'art', prompt: 'More', note: 'more', when: '2h' })).toMatchObject({ ok: false, code: 'invalid' });
    app.clock.advance(0); await settled(); // held recurring rows still do not consume one-off capacity
    const last = wakes(app.db).find(w => w.note === 'last')!;
    app.value('cancel', { id: last.id });
    expect(app.call('in', { agent: 'art', prompt: 'Last', note: 'last', when: '2h' }).ok).toBe(true);
  });
  it('waits for quota reset plus a minute without using the job failure budget, including after restart', async () => {
    const dir = home(), clock = new FakeClock(Date.parse('2026-11-13T10:00:00Z'));
    const retryAfter = '2026-11-13T22:01:00Z';
    const firstStart = vi.fn(async () => ({ state: 'not-started', code: 'quota', reason: 'No model room', retryAfter } as const));
    const app = await loom({ runtime: { startBody: firstStart } }, dir, clock);
    const w = app.set();
    clock.advance(60_000); await settled();
    const due = Date.parse(retryAfter) + 60_000;
    expect(wake(app.db, w.id)).toMatchObject({ state: 'pending', due, failures: 0, outcome: 'No model room' });
    expect(app.value<{ kind: string }[]>('log').at(-1)?.kind).toBe('quota-wait');
    await app.close();
    const startBody = vi.fn(async () => ({ state: 'started', body: 'resumed' } as const));
    const restarted = await loom({ runtime: { startBody } }, dir, clock);
    clock.advance(due - clock.now() - 1); await settled(); expect(startBody).not.toHaveBeenCalled();
    clock.advance(1); await settled();
    expect(startBody).toHaveBeenCalledTimes(1);
    const firstInput = firstStart.mock.calls[0] as unknown as [{ wake: Wake; intent: string }];
    const nextInput = startBody.mock.calls[0] as unknown as [{ wake: Wake; intent: string }];
    expect(firstInput[0].wake.id).toBe(w.id); expect(nextInput[0].wake.id).toBe(w.id);
    expect(nextInput[0].intent).not.toBe(firstInput[0].intent);
    expect(wake(restarted.db, w.id)).toMatchObject({ state: 'fired', failures: 0 });
  });
  it.each([
    [undefined, 61], ['bad', 61], [60, 61], ['2030-01-01', 61], ['2027-02-30T00:00:00Z', 61],
    ['2000-01-01T00:00:00Z', 15], ['9999-12-31T23:59:59Z', 8 * 24 * 60],
    ['2026-11-13T12:01:00+02:00', 15],
  ])('bounds quota reset %j with no hot loop', async (retryAfter, minutes) => {
    const clock = new FakeClock(Date.parse('2026-11-13T10:00:00Z'));
    const app = await loom({ runtime: { async startBody() { return { state: 'not-started', code: 'quota', reason: 'quota', retryAfter, retryAt: 1 }; } } }, home(), clock);
    const w = app.set(); clock.advance(60_000); await settled();
    expect(wake(app.db, w.id)).toMatchObject({ state: 'pending', failures: 0, due: clock.now() + minutes! * 60_000 });
  });
  it('retains existing failures over repeated quota waits and suppresses only quota-notice triage', async () => {
    let quota = false;
    const app = await loom({ runtime: { async startBody() { return quota
      ? { state: 'not-started', code: 'quota', reason: 'No room' }
      : { state: 'not-started', reason: 'offline' }; } } });
    const w = app.set(); app.clock.advance(60_000); await settled();
    quota = true;
    for (let n = 0; n < 7; n++) {
      app.clock.advance(wake(app.db, w.id)!.due - app.clock.now()); await settled();
      expect(wake(app.db, w.id)).toMatchObject({ state: 'pending', failures: 1, due: app.clock.now() + 61 * 60_000 });
    }
    const notice = app.value('in', { agent: 'art', prompt: 'Triage quota', note: 'quota', place: 'alert:runtime-quota', when: '1m' });
    const other = app.value('in', { agent: 'art', prompt: 'Triage disk', note: 'disk', place: 'alert:disk', when: '1m' });
    app.clock.advance(60_000); await settled();
    expect(wake(app.db, notice.id)).toMatchObject({ state: 'cancelled', failures: 0, outcome: 'No room' });
    expect(wake(app.db, other.id)).toMatchObject({ state: 'pending', failures: 0 });
    expect(app.value<{ kind: string; note: string }[]>('log').filter(e => e.note === 'quota').at(-1)?.kind).toBe('quota-notice');
  });
  it('does not revive a removed lane on a quota result from an in-flight start', async () => {
    const result = deferred<StartResult>(), invoked = deferred<void>();
    const app = await loom({ runtime: { startBody() { invoked.resolve(); return result.promise; } } });
    const lane = app.value<Schedule>('laneSet', { name: 'upkeep', agent: 'art', at: '03:31', text: 'Tidy.' });
    const run = app.value('scheduleRun', { id: lane.id }); app.clock.advance(0); await invoked.promise;
    app.value('laneRemove', { name: 'upkeep' });
    result.resolve({ state: 'not-started', code: 'quota', reason: 'No room' }); await settled();
    expect(wake(app.db, run.id)).toMatchObject({ state: 'cancelled', failures: 0 });
  });
  it('does not retry a failed continuation, including after restart or an explicit retry hint', async () => {
    const startBody = vi.fn(async () => ({ state: 'not-started', reason: 'out of quota is only reason text', retryAt: 1 } as const));
    const app = await loom({ runtime: { startBody } });
    const w = app.value('in', { agent: 'art', prompt: 'Report once', note: 'report', continuation: 'opaque-report-handle', when: '1m' });
    app.clock.advance(60_000); await settled();
    expect(wake(app.db, w.id)).toMatchObject({ state: 'failed', failures: 1, outcome: 'out of quota is only reason text', continuation: 'opaque-report-handle' });
    expect(app.value<{ kind: string }[]>('log').at(-1)?.kind).toBe('failed');
    expect(startBody).toHaveBeenCalledTimes(1);
    await app.close();
    const restarted = await loom({ runtime: { startBody } }, app.dir, app.clock);
    restarted.clock.advance(8 * 86400_000); await settled();
    expect(startBody).toHaveBeenCalledTimes(1);
    expect(wake(restarted.db, w.id)).toMatchObject({ state: 'failed', failures: 1 });
    expect(wakes(restarted.db)).toHaveLength(1);
  });
  it('defers continuation quota waits but stops at the first definite failure', async () => {
    const startBody = vi.fn<() => Promise<StartResult>>()
      .mockResolvedValueOnce({ state: 'not-started', code: 'quota', reason: 'No model room' })
      .mockResolvedValue({ state: 'not-started', reason: 'Report refused' });
    const app = await loom({ runtime: { startBody } });
    const w = app.value('in', { agent: 'art', prompt: 'Report once', note: 'report', continuation: 'opaque-report-handle', when: '1m' });
    app.clock.advance(60_000); await settled();
    expect(wake(app.db, w.id)).toMatchObject({ state: 'pending', failures: 0, due: app.clock.now() + 61 * 60_000 });
    expect(app.value<{ kind: string }[]>('log').at(-1)?.kind).toBe('quota-wait');
    app.clock.advance(61 * 60_000); await settled();
    expect(wake(app.db, w.id)).toMatchObject({ state: 'failed', failures: 1, outcome: 'Report refused' });
    app.clock.advance(8 * 86400_000); await settled();
    expect(startBody).toHaveBeenCalledTimes(2);
  });
  it.each(['held', 'uncertain', 'throw'] as const)('holds a continuation on %s rather than treating it as a definite failure', async state => {
    const startBody = vi.fn(async (): Promise<StartResult> => {
      if (state === 'throw') throw new Error('Lost answer');
      return { state, reason: 'No definite result' };
    });
    const app = await loom({ runtime: { startBody } });
    const w = app.value('in', { agent: 'art', prompt: 'Report once', note: 'report', continuation: 'opaque-report-handle', when: '1m' });
    app.clock.advance(60_000); await settled();
    expect(wake(app.db, w.id)).toMatchObject({ state: 'held', hold: state === 'held' ? 'staging' : 'uncertain', failures: 0 });
    app.clock.advance(8 * 86400_000); await settled();
    expect(startBody).toHaveBeenCalledTimes(1);
  });
  it('backs off ordinary failures through six attempts even when the reason mentions quota', async () => {
    const startBody = vi.fn(async () => ({ state: 'not-started', reason: 'quota: no model has room' } as const));
    const app = await loom({ runtime: { startBody } });
    const w = app.set();
    for (let failure = 1; failure <= 6; failure++) {
      app.clock.advance(wake(app.db, w.id)!.due - app.clock.now()); await settled();
      expect(wake(app.db, w.id)).toMatchObject({ failures: failure, state: failure === 6 ? 'failed' : 'pending' });
      expect(startBody).toHaveBeenCalledTimes(failure);
      if (failure < 6) expect(wake(app.db, w.id)!.due - app.clock.now()).toBe(15 * 60_000 * 2 ** (failure - 1));
    }
    app.clock.advance(8 * 86400_000); await settled(); expect(startBody).toHaveBeenCalledTimes(6);
  });
  it.each(['replace', 'remove'] as const)('does not revive an ordinary schedule on quota after %s', async action => {
    const result = deferred<StartResult>(), invoked = deferred<void>();
    const clock = new FakeClock(Date.parse('2026-11-13T09:00:00Z'));
    const app = await loom({ runtime: { startBody() { invoked.resolve(); return result.promise; } } }, home(), clock);
    const input = { id: 'daily', agent: 'art', at: '03:31', prompt: 'Old words', note: 'daily' };
    app.value('scheduleSet', input); clock.advance(31 * 60_000); await invoked.promise;
    const firing = wakes(app.db).find(w => w.state === 'firing')!;
    if (action === 'replace') app.value('scheduleSet', { ...input, prompt: 'New words' });
    else app.value('scheduleRemove', { id: input.id });
    result.resolve({ state: 'not-started', code: 'quota', reason: 'No room' }); await settled();
    expect(wake(app.db, firing.id)).toMatchObject({ state: 'cancelled', failures: 0 });
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
    expect(wake(app.db, late.id)).toMatchObject({ state: 'held', hold: 'uncertain', outcome: 'Cancellation raced dispatch; a body may have started' });
    expect(startBody).toHaveBeenCalledTimes(1);
    app.value('cancel', { id: late.id });
    app.clock.advance(86400_000); await settled();
    expect(wake(app.db, late.id)).toMatchObject({ state: 'held', hold: 'uncertain' });
    expect(app.call('now', { id: late.id })).toMatchObject({ ok: false, code: 'invalid' });
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
    expect(wake(app.db, timeout.id)?.wait?.answer).toBe('pending');
    expect(wake(app.db, timeout.id)?.prompt).toContain('No answer to q-123 after 24h.');
    expect(wake(app.db, timeout.id)?.note).toBe('Resumed, no answer in 24h: timeout');
  });
  it('resumes a parked answer once across restart, ignoring stale instructions on denial', async () => {
    const dir = home(), clock = new FakeClock();
    let answer: 'pending' | 'denied' = 'pending';
    const options: ClockOptions = { approvals: { check: () => ({ state: answer, instruction: 'Spend the stale Allow', kind: 'merge', target: 'head' }), subscribe: () => () => {} } };
    const first = await loom(options, dir, clock);
    const w = first.value('park', { agent: 'art', prompt: 'Continue the work', note: 'Resumed after your OK: old work', on: 'a-123' });
    clock.advance(0); await first.close(); answer = 'denied';
    const startBody = vi.fn(async () => ({ state: 'started', body: 'resume-body' } as const));
    const restarted = await loom({ ...options, runtime: { startBody } }, dir, clock);
    clock.advance(5*60_000); await settled();
    expect(startBody).toHaveBeenCalledTimes(1);
    const resumed = wake(restarted.db, w.id)!;
    expect(resumed.note).toBe('Resumed after you said no: old work');
    expect(resumed.prompt).toBe("The owner's answer to a-123: denied. Don't work around it: comment on the task what's blocked and why, and wrap up cleanly.\n\n---\n\nContinue the work");
    expect(resumed.wait).toMatchObject({ id: 'a-123', answer: 'denied' });
    expect(resumed.by).toEqual(owner);
    await restarted.close(); const again = await loom({ ...options, runtime: { startBody } }, dir, clock);
    clock.advance(24*60*60_000); await settled();
    expect(startBody).toHaveBeenCalledTimes(1); expect(wake(again.db, w.id)?.note).toBe(resumed.note);
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
    const guards = [vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'realpathSync'), vi.spyOn(childProcess, 'spawn'), vi.spyOn(childProcess, 'execFile'), vi.spyOn(childProcess, 'execSync')];
    for (const guard of guards) guard.mockClear().mockImplementation(() => { throw new Error('Forbidden lane filesystem/process access'); });
    try {
      expect(app.value('in', { agent: 'art', file: 'routines/does-not-exist.md', note: 'rearm', when: '31m' }, { kind: 'agent', id: 'art' })).toMatchObject({ alreadyScheduled: true, schedule: 'lane/file-lane' });
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
  it('attributes replacement schedule work to its authenticated editor', async () => {
    const startBody = vi.fn(async () => ({ state: 'started', body: 'b' } as const));
    const app = await loom({ runtime: { startBody } });
    app.value('scheduleSet', { id: 'daily', agent: 'art', at: '00:01', prompt: 'Owner words', note: 'daily' });
    const agent: Viewer = { kind: 'agent', id: 'art' };
    expect(app.value<Schedule>('scheduleSet', { id: 'daily', agent: 'art', at: '00:01', prompt: 'Agent words', note: 'daily' }, agent).by).toEqual(agent);
    const pending = wakes(app.db).find(w => w.state === 'pending' && w.schedule === 'daily')!;
    app.clock.advance(pending.due - app.clock.now()); await settled();
    expect(startBody).toHaveBeenCalledWith(expect.objectContaining({ viewer: agent, wake: expect.objectContaining({ by: agent, prompt: 'Agent words' }) }));
  });
  it('includes an otherwise empty paused agent in each new live subscription', async () => {
    const app = await loom();
    app.value('pause', { agent: 'art' });
    for (let n = 0; n < 2; n++) {
      const ws = new WebSocket(app.url.replace('http:', 'ws:')+'/live');
      await once(ws, 'open');
      const initial = once(ws, 'message');
      ws.send(JSON.stringify({ kind: 'subscribe', type: 'clock' }));
      const [raw] = await initial;
      expect(JSON.parse(raw.toString())).toMatchObject({ kind: 'set', records: [{ id: 'art', paused: true }] });
      ws.terminate(); await once(ws, 'close');
    }
  });
  it('removes terminal wakes from the live scope exactly a day later', async () => {
    const app = await loom(), w = app.set(); app.value('cancel', { id: w.id });
    const ws = new WebSocket(app.url.replace('http:', 'ws:')+'/live'); const messages: unknown[] = []; ws.on('message', raw => messages.push(JSON.parse(raw.toString()))); await once(ws, 'open');
    const initial = once(ws, 'message'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'wake' })); await initial;
    expect(messages).toMatchObject([{ kind: 'set', records: [{ id: w.id }] }]);
    const removed = once(ws, 'message'); app.clock.advance(86400_000); await removed; expect(messages.at(-1)).toMatchObject({ kind: 'del', id: w.id }); ws.terminate(); await once(ws, 'close');
  });
});
