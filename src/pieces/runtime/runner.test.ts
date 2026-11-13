import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { signin, hash } from '../../core/signin/index.js';
import { fixtureSharing } from '../../fixture.js';
import { runtimeStore } from './store.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const owner: Viewer = { kind: 'member', id: 'jonathan' };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'runtime-runner-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, next: true, sharing: () => ({ ...fixtureSharing(), services: { keyholder: { types: ['runtime.box'], operations: ['runtime.hearBox'] } } }) }); cleanups.push(app.close);
  const store = runtimeStore(app.db), s = signin(app);
  app.db.transaction(() => {
    new HouseholdDatabase(app.db).replace(home, { v: 1, agents: ['art'], members: [{ person: 'jonathan', role: 'owner', agents: '*' }] });
    s.tokens.replace({ v: 1, tokens: [] }, {});
    for (const id of ['a', 'b', 'gone']) store.put('box', {
      id, name: 'shared-name', owner: 'jonathan', local: false, mayHost: ['art'], lentTo: ['mark'],
      facts: ['arch:x64'], labels: ['gpu:5090'], alwaysOn: true, reportOnly: true, createdAt: 1,
      ...(id === 'gone' ? { revokedAt: 1 } : {}),
    }, 1);
  })();
  let seq = 0;
  const call = (input: unknown, viewer: Viewer = { kind: 'runner', id: 'a' }, id = `r-${++seq}`) => app.operations.call('direct', viewer, 'runtime.hearBox', input, id);
  const principal = (id: string, active: boolean) => app.operations.call('direct', owner, 'signin.setPrincipal', { kind: 'runner', id, active }, `p-${++seq}`);
  const mint = (role: string) => {
    const token = randomBytes(32).toString('hex');
    s.tokens.change(tokens => tokens.push({ label: `test-${++seq}`, role, sha256: hash(token), created: new Date(clock.now()).toISOString() }));
    return token;
  };
  const post = (token: string | undefined, input: unknown, id = `http-${++seq}`, op = 'hearBox') => fetch(`${app.url}/api/runtime/${op}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ input, id }),
  });
  return { app, clock, store, s, call, principal, mint, post };
}
it('binds reports to real central runner bearers and invalidates disabled or revoked credentials', async () => {
  const f = await setup(), token = f.mint('runner:a');
  expect((await f.post(token, {})).status).toBe(401);
  expect(f.principal('a', true)).toMatchObject({ ok: true });
  const response = await f.post(token, { facts: ['arch:arm64'] });
  expect(await response.json()).toEqual({ ok: true, value: { box: 'a' } });
  expect(f.store.read('box', 'a')).toMatchObject({ facts: ['arch:arm64'], lastSeen: f.clock.now(), labels: ['gpu:5090'], owner: 'jonathan', reportOnly: true, alwaysOn: true, mayHost: ['art'], lentTo: ['mark'] });
  expect(f.store.read('box', 'b')?.lastSeen).toBeUndefined();
  expect((await f.post(undefined, {})).status).toBe(401);
  f.principal('a', false);
  expect((await f.post(token, {})).status).toBe(401);
  f.principal('a', true);
  f.s.tokens.change(tokens => { tokens.find(t => t.sha256 === hash(token))!.revoked = new Date(f.clock.now()).toISOString(); });
  expect((await f.post(token, {})).status).toBe(401);
});
it('denies other viewer kinds even with service grants and refuses unenrolled, named or revoked runners', async () => {
  const f = await setup();
  for (const viewer of [owner, { kind: 'member', id: 'pollock' }, { kind: 'agent', id: 'art' }, { kind: 'service', id: 'keyholder' }] as Viewer[])
    expect(f.call({}, viewer)).toMatchObject({ ok: false, code: 'denied' });
  for (const id of ['missing', 'shared-name', 'gone']) {
    f.principal(id, true);
    const token = f.mint(`runner:${id}`);
    expect(await (await f.post(token, {})).json()).toMatchObject({ ok: false, code: 'denied' });
  }
  const token = f.mint('agent:art');
  expect(await (await f.post(token, {})).json()).toMatchObject({ ok: false, code: 'denied' });
  expect(f.store.read('box', 'gone')?.lastSeen).toBeUndefined();
});
it('rejects identity, configuration and time injection plus malformed facts before writes', async () => {
  const f = await setup(), before = f.store.read('box', 'a');
  for (const input of [{ box: 'b' }, { owner: 'pollock' }, { lastSeen: 9 }, { labels: [] }, { facts: ['BadKey'] }, { facts: Array(33).fill('cap') }])
    expect(f.call(input)).toMatchObject({ ok: false, code: 'invalid' });
  expect(f.store.read('box', 'a')).toEqual(before);
});
it('commits only changed reports, preserves omitted facts, clears explicit facts and replays receipts without freshening liveness', async () => {
  const f = await setup(), changed = vi.spyOn(f.app.live, 'changed');
  expect(f.call({ facts: ['arch:arm64', 'arch:arm64'] }, undefined, 'first')).toMatchObject({ ok: true });
  expect(changed).toHaveBeenCalledExactlyOnceWith([{ type: 'runtime.box', id: 'a' }]);
  changed.mockClear();
  expect(f.call({})).toMatchObject({ ok: true }); expect(changed).not.toHaveBeenCalled();
  const before = f.store.read('box', 'a'); f.clock.advance(1000);
  expect(f.call({ facts: ['arch:arm64', 'arch:arm64'] }, undefined, 'first')).toMatchObject({ ok: true });
  expect(f.store.read('box', 'a')).toEqual(before); expect(changed).not.toHaveBeenCalled();
  expect(f.call({ facts: [] }, undefined, 'first')).toMatchObject({ ok: false, code: 'conflict' });
  f.call({}); expect(f.store.read('box', 'a')).toMatchObject({ facts: ['arch:arm64'], lastSeen: f.clock.now() });
  f.call({ facts: [] }); expect(f.store.read('box', 'a')?.facts).toEqual([]);
});
it('rolls reports, receipts and notifications back when persistence fails, then permits the same retry', async () => {
  const f = await setup(), changed = vi.spyOn(f.app.live, 'changed'), before = f.store.read('box', 'a');
  f.app.db.exec("CREATE TRIGGER reject_report BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'test abort'); END");
  expect(f.call({}, undefined, 'retry')).toMatchObject({ ok: false });
  expect(f.store.read('box', 'a')).toEqual(before); expect(changed).not.toHaveBeenCalled();
  expect(f.app.db.prepare('SELECT * FROM core_operations WHERE id=?').get('retry')).toBeUndefined();
  f.app.db.exec('DROP TRIGGER reject_report');
  expect(f.call({}, undefined, 'retry')).toMatchObject({ ok: true }); expect(changed).toHaveBeenCalledOnce();
});
it('keeps runner box registry reads empty after an accepted heartbeat', async () => {
  const f = await setup(); f.principal('a', true); const token = f.mint('runner:a');
  expect(await (await f.post(token, {})).json()).toMatchObject({ ok: true });
  expect(await (await f.post(token, {}, undefined, 'listBoxes')).json()).toEqual({ ok: true, value: { records: [] } });
});

it('refuses a still-authenticating runner after its box is revoked without reviving metadata', async () => {
  const f = await setup(); f.principal('a', true); const token = f.mint('runner:a');
  expect(await (await f.post(token, {})).json()).toMatchObject({ ok: true });
  f.app.db.transaction(() => {
    const { changedAt: _, ...box } = f.store.read('box', 'a')!;
    f.store.put('box', { ...box, revokedAt: f.clock.now() }, f.clock.now());
  })();
  const before = f.store.read('box', 'a'); f.clock.advance(1);
  expect(await (await f.post(token, { facts: ['gpu:fake'] })).json()).toMatchObject({ ok: false, code: 'denied' });
  expect(f.store.read('box', 'a')).toEqual(before);
});
