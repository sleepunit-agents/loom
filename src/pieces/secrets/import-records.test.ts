import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock } from '../../core/index.js';
import { grantsRole, installSecrets } from './index.js';
import { planLegacySecretRecords, type LegacySecretRecordPrincipals } from './import-records.js';
const at = '2020-01-01T00:00:00.000Z', now = Date.parse(at), expires = '2020-01-01T01:00:00.000Z';
const original = { id: 'q-01234567', secret: 'API', agent: 'old-art', house: 'h-1', service: 'discord',
  why: 'work', minutes: 60, at, state: 'granted', decided: at, expires, by: 'owner', who: 'old-dana' };
const carried = { ...original, id: 'q-12345678', house: 'h-2', who: undefined, carriedFrom: original.id };
const pair = [{ ...original, claimedBy: carried.id }, carried];
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const ids = (): LegacySecretRecordPrincipals => ({ bindings: new Map([['old-art', 'art']]), registered: new Set(['art']),
  members: new Map([['old-dana', 'dana'], ['old-jonathan', 'jonathan']]), registeredMembers: new Set(['dana', 'jonathan']) });
function plan(rows: Record<string, unknown>[] = pair, principals = ids(), names = new Set(['API']), snapshot = now) {
  return planLegacySecretRecords(bytes({}), bytes({ v: 1, requests: Object.fromEntries(rows.map(r => [r.id, r])) }), principals, names, snapshot);
}
const invalid = (rows: Record<string, unknown>[], principals = ids(), names = new Set(['API'])) =>
  expect(() => plan(rows, principals, names)).toThrow(/^Invalid legacy secret destination records$/);
const close: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of close.splice(0)) await cleanup(); });
it('materializes the exact pair with a non-authorizing original and preserves source attribution independently', () => {
  const result = plan();
  expect(result.requests).toEqual([
    { id: original.id, agent: 'art', kind: 'secret', target: 'API', askedBy: { kind: 'agent', id: 'art' },
      why: 'work', minutes: 60, scope: { house: 'h-1', service: 'discord' }, createdAt: now, state: 'allowed',
      answeredAt: now, by: 'dana', claimedBy: carried.id },
    { id: carried.id, agent: 'art', kind: 'secret', target: 'API', askedBy: { kind: 'agent', id: 'art' },
      why: 'work', minutes: 60, scope: { house: 'h-2', service: 'discord' }, createdAt: now, state: 'allowed',
      answeredAt: now, carriedFrom: original.id },
  ]);
  expect(result.grants).toEqual([
    { id: '["art","secret","API","h-2","discord"]', agent: 'art', kind: 'secret', target: 'API', scope: { house: 'h-2', service: 'discord' },
      requestId: carried.id, expiresAt: Date.parse(expires), createdAt: now, by: 'dana', pairedRequestId: original.id },
    { id: '["art","secret","API","h-1","discord"]', agent: 'art', kind: 'secret', target: 'API', scope: { house: 'h-1', service: 'discord' },
      requestId: original.id, expiresAt: Date.parse(expires), createdAt: now, by: 'dana', movedTo: carried.id, pairedRequestId: carried.id },
  ]);
  expect(result.metadata.requests.requests[0].source).toEqual(pair[0]);
  expect(result.metadata.requests.requests[1].source).not.toHaveProperty('who');
  result.grants[0].scope!.house = 'h-99';
  expect(result.requests[1].scope!.house).toBe('h-2');
  expect(result.metadata.requests.grants[0].scope.house).toBe('h-2');
});
for (const house of ['h-1', 'h-2']) it(`runtime consumes planned records with exact access and paired revocation via ${house}`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-secret-records-')); fixture(home);
  const clock = new FakeClock(now);
  const app = await startLoom({ home, next: true, staging: true, clock, sharing: fixtureSharing,
    install: a => installSecrets(a.db, a.operations, a.live, fixtureSharing) });
  close.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const result = plan();
  // Fixture insertion only: the production atomic importer does not exist yet.
  for (const r of result.requests) app.db.prepare('INSERT INTO secrets_requests VALUES (?,?)').run(r.id, JSON.stringify(r));
  for (const g of result.grants) app.db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?)').run(g.id, g.agent, g.kind, g.target, JSON.stringify(g));
  const grants = grantsRole(app.db), resource = { kind: 'secret' as const, target: 'API' };
  expect(grants.mayUse('art', resource, now, { house: 'h-1', service: 'discord' })).toBe(false);
  expect(grants.mayUse('art', resource, now, { house: 'h-2', service: 'discord' })).toBe(true);
  for (const context of [undefined, { house: 'h-2' }, { house: 'h-3', service: 'discord' }, { house: 'h-2', service: 'slack' }])
    expect(grants.mayUse('art', resource, now, context)).toBe(false);
  expect(grants.mayUse('pond-bot', resource, now, { house: 'h-2', service: 'discord' })).toBe(false);
  expect(grants.mayUse('art', resource, Date.parse(expires), { house: 'h-2', service: 'discord' })).toBe(false);
  expect(app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'secrets.revoke',
    { agent: 'art', ...resource, scope: { house, service: 'discord' } }, 'revoke')).toMatchObject({ ok: true });
  expect(app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);
  expect((app.db.prepare('SELECT record FROM secrets_requests').all() as { record: string }[]).map(r => JSON.parse(r.record).state)).toEqual(['revoked', 'revoked']);
});
it('keeps policy, Always, exact absent service and historical states without minting stale grants', () => {
  const policy = { ...original, id: 'q-23456789', by: 'policy', who: undefined, service: undefined };
  const always = { ...original, id: 'q-34567890', house: 'h-3', always: true, minutes: 480, expires: '2020-01-01T08:00:00.000Z' };
  const result = plan([policy, always]);
  expect(result.grants.map(g => [g.by, g.scope])).toEqual([['policy', { house: 'h-1' }], ['dana', { house: 'h-3', service: 'discord' }]]);
  expect(result.requests[0]).toMatchObject({ decision: 'policy' }); expect(result.requests[0]).not.toHaveProperty('by');
  expect(result.requests[1]).toMatchObject({ always: true, minutes: 480, by: 'dana' });
  expect(plan(pair, ids(), new Set(), Date.parse(expires)).grants).toEqual([]);
  const revoked = pair.map(r => ({ ...r, state: 'revoked' }));
  expect(plan(revoked).grants).toEqual([]); expect(plan(revoked).requests.map(r => r.state)).toEqual(['revoked', 'revoked']);
  const denied = { ...original, state: 'denied', expires: undefined, who: undefined };
  expect(plan([denied]).requests[0]).not.toHaveProperty('by');
  expect(plan([denied]).grants).toEqual([]);
});
it('requires exact injective registered member mapping for all surviving attribution, including history', () => {
  const historical = { ...original, state: 'denied', expires: undefined };
  for (const members of [new Map(), new Map([['old-dana', 'absent']]), new Map([['old-dana', '']])]) invalid([historical], { ...ids(), members });
  const second = { ...historical, id: 'q-23456789', who: 'old-jonathan' };
  invalid([historical, second], { ...ids(), members: new Map([['old-dana', 'dana'], ['old-jonathan', 'dana']]) });
  expect(plan([historical, { ...second, who: 'old-dana' }]).requests.map(r => r.by)).toEqual(['dana', 'dana']);
});
it('refuses unsupported pending attention, unattributed live owner authority, absent names and invalid service', () => {
  invalid([{ ...original, state: 'pending', by: undefined, who: undefined, decided: undefined, expires: undefined }]);
  invalid([{ ...original, who: undefined }]); invalid(pair.map(r => ({ ...r, who: undefined })));
  invalid([original], ids(), new Set()); invalid([original], ids(), new Set(['API', 'bad name']));
  invalid([{ ...original, service: 'bad service' }]);
  expect(plan([{ ...original, who: undefined }], ids(), new Set(), Date.parse(expires)).grants).toEqual([]);
});
it('refuses a moved-original slot that would overwrite another independent live grant', () => {
  invalid([...pair, { ...original, id: 'q-23456789' }]);
  // Same exact scope with service absence remains a different slot.
  expect(plan([...pair, { ...original, id: 'q-23456789', service: undefined }]).grants).toHaveLength(3);
});
it('retains missing pruned historical links without reconstructing authority', () => {
  expect(plan([{ ...pair[0] }]).grants).toEqual([]);
  expect(plan([{ ...carried, state: 'revoked' }]).requests[0]).toMatchObject({ carriedFrom: original.id });
  invalid([carried]);
});
