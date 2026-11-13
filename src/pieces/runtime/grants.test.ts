import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
import { configuredBuild, configuredHouse } from './builds.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(staging = false) {
  const home = mkdtempSync(join(tmpdir(), 'runtime-grants-')); fixture(home);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock(), sharing = fixtureSharing();
  let app = await startLoom({ home, next: true, staging, clock, sharing: () => sharing }); cleanup.push(() => app.close());
  let seq = 0;
  const call = (grants: unknown = {}, viewer: Viewer = { kind: 'member', id: 'jonathan' }, agent = 'art', id = `grants-${++seq}`) => app.operations.call('direct', viewer, 'runtime.configureGrants', { agent, grants }, id);
  return { get app() { return app; }, get store() { return runtimeStore(app.db); }, clock, sharing, call,
    restart: async () => { await app.close(); app = await startLoom({ home, next: true, staging, clock, sharing: () => sharing }); } };
}
const full = {
  nested: true, gpu: true, repoSecret: 'repo-key', secrets: { github: 'github-store' },
  ports: [{ ip: '127.0.0.1', port: 1024 }, { ip: '0.0.0.0', port: 65535 }],
  tailnets: [{ name: 'fleet', socket: '/run/tailscale-fleet/tailscaled.sock' }], logins: ['claude', 'codex'],
  scopes: { github: 'owner+pond+service:discord', 'tailnet:fleet': 'pond' }, steers: { patrick: ['pond'] },
};
it('persists owner grants, preserves build/box/model settings, and never creates executable work', async () => {
  const f = await setup(true);
  f.app.db.transaction(() => f.store.put('settings', { id: 'art', agent: 'art', boxes: ['a'], model: 'model', house: { repo: '/art', houseFile: 'house/house.json' } }, 1))();
  expect(f.call(full)).toEqual({ ok: true, value: { agent: 'art' } }); await f.restart();
  expect(f.store.read('settings', 'art')).toMatchObject({ boxes: ['a'], model: 'model', house: { repo: '/art' }, grants: { ...full, scopeStores: { github: 'github-store' } } });
  expect(f.app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'runtime.configureHouse', { agent: 'art', house: { repo: '/changed' } }, 'house').ok).toBe(true);
  expect(f.app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'runtime.setBoxes', { agent: 'art', boxes: [] }, 'boxes').ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants).toEqual({ ...full, scopeStores: { github: 'github-store' } });
  expect(f.store.ids('job')).toEqual([]);
  expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toEqual([]);
  expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
});
it('uses exact target central agent-setup even for owners and fully granted services', async () => {
  const f = await setup(); f.sharing.services.svc = { types: ['runtime.settings'], operations: ['runtime.configureGrants'] };
  for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'member', id: 'missing' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'art' }, { kind: 'service', id: 'svc' }] as Viewer[])
    expect(f.call(full, viewer)).toMatchObject({ ok: false, code: 'denied' });
  expect(f.call(full, undefined, 'pond-bot')).toMatchObject({ ok: false, code: 'denied' });
  expect(f.call(full, undefined, 'missing')).toMatchObject({ ok: false, code: 'denied' });
  expect(f.store.ids('settings')).toEqual([]);
  expect(f.call(full, { kind: 'member', id: 'pollock' }, 'pond-bot').ok).toBe(true);
  expect(f.call(full).ok).toBe(true);
});
it('preserves scopes and steering on empty/omitted forms and remembers removed secret sources across renames', async () => {
  const f = await setup(); expect(f.call(full).ok).toBe(true);
  expect(f.call({ scopes: {}, steers: {} }).ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants).toMatchObject({ nested: false, gpu: false, secrets: {}, ports: [], tailnets: [], scopes: full.scopes, steers: full.steers, logins: full.logins, scopeStores: { github: 'github-store' } });
  await f.restart();
  expect(f.call({ secrets: { renamed: 'github-store' } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.call({ secrets: { renamed: 'github-store' }, scopes: { ...full.scopes, renamed: full.scopes.github } }).ok).toBe(true);
  expect(f.call({}).ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants?.scopeStores).toEqual({ github: 'github-store', renamed: 'github-store' });
  expect(f.call({ secrets: { third: 'github-store' } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.call({ secrets: { third: 'github-store' }, scopes: { ...full.scopes, renamed: full.scopes.github, third: full.scopes.github } }).ok).toBe(true);
  expect(f.call({ secrets: { third: 'github-store' }, scopes: 'none', steers: 'none', logins: 'default' }).ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants).toMatchObject({ secrets: { third: 'github-store' }, scopes: {}, scopeStores: {}, steers: {} });
  expect(f.store.read('settings', 'art')?.grants?.logins).toBeUndefined();
});
it('rejects inconsistent secret/socket aliases and scope typos; accepts equal restrictions and explicit login removal', async () => {
  const f = await setup();
  expect(f.call({ secrets: { a: 'store', b: 'store' }, scopes: { a: 'owner' } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.call({ secrets: { a: 'store' }, scopes: { typo: 'owner' } })).toMatchObject({ ok: false, code: 'invalid' });
  const tailnets = [{ name: 'a', socket: '/run/tailscaled.sock' }, { name: 'b', socket: '/run/tailscaled.sock' }];
  expect(f.call({ tailnets, scopes: { 'tailnet:a': 'pond' } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.call({ tailnets, scopes: { 'tailnet:a': 'pond', 'tailnet:b': 'pond' }, secrets: { a: 'store', b: 'store' }, logins: ['claude', 'claude'] }).ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants?.logins).toEqual(['claude']);
  expect(f.call({ logins: [] }).ok).toBe(true); expect(f.store.read('settings', 'art')?.grants?.logins).toEqual([]);
});
it('validates bounded structured grants and refuses values/authority injected as unknown fields', async () => {
  const f = await setup();
  const invalid = [
    { secrets: 'github=github-store' }, { ports: '7401' }, { tailnets: 'fleet=/run/tailscaled.sock' },
    { logins: 'claude' }, { scopes: 'github=owner' }, { steers: 'patrick=pond' },
    { nested: 'yes' }, { gpu: 1 }, { repoSecret: 'sub:anthropic' }, { repoSecret: 'x'.repeat(65) },
    { secrets: { name: 'secret value with spaces' } }, { secrets: Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`a${n}`, 'store'])) },
    ...[{ ip: '256.1.1.1', port: 7401 }, { ip: '::1', port: 7401 }, { ip: '127.0.0.1', port: 1023 }, { ip: '0.0.0.0', port: 65536 }, { ip: '127.0.0.1', port: 7401.5 }, { ip: '127.0.0.1', port: 7401, extra: true }].map(port => ({ ports: [port] })),
    { ports: Array.from({ length: 9 }, (_, n) => ({ ip: '127.0.0.1', port: 7400 + n })) }, { ports: [{ ip: '127.0.0.1', port: 7401 }, { ip: '0.0.0.0', port: 7401 }] },
    ...['run/tailscaled.sock', '/run/../tailscaled.sock', '/run/./tailscaled.sock', '/run//tailscaled.sock', '/run/podman.sock'].map(socket => ({ tailnets: [{ name: 'fleet', socket }] })),
    { tailnets: [full.tailnets[0], full.tailnets[0]] }, { tailnets: Array.from({ length: 5 }, (_, n) => ({ name: `a${n}`, socket: '/run/tailscaled.sock' })) },
    { logins: ['gemini'] }, { logins: ['claude', 'codex', 'claude'] }, { scopes: { github: 'owner++pond' } }, { scopes: { github: Array(11).fill('pond').join('+') } }, { scopes: { github: 'x'.repeat(201) } },
    { steers: { owner: ['pond'] } }, { steers: { patrick: ['owner'] } }, { steers: { patrick: [] } }, { steers: { patrick: Array(11).fill('pond') } },
    ...['token', 'value', 'scopeStores', 'owner', 'member', 'project', 'principal', 'changedAt', 'house', 'job'].map(key => ({ [key]: 'injected' })),
  ];
  for (const grants of invalid) expect(f.call(grants), JSON.stringify(grants)).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.store.ids('settings')).toEqual([]);
});
it('keeps receipts atomic, identical saves quiet, and replay cannot restore an earlier grant', async () => {
  const f = await setup(), changed = vi.spyOn(f.app.live, 'changed');
  expect(f.call(full, undefined, undefined, 'first').ok).toBe(true);
  expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'runtime.settings', id: 'art' }]); changed.mockClear();
  const at = f.store.read('settings', 'art')!.changedAt; f.clock.advance(100);
  expect(f.call(full).ok).toBe(true); expect(changed).not.toHaveBeenCalled(); expect(f.store.read('settings', 'art')?.changedAt).toBe(at);
  expect(f.call({ scopes: 'none', steers: 'none', logins: [] }).ok).toBe(true); await f.restart();
  const spy = vi.spyOn(f.app.live, 'changed'), before = f.store.read('settings', 'art');
  expect(f.call(full, undefined, undefined, 'first')).toEqual({ ok: true, value: { agent: 'art' } });
  expect(f.store.read('settings', 'art')).toEqual(before); expect(spy).not.toHaveBeenCalled();
  expect(f.call({}, undefined, undefined, 'first')).toMatchObject({ ok: false, code: 'conflict' });
  f.app.db.exec("CREATE TRIGGER abort_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'abort'); END");
  expect(f.call(full, undefined, undefined, 'late')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(f.store.read('settings', 'art')).toEqual(before); expect(spy).not.toHaveBeenCalled();
  f.app.db.exec('DROP TRIGGER abort_receipt'); expect(f.call(full, undefined, undefined, 'late').ok).toBe(true);
});
it('snapshots the repository secret reference on claim and excludes builds after that reference changes', async () => {
  const f = await setup(); expect(f.call({ repoSecret: 'repo-one' }).ok).toBe(true);
  f.app.db.transaction(() => {
    const { changedAt: _, ...settings } = f.store.read('settings', 'art')!;
    f.store.put('settings', { ...settings, house: { repo: '/art', houseFile: 'house/house.json' } }, 1);
    f.store.put('box', { id: 'a', name: 'a', owner: 'jonathan', local: false, mayHost: '*', lentTo: [], facts: [], labels: [], alwaysOn: false, reportOnly: false, createdAt: 1 }, 1);
    f.store.put('job', { id: 'j', agent: 'art', runner: 'a', box: 'a', title: 'j', state: 'queued', createdAt: 1 }, 1);
  })();
  const runner: Viewer = { kind: 'runner', id: 'a' };
  expect(f.app.operations.call('direct', runner, 'runtime.claimJob', { job: 'j' }, 'claim').ok).toBe(true);
  expect(f.store.read('job', 'j')?.made).toEqual({ repo: '/art', houseFile: 'house/house.json', repoSecret: 'repo-one' });
  const build = 'loom-house-art:0123456789abcdef0123';
  expect(f.app.operations.call('direct', runner, 'runtime.reportJob', { job: 'j', state: 'running', build }, 'report').ok).toBe(true);
  const job = f.store.read('job', 'j')!;
  expect(configuredBuild(job, configuredHouse(f.store.read('settings', 'art')))).toBe(build);
  const { repoSecret: _secret, ...historical } = job.made!;
  expect(configuredBuild({ ...job, made: historical }, configuredHouse(f.store.read('settings', 'art')))).toBeUndefined();
  expect(f.call({ repoSecret: 'repo-two' }).ok).toBe(true);
  expect(configuredBuild(job, configuredHouse(f.store.read('settings', 'art')))).toBeUndefined();
  expect(f.call({}).ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants?.repoSecret).toBeUndefined();
  expect(configuredHouse(f.store.read('settings', 'art'))).toEqual({ repo: '/art', houseFile: 'house/house.json' });
  expect(configuredBuild(job, configuredHouse(f.store.read('settings', 'art')))).toBeUndefined();
  expect(f.app.operations.call('direct', runner, 'runtime.claimJob', { job: 'j' }, 'claim').ok).toBe(true);
  expect(f.store.read('job', 'j')?.made?.repoSecret).toBe('repo-one');
});
it('accepts documented list/map limits and inherited-object names as ordinary secret aliases', async () => {
  const f = await setup();
  const secrets = Object.fromEntries(Array.from({ length: 32 }, (_, n) => [`a${n}`, `store${n}`]));
  const tailnets = Array.from({ length: 4 }, (_, n) => ({ name: `net${n}`, socket: `/run/net${n}/tailscaled.sock` }));
  const scopes = Object.fromEntries([...Object.keys(secrets).map(key => [key, 'owner']), ...tailnets.map(item => [`tailnet:${item.name}`, 'pond'])]);
  const steers = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`person${n}`, ['pond']]));
  const ports = Array.from({ length: 8 }, (_, n) => ({ ip: '255.255.255.255', port: 1024 + n }));
  expect(f.call({ secrets, tailnets, scopes, steers, ports }).ok).toBe(true);
  expect(f.call({ steers: { ...steers, extra: ['pond'] } })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.call({ scopes: Object.fromEntries(Array.from({ length: 41 }, (_, n) => [`a${n}`, 'owner'])) })).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.call({ secrets: { constructor: 'same', toString: 'same' }, scopes: 'none', steers: 'none' }).ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants?.secrets).toEqual({ constructor: 'same', toString: 'same' });
  expect(f.call({ tailnets: [{ name: 'root', socket: '/tailscaled.sock' }] }).ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants?.tailnets).toEqual([{ name: 'root', socket: '/tailscaled.sock' }]);
});
it('replaces supplied nonempty scope and steering maps rather than merging old entries', async () => {
  const f = await setup();
  expect(f.call({ ...full, steers: { patrick: ['pond'], mark: ['other'] } }).ok).toBe(true);
  expect(f.call({ scopes: { github: 'owner' }, steers: { patrick: ['other'] } }).ok).toBe(true);
  expect(f.store.read('settings', 'art')?.grants).toMatchObject({ scopes: { github: 'owner' }, steers: { patrick: ['other'] }, scopeStores: { github: 'github-store' } });
  expect(f.store.read('settings', 'art')?.grants?.scopes).toEqual({ github: 'owner' });
  expect(f.store.read('settings', 'art')?.grants?.steers).toEqual({ patrick: ['other'] });
});
it('exposes grant references only through centrally scoped settings and keeps acknowledgements minimal', async () => {
  const f = await setup(); expect(f.call(full)).toEqual({ ok: true, value: { agent: 'art' } });
  const list = (viewer: Viewer) => f.app.operations.call('direct', viewer, 'runtime.listSettings', {});
  expect(list({ kind: 'agent', id: 'art' })).toMatchObject({ ok: true, value: { records: [{ grants: { repoSecret: 'repo-key', secrets: full.secrets } }] } });
  for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'agent', id: 'pond-bot' }, { kind: 'runner', id: 'art' }] as Viewer[])
    expect(list(viewer)).toEqual({ ok: true, value: { records: [] } });
});
it('keeps reordered maps quiet including remembered source history', async () => {
  const f = await setup(), changed = vi.spyOn(f.app.live, 'changed');
  const grants = { ...full, secrets: { github: 'github-store', extra: 'other-store' }, scopes: { ...full.scopes, extra: 'owner' }, steers: { patrick: ['pond'], mark: ['other'] } };
  expect(f.call(grants).ok).toBe(true); changed.mockClear();
  const before = f.store.read('settings', 'art'); f.clock.advance(100);
  const reverse = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).reverse());
  expect(f.call({ ...grants, secrets: reverse(grants.secrets), scopes: reverse(grants.scopes), steers: reverse(grants.steers) }).ok).toBe(true);
  expect(f.store.read('settings', 'art')).toEqual(before); expect(changed).not.toHaveBeenCalled();
  expect(f.call({ secrets: {}, scopes: reverse(grants.scopes) }).ok).toBe(true); changed.mockClear();
  const removed = f.store.read('settings', 'art'); f.clock.advance(100);
  expect(f.call({ secrets: {}, scopes: grants.scopes }).ok).toBe(true);
  expect(f.store.read('settings', 'art')).toEqual(removed); expect(changed).not.toHaveBeenCalled();
});
