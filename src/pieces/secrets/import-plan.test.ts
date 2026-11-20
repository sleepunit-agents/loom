import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import subprocess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
vi.mock('../../core/index.js', () => { throw new Error('Forbidden database dependency'); });
import { planLegacySecretMetadata } from './import-plan.js';
import { requestDecision } from './policy.js';
import type { LegacyRequestPrincipals } from './request-plan.js';
const at = '2020-01-01T00:00:00.000Z', snapshot = Date.parse(at);
const request = { id: 'q-01234567', secret: 'API', agent: 'old-art', house: 'h-123', why: 'use', minutes: 60, at,
  state: 'granted', by: 'owner', decided: at, expires: '2020-01-01T01:00:00.000Z' };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const requests = (rows: Record<string, unknown>[] = [request]) => bytes({ v: 1, requests: Object.fromEntries(rows.map(row => [row.id, row])) });
const principals = (): LegacyRequestPrincipals => ({ bindings: new Map([['old-art', 'art'], ['old-bridge', 'bridge']]), registered: new Set(['art', 'bridge']) });
const policy = { default: 'never', secrets: {
  API: { grant: 'auto', agents: ['old-art', 'old-art'], houses: ['old-bridge'], minutes: 999 },
  START: { houses: ['old-art'] }, NEVER: { grant: 'never', agents: ['old-bridge'], houses: ['old-art'] },
} };
const invalid = (p: unknown, rows = [request], ids = principals()) => expect(() => planLegacySecretMetadata(bytes(p), requests(rows), ids, snapshot)).toThrow(/^Invalid legacy secret metadata plan$/);
it('resolves policy/request membership together without mixing startup and request authority', () => {
  const p = bytes(policy), r = requests(), originalP = Buffer.from(p), originalR = Buffer.from(r), ids = principals();
  const result = planLegacySecretMetadata(p, r, ids, snapshot);
  expect(result.sourcePolicy).toEqual({ ...policy, secrets: { ...policy.secrets, API: { ...policy.secrets.API, minutes: 480 } } });
  expect(result.policy).toEqual({ default: 'never', secrets: {
    API: { grant: 'auto', agents: ['art', 'art'], houses: ['bridge'], minutes: 480 },
    START: { houses: ['art'] }, NEVER: { grant: 'never', agents: ['bridge'], houses: ['art'] },
  } });
  expect(result.requests.requests).toEqual([{ source: request, agent: 'art' }]);
  expect(result.requests.grants).toEqual([{ agent: 'art', kind: 'secret', target: 'API', scope: { house: 'h-123' }, requestId: request.id, expiresAt: Date.parse(request.expires) }]);
  expect(requestDecision(result.policy, 'art', 'API')).toEqual({ level: 'auto', minutes: 480 });
  expect(requestDecision(result.policy, 'bridge', 'API').level).toBe('ask');
  expect(requestDecision(result.policy, 'art', 'START').level).toBe('never');
  expect(requestDecision(result.policy, 'bridge', 'NEVER').level).toBe('never');
  expect(p).toEqual(originalP); expect(r).toEqual(originalR);
  expect([...ids.bindings]).toEqual([['old-art', 'art'], ['old-bridge', 'bridge']]);
  result.policy.secrets.API.agents!.push('bridge');
  expect(result.sourcePolicy.secrets.API.agents).toEqual(['old-art', 'old-art']);
});
it('requires explicit registered policy principals in both active and inactive membership fields', () => {
  for (const field of ['agents', 'houses']) for (const grant of ['auto', 'never', 'ask']) {
    const p = { secrets: { API: { grant, [field]: ['old-bridge'] } } };
    invalid(p, [], { bindings: new Map(), registered: new Set(['old-bridge']) });
    invalid(p, [], { bindings: new Map([['old-bridge', 'bridge']]), registered: new Set(['art']) });
    invalid(p, [], { bindings: new Map([['old-bridge', 'service:changes']]), registered: new Set(['service:changes']) });
    invalid(p, [], { bindings: new Map([['old-bridge', 'bridge-']]), registered: new Set(['bridge-']) });
  }
});
it('refuses alias merging across request and policy inputs even for denied history', () => {
  const ids = { bindings: new Map([['old-art', 'art'], ['old-bridge', 'art']]), registered: new Set(['art']) };
  for (const field of ['agents', 'houses']) {
    const p = { secrets: { API: { [field]: ['old-bridge'] } } };
    invalid(p, [request], ids);
    invalid(p, [{ ...request, state: 'denied', expires: undefined }], ids);
  }
});
it('refuses alias merging between policy fields and between separate rules', () => {
  const ids = { bindings: new Map([['old-art', 'art'], ['old-bridge', 'art']]), registered: new Set(['art']) };
  invalid({ secrets: { API: { agents: ['old-art'], houses: ['old-bridge'] } } }, [], ids);
  invalid({ secrets: { API: { agents: ['old-art'] }, OTHER: { houses: ['old-bridge'] } } }, [], ids);
});
it('allows repeated identical identities across fields and ignores unused binding entries', () => {
  const ids = principals(); (ids.bindings as Map<string, string>).set('unused', 'art');
  const result = planLegacySecretMetadata(bytes({ secrets: { API: { agents: ['old-art'], houses: ['old-art'] } } }), requests(), ids, snapshot);
  expect(result.policy.secrets.API).toEqual({ agents: ['art'], houses: ['art'] });
});
it('retains strict policy source refusal and redacts both inputs and planning failures', () => {
  const sentinel = 'PRIVATE-VALUE';
  for (const p of [sentinel, '{"default":"never","default":"auto"}', '{"value":"PRIVATE-VALUE"}', '{"secrets":{"API":{"houses":["old--art"]}}}']) {
    expect(() => planLegacySecretMetadata(Buffer.from(p), requests(), principals(), snapshot)).toThrow(/^Invalid legacy secret metadata plan$/);
  }
  expect(() => planLegacySecretMetadata(bytes(policy), Buffer.from(sentinel), principals(), snapshot)).toThrow(/^Invalid legacy secret metadata plan$/);
  expect(() => planLegacySecretMetadata(bytes(policy), requests(), principals(), snapshot - 1)).toThrow(/^Invalid legacy secret metadata plan$/);
  expect(() => planLegacySecretMetadata(bytes(policy), requests(), principals(), NaN)).toThrow(/^Invalid legacy secret metadata plan$/);
});
it('keeps omitted membership omitted and explicit empty membership empty', () => {
  expect(planLegacySecretMetadata(bytes({ default: 'auto', secrets: { API: { grant: 'auto' }, OTHER: { agents: [], houses: [] } } }), requests([]), principals(), snapshot).policy)
    .toEqual({ default: 'auto', secrets: { API: { grant: 'auto' }, OTHER: { agents: [], houses: [] } } });
});

it('uses no database, filesystem, subprocess or implicit current clock', () => {
  const p = bytes(policy), r = requests();
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
    expect(planLegacySecretMetadata(p, r, principals(), snapshot).requests.grants).toHaveLength(1);
    expect(clock).not.toHaveBeenCalled();
    for (const call of [...reads, ...processes]) expect(call).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); syncBuiltinESMExports(); }
});
