import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(staging = false) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-queue-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true })); fixture(home);
  const clock = new FakeClock(), sharing = fixtureSharing();
  let app = await startLoom({ home, clock, next: true, staging, sharing: () => sharing });
  cleanups.push(() => app.close());
  const store = runtimeStore(app.db);
  app.db.transaction(() => {
    for (const id of ['a', 'b']) store.put('box', { id, name: id === 'b' ? 'rig' : id, owner: 'jonathan', local: false,
      mayHost: '*', lentTo: [], facts: id === 'b' ? ['gpu:5090'] : [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1 }, 1);
    store.put('settings', { id: 'art', agent: 'art', boxes: ['a', 'b'] }, 1);
  })();
  let seq = 0;
  const input = { agent: 'art', title: 'Inspect fixture', brief: 'PRIVATE request words' };
  const call = (extra: object = {}, viewer: Viewer = { kind: 'member', id: 'jonathan' }, id = `queue-${++seq}`) =>
    app.operations.call('direct', viewer, 'runtime.queueBody', { ...input, ...extra }, id);
  const jobOf = (result: ReturnType<typeof call>) => { expect(result.ok).toBe(true); return (result as { ok: true; value: { job: string } }).value.job; };
  return { get app() { return app; }, get store() { return runtimeStore(app.db); }, sharing, clock, call, input, jobOf,
    restart: async () => { await app.close(); app = await startLoom({ home, clock, next: true, staging, sharing: () => sharing }); },
  };
}
it('queues durable input and canonical placement, then an assigned runner can claim the real request', async () => {
  const f = await setup();
  const job = f.jobOf(f.call({ box: 'rig', needs: ['gpu:5090'], project: 'pond' }));
  expect(f.store.read('job', job)).toEqual({ id: job, agent: 'art', project: 'pond', title: f.input.title, box: 'b', runner: 'b', state: 'queued', createdAt: f.clock.now(), changedAt: f.clock.now() });
  expect(f.app.db.prepare('SELECT * FROM runtime_inputs WHERE job=?').get(job)).toEqual({ job, brief: f.input.brief, needs: '["gpu:5090"]' });
  expect(f.app.operations.call('direct', { kind: 'runner', id: 'a' }, 'runtime.claimJob', { job }, 'wrong')).toMatchObject({ ok: false, code: 'denied' });
  expect(f.app.operations.call('direct', { kind: 'runner', id: 'b' }, 'runtime.claimJob', { job }, 'claim')).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'runtime.configureHouse', { agent: 'art', house: { repo: '/fixture/art' } }, 'configure').ok).toBe(true);
  expect(f.app.operations.call('direct', { kind: 'runner', id: 'b' }, 'runtime.claimJob', { job }, 'claim')).toEqual({ ok: true, value: { job, state: 'starting' } });
});
it('requires give-work and separately authorizes every supplied scope', async () => {
  const f = await setup();
  for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'a' }, { kind: 'service', id: 'keyholder' }] as Viewer[])
    expect(f.call({}, viewer)).toMatchObject({ ok: false, code: 'denied' });
  // Pollock can see Pond and give work to pond-bot, but cannot use the unrelated Other project.
  expect(f.call({ agent: 'pond-bot', project: 'other' }, { kind: 'member', id: 'pollock' })).toMatchObject({ ok: false, code: 'denied' });
  expect(f.call({ member: 'pollock' })).toMatchObject({ ok: false, code: 'denied' });
  expect(f.call({ agent: 'missing' })).toMatchObject({ ok: false, code: 'denied' });
  expect(f.store.ids('job')).toEqual([]);
  const privateJob = f.jobOf(f.call({ member: 'jonathan', project: 'pond' }));
  expect(f.store.read('job', privateJob)?.member).toBe('jonathan');
  const visible = (viewer: Viewer) => f.app.operations.call('direct', viewer, 'runtime.listJobs', {});
  expect(visible({ kind: 'member', id: 'jonathan' })).toMatchObject({ ok: true, value: { records: [{ id: privateJob, member: 'jonathan' }] } });
  for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'a' }] as Viewer[])
    expect(visible(viewer)).toEqual({ ok: true, value: { records: [] } });
});
it('rechecks placement and capabilities and never creates partial requests on a refusal', async () => {
  const f = await setup();
  expect(f.store.read('settings', 'art')?.boxes).toEqual(['a', 'b']);
  expect(f.store.read('job', f.jobOf(f.call()))?.box).toBe('a');
  expect(f.store.read('job', f.jobOf(f.call({ needs: ['gpu:5090'] })))?.box).toBe('b');
  for (const extra of [{ box: 'missing' }, { box: 'a', needs: ['gpu:5090'] }, { needs: ['arch:arm64'] }]) expect(f.call(extra)).toMatchObject({ ok: false });
  f.app.db.transaction(() => { const { changedAt: _, ...box } = f.store.read('box', 'b')!; f.store.put('box', { ...box, mayHost: [] }, 1); })();
  expect(f.call({ box: 'rig' })).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.store.ids('job')).toHaveLength(2);
  expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toHaveLength(2);
});
it('keeps request words out of acknowledgements, live/registry collections and retry results in staging', async () => {
  const f = await setup(true), result = f.call(), job = f.jobOf(result);
  expect(result).toEqual({ ok: true, value: { job, state: 'queued' } });
  const collection = f.app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'runtime.listJobs', {});
  expect(collection).toMatchObject({ ok: true, value: { records: [{ id: job, title: f.input.title }] } });
  expect(JSON.stringify(collection)).not.toContain(f.input.brief);
  expect(JSON.stringify(f.app.db.prepare("SELECT result FROM core_operations WHERE name='runtime.queueBody'").all())).not.toContain(f.input.brief);
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
  expect(f.app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'runtime.startBody', f.input, 'start')).toMatchObject({ ok: false, code: 'conflict' }); // No configured house yet.
  expect(f.app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'runtime.takeInput', { job })).toMatchObject({ ok: false });
});
it('replays after restart without re-placement or notifications; changed input conflicts', async () => {
  const f = await setup(), result = f.call({}, undefined, 'stable'), job = f.jobOf(result);
  f.app.db.transaction(() => { const { changedAt: _, ...box } = f.store.read('box', 'a')!; f.store.put('box', { ...box, revokedAt: 1 }, 1); })();
  await f.restart(); f.clock.advance(10);
  const changed = vi.spyOn(f.app.live, 'changed');
  expect(f.call({}, undefined, 'stable')).toEqual(result);
  expect(f.call({ brief: 'different' }, undefined, 'stable')).toMatchObject({ ok: false, code: 'conflict' });
  expect(changed).not.toHaveBeenCalled();
  expect(f.store.ids('job')).toEqual([job]);
  expect(f.app.db.prepare('SELECT brief FROM runtime_inputs WHERE job=?').get(job)).toEqual({ brief: f.input.brief });
});
it('rolls job, input and receipt back together on both later writes and announces only commits', async () => {
  const f = await setup(), changed = vi.spyOn(f.app.live, 'changed');
  for (const table of ['runtime_inputs', 'core_operations']) {
    f.app.db.exec(`CREATE TRIGGER abort_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'abort'); END`);
    expect(f.call({}, undefined, table)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(f.store.ids('job')).toEqual([]); expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toEqual([]);
    expect(f.app.db.prepare('SELECT * FROM core_operations WHERE id=?').get(table)).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    f.app.db.exec('DROP TRIGGER abort_write');
  }
  const job = f.jobOf(f.call({}, undefined, 'runtime_inputs'));
  expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'runtime.job', id: job }]);
});
it('rejects identity, authority and lifecycle injection and bounds request payloads', async () => {
  const f = await setup();
  for (const extra of [{ job: 'chosen' }, { runner: 'a' }, { state: 'running' }, { createdAt: 1 }, { conversation: 'cv' }, { model: 'model' }, { account: 'key' }, { source: { kind: 'wake', id: 'w' } }, { brief: '' }, { brief: 'x'.repeat(100_001) }, { title: '' }, { needs: Array(33).fill('gpu') }])
    expect(f.call(extra)).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.store.ids('job')).toEqual([]);
});
it('upgrades version-one runtime storage without changing existing job/box metadata', async () => {
  const f = await setup(), job = f.jobOf(f.call());
  const before = f.store.read('job', job), boxes = f.app.db.prepare('SELECT * FROM runtime_boxes ORDER BY id').all();
  // Materialize the previous runtime layout with existing metadata.
  f.app.db.exec("DROP TABLE runtime_results; DROP TABLE runtime_deliveries; DROP TABLE runtime_inputs; DELETE FROM core_migrations WHERE piece='runtime' AND number>=2");
  await f.restart();
  expect(f.store.read('job', job)).toEqual(before);
  expect(f.app.db.prepare('SELECT * FROM runtime_boxes ORDER BY id').all()).toEqual(boxes);
  expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toEqual([]);
  expect(f.call()).toMatchObject({ ok: true });
});

it('independently checks project scope even with private visibility and never grants service give-work', async () => {
  const f = await setup(), pollock = { kind: 'member', id: 'pollock' } as const;
  f.sharing.services.keyholder = { types: ['runtime.job'], operations: ['runtime.queueBody'] };
  expect(f.call({}, { kind: 'service', id: 'keyholder' })).toMatchObject({ ok: false, code: 'denied' });
  // Private visibility lets give-work succeed: mayCreate must independently check Other.
  expect(f.call({ agent: 'pond-bot', member: 'pollock', project: 'other' }, pollock)).toMatchObject({ ok: false, code: 'denied' });
  expect(f.store.ids('job')).toEqual([]);
  f.app.db.transaction(() => { const { changedAt: _, ...box } = f.store.read('box', 'a')!; f.store.put('box', { ...box, lentTo: ['pond-bot'] }, 1); })();
  const job = f.jobOf(f.call({ agent: 'pond-bot', member: 'pollock', project: 'pond', box: 'a' }, pollock));
  expect(f.store.read('job', job)).toMatchObject({ agent: 'pond-bot', member: 'pollock', project: 'pond', box: 'a' });
});
