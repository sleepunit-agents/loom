import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installSecrets, grantsRole } from './index.js';
import { secretStartPermission } from './policy.js';
import type { GrantRequest } from './role.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'art' };
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'loom-secret-policy-')); homes.push(home);
  const clock = new FakeClock(); const raised: GrantRequest[] = [];
  const app = await startLoom({ home, clock, sharing: fixtureSharing, install: a => installSecrets(a.db, a.operations, a.live, fixtureSharing, { raise: r => { raised.push(r); return { raised: true }; } }) });
  closes.push(app.close); let seq = 0;
  const call = (viewer: Viewer, op: string, input: unknown) => app.operations.call('direct', viewer, `secrets.${op}`, input, `p-${++seq}`);
  expect(call(owner, 'describe', { name: 'api-key', description: '' }).ok).toBe(true);
  const request = (house: string, minutes?: number, viewer = agent) => call(viewer, 'requestHouse', { agent: viewer.id, scope: { house }, target: 'api-key', why: 'needed', ...(minutes === undefined ? {} : { minutes }) });
  return { app, clock, raised, call, request };
}
it('ports the old auto agent restriction, duration clamp, default and exact house grant', async () => {
  const { app, call, request, raised, clock } = await setup();
  expect(call(owner, 'policy', { secrets: { 'api-key': { grant: 'auto', agents: ['art'], minutes: 30 } } }).ok).toBe(true);
  const result = request('h-1', 999);
  expect(result).toMatchObject({ ok: true, value: { state: 'allowed', minutes: 30, decision: 'policy' } });
  expect(raised).toHaveLength(0);
  const grants = grantsRole(app.db), resource = { kind: 'secret' as const, target: 'api-key' };
  expect(grants.mayUse('art', resource, clock.now(), { house: 'h-1' })).toBe(true);
  expect(grants.mayUse('art', resource, clock.now(), { house: 'h-1', service: 'discord' })).toBe(false);
  expect(grants.mayUse('art', resource, clock.now(), { house: 'h-2' })).toBe(false);
  expect(request('h-3', 5, { kind: 'agent', id: 'pond-bot' })).toMatchObject({ ok: true, value: { state: 'pending', minutes: 5 } });
  expect(raised).toHaveLength(1);
  clock.advance(30 * 60_000);
  expect(grants.mayUse('art', resource, clock.now(), { house: 'h-1' })).toBe(false);
  expect(call(owner, 'policy', { default: 'auto' }).ok).toBe(true);
  expect(request('h-4')).toMatchObject({ ok: true, value: { state: 'allowed', minutes: 60 } });
});
it('never overrides existing grants immediately and prevents a pending allow without rewriting history', async () => {
  const { app, call, request, clock } = await setup();
  const pending = request('h-1'); expect(pending.ok).toBe(true);
  const id = pending.ok ? (pending.value as GrantRequest).id : '';
  expect(call(owner, 'grant', { agent: 'art', kind: 'secret', target: 'api-key' }).ok).toBe(true);
  expect(call(owner, 'policy', { secrets: { 'api-key': { grant: 'never', houses: ['art'] } } }).ok).toBe(true);
  expect(grantsRole(app.db).mayUse('art', { kind: 'secret', target: 'api-key' }, clock.now())).toBe(false);
  expect(call(owner, 'answer', { id, allow: true })).toMatchObject({ ok: false, code: 'conflict' });
  expect(request('h-2')).toMatchObject({ ok: true, value: { state: 'denied', decision: 'policy' } });
  expect(secretStartPermission(app.db, 'art', 'api-key')).toBe('denied');
  expect(call(owner, 'answer', { id, allow: false })).toMatchObject({ ok: true, value: { state: 'denied' } });
});
it('start permission is independent of automatic request permission and only owners edit policy', async () => {
  const { app, call, request } = await setup();
  const policy = { secrets: { 'api-key': { grant: 'auto', agents: ['art'], houses: ['pond-bot'] } } };
  for (const viewer of [agent, { kind: 'member', id: 'pollock' }, { kind: 'service', id: 'holder' }, { kind: 'runner', id: 'one' }] as Viewer[]) {
    expect(call(viewer, 'policy', policy)).toMatchObject({ ok: false, code: 'denied' });
  }
  expect(call(owner, 'policy', policy).ok).toBe(true);
  expect(secretStartPermission(app.db, 'art', 'api-key')).toBe('ask');
  expect(secretStartPermission(app.db, 'pond-bot', 'api-key')).toBe('allowed');
  expect(request('h-1')).toMatchObject({ ok: true, value: { state: 'allowed' } });
  expect(call(owner, 'policy', { default: 'auto', secrets: { 'api-key': { grant: 'ask' } } }).ok).toBe(true);
  expect(request('h-2')).toMatchObject({ ok: true, value: { state: 'pending' } });
  expect(call(owner, 'policy', { default: 'never' }).ok).toBe(true);
  expect(request('h-3')).toMatchObject({ ok: true, value: { state: 'denied' } });
  expect(secretStartPermission(app.db, 'art', 'api-key')).toBe('ask');
  for (const invalid of [{ default: 'yes' }, { secrets: { 'api-key': { minutes: 481 } } }, { secrets: { 'api-key': { value: 'sentinel' } } }]) expect(call(owner, 'policy', invalid)).toMatchObject({ ok: false, code: 'invalid' });
});
