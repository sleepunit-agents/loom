import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import subprocess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
vi.mock('../../core/index.js', () => { throw new Error('Forbidden core dependency'); });
import { parseLegacySecretRequestLinks } from './request-links.js';
const at = '2020-01-01T00:00:00.000Z';
const later = '2020-01-01T00:30:00.000Z';
const expires = '2020-01-01T01:00:00.000Z';
const original = { id: 'q-01234567', secret: 'API', agent: 'art', house: 'h-123', why: 'original', minutes: 60, at,
  state: 'granted', by: 'owner', who: 'dana', decided: at, expires, claimedBy: 'q-89abcdef' };
const carried = { ...original, id: 'q-89abcdef', house: 'h-124', why: 'next house', at: later, decided: later,
  who: undefined, claimedBy: undefined, carriedFrom: original.id };
const parse = (...rows: Record<string, unknown>[]) => parseLegacySecretRequestLinks(Buffer.from(JSON.stringify({ v: 1, requests: Object.fromEntries(rows.map(r => [r.id, r])) })));
const invalid = (...rows: Record<string, unknown>[]) => expect(() => parse(...rows)).toThrow(/^Invalid legacy secret request links$/);
it('preserves exact linked metadata, expired grants and absence of answering attribution', () => {
  const bytes = Buffer.from(JSON.stringify({ v: 1, requests: { [original.id]: original, [carried.id]: carried } }));
  const before = Buffer.from(bytes);
  expect(parseLegacySecretRequestLinks(bytes)).toEqual([original, JSON.parse(JSON.stringify(carried))]);
  expect(bytes).toEqual(before);
  expect(parse()).toEqual([]);
});
it('refuses a carry that changes identity, secret, service, house or expiry', () => {
  for (const edit of [{ agent: 'other' }, { secret: 'OTHER' }, { service: 'bridge' }, { house: original.house },
    { expires: '2020-01-01T02:00:00.000Z' }]) invalid(original, { ...carried, ...edit });
  // Exact service presence matters; matching service values are preserved.
  expect(parse({ ...original, service: 'bridge' }, { ...carried, service: 'bridge' })).toHaveLength(2);
});
it('requires reciprocal links when the partner survives retention', () => {
  invalid({ ...original, claimedBy: undefined }, carried);
  invalid(original, { ...carried, carriedFrom: undefined, minutes: 30 });
  invalid({ ...original, claimedBy: 'q-abcdef01' }, carried);
  invalid(original, { ...carried, carriedFrom: 'q-abcdef01' });
});
it('refuses inconsistent paired revocation, preserving a matching pair verbatim', () => {
  const revoke = { state: 'revoked', decided: later };
  invalid({ ...original, ...revoke }, carried);
  invalid(original, { ...carried, ...revoke });
  invalid({ ...original, ...revoke }, { ...carried, ...revoke, decided: expires });
  expect(parse({ ...original, ...revoke }, { ...carried, ...revoke })).toHaveLength(2);
});
it('retains pruned links but never treats them as authorization', () => {
  expect(parse(original)).toEqual([original]);
  expect(parse(carried)).toEqual([JSON.parse(JSON.stringify(carried))]);
});
it('refuses forked claims even when the common historical partner was pruned', () => {
  invalid(carried, { ...carried, id: 'q-abcdef01', house: 'h-125' });
  invalid(original, { ...original, id: 'q-abcdef01', house: 'h-125' });
});
it('requires a plain owner Allow as the original, not Always, policy or another carry', () => {
  invalid({ ...original, always: true, minutes: 480, expires: '2020-01-01T08:00:00.000Z' }, carried);
  invalid({ ...original, by: 'policy', who: undefined }, carried);
  invalid({ ...original, carriedFrom: 'q-abcdef01' }, carried);
});
it('redacts malformed input including source-parser failures', () => {
  for (const text of ['PRIVATE-VALUE', '{"v":1,"requests":{},"requests":{"value":"PRIVATE-VALUE"}}']) {
    expect(() => parseLegacySecretRequestLinks(Buffer.from(text))).toThrow(/^Invalid legacy secret request links$/);
  }
});

it('refuses a second carry hidden by a pruned middle partner', () => {
  invalid({ ...original, claimedBy: 'q-abcdef01' }, { ...carried, carriedFrom: 'q-abcdef01' });
});
it('refuses carry creation at or after its inherited expiry, also after revocation', () => {
  for (const at of [expires, '2020-01-01T02:00:00.000Z']) {
    invalid(original, { ...carried, at, decided: at });
    invalid({ ...original, state: 'revoked', decided: expires }, { ...carried, state: 'revoked', at, decided: expires });
    invalid({ ...carried, at, decided: at }); // Missing source is no exception.
  }
});
it('uses no filesystem, subprocess, current clock or database capability', () => {
  const bytes = Buffer.from(JSON.stringify({ v: 1, requests: { [original.id]: original, [carried.id]: carried } }));
  const forbidden = () => { throw new Error('Forbidden parser side effect'); };
  const reads = (['readFileSync', 'writeFileSync', 'openSync', 'appendFileSync', 'readdirSync', 'statSync'] as const)
    .map(name => vi.spyOn(fs, name).mockImplementation(forbidden));
  const processes = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
    .map(name => vi.spyOn(subprocess, name).mockImplementation(forbidden));
  const now = vi.spyOn(Date, 'now').mockImplementation(forbidden);
  syncBuiltinESMExports();
  try {
    expect(parseLegacySecretRequestLinks(bytes)).toHaveLength(2);
    for (const call of [...reads, ...processes, now]) expect(call).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); }
});
