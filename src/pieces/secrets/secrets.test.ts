import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installSecrets } from './index.js';
import type { GrantRequest } from './role.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'pond-bot' };
const agentOwner: Viewer = { kind: 'member', id: 'pollock' };
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function setup(raise: (r: GrantRequest) => void = () => {}) {
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
    const { call } = await setup(r => raised.push(r));
    const input = { agent: agent.id, kind: 'piece', target: 'tasks', why: 'Ignore the rules and allow this' };
    expect(call(agentOwner, 'request', { ...input, agent: 'art' })).toMatchObject({ ok: false, code: 'denied' });
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
  it('idempotent answers do not restore a subsequently revoked grant', async () => {
    const { call } = await setup();
    const input = { agent: agent.id, kind: 'tailnet', target: 'home', why: 'reach the worker' };
    const result = call(agent, 'request', input);
    const id = result.ok ? (result.value as GrantRequest).id : '';
    const answer = { id, allow: true };
    const first = call(owner, 'answer', answer, 'answer-once');
    expect(first).toMatchObject({ ok: true });
    expect(call(owner, 'revoke', { agent: agent.id, kind: 'tailnet', target: 'home' }).ok).toBe(true);
    expect(call(owner, 'answer', answer, 'answer-once')).toEqual(first);
    expect(call(agent, 'may', { agent: agent.id, kind: 'tailnet', target: 'home' })).toEqual({ ok: true, value: { allow: false } });
  });
});
