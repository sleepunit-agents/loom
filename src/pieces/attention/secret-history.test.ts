import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing, installFixture } from '../../fixture.js';
import { FakeClock, type RecordType, type Result, type Viewer } from '../../core/index.js';
import type { Grant, GrantRequest } from '../secrets/role.js';
import type { Ask } from './role.js';

const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'pond-bot' };
const closes: (() => Promise<void>)[] = [], homes: string[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const value = <T>(result: Result): T => {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw Error(result.code);
  return result.value as T;
};

it('keeps owning decision history after expiry and restart without a second Inbox archive', async () => {
  const home = mkdtempSync(join(tmpdir(), 'attention-secret-history-')); homes.push(home); fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-14T12:00:00Z'));
  let seq = 0;
  async function open() {
    const types = new Map<string, RecordType>();
    const app = await startLoom({ home, next: true, staging: true, clock, sharing: fixtureSharing, stdout: () => {}, install: app => {
      installFixture(app);
      const register = app.live.register.bind(app.live);
      app.live.register = type => { types.set(type.name, type); register(type); };
    } });
    closes.push(app.close);
    const call = (name: string, input: unknown, viewer = owner) => app.operations.call('direct', viewer, name, input, `history-${++seq}`);
    const records = <T>(name: string, viewer = owner) => {
      const type = types.get(name)!;
      return type.ids(undefined).flatMap(id => type.read(id, viewer) ?? []) as T[];
    };
    return { app, call, records };
  }
  let s = await open();
  value(s.call('secrets.describe', { name: 'history-key', description: '' }));
  const request = (house: string) => value<GrantRequest>(s.call('secrets.requestHouse', {
    agent: agent.id, target: 'history-key', scope: { house }, why: 'Fixture work', minutes: 2,
  }, agent));
  const allowed = request('h-1'), denied = request('h-2');
  value(s.call('secrets.answer', { id: allowed.id, allow: true }));
  value(s.call('secrets.answer', { id: denied.id, allow: false }));
  const history = value<{ requests: GrantRequest[]; grants: Grant[] }>(s.call('secrets.list', {}));
  expect(history.requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: allowed.id, state: 'allowed', by: owner.id, answeredAt: clock.now(), minutes: 2 }),
    expect.objectContaining({ id: denied.id, state: 'denied', by: owner.id, answeredAt: clock.now() }),
  ]));
  expect(history.grants).toHaveLength(1);
  expect(history.grants[0]).toMatchObject({ requestId: allowed.id, expiresAt: clock.now() + 120_000 });
  const cleared = s.records<Ask>('attention.ask');
  expect(cleared).toHaveLength(2);
  expect(cleared).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: allowed.id, state: 'resolved', resolution: 'Grant request allowed' }),
    expect.objectContaining({ id: denied.id, state: 'resolved', resolution: 'Grant request denied' }),
  ]));
  clock.advance(120_001);
  await s.app.close(); closes.pop();
  s = await open();
  expect(value(s.call('secrets.list', {}))).toEqual(expect.objectContaining(history));
  expect(s.records<GrantRequest>('secret.request')).toEqual(expect.arrayContaining(history.requests));
  expect(s.records<Grant>('secret.grant')[0].expiresAt).toBeLessThan(clock.now());
  expect(s.records<Ask>('attention.ask')).toEqual(cleared);
  expect(s.call('secrets.list', {}, agent)).toMatchObject({ ok: false, code: 'denied' });
  value(s.call('secrets.revoke', { agent: agent.id, kind: 'secret', target: 'history-key', scope: { house: 'h-1' } }));
  expect(value<{ requests: GrantRequest[] }>(s.call('secrets.list', {})).requests).toEqual(expect.arrayContaining([
    { ...history.requests.find(r => r.id === allowed.id)!, state: 'revoked' },
    history.requests.find(r => r.id === denied.id)!,
  ]));
  expect(s.records<Ask>('attention.ask')).toEqual(cleared);
});
