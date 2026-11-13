import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer, type Sharing } from '../../core/index.js';
import { installClock, type ClockOptions } from './index.js';
import { wakes, wake, active, type Wake } from './store.js';
import { deadmanPrompt, deadmanNote } from './deadman.js';
import type { StartResult } from './dependencies/runtime.js';
const day = 86_400_000;
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const sharing: Sharing = { members: { jonathan: { owner: true, agents: ['art', 'pollock'] } }, projects: {}, services: {} };
const dirs: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function loom(options: ClockOptions = {}, dir = mkdtempSync(join(tmpdir(), 'loom-deadman-')), clock = new FakeClock()) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const app = await startLoom({ home: dir, clock, install(app) {
    const jobs = installClock(app.db, app.operations, app.live, () => sharing, options); app.onClose(jobs.close);
  } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } }; closes.push(close);
  const call = (verb: string, input: object = {}, viewer = owner, door: 'direct' | 'http' = 'direct') => app.operations.call(door, viewer, `clock.${verb}`, input, randomUUID());
  const value = (verb: string, input: object = {}, viewer = owner): Wake => {
    const r = call(verb, input, viewer); if (!r.ok) throw new Error(JSON.stringify(r)); return r.value as Wake;
  };
  return { ...app, close, call, value, clock, dir };
}
const settle = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };
it('opts in only configured agents, fixes the words and elapsed 24h deadline, and retains them across restart', async () => {
  const disabled = await loom(); disabled.clock.advance(0);
  expect(wakes(disabled.db)).toEqual([]);
  const clock = new FakeClock(Date.UTC(2026, 10, 1, 5, 30)); // fall DST boundary
  const app = await loom({ deadmanAgents: ['art', 'art'] }, undefined, clock);
  const start = clock.now(); clock.advance(0);
  const [safety] = wakes(app.db);
  expect(wakes(app.db)).toHaveLength(1);
  expect(safety).toMatchObject({ agent: 'art', by: { kind: 'agent', id: 'art' }, deadman: true,
    prompt: deadmanPrompt, note: deadmanNote, due: start + day, state: 'pending', failures: 0 });
  for (const key of ['member', 'project', 'approval', 'continuation', 'slot', 'place', 'file', 'schedule']) expect(safety).not.toHaveProperty(key);
  clock.advance(3_600_000); await app.close();
  const restarted = await loom({ deadmanAgents: ['art'] }, app.dir, clock); clock.advance(0);
  expect(wakes(restarted.db)).toEqual([safety]);
  expect(restarted.call('deadman', { agent: 'pollock' }, { kind: 'agent', id: 'pollock' })).toMatchObject({ ok: false, code: 'denied' });
  expect(restarted.call('deadman', { agent: 'art' }, owner)).toMatchObject({ ok: false, code: 'denied' });
  expect(restarted.call('deadman', { agent: 'art' }, { kind: 'agent', id: 'art' }, 'http')).toMatchObject({ ok: false });
});
it('replaces a default atomically with real work, keeps other clocks independent, and rearms when emptied', async () => {
  const app = await loom({ deadmanAgents: ['art', 'pollock'] }); app.clock.advance(0);
  const safety = wakes(app.db).find(w => w.agent === 'art')!;
  const other = wakes(app.db).find(w => w.agent === 'pollock')!;
  const real = app.value('in', { agent: 'art', prompt: 'Real work', note: '', when: '2d', deadman: true });
  expect(real.deadman).toBeUndefined();
  expect(wake(app.db, safety.id)).toMatchObject({ state: 'cancelled', outcome: 'Replaced by real work' });
  expect(wake(app.db, other.id)).toEqual(other);
  expect(wakes(app.db).filter(w => w.agent === 'art' && active(w))).toEqual([real]);
  app.clock.advance(60_000);
  app.value('cancel', { id: real.id });
  const next = wakes(app.db).find(w => w.agent === 'art' && active(w))!;
  expect(next).toMatchObject({ deadman: true, due: app.clock.now() + day, by: { kind: 'agent', id: 'art' } });
  expect(next.id).not.toBe(safety.id);
});
it.each(['parked', 'held', 'firing'] as const)('treats %s real work as a nonempty spool', async state => {
  const app = await loom({ deadmanAgents: ['art'] });
  const real = app.value('in', { agent: 'art', prompt: 'Real', note: '', when: '1m' });
  real.state = state;
  if (state === 'held') real.hold = 'uncertain';
  app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(real), real.id);
  app.clock.advance(0);
  app.value('rearm');
  expect(wakes(app.db)).toEqual([real]);
});
it('preserves a default after a rejected write and clears it for the first schedule occurrence', async () => {
  const app = await loom({ deadmanAgents: ['art'] }); app.clock.advance(0);
  const before = wakes(app.db);
  expect(app.call('in', { agent: 'art', prompt: 'Invalid', note: '', when: 'nonsense' })).toMatchObject({ ok: false });
  expect(wakes(app.db)).toEqual(before);
  app.value('scheduleSet', { id: 'nightly', agent: 'art', prompt: 'Scheduled work', note: '', at: '03:31' });
  expect(wake(app.db, before[0].id)?.state).toBe('cancelled');
  expect(wakes(app.db).filter(active)).toMatchObject([{ schedule: 'nightly', state: 'pending' }]);
  app.value('scheduleRemove', { id: 'nightly' });
  expect(wakes(app.db).filter(active)).toMatchObject([{ deadman: true, due: app.clock.now() + day }]);
});
it('holds default starts in staging, honours pause/resume, and cancels a known-held default for real work', async () => {
  const app = await loom({ deadmanAgents: ['art'] }); app.clock.advance(0);
  const safety = wakes(app.db)[0]; app.value('pause', { agent: 'art' });
  app.clock.advance(day); await settle();
  expect(wake(app.db, safety.id)).toMatchObject({ state: 'held', hold: 'paused' });
  app.value('resume', { agent: 'art' }); app.clock.advance(60_000); await settle();
  expect(wake(app.db, safety.id)).toMatchObject({ state: 'held', hold: 'staging' });
  expect(wakes(app.db).filter(active)).toHaveLength(1);
  app.value('in', { agent: 'art', prompt: 'Real', note: '', when: '1m' });
  expect(wake(app.db, safety.id)?.state).toBe('cancelled');
});
it('fires once as the configured agent and plants the next fixed default after confirmed completion', async () => {
  const startBody = vi.fn(async (): Promise<StartResult> => ({ state: 'started', body: 'body-safety' }));
  const app = await loom({ deadmanAgents: ['art'], runtime: { startBody } }); app.clock.advance(0);
  const first = wakes(app.db)[0]; app.clock.advance(day); await settle();
  expect(startBody).toHaveBeenCalledTimes(1);
  expect(startBody.mock.calls[0]).toMatchObject([{ viewer: { kind: 'agent', id: 'art' }, wake: { id: first.id, prompt: deadmanPrompt } }]);
  expect(wake(app.db, first.id)?.state).toBe('fired');
  const next = wakes(app.db).find(active)!;
  expect(next).toMatchObject({ deadman: true, due: app.clock.now() + day, by: { kind: 'agent', id: 'art' } });
  await app.close(); const restarted = await loom({ deadmanAgents: ['art'], runtime: { startBody } }, app.dir, app.clock);
  app.clock.advance(0); await settle();
  expect(startBody).toHaveBeenCalledTimes(1); expect(wakes(restarted.db).filter(active)).toEqual([next]);
});
it('does not synthesize authority after opt-out, and never replaces an uncertain default with another safety wake', async () => {
  const startBody = vi.fn(async (): Promise<StartResult> => ({ state: 'started', body: 'must-not-start' }));
  const app = await loom({ deadmanAgents: ['art'] }); app.clock.advance(0); const safety = wakes(app.db)[0];
  await app.close(); const disabled = await loom({ runtime: { startBody } }, app.dir, app.clock);
  app.clock.advance(day); await settle();
  expect(startBody).not.toHaveBeenCalled(); expect(wake(disabled.db, safety.id)).toMatchObject({ state: 'held', hold: 'permission' });
  await disabled.close();
  const uncertain = await loom({ deadmanAgents: ['art'], runtime: { async startBody() { throw new Error('lost outcome'); } } }, app.dir, app.clock);
  uncertain.value('now', { id: safety.id }); app.clock.advance(0); await settle();
  expect(wake(uncertain.db, safety.id)).toMatchObject({ state: 'held', hold: 'uncertain' });
  const real = uncertain.value('in', { agent: 'art', prompt: 'Independent', note: '', when: '1h' });
  expect(wake(uncertain.db, safety.id)).toMatchObject({ state: 'held', hold: 'uncertain' });
  uncertain.value('cancel', { id: real.id });
  expect(wakes(uncertain.db).filter(active)).toHaveLength(1);
});
it('composes explicit next-mode opt-in without changing the default hold runtime or reading legacy settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-next-deadman-')); dirs.push(dir);
  const clock = new FakeClock();
  const app = await startLoom({ home: dir, clock, next: true, stdout: () => {}, sharing: () => sharing, clockDeadmanAgents: ['art'] });
  closes.push(() => app.close());
  clock.advance(0);
  expect(wakes(app.db)).toMatchObject([{ deadman: true, agent: 'art', by: { kind: 'agent', id: 'art' }, due: clock.now() + day }]);
  clock.advance(day); await settle();
  expect(wakes(app.db)).toMatchObject([{ state: 'held', hold: 'staging' }]);
});
