import { afterEach, describe, expect, it } from 'vitest';
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
async function setup(raise: GrantAttention['raise'] = () => ({ raised: true })) {
  const home = mkdtempSync(join(tmpdir(), 'loom-secrets-')); homes.push(home);
  const clock = new FakeClock();
  const app = await startLoom({ home, clock, sharing: fixtureSharing, install: a => installSecrets(a.db, a.operations, a.live, fixtureSharing, { raise }) });
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
    expect(call(agent, 'request', { agent: agent.id, kind: 'secret', target: 'api-key', why: 'deploy' })).toMatchObject({ ok: false, code: 'unavailable' });
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
  expect(handSecret(app.db, holder, agent.id, resource.target, 'sink', clock.now())).toBe(false);
  expect(handSecret(app.db, holder, agent.id, resource.target, 'sink', clock.now(), scope)).toBe(true);
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
