import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { grantsRole, installSecrets } from './index.js';
import type { GrantRequest } from './role.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' }, agent: Viewer = { kind: 'agent', id: 'art' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'loom-carry-')), clock = new FakeClock();
  const raised: GrantRequest[] = [];
  const app = await startLoom({ home, clock, sharing: fixtureSharing, install: a => installSecrets(a.db, a.operations, a.live, fixtureSharing, { raise: r => { raised.push(r); return { raised: true }; } }) });
  cleanups.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  let seq = 0;
  const call = (v: Viewer, op: string, input: unknown, id = `carry-${++seq}`) => app.operations.call('direct', v, `secrets.${op}`, input, id);
  expect(call(owner, 'describe', { name: 'key', description: '' }).ok).toBe(true);
  const request = (house: string, service?: string, v = agent, id?: string) => call(v, 'requestHouse', { agent: v.id, target: 'key', scope: { house, ...(service ? { service } : {}) }, why: 'work' }, id);
  const resource = { kind: 'secret' as const, target: 'key' };
  const may = (house: string, service?: string) => grantsRole(app.db).mayUse(agent.id, resource, clock.now(), { house, ...(service ? { service } : {}) });
  const answer = (r: ReturnType<typeof request>, always?: true) => { expect(r.ok).toBe(true); return call(owner, 'answer', { id: r.ok ? (r.value as GrantRequest).id : '', allow: true, ...(always ? { always } : {}) }); };
  return { app, clock, raised, call, request, resource, may, answer };
}
for (const revokeHouse of ['h-1', 'h-2']) it(`moves plain Allow once with its expiry and revokes both via ${revokeHouse}`, async () => {
  const { clock, raised, call, request, may, answer, resource } = await setup();
  const first = request('h-1', 'discord'); expect(answer(first).ok).toBe(true);
  clock.advance(1000);
  for (const [house, service, viewer] of [['h-3', undefined, agent], ['h-4', 'slack', agent], ['h-5', 'discord', { kind: 'agent', id: 'pond-bot' }]] as const) expect(request(house, service, viewer)).toMatchObject({ ok: true, value: { state: 'pending' } });
  const next = request('h-2', 'discord', agent, 'move');
  expect(next).toMatchObject({ ok: true, value: { state: 'allowed', carriedFrom: first.ok ? (first.value as GrantRequest).id : '' } });
  expect(raised).toHaveLength(4); expect(may('h-1', 'discord')).toBe(false); expect(may('h-2', 'discord')).toBe(true);
  expect(request('h-6', 'discord')).toMatchObject({ ok: true, value: { state: 'pending' } });
  for (const v of [agent, { kind: 'member', id: 'pollock' }, { kind: 'service', id: 'holder' }] as Viewer[]) expect(call(v, 'revoke', { agent: agent.id, ...resource, scope: { house: revokeHouse, service: 'discord' } })).toMatchObject({ ok: false, code: 'denied' });
  expect(call(owner, 'revoke', { agent: agent.id, ...resource, scope: { house: revokeHouse, service: 'discord' } }).ok).toBe(true);
  expect(may('h-1', 'discord')).toBe(false); expect(may('h-2', 'discord')).toBe(false);
  expect(request('h-2', 'discord', agent, 'move')).toEqual(next); expect(may('h-2', 'discord')).toBe(false);
  clock.advance(60 * 60_000); expect(may('h-2', 'discord')).toBe(false);
});
it('keeps original expiry even when the next house asks for a longer duration', async () => {
  const { clock, request, may, answer } = await setup();
  expect(answer(request('h-1')).ok).toBe(true); clock.advance(59 * 60_000);
  expect(request('h-2')).toMatchObject({ ok: true, value: { state: 'allowed' } });
  clock.advance(60_000 - 1); expect(may('h-2')).toBe(true); clock.advance(1); expect(may('h-2')).toBe(false);
});
it('never wins; expired, revoked, manual and Always grants do not carry', async () => {
  const { clock, call, request, answer, resource } = await setup();
  expect(answer(request('h-1')).ok).toBe(true);
  expect(call(owner, 'policy', { default: 'never' }).ok).toBe(true);
  expect(request('h-2')).toMatchObject({ ok: true, value: { state: 'denied' } });
  expect(call(owner, 'policy', {}).ok).toBe(true); clock.advance(60 * 60_000);
  expect(request('h-3')).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(answer(request('h-4')).ok).toBe(true);
  expect(call(owner, 'revoke', { agent: agent.id, ...resource, scope: { house: 'h-4' } }).ok).toBe(true);
  expect(request('h-5')).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(call(owner, 'grant', { agent: agent.id, ...resource, scope: { house: 'h-6' }, expiresAt: clock.now() + 10000 }).ok).toBe(true);
  expect(request('h-7')).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(answer(request('h-8'), true).ok).toBe(true);
  expect(call(owner, 'always', { name: 'key', agent: agent.id, on: false }).ok).toBe(true);
  expect(request('h-9')).toMatchObject({ ok: true, value: { state: 'pending' } });
});
it('rolls a failed move back and permits the same operation to retry', async () => {
  const { app, call, request, may, answer } = await setup();
  expect(answer(request('h-1')).ok).toBe(true);
  const snapshot = () => ['secrets_requests', 'secrets_grants', 'core_operations'].map(t => app.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
  const before = snapshot();
  const changed = vi.spyOn(app.live, 'changed');
  app.db.exec("CREATE TRIGGER fail_carry BEFORE INSERT ON secrets_grants WHEN NEW.id LIKE '%h-2%' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  expect(request('h-2', undefined, agent, 'retry-move').ok).toBe(false);
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled(); expect(may('h-1')).toBe(true); expect(may('h-2')).toBe(false);
  app.db.exec('DROP TRIGGER fail_carry');
  expect(request('h-2', undefined, agent, 'retry-move')).toMatchObject({ ok: true, value: { state: 'allowed' } });
  expect(may('h-1')).toBe(false); expect(may('h-2')).toBe(true);
  expectPairNotifications(app, changed.mock.calls);
  expect(call(owner, 'list', {}).ok).toBe(true);
});
it('policy auto grants independently instead of consuming an owner Allow', async () => {
  const { call, request, may, answer } = await setup();
  expect(answer(request('h-1')).ok).toBe(true);
  expect(call(owner, 'policy', { default: 'auto' }).ok).toBe(true);
  expect(request('h-2')).toMatchObject({ ok: true, value: { state: 'allowed', decision: 'policy' } });
  expect(may('h-1')).toBe(true); expect(may('h-2')).toBe(true);
  expect(call(owner, 'policy', {}).ok).toBe(true);
  expect(request('h-3')).toMatchObject({ ok: true, value: { state: 'allowed', carriedFrom: expect.any(String) } });
  expect(may('h-1')).toBe(false); expect(may('h-3')).toBe(true);
});
it('does not revoke a later independent replacement at a paired scope', async () => {
  const { call, request, may, answer, resource, clock } = await setup();
  expect(answer(request('h-1')).ok).toBe(true); expect(request('h-2').ok).toBe(true);
  expect(call(owner, 'grant', { agent: agent.id, ...resource, scope: { house: 'h-2' }, expiresAt: clock.now() + 10000 }).ok).toBe(true);
  expect(call(owner, 'revoke', { agent: agent.id, ...resource, scope: { house: 'h-1' } }).ok).toBe(true);
  expect(may('h-1')).toBe(false); expect(may('h-2')).toBe(true);
});
it('paired revoke rolls both grants and request states back on failure', async () => {
  const { app, call, request, may, answer, resource } = await setup();
  expect(answer(request('h-1')).ok).toBe(true); expect(request('h-2').ok).toBe(true);
  const snapshot = () => ['secrets_requests', 'secrets_grants', 'core_operations'].map(t => app.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
  const before = snapshot();
  const changed = vi.spyOn(app.live, 'changed');
  app.db.exec("CREATE TRIGGER fail_revoke BEFORE DELETE ON secrets_grants WHEN OLD.id LIKE '%h-1%' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  const input = { agent: agent.id, ...resource, scope: { house: 'h-1' } };
  expect(call(owner, 'revoke', input, 'retry-revoke').ok).toBe(false);
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled(); expect(may('h-1')).toBe(false); expect(may('h-2')).toBe(true);
  app.db.exec('DROP TRIGGER fail_revoke');
  expect(call(owner, 'revoke', input, 'retry-revoke').ok).toBe(true);
  expect(may('h-2')).toBe(false);
  expectPairNotifications(app, changed.mock.calls);
  const result = call(owner, 'list', {});
  expect(result).toMatchObject({ ok: true, value: { requests: [expect.objectContaining({ state: 'revoked' }), expect.objectContaining({ state: 'revoked' })] } });
});

function expectPairNotifications(app: Awaited<ReturnType<typeof setup>>['app'], calls: unknown[][]) {
  const ids = app.db.prepare('SELECT id FROM secrets_requests').all() as { id: string }[];
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toEqual(expect.arrayContaining([
    ...ids.map(({ id }) => ({ type: 'secret.request', id })),
    ...['h-1', 'h-2'].map(house => ({ type: 'secret.grant', id: JSON.stringify(['art', 'secret', 'key', house, null]) })),
  ]));
  expect(calls[0][0]).toHaveLength(4);
}
it('checks Never before reusing a moved or pending request with a fresh operation', async () => {
  const { call, request, may, answer } = await setup();
  expect(answer(request('h-1')).ok).toBe(true); expect(request('h-2')).toMatchObject({ ok: true, value: { state: 'allowed' } });
  expect(request('h-3')).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(call(owner, 'policy', { default: 'never' }).ok).toBe(true);
  expect(request('h-2')).toMatchObject({ ok: true, value: { state: 'denied', decision: 'policy' } });
  expect(request('h-3')).toMatchObject({ ok: true, value: { state: 'denied', decision: 'policy' } });
  expect(may('h-1')).toBe(false); expect(may('h-2')).toBe(false);
});
it('cannot carry an isolated policy grant after switching back to ask', async () => {
  const { call, request } = await setup();
  expect(call(owner, 'policy', { default: 'auto' }).ok).toBe(true);
  expect(request('h-1')).toMatchObject({ ok: true, value: { state: 'allowed', decision: 'policy' } });
  expect(call(owner, 'policy', {}).ok).toBe(true);
  expect(request('h-2')).toMatchObject({ ok: true, value: { state: 'pending' } });
});
it('does not carry an eligible owner Allow for a different secret name', async () => {
  const { call, request, answer, may } = await setup();
  expect(answer(request('h-1')).ok).toBe(true);
  expect(call(owner, 'describe', { name: 'other-key', description: '' }).ok).toBe(true);
  expect(call(agent, 'requestHouse', { agent: agent.id, target: 'other-key', scope: { house: 'h-2' }, why: 'work' })).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(may('h-1')).toBe(true);
});
