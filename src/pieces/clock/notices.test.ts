import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installAttention } from '../attention/index.js';
import { installClock } from './index.js';
import type { StartResult } from './dependencies/runtime.js';
import type { Wake } from './store.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'art' };
const sharing = () => ({ members: { jonathan: { owner: true, agents: ['art'] }, guest: { owner: false, agents: ['art'] } }, projects: {}, services: {} });
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function setup(home = mkdtempSync(join(tmpdir(), 'clock-notices-')), next = false, runtime?: { startBody(): Promise<StartResult> }) {
  if (!homes.includes(home)) homes.push(home);
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, next, sharing, authenticate: () => ({ viewer: owner, valid: () => true }), install(app) {
    if (next) return;
    const sources = installAttention(app.db, app.operations, app.live, sharing);
    const notices = sources.register('clock', () => {});
    const jobs = installClock(app.db, app.operations, app.live, sharing, { notices, runtime });
    app.onClose(jobs.close);
  } });
  let closed = false; const close = async () => { if (!closed) { closed = true; await app.close(); } }; closes.push(close);
  const call = (name: string, input: object, viewer = owner, receipt = randomUUID()) => app.operations.call('direct', viewer, name, input, receipt);
  const set = (extra: object = {}) => {
    const result = call('clock.in', { agent: 'art', prompt: 'PRIVATE PROMPT', note: 'PRIVATE NOTE', when: '1m', ...extra });
    if (!result.ok) throw Error(JSON.stringify(result)); return result.value as Wake;
  };
  const outcome = (w: Wake, result: StartResult) => {
    clock.advance(w.due - clock.now());
    // Drive the same direct-only transition as the daemon before its queued pump.
    const attempt = randomUUID();
    const current = JSON.parse((app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(w.id) as { record: string }).record) as Wake;
    // The pump may already have committed an intent at this deadline.
    const dispatched = current.state === 'firing' ? current : (() => {
      const r = call('clock.dispatch', { id: w.id, attempt }); if (!r.ok) throw Error(JSON.stringify(r)); return r.value as Wake;
    })();
    const r = call('clock.outcome', { id: w.id, attempt: dispatched.attempt, result });
    if (!r.ok) throw Error(JSON.stringify(r)); return r.value as Wake;
  };
  const notices = () => app.db.prepare('SELECT record FROM attention_asks ORDER BY id').all().map(r => JSON.parse((r as {record:string}).record));
  return { app, close, call, set, outcome, notices, home };
}
it('publishes only at three failures and give-up; acknowledgement never repeats or starts work', async () => {
  const a = await setup(); let w = a.set();
  for (let n = 1; n <= 6; n++) {
    w = a.outcome(w, { state: 'not-started', reason: 'PRIVATE RUNTIME ERROR' });
    expect(w.failures).toBe(n);
    expect(a.notices()).toHaveLength(n < 3 ? 0 : n < 6 ? 1 : 2);
    if (n === 3) {
      const id = a.notices()[0].id;
      expect(a.call('attention.answer', { id, answer: { kind: 'done' } }).ok).toBe(true);
    }
  }
  expect(w.state).toBe('failed');
  expect(a.notices().map(n => n.state).sort()).toEqual(['answered', 'open']);
  expect(JSON.stringify(a.notices())).not.toMatch(/PRIVATE/);
  for (const viewer of [agent, { kind: 'member', id: 'guest' } as Viewer])
    expect(a.call('attention.get', { id: a.notices()[0].id }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  await a.close();
  const b = await setup(a.home);
  expect(b.notices()).toHaveLength(2);
  expect(b.call('attention.answer', { id: b.notices().find(n => n.state === 'open').id, answer: { kind: 'dismiss' } }).ok).toBe(true);
  expect(b.call('clock.list', {})).toMatchObject({ ok: true, value: [expect.objectContaining({ state: 'failed', failures: 6 })] });
});
it('deduplicates quota notices across waits and answer; never consumes failures', async () => {
  const a = await setup(); let w = a.set();
  w = a.outcome(w, { state: 'not-started', code: 'quota', reason: 'PRIVATE QUOTA' });
  expect(w.failures).toBe(0); expect(a.notices()).toHaveLength(1);
  const id = a.notices()[0].id;
  expect(a.call('attention.answer', { id, answer: { kind: 'done' } }).ok).toBe(true);
  w = a.outcome(w, { state: 'not-started', code: 'quota', reason: 'PRIVATE QUOTA' });
  expect(w.failures).toBe(0); expect(a.notices()).toHaveLength(1);
  expect(a.notices()[0].state).toBe('answered');
});
it('notifies on failed continuation and suppressed quota triage but never on held or uncertain work', async () => {
  const a = await setup();
  const continuation = a.outcome(a.set({ continuation: 'opaque' }), { state: 'not-started', reason: 'PRIVATE FAILURE' });
  expect(continuation.state).toBe('failed');
  const triage = a.outcome(a.set({ place: 'alert:runtime-quota' }), { state: 'not-started', code: 'quota', reason: 'PRIVATE QUOTA' });
  expect(triage.state).toBe('cancelled');
  a.outcome(a.set(), { state: 'held', reason: 'Staging' });
  a.outcome(a.set(), { state: 'uncertain', reason: 'Unknown' });
  expect(a.notices()).toHaveLength(2);
});
it('rolls back the outcome with a failed notice write', async () => {
  const a = await setup(); let w = a.set();
  w = a.outcome(w, { state: 'not-started', reason: 'first' });
  w = a.outcome(w, { state: 'not-started', reason: 'second' });
  a.app.db.exec("CREATE TRIGGER refuse_notice BEFORE INSERT ON attention_asks BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END");
  expect(() => a.outcome(w, { state: 'not-started', reason: 'third' })).toThrow('unavailable');
  const row = JSON.parse((a.app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(w.id) as {record:string}).record);
  expect(row).toMatchObject({ state: 'firing', failures: 2 });
  expect(a.notices()).toHaveLength(0);
});

it('composes household notices on the real next side without a fixture installer', async () => {
  const a = await setup(undefined, true);
  const w = a.outcome(a.set(), { state: 'not-started', code: 'quota', reason: 'PRIVATE QUOTA' });
  expect(w.state).toBe('pending');
  expect(a.notices()).toHaveLength(1);
  const id = a.notices()[0].id;
  expect(a.call('attention.answer', { id, answer: { kind: 'done' } }).ok).toBe(true);
  expect(a.call('clock.list', {})).toMatchObject({ ok: true, value: [expect.objectContaining({ state: 'pending', failures: 0 })] });
});

it('publishes from the actual asynchronous daemon outcome path once per threshold', async () => {
  let calls = 0;
  const a = await setup(undefined, false, { async startBody() { calls++; return { state: 'not-started', reason: 'PRIVATE ERROR' }; } });
  let w = a.set();
  for (let n = 1; n <= 6; n++) {
    // Drain the documented promise chain; no wall-clock sleeps or child process.
    const due = w.due;
    const clock = a.app.operations.clock as FakeClock;
    clock.advance(due - clock.now());
    for (let step = 0; step < 6; step++) await Promise.resolve();
    w = JSON.parse((a.app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(w.id) as {record:string}).record);
    expect(w.failures).toBe(n);
    expect(a.notices()).toHaveLength(n < 3 ? 0 : n < 6 ? 1 : 2);
  }
  expect(calls).toBe(6); expect(w.state).toBe('failed');
});
