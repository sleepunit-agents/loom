import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, migrate, openDb, type Viewer } from '../../core/index.js';
import { grantsRole, installSecrets, type GrantAttention } from './index.js';
import { schema } from './schema/001.js';
import { handSecret } from './values.js';
import type { KeyHolder } from './keyholder.js';
import type { GrantRequest } from './role.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'pond-bot' };
const agentOwner: Viewer = { kind: 'member', id: 'pollock' };
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function setup(raise: GrantAttention['raise'] = () => ({ raised: true }), withAttention = true) {
  const home = mkdtempSync(join(tmpdir(), 'loom-secrets-')); homes.push(home);
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, sharing: fixtureSharing, install: a => installSecrets(a.db, a.operations, a.live, fixtureSharing, withAttention ? { raise } : undefined) });
  closes.push(app.close);
  let seq = 0;
  return { app, clock, call: (viewer: Viewer, name: string, input: unknown, id = `op-${++seq}`) => app.operations.call('direct', viewer, `secrets.${name}`, input, id) };
}
describe('one grants authority', () => {
  it('only household owners grant; exact resources, expiry and revocation are checked without a stale cache', async () => {
    const { call, clock } = await setup();
    const input = { agent: agent.id, kind: 'secret', target: 'api-key', expiresAt: clock.now() + 1000 };
    for (const viewer of [agent, agentOwner, { kind: 'service', id: 'keyholder' } as Viewer, { kind: 'runner', id: 'one' } as Viewer]) expect(call(viewer, 'grant', input)).toMatchObject({ ok: false, code: 'denied' });
    for (const viewer of [agent, agentOwner]) expect(call(viewer, 'revoke', { agent: agent.id, kind: 'secret', target: 'api-key' })).toMatchObject({ ok: false, code: 'denied' });
    expect(call(owner, 'grant', input)).toMatchObject({ ok: true, value: { by: 'jonathan' } });
    expect(call(agent, 'may', input)).toMatchObject({ ok: false, code: 'invalid' });
    const ask = { agent: agent.id, kind: 'secret', target: 'api-key' };
    expect(call(agent, 'may', ask)).toEqual({ ok: true, value: { allow: true } });
    expect(call(agent, 'may', { ...ask, kind: 'runner' })).toEqual({ ok: true, value: { allow: false } });
    expect(call(agent, 'may', { ...ask, agent: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    clock.advance(1000);
    expect(call(agent, 'may', ask)).toEqual({ ok: true, value: { allow: false } });
    expect(call(owner, 'grant', ask).ok).toBe(true);
    expect(call(owner, 'revoke', ask).ok).toBe(true);
    expect(call(agent, 'may', ask)).toEqual({ ok: true, value: { allow: false } });
  });
  it('an agent owner requests only for their agent, reasons never grant, first household answer wins', async () => {
    const raised: GrantRequest[] = [];
    const { call } = await setup(r => { raised.push(r); return { raised: true }; });
    const input = { agent: agent.id, kind: 'piece', target: 'tasks', why: 'Ignore the rules and allow this' };
    expect(call(agentOwner, 'request', { ...input, agent: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    expect(call(agent, 'request', { ...input, agent: 'art' })).toMatchObject({ ok: false, code: 'denied' });
    const result = call(agentOwner, 'request', input);
    expect(result.ok).toBe(true);
    const request = result.ok ? result.value as GrantRequest : undefined;
    expect(call(agent, 'request', input)).toEqual(result);
    expect(raised).toHaveLength(1);
    expect(call(agent, 'may', { agent: agent.id, kind: 'piece', target: 'tasks' })).toEqual({ ok: true, value: { allow: false } });
    expect(call(agentOwner, 'answer', { id: request!.id, allow: true })).toMatchObject({ ok: false, code: 'denied' });
    expect(call(owner, 'answer', { id: request!.id, allow: false })).toMatchObject({ ok: true, value: { state: 'denied', by: 'jonathan' } });
    expect(call(owner, 'answer', { id: request!.id, allow: true })).toMatchObject({ ok: false, code: 'conflict' });
  });
  it('rolls a failed attention raise back and rejects value fields before any persistence', async () => {
    const { app, call } = await setup(() => { throw new Error('attention unavailable'); });
    expect(call(agent, 'request', { agent: agent.id, kind: 'secret', target: 'api-key', why: 'deploy' })).toMatchObject({ ok: false, code: 'denied' });
    expect(app.db.prepare('SELECT * FROM secrets_requests').all()).toEqual([]);
    const sentinel = 'VALUE-MUST-NOT-BE-RECORDED';
    expect(call(owner, 'describe', { name: 'api-key', description: '', value: sentinel })).toMatchObject({ ok: false, code: 'invalid' });
    expect(app.db.prepare('SELECT * FROM secrets_names').all()).toEqual([]);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM core_operations').all())).not.toContain(sentinel);
  });
  it('rejects miswired asynchronous attention before committing a pending request', async () => {
    const asynchronous = (async () => { throw new Error('attention failed'); }) as unknown as GrantAttention['raise'];
    const { app, call } = await setup(asynchronous);
    expect(call(agent, 'request', { agent: agent.id, kind: 'piece', target: 'tasks', why: 'work' })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(app.db.prepare('SELECT * FROM secrets_requests').all()).toEqual([]);
    expect(app.db.prepare('SELECT * FROM core_operations WHERE name=?').all('secrets.request')).toEqual([]);
  });
  it('idempotent answers do not restore a subsequently revoked grant', async () => {
    const { call } = await setup();
    const input = { agent: agent.id, kind: 'tailnet', target: 'home', why: 'reach the worker' };
    const result = call(agent, 'request', input);
    const id = result.ok ? (result.value as GrantRequest).id : '';
    const answer = { id, allow: true };
    const first = call(owner, 'answer', answer, 'answer-once');
    expect(first).toMatchObject({ ok: true });
    expect(call(agent, 'may', { agent: agent.id, kind: 'tailnet', target: 'home' })).toEqual({ ok: true, value: { allow: true } });
    expect(call(owner, 'revoke', { agent: agent.id, kind: 'tailnet', target: 'home' }).ok).toBe(true);
    expect(call(owner, 'answer', answer, 'answer-once')).toEqual(first);
    expect(call(agent, 'may', { agent: agent.id, kind: 'tailnet', target: 'home' })).toEqual({ ok: true, value: { allow: false } });
  });
});

it('keeps temporary grants confined to their exact house and service through runtime handoff', async () => {
  const { app, call, clock } = await setup();
  const resource = { kind: 'secret' as const, target: 'api-key' };
  const scope = { house: 'h-12', service: 'discord' };
  const grant = { agent: agent.id, ...resource, scope, expiresAt: clock.now() + 1000 };
  expect(call(owner, 'grant', { ...grant, expiresAt: undefined })).toMatchObject({ ok: false, code: 'invalid' });
  for (const expiresAt of [clock.now(), clock.now() - 1]) {
    expect(call(owner, 'grant', { ...grant, expiresAt })).toMatchObject({ ok: false, code: 'invalid' });
    expect(app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);
  }
  expect(call(agentOwner, 'grant', grant)).toMatchObject({ ok: false, code: 'denied' });
  expect(call(owner, 'grant', grant).ok).toBe(true);
  expect(call(owner, 'grant', { ...grant, scope: { house: 'h-13' } }).ok).toBe(true);
  const grants = grantsRole(app.db);
  for (const context of [undefined, { house: 'h-12' }, { house: 'h-12', service: 'slack' }, { house: 'h-14', service: 'discord' }]) {
    expect(grants.mayUse(agent.id, resource, clock.now(), context)).toBe(false);
  }
  expect(grants.mayUse(agent.id, resource, clock.now(), scope)).toBe(true);
  expect(grants.mayUse(agent.id, resource, clock.now(), { house: 'h-13' })).toBe(true);
  expect(grants.mayUse(agent.id, resource, clock.now(), { house: 'h-13', service: 'discord' })).toBe(false);
  expect(call(agent, 'may', { agent: agent.id, ...resource })).toEqual({ ok: true, value: { allow: false } });
  expect(call(agent, 'may', { agent: agent.id, ...resource, scope })).toMatchObject({ ok: false, code: 'invalid' });
  const handed: string[] = [];
  const holder: KeyHolder = { names: () => [], set() {}, remove() {}, rotate() {}, handTo(_name, sink) { handed.push(sink); } };
  expect(handSecret(app.db, app.live, holder, agent.id, resource.target, 'sink', clock.now())).toBe(false);
  expect(handSecret(app.db, app.live, holder, agent.id, resource.target, 'sink', clock.now(), scope)).toBe(true);
  expect(handed).toEqual(['sink']);
  expect(call(owner, 'revoke', { agent: agent.id, ...resource, scope }).ok).toBe(true);
  expect(grants.mayUse(agent.id, resource, clock.now(), scope)).toBe(false);
  expect(grants.mayUse(agent.id, resource, clock.now(), { house: 'h-13' })).toBe(true);
  clock.advance(1000);
  expect(grants.mayUse(agent.id, resource, clock.now(), { house: 'h-13' })).toBe(false);
});
it('upgrades the initial table without changing existing grant identity, content or expiry', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-grant-upgrade-')); homes.push(home);
  const { db, close } = openDb(home);
  try {
    migrate(db, 'secrets', schema.slice(0, 1));
    const record = { id: '["art","piece","tasks"]', agent: 'art', kind: 'piece', target: 'tasks', by: 'jonathan', createdAt: 10, expiresAt: 100 };
    db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?)').run(record.id, record.agent, record.kind, record.target, JSON.stringify(record));
    migrate(db, 'secrets', schema);
    migrate(db, 'secrets', schema);
    expect(db.prepare('SELECT record FROM secrets_grants').all()).toEqual([{ record: JSON.stringify(record) }]);
    const grants = grantsRole(db);
    expect(grants.mayUse('art', { kind: 'piece', target: 'tasks' }, 99)).toBe(true);
    expect(grants.mayUse('art', { kind: 'piece', target: 'tasks' }, 100)).toBe(false);
  } finally { close(); }
});

it('accepts secret requests only through the authenticated runtime seam and answers with a bounded exact grant', async () => {
  const raised: GrantRequest[] = [];
  const { app, call, clock } = await setup(r => { raised.push(r); return { raised: true }; });
  const input = { agent: agent.id, target: 'api-key', scope: { house: 'h-71', service: 'discord' }, why: 'deploy' };
  const publicInput = { agent: agent.id, kind: 'secret', target: input.target, why: input.why };
  expect(call(agent, 'request', publicInput)).toMatchObject({ ok: false, code: 'denied' });
  expect(call(agent, 'request', { ...publicInput, scope: input.scope })).toMatchObject({ ok: false, code: 'invalid' });
  for (const door of ['http', 'socket', 'mcp'] as const) {
    expect(app.operations.call(door, agent, 'secrets.requestHouse', input, `spoof-${door}`)).toMatchObject({ ok: false, code: 'denied' });
    expect(app.operations.offered(door).some(o => o.name === 'secrets.requestHouse')).toBe(false);
  }
  expect(call(agent, 'requestHouse', input)).toMatchObject({ ok: false, code: 'not-found' });
  expect(call(owner, 'describe', { name: input.target, description: '' }).ok).toBe(true);
  for (const viewer of [owner, agentOwner, { kind: 'agent', id: 'art' } as Viewer]) {
    expect(call(viewer, 'requestHouse', input)).toMatchObject({ ok: false, code: 'denied' });
  }
  for (const minutes of [0, -1, 1.5]) expect(call(agent, 'requestHouse', { ...input, minutes })).toMatchObject({ ok: false, code: 'invalid' });
  const result = call(agent, 'requestHouse', input);
  expect(result).toMatchObject({ ok: true, value: { scope: input.scope, minutes: 60 } });
  expect(call(agent, 'requestHouse', input)).toEqual(result);
  expect(raised).toHaveLength(1);
  const otherService = call(agent, 'requestHouse', { ...input, scope: { house: 'h-71' }, minutes: 480 });
  const otherHouse = call(agent, 'requestHouse', { ...input, scope: { house: 'h-72', service: 'discord' } });
  expect(otherService).toMatchObject({ ok: true, value: { minutes: 60 } });
  expect(otherHouse.ok).toBe(true);
  expect(raised).toHaveLength(3);
  const request = result.ok ? result.value as GrantRequest : undefined;
  expect(call(agentOwner, 'answer', { id: request!.id, allow: true })).toMatchObject({ ok: false, code: 'denied' });
  clock.advance(500);
  expect(call(owner, 'answer', { id: request!.id, allow: true })).toMatchObject({ ok: true, value: { by: owner.id } });
  const grants = grantsRole(app.db), resource = { kind: 'secret' as const, target: input.target };
  expect(grants.mayUse(agent.id, resource, clock.now(), input.scope)).toBe(true);
  expect(call(agent, 'requestHouse', input)).toMatchObject({ ok: true, value: { id: request!.id, state: 'allowed' } });
  expect(raised).toHaveLength(3);
  for (const scope of [undefined, { house: 'h-71' }, { house: 'h-72', service: 'discord' }]) expect(grants.mayUse(agent.id, resource, clock.now(), scope)).toBe(false);
  clock.advance(60 * 60_000 - 1);
  expect(grants.mayUse(agent.id, resource, clock.now(), input.scope)).toBe(true);
  clock.advance(1);
  expect(grants.mayUse(agent.id, resource, clock.now(), input.scope)).toBe(false);
  expect(call(owner, 'answer', { id: request!.id, allow: true })).toMatchObject({ ok: false, code: 'conflict' });
});

it('rolls back a house request when attention fails and refuses legacy unscoped secret approvals', async () => {
  const { app, call } = await setup(() => { throw new Error('attention unavailable'); });
  expect(call(owner, 'describe', { name: 'api-key', description: '' }).ok).toBe(true);
  expect(call(agent, 'requestHouse', { agent: agent.id, target: 'api-key', scope: { house: 'h-12' }, why: 'deploy' })).toMatchObject({ ok: false, code: 'unavailable' });
  expect(app.db.prepare('SELECT * FROM secrets_requests').all()).toEqual([]);
  const legacy: GrantRequest = { id: 'q-legacy', agent: agent.id, kind: 'secret', target: 'api-key', why: 'old', state: 'pending', askedBy: agent, createdAt: 1 };
  app.db.prepare('INSERT INTO secrets_requests VALUES (?,?)').run(legacy.id, JSON.stringify(legacy));
  expect(call(owner, 'answer', { id: legacy.id, allow: true })).toMatchObject({ ok: false, code: 'invalid' });
  expect(app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);
  expect(call(owner, 'answer', { id: legacy.id, allow: false })).toMatchObject({ ok: true, value: { state: 'denied' } });
});


it('fails closed on missing, invalid and asynchronous house attention acknowledgments', async () => {
  const cases: Array<{ raise: GrantAttention['raise']; installed?: boolean }> = [
    { raise: () => ({ raised: true }), installed: false },
    { raise: (() => ({ raised: false })) as unknown as GrantAttention['raise'] },
    { raise: (async () => { throw new Error('async failure'); }) as unknown as GrantAttention['raise'] },
  ];
  for (const { raise, installed } of cases) {
    const { app, call } = await setup(raise, installed);
    expect(call(owner, 'describe', { name: 'api-key', description: '' }).ok).toBe(true);
    expect(call(agent, 'requestHouse', { agent: agent.id, target: 'api-key', scope: { house: 'h-12' }, why: 'deploy' })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(app.db.prepare('SELECT * FROM secrets_requests').all()).toEqual([]);
    expect(app.db.prepare('SELECT * FROM core_operations WHERE name=?').all('secrets.requestHouse')).toEqual([]);
  }
});


it('reuses only the request own live scoped grant, never a global or replacement grant', async () => {
  const { app, call, clock } = await setup();
  const input = { agent: agent.id, target: 'api-key', scope: { house: 'h-81' }, why: 'deploy', minutes: 2 };
  expect(call(owner, 'describe', { name: input.target, description: '' }).ok).toBe(true);
  const first = call(agent, 'requestHouse', input);
  const id = first.ok ? (first.value as GrantRequest).id : '';
  expect(call(owner, 'answer', { id, allow: true }).ok).toBe(true);
  const resource = { agent: agent.id, kind: 'secret' as const, target: input.target };
  clock.advance(2 * 60_000 - 1);
  expect(grantsRole(app.db).mayUse(agent.id, resource, clock.now(), input.scope)).toBe(true);
  expect(call(agent, 'requestHouse', input)).toMatchObject({ ok: true, value: { id } });
  clock.advance(1);
  expect(grantsRole(app.db).mayUse(agent.id, resource, clock.now(), input.scope)).toBe(false);
  expect(call(owner, 'grant', resource).ok).toBe(true);
  const second = call(agent, 'requestHouse', input);
  const secondId = second.ok ? (second.value as GrantRequest).id : '';
  expect(second).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(secondId).not.toBe(id);
  expect(call(owner, 'answer', { id: secondId, allow: true }).ok).toBe(true);
  expect(call(owner, 'revoke', { ...resource, scope: input.scope }).ok).toBe(true);
  const third = call(agent, 'requestHouse', input);
  const thirdId = third.ok ? (third.value as GrantRequest).id : '';
  expect(third).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(thirdId).not.toBe(secondId);
  expect(call(owner, 'answer', { id: thirdId, allow: true }).ok).toBe(true);
  expect(call(owner, 'grant', { ...resource, scope: input.scope, expiresAt: clock.now() + 1000 }).ok).toBe(true);
  const fourth = call(agent, 'requestHouse', input);
  expect(fourth).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(fourth.ok && (fourth.value as GrantRequest).id).not.toBe(thirdId);
});

it('Always answers grant eight hours, auto only the named agent, and Stop preserves current access and start policy', async () => {
  const raised: GrantRequest[] = [];
  const { app, call, clock } = await setup(r => { raised.push(r); return { raised: true }; });
  call(owner, 'describe', { name: 'api-key', description: '' });
  call(owner, 'policy', { secrets: { 'api-key': { houses: ['art'], minutes: 10 } } });
  const input = { agent: agent.id, target: 'api-key', scope: { house: 'h-20', service: 'discord' }, why: '\n<deploy>\u202e [now]　please' };
  const request = call(agent, 'requestHouse', input);
  expect(request).toMatchObject({ ok: true, value: { why: 'deploy now please', minutes: 10 } });
  const id = request.ok ? (request.value as GrantRequest).id : '';
  for (const viewer of [agent, agentOwner, { kind: 'service', id: 'keyholder' } as Viewer]) {
    expect(call(viewer, 'always', { name: 'api-key', agent: agent.id, on: true })).toMatchObject({ ok: false, code: 'denied' });
    expect(call(viewer, 'answer', { id, allow: true, always: true })).toMatchObject({ ok: false, code: 'denied' });
  }
  expect(call(owner, 'answer', { id, allow: false, always: true })).toMatchObject({ ok: false, code: 'invalid' });
  const answer = { id, allow: true, always: true };
  const allowed = call(owner, 'answer', answer, 'always-answer');
  expect(allowed).toMatchObject({ ok: true, value: { always: true, minutes: 480 } });
  const policy = () => JSON.parse((app.db.prepare("SELECT value FROM secrets_meta WHERE key='policy'").get() as {value: string}).value);
  expect(policy().secrets['api-key']).toEqual({ grant: 'auto', agents: [agent.id], houses: ['art'], minutes: 480 });
  const auto = call(agent, 'requestHouse', { ...input, scope: { house: 'h-21' } });
  expect(auto).toMatchObject({ ok: true, value: { state: 'allowed', decision: 'policy', minutes: 480 } });
  expect(raised).toHaveLength(1);
  expect(call({kind: 'agent', id: 'art'}, 'requestHouse', { ...input, agent: 'art', scope: { house: 'h-22' } })).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(call(owner, 'always', { name: 'api-key', agent: agent.id, on: false }).ok).toBe(true);
  expect(policy().secrets['api-key']).toEqual({ grant: 'ask', houses: ['art'], minutes: 480 });
  expect(call(owner, 'answer', answer, 'always-answer')).toEqual(allowed);
  expect(policy().secrets['api-key'].grant).toBe('ask');
  const resource = {kind: 'secret' as const, target: 'api-key'};
  const grants = grantsRole(app.db);
  expect(grants.mayUse(agent.id, resource, clock.now(), input.scope)).toBe(true);
  expect(grants.mayUse(agent.id, resource, clock.now(), { house: 'h-21' })).toBe(true);
  expect(grants.mayUse(agent.id, resource, clock.now(), { house: 'h-20' })).toBe(false);
  expect(call(agent, 'requestHouse', { ...input, scope: { house: 'h-23' } })).toMatchObject({ ok: true, value: { state: 'pending' } });
  clock.advance(480 * 60_000 - 1);
  expect(grants.mayUse(agent.id, resource, clock.now(), input.scope)).toBe(true);
  clock.advance(1);
  expect(grants.mayUse(agent.id, resource, clock.now(), input.scope)).toBe(false);
  expect(call(agent, 'requestHouse', { ...input, why: '<>[]{}\u0000' })).toMatchObject({ ok: false, code: 'invalid' });
});

it('standing toggles preserve other agents and never cannot be bypassed by a toggle or pending Always answer', async () => {
  const { app, call } = await setup();
  expect(call(owner, 'always', { name: 'missing', agent: agent.id, on: true })).toMatchObject({ ok: false, code: 'not-found' });
  call(owner, 'describe', { name: 'api-key', description: '' });
  for (const a of [agent.id, 'art']) expect(call(owner, 'always', { name: 'api-key', agent: a, on: true }).ok).toBe(true);
  expect(call(owner, 'always', { name: 'api-key', agent: agent.id, on: false })).toMatchObject({ ok: true, value: { secrets: { 'api-key': { grant: 'auto', agents: ['art'], minutes: 480 } } } });
  const result = call(agent, 'requestHouse', { agent: agent.id, target: 'api-key', scope: { house: 'h-24' }, why: 'work' });
  const id = result.ok ? (result.value as GrantRequest).id : '';
  call(owner, 'policy', { secrets: { 'api-key': { grant: 'never' } } });
  expect(call(owner, 'always', { name: 'api-key', agent: agent.id, on: true })).toMatchObject({ ok: false, code: 'conflict' });
  expect(call(owner, 'always', { name: 'api-key', agent: agent.id, on: false })).toMatchObject({ ok: true, value: { secrets: { 'api-key': { grant: 'never' } } } });
  expect(call(owner, 'answer', { id, allow: true, always: true })).toMatchObject({ ok: false, code: 'conflict' });
  expect(app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);
  expect(call(owner, 'answer', { id, allow: false }).ok).toBe(true);
});


it('rejects standing policy overflow and rolls back every Always write when grant storage fails', async () => {
  const { app, call } = await setup();
  call(owner, 'describe', { name: 'api-key', description: '' });
  const pending = call(agent, 'requestHouse', { agent: agent.id, target: 'api-key', scope: { house: 'h-25' }, why: 'x'.repeat(400) });
  expect(pending).toMatchObject({ ok: true, value: { why: 'x'.repeat(300) } });
  const id = pending.ok ? (pending.value as GrantRequest).id : '';
  expect(JSON.parse((app.db.prepare('SELECT record FROM secrets_requests WHERE id=?').get(id) as { record: string }).record).why).toBe('x'.repeat(300));
  const full = { secrets: { 'api-key': { grant: 'auto', agents: Array.from({ length: 1000 }, (_, i) => `agent-${i}`) } } };
  expect(call(owner, 'policy', full).ok).toBe(true);
  const rows = () => ['secrets_meta', 'secrets_requests', 'secrets_grants', 'core_operations'].map(t => app.db.prepare(`SELECT * FROM ${t}`).all());
  const baseline = rows();
  for (const [operation, input] of [
    ['always', { name: 'api-key', agent: agent.id, on: true }],
    ['answer', { id, allow: true, always: true }],
  ] as const) expect(call(owner, operation, input)).toMatchObject({ ok: false, code: 'invalid' });
  expect(rows()).toEqual(baseline);
  expect(call(owner, 'policy', {}).ok).toBe(true);
  const before = rows();
  const changed = vi.spyOn(app.live, 'changed');
  app.db.exec("CREATE TRIGGER reject_always_grant BEFORE INSERT ON secrets_grants BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const answer = { id, allow: true, always: true };
  expect(call(owner, 'answer', answer, 'atomic-always')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(rows()).toEqual(before);
  expect(changed).not.toHaveBeenCalled();
  app.db.exec('DROP TRIGGER reject_always_grant');
  expect(call(owner, 'answer', answer, 'atomic-always')).toMatchObject({ ok: true, value: { always: true, state: 'allowed' } });
  changed.mockRestore();
});

it('Stop leaves nonstanding ask and inherited-default policy content unchanged', async () => {
  const { app, call } = await setup();
  call(owner, 'describe', { name: 'api-key', description: '' });
  for (const rule of [{ grant: 'ask', minutes: 30, houses: ['art'] }, { minutes: 45, houses: ['art'] }]) {
    expect(call(owner, 'policy', { default: 'auto', secrets: { 'api-key': rule } }).ok).toBe(true);
    const before = app.db.prepare('SELECT * FROM secrets_meta').all();
    expect(call(owner, 'always', { name: 'api-key', agent: agent.id, on: false }).ok).toBe(true);
    expect(app.db.prepare('SELECT * FROM secrets_meta').all()).toEqual(before);
  }
});
