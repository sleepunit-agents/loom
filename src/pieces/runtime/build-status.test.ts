import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
import type { RuntimeRecords } from './records.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const image = (digit: string) => `loom-house-art:${digit.repeat(20)}`;
async function setup(staging = false) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-build-status-')); fixture(home);
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock(), sharing = fixtureSharing();
  let app = await startLoom({ home, next: true, staging, clock, sharing: () => sharing });
  cleanups.push(() => app.close());
  let seq = 0;
  const store = () => runtimeStore(app.db);
  const put = (id: string, extra: Partial<RuntimeRecords['job']> = {}) => app.db.transaction(() => store().put('job', {
    id, agent: 'art', runner: 'a', box: 'a', title: id, state: 'queued', createdAt: 1, ...extra,
  }, clock.now()))();
  const call = (name: string, input: unknown, viewer: Viewer = { kind: 'runner', id: 'a' }, id = `op-${++seq}`) => app.operations.call('direct', viewer, `runtime.${name}`, input, id);
  const status = (viewer: Viewer = { kind: 'member', id: 'jonathan' }, input: unknown = { agent: 'art' }) => call('buildStatus', input, viewer);
  app.db.transaction(() => {
    store().put('box', { id: 'a', name: 'a', owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1 }, 1);
    store().put('settings', { id: 'art', agent: 'art', boxes: [], house: { repo: '/art', houseFile: 'house/house.json' } }, 1);
  })();
  return { get app() { return app; }, get store() { return store(); }, clock, sharing, put, call, status,
    restart: async () => { await app.close(); app = await startLoom({ home, next: true, staging, clock, sharing: () => sharing }); } };
}
it('discovers the newest visible matching report, survives restart, and never re-dates a repeated image', async () => {
  const f = await setup();
  expect(f.status()).toEqual({ ok: true, value: { agent: 'art', build: null } });
  for (const [job, digit] of [['old', '1'], ['new', '2']]) {
    f.put(job); expect(f.call('claimJob', { job }).ok).toBe(true); f.clock.advance(10);
    expect(f.call('reportJob', { job, state: 'running', build: image(digit) }, undefined, `report-${job}`).ok).toBe(true);
  }
  const at = f.clock.now(), newest = { ok: true, value: { agent: 'art', build: { image: image('2'), job: 'new', at } } };
  expect(f.status()).toEqual(newest);
  const oldAt = f.store.read('job', 'old')!.buildAt;
  f.clock.advance(100);
  expect(f.call('reportJob', { job: 'old', state: 'waiting' }).ok).toBe(true);
  expect(f.call('reportJob', { job: 'old', state: 'running', build: image('1') }).ok).toBe(true);
  expect(f.call('reportJob', { job: 'old', state: 'running', build: image('1') }, undefined, 'report-old').ok).toBe(true);
  expect(f.store.read('job', 'old')!.buildAt).toBe(oldAt); expect(f.status()).toEqual(newest);
  await f.restart(); expect(f.status()).toEqual(newest);
});
it('filters private and project jobs before selecting, with separate service type and operation grants', async () => {
  const f = await setup(), made = f.store.read('settings', 'art')!.house!;
  f.put('public', { state: 'done', made, claimedAt: 1, build: image('1'), buildAt: 10 });
  f.put('private', { state: 'done', member: 'jonathan', made, claimedAt: 1, build: image('2'), buildAt: 20 });
  f.put('project', { state: 'running', project: 'other', made, claimedAt: 1, build: image('3'), buildAt: 30 });
  f.sharing.projects.other.agents = [];
  expect(f.status()).toMatchObject({ value: { build: { job: 'project' } } });
  expect(f.status({ kind: 'agent', id: 'art' })).toMatchObject({ value: { build: { job: 'public' } } });
  for (const viewer of [{ kind: 'runner', id: 'a' }, { kind: 'member', id: 'pollock' }, { kind: 'agent', id: 'pond-bot' }, { kind: 'service', id: 'svc' }] as Viewer[])
    expect(f.status(viewer)).toMatchObject({ ok: false, code: 'denied' });
  f.sharing.services.svc = { types: ['runtime.settings'], operations: ['runtime.buildStatus'] };
  expect(f.status({ kind: 'service', id: 'svc' })).toMatchObject({ value: { build: null } });
  f.sharing.services.svc.types.push('runtime.job');
  expect(f.status({ kind: 'service', id: 'svc' })).toMatchObject({ value: { build: { job: 'project' } } });
  f.sharing.services.svc.operations = [];
  expect(f.status({ kind: 'service', id: 'svc' })).toMatchObject({ ok: false, code: 'denied' });
  f.sharing.services.svc = { types: ['runtime.job'], operations: ['runtime.buildStatus'] };
  expect(f.status({ kind: 'service', id: 'svc' })).toMatchObject({ ok: false, code: 'denied' });
});
it('excludes changed identities, missing provenance, undated historical builds and impossible report times', async () => {
  const f = await setup(), made = f.store.read('settings', 'art')!.house!;
  const good = { state: 'running' as const, made, claimedAt: 1, build: image('1'), buildAt: 10 };
  f.put('good', good);
  for (const [id, extra] of Object.entries({
    repo: { made: { ...made, repo: '/different' } }, file: { made: { ...made, houseFile: 'other.json' } },
    branch: { made: { ...made, branch: 'next' } }, secret: { made: { ...made, repoSecret: 'repo-key' } },
    queued: { state: 'queued' as const }, undated: { buildAt: undefined }, unclaimed: { claimedAt: undefined }, unsnapped: { made: undefined },
    beforeClaim: { claimedAt: 30 }, future: { buildAt: f.clock.now() + 1 }, wrongAgent: { build: 'loom-house-mark:' + 'a'.repeat(20) },
  })) f.put(id, { ...good, buildAt: 20, ...extra });
  expect(f.status()).toMatchObject({ value: { build: { job: 'good' } } });
  const owner: Viewer = { kind: 'member', id: 'jonathan' };
  expect(f.call('configureGrants', { agent: 'art', grants: { repoSecret: 'private-key' } }, owner).ok).toBe(true);
  expect(f.status()).toMatchObject({ value: { build: null } });
  expect(f.call('configureGrants', { agent: 'art', grants: {} }, owner).ok).toBe(true);
  expect(f.status()).toMatchObject({ value: { build: { job: 'good' } } });
  f.app.db.prepare("DELETE FROM runtime_settings WHERE id='art'").run();
  expect(f.status()).toMatchObject({ value: { build: null } });
});
it('chooses stable equal-time ties and refuses injected discovery or report authority', async () => {
  const f = await setup(), made = f.store.read('settings', 'art')!.house!;
  for (const id of ['z', 'a']) f.put(id, { state: 'running', made, claimedAt: 1, build: image(id === 'a' ? '1' : '2'), buildAt: 10 });
  expect(f.status()).toMatchObject({ value: { build: { job: 'a' } } });
  for (const extra of [{ member: 'jonathan' }, { project: 'other' }, { build: image('2') }, { at: 10 }])
    expect(f.status(undefined, { agent: 'art', ...extra })).toMatchObject({ ok: false, code: 'invalid' });
  f.put('report'); expect(f.call('claimJob', { job: 'report' }).ok).toBe(true);
  expect(f.call('reportJob', { job: 'report', state: 'running', build: image('1'), buildAt: 10 })).toMatchObject({ ok: false, code: 'invalid' });
});
it('rolls back report time with receipt failure and creates no effects or writes during discovery in staging', async () => {
  const f = await setup(true); f.put('j'); f.call('claimJob', { job: 'j' });
  const before = f.store.read('job', 'j'), changed = vi.spyOn(f.app.live, 'changed');
  f.app.db.exec("CREATE TRIGGER abort_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'abort'); END");
  expect(f.call('reportJob', { job: 'j', state: 'running', build: image('1') }, undefined, 'report')).toMatchObject({ ok: false });
  expect(f.store.read('job', 'j')).toEqual(before);
  expect(f.status()).toMatchObject({ value: { build: null } });
  f.app.db.exec('DROP TRIGGER abort_receipt');
  expect(f.call('reportJob', { job: 'j', state: 'running', build: image('1') }, undefined, 'report').ok).toBe(true);
  changed.mockClear();
  const receipts = f.app.db.prepare('SELECT count(*) AS n FROM core_operations').get();
  expect(f.status()).toMatchObject({ value: { build: { job: 'j', at: f.clock.now() } } });
  expect(f.app.db.prepare('SELECT count(*) AS n FROM core_operations').get()).toEqual(receipts);
  expect(changed).not.toHaveBeenCalled(); expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
});
it('keeps historical images undated on repeat and clears stale queued report time at claim', async () => {
  const f = await setup(), made = f.store.read('settings', 'art')!.house!;
  f.put('historical', { state: 'running', made, claimedAt: 1, build: image('1') });
  expect(f.call('reportJob', { job: 'historical', state: 'running', build: image('1') }).ok).toBe(true);
  expect(f.store.read('job', 'historical')!.buildAt).toBeUndefined();
  expect(f.status()).toMatchObject({ value: { build: null } });
  f.put('queued', { made, claimedAt: 1, build: image('2'), buildAt: 10 });
  expect(f.call('claimJob', { job: 'queued' }).ok).toBe(true);
  expect(f.store.read('job', 'queued')!.build).toBeUndefined();
  expect(f.store.read('job', 'queued')!.buildAt).toBeUndefined();
  expect(f.status()).toMatchObject({ value: { build: null } });
});
