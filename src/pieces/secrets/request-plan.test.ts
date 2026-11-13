import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import subprocess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
vi.mock('../../core/index.js', () => { throw new Error('Forbidden database dependency'); });
import { planLegacySecretRequests, type LegacyRequestPrincipals } from './request-plan.js';
const at = '2020-01-01T00:00:00.000Z', later = '2020-01-01T00:30:00.000Z', expires = '2020-01-01T01:00:00.000Z';
const now = Date.parse(later);
const original = { id: 'q-01234567', secret: 'API', agent: 'art-', house: 'h-123', why: 'original', minutes: 60, at,
  state: 'granted', by: 'owner', decided: at, expires, claimedBy: 'q-89abcdef' };
const carried = { ...original, id: 'q-89abcdef', house: 'h-124', at: later, decided: later,
  claimedBy: undefined, carriedFrom: original.id };
const plain = { ...original, claimedBy: undefined };
const principals = (): LegacyRequestPrincipals => ({ bindings: new Map([['art-', 'art']]), registered: new Set(['art', 'other']) });
const bytes = (...rows: Record<string, unknown>[]) => Buffer.from(JSON.stringify({ v: 1, requests: Object.fromEntries(rows.map(row => [row.id, row])) }));
const plan = (...rows: Record<string, unknown>[]) => planLegacySecretRequests(bytes(...rows), principals(), now);
const invalid = (source: Buffer, identities = principals(), time = now) => expect(() => planLegacySecretRequests(source, identities, time)).toThrow(/^Invalid legacy secret request plan$/);
it('maps exact legacy strings while preserving every source field without inventing attribution', () => {
  const input = bytes(original, carried), copy = Buffer.from(input), ids = principals();
  const result = planLegacySecretRequests(input, ids, now);
  expect(result).toEqual({ snapshotAt: now, requests: [original, carried].map(source => ({ source: JSON.parse(JSON.stringify(source)), agent: 'art' })),
    grants: [{ agent: 'art', kind: 'secret', target: 'API', scope: { house: 'h-124' }, requestId: carried.id, expiresAt: Date.parse(expires), pairedRequestId: original.id }] });
  expect(input).toEqual(copy); expect([...ids.bindings]).toEqual([['art-', 'art']]); expect([...ids.registered]).toEqual(['art', 'other']);
  expect(result.requests.every(row => !Object.hasOwn(row.source, 'who'))).toBe(true);
});
it('requires explicit registered valid principals even for expired and pending history', () => {
  const pending = { id: original.id, secret: 'API', agent: 'art-', house: 'h-123', why: 'pending', minutes: 60, at, state: 'pending' };
  for (const row of [plain, pending, { ...plain, expires: undefined, state: 'denied' }]) {
    invalid(bytes(row), { bindings: new Map(), registered: new Set(['art-']) });
    invalid(bytes(row), { bindings: new Map([['art-', 'art']]), registered: new Set() });
    invalid(bytes(row), { bindings: new Map([['art-', 'service:changes']]), registered: new Set(['service:changes']) });
  }
  invalid(bytes({ ...plain, agent: 'art' })); // No fallback to identical registered name.
});
it('does not normalize case, whitespace, separators or prototype-looking legacy strings', () => {
  for (const old of ['art--bridge', 'ART', ' art ', '', '__proto__', 'constructor']) {
    const input = bytes({ ...plain, agent: old });
    invalid(input);
    expect(planLegacySecretRequests(input, { bindings: new Map([[old, 'art']]), registered: new Set(['art']) }, now).grants[0].agent).toBe('art');
  }
});
it('refuses principal alias merging even when the rows use different scopes or are historical', () => {
  const identities = { bindings: new Map([['art-', 'art'], ['art--', 'art']]), registered: new Set(['art']) };
  invalid(bytes(plain, { ...plain, id: carried.id, agent: 'art--', house: 'h-999', state: 'revoked', decided: later }), identities);
});
it('keeps house/service and exact expiry; plain, Always and policy grants stay temporary', () => {
  const rows = [plain, { ...plain, id: carried.id, house: 'h-124', service: 'Bridge Mixed Case' },
    { ...plain, id: 'q-abcdef01', secret: 'OTHER', by: 'policy' },
    { ...plain, id: 'q-abcdef02', secret: 'START', always: true, minutes: 480, expires: '2020-01-01T08:00:00.000Z' }];
  const result = plan(...rows);
  expect(result.grants.map(row => [row.scope, row.expiresAt])).toEqual(rows.map(row => [
    { house: row.house, ...('service' in row ? { service: row.service } : {}) }, Date.parse(row.expires),
  ]));
  expect(result.requests[3].source.always).toBe(true);
});
it('never grants moved originals, including when their target was pruned', () => {
  expect(plan(original).grants).toEqual([]);
  expect(plan(original).requests[0].source.claimedBy).toBe(carried.id);
  expect(plan(original, carried).grants.map(row => row.requestId)).toEqual([carried.id]);
});
it('refuses live carried authority without its surviving original; retains expired or revoked history', () => {
  invalid(bytes(carried));
  const expired = planLegacySecretRequests(bytes(carried), principals(), Date.parse(expires));
  expect(expired.grants).toEqual([]); expect(expired.requests[0].source.carriedFrom).toBe(original.id);
  expect(plan({ ...carried, state: 'revoked', decided: later }).grants).toEqual([]);
});
it('refuses a live carry predating the original authorization', () => {
  invalid(bytes({ ...original, decided: later, expires: '2020-01-01T01:30:00.000Z' },
    { ...carried, at, decided: at, expires: '2020-01-01T01:30:00.000Z' }));
});
it('refuses multiple live grants at one exact scope rather than choosing later expiry or unioning', () => {
  const second = { ...plain, id: carried.id, minutes: 120, expires: '2020-01-01T02:00:00.000Z' };
  invalid(bytes(plain, second)); invalid(bytes(second, plain));
  expect(plan({ ...plain, expires: '2020-01-01T00:20:00.000Z', minutes: 20 }, second).grants.map(row => row.requestId)).toEqual([second.id]);
  expect(plan(plain, { ...second, service: 'bridge' }).grants).toHaveLength(2);
  expect(plan(plain, { ...second, house: 'h-999' }).grants).toHaveLength(2);
  expect(plan(plain, { ...second, secret: 'OTHER' }).grants).toHaveLength(2);
});
it('keeps revoked pairs and pending/denied/expired rows without effective grants', () => {
  const rows = [{ ...original, state: 'revoked', decided: later }, { ...carried, state: 'revoked', decided: later },
    { ...plain, id: 'q-abcdef01', state: 'denied', expires: undefined },
    { id: 'q-abcdef02', secret: 'API', agent: 'art-', house: 'h-999', why: 'pending', minutes: 60, at, state: 'pending' }];
  expect(plan(...rows).grants).toEqual([]);
  expect(plan(...rows).requests.map(row => row.source)).toEqual(JSON.parse(JSON.stringify(rows)));
  expect(planLegacySecretRequests(bytes(plain), principals(), Date.parse(expires)).grants).toEqual([]);
});
it('requires explicit valid snapshot time and redacts parser/mapping failures', () => {
  for (const time of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) invalid(bytes(plain), principals(), time);
  invalid(Buffer.from('PRIVATE-VALUE'));
  invalid(bytes({ ...plain, value: 'PRIVATE-VALUE' }));
  expect(planLegacySecretRequests(bytes(), principals(), 0)).toEqual({ snapshotAt: 0, requests: [], grants: [] });
});
it('uses no database, filesystem, subprocess or implicit current clock', () => {
  const input = bytes(original, carried);
  const forbidden = () => { throw new Error('Forbidden planning side effect'); };
  const reads = (['readFileSync', 'writeFileSync', 'openSync', 'appendFileSync', 'readdirSync', 'statSync'] as const).map(name => vi.spyOn(fs, name).mockImplementation(forbidden));
  const processes = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const).map(name => vi.spyOn(subprocess, name).mockImplementation(forbidden));
  const NativeDate = Date;
  const clock = vi.fn(function (...args: unknown[]) {
    if (args.length === 0) throw new Error('Forbidden implicit current clock');
    return Reflect.construct(NativeDate, args);
  });
  Object.assign(clock, { parse: NativeDate.parse, UTC: NativeDate.UTC, now: forbidden });
  vi.stubGlobal('Date', clock);
  syncBuiltinESMExports();
  try {
    expect(planLegacySecretRequests(input, principals(), now).grants).toHaveLength(1);
    expect(clock).not.toHaveBeenCalled();
    for (const call of [...reads, ...processes]) expect(call).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); syncBuiltinESMExports(); }
});

it('refuses future source events instead of authorizing early or reconstructing past revocations', () => {
  invalid(bytes(plain), principals(), 0);
  invalid(bytes(original, carried), principals(), Date.parse(at));
  // Even a future denied/revoked/pending event makes this an inconsistent snapshot.
  for (const row of [
    { ...plain, at: expires },
    { ...plain, state: 'denied', expires: undefined, decided: expires },
    { ...plain, state: 'revoked', decided: expires },
    { id: original.id, secret: 'API', agent: 'art-', house: 'h-123', why: 'pending', minutes: 60, at: expires, state: 'pending' },
  ]) invalid(bytes(row));
  expect(planLegacySecretRequests(bytes(plain), principals(), Date.parse(at)).grants).toHaveLength(1);
  expect(planLegacySecretRequests(bytes(original, carried), principals(), now).grants).toHaveLength(1);
});
