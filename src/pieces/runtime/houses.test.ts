import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(staging = false) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-houses-')); fixture(home);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock(), sharing = fixtureSharing();
  let app = await startLoom({ home, next: true, staging, clock, sharing: () => sharing }); cleanup.push(() => app.close());
  let seq = 0;
  const input = { agent: 'art', house: { repo: 'https://github.com/sleepunit-agents/art' } };
  const call = (value: unknown = input, viewer: Viewer = { kind: 'member', id: 'jonathan' }, id = `house-${++seq}`) => app.operations.call('direct', viewer, 'runtime.configureHouse', value, id);
  return { get app() { return app; }, get store() { return runtimeStore(app.db); }, clock, sharing, call, input,
    restart: async () => { await app.close(); app = await startLoom({ home, next: true, staging, clock, sharing: () => sharing }); } };
}
it('persists build identity, defaults the house path and preserves box/model settings in both directions', async () => {
  const f = await setup();
  f.app.db.transaction(() => f.store.put('settings', { id: 'art', agent: 'art', boxes: ['box'], model: 'gpt-6.1-sol' }, 1))();
  expect(f.call()).toEqual({ ok: true, value: { agent: 'art' } });
  expect(f.store.read('settings', 'art')).toMatchObject({ boxes: ['box'], model: 'gpt-6.1-sol', house: { repo: f.input.house.repo, houseFile: 'house/house.json' } });
  expect(f.app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'runtime.setBoxes', { agent: 'art', boxes: [] }, 'boxes').ok).toBe(true);
  await f.restart();
  expect(f.store.read('settings', 'art')).toMatchObject({ boxes: [], model: 'gpt-6.1-sol', house: { repo: f.input.house.repo, houseFile: 'house/house.json' } });
});
it('uses central agent setup for each owner and denies agents, runners and fully granted services', async () => {
  const f = await setup(); f.sharing.services.svc = { types: ['runtime.settings'], operations: ['runtime.configureHouse'] };
  for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'member', id: 'missing' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'art' }, { kind: 'service', id: 'svc' }] as Viewer[])
    expect(f.call(f.input, viewer)).toMatchObject({ ok: false, code: 'denied' });
  expect(f.call({ ...f.input, agent: 'missing' })).toMatchObject({ ok: false, code: 'denied' });
  const pond = { ...f.input, agent: 'pond-bot' };
  expect(f.call(pond)).toMatchObject({ ok: false, code: 'denied' });
  expect(f.store.ids('settings')).toEqual([]);
  expect(f.call(pond, { kind: 'member', id: 'pollock' }).ok).toBe(true);
  expect(f.call().ok).toBe(true);
});
it('replaces only house identity, clears omitted branch and supports legacy repository locators', async () => {
  const f = await setup();
  for (const repo of ['git@github.com:sleepunit-agents/art.git', '/repos/art', f.input.house.repo]) {
    expect(f.call({ agent: 'art', house: { repo, houseFile: 'tank/config.json', branch: 'build/next-1' } }).ok).toBe(true);
    expect(f.store.read('settings', 'art')?.house).toEqual({ repo, houseFile: 'tank/config.json', branch: 'build/next-1' });
  }
  expect(f.call().ok).toBe(true);
  expect(f.store.read('settings', 'art')?.house).toEqual({ repo: f.input.house.repo, houseFile: 'house/house.json' });
});
it('rejects path traversal, credentials, unsupported locators and injected capabilities or authority', async () => {
  const f = await setup();
  const houses = [
    ...['/house.json', '../house.json', 'a/../b', './house.json', 'a//b', 'a/', 'a b', ''].map(houseFile => ({ ...f.input.house, houseFile })),
    ...['http://host/repo', 'https:host/repo', 'https://host/a b', 'relative/path', 'https://user:password@host/repo', 'https://user@host/repo', 'https://host/repo?token=x', 'https://host/repo#key', 'git@host:repo?key=x', '', 'x'.repeat(401)].map(repo => ({ repo })),
    ...['nested', 'gpu', 'secrets', 'repoSecret', 'ports', 'tailnets', 'logins', 'scopes', 'steers', 'token'].map(key => ({ ...f.input.house, [key]: true })),
    { ...f.input.house, branch: 'main;cmd' }, { ...f.input.house, branch: '' },
  ];
  for (const house of houses) expect(f.call({ agent: 'art', house })).toMatchObject({ ok: false, code: 'invalid' });
  for (const field of ['project', 'member', 'owner', 'changedAt', 'box', 'job']) expect(f.call({ ...f.input, [field]: 'injected' })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.store.ids('settings')).toEqual([]);
});
it('announces only changes, replays old acknowledgements without restoring stale configuration, and rolls back late failure', async () => {
  const f = await setup(), changed = vi.spyOn(f.app.live, 'changed');
  expect(f.call(undefined, undefined, 'stable').ok).toBe(true);
  expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'runtime.settings', id: 'art' }]); changed.mockClear();
  const at = f.store.read('settings', 'art')!.changedAt; f.clock.advance(100);
  expect(f.call().ok).toBe(true); expect(changed).not.toHaveBeenCalled(); expect(f.store.read('settings', 'art')!.changedAt).toBe(at);
  expect(f.call({ agent: 'art', house: { repo: '/new' } }).ok).toBe(true); changed.mockClear();
  await f.restart(); const afterRestart = vi.spyOn(f.app.live, 'changed');
  expect(f.call(undefined, undefined, 'stable')).toEqual({ ok: true, value: { agent: 'art' } });
  expect(f.store.read('settings', 'art')?.house?.repo).toBe('/new'); expect(afterRestart).not.toHaveBeenCalled();
  expect(f.call({ agent: 'art', house: { repo: '/different' } }, undefined, 'stable')).toMatchObject({ ok: false, code: 'conflict' });
  const before = f.store.read('settings', 'art');
  f.app.db.exec("CREATE TRIGGER abort_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'abort'); END");
  expect(f.call(undefined, undefined, 'late')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(f.store.read('settings', 'art')).toEqual(before); expect(afterRestart).not.toHaveBeenCalled();
  expect(f.app.db.prepare('SELECT * FROM core_operations WHERE id=?').get('late')).toBeUndefined();
  f.app.db.exec('DROP TRIGGER abort_receipt'); expect(f.call(undefined, undefined, 'late').ok).toBe(true);
});
it('exposes only centrally scoped configuration metadata and creates no jobs or effects even in staging', async () => {
  const f = await setup(true); expect(f.call().ok).toBe(true);
  const list = (viewer: Viewer) => f.app.operations.call('direct', viewer, 'runtime.listSettings', {});
  expect(list({ kind: 'agent', id: 'art' })).toMatchObject({ ok: true, value: { records: [{ house: { repo: f.input.house.repo } }] } });
  for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'agent', id: 'pond-bot' }, { kind: 'runner', id: 'art' }] as Viewer[])
    expect(list(viewer)).toEqual({ ok: true, value: { records: [] } });
  expect(f.store.ids('job')).toEqual([]); expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toEqual([]);
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
});
