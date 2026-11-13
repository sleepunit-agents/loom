import { expect, it } from 'vitest';
import { parseLegacySecretRequests } from './request-source.js';
const at = '2020-01-01T00:00:00.000Z';
const expires = '2020-01-01T01:00:00.000Z';
const base = { id: 'q-01234567', secret: 'API', agent: 'art', house: 'h-123', why: 'for a job', minutes: 60, at, state: 'pending' };
const parse = (requests: unknown) => parseLegacySecretRequests(Buffer.from(JSON.stringify({ v: 1, requests })));
const one = (r: typeof base | Record<string, unknown>) => parse({ 'q-01234567': r });
it('preserves pending and every stored decision, including expired grants, exact scope and actual member', () => {
  const fixtures = [base,
    { ...base, state: 'denied', by: 'policy', decided: at },
    { ...base, state: 'denied', by: 'owner', who: 'dana', decided: at },
    { ...base, state: 'granted', by: 'policy', decided: at, expires },
    { ...base, state: 'granted', by: 'owner', who: 'jonathan-barket', decided: at, expires, always: true, minutes: 480, service: 'bridge' },
    { ...base, state: 'revoked', by: 'owner', decided: expires, expires },
  ];
  for (const fixture of fixtures) expect(one(fixture)).toEqual([fixture]);
  expect(parse({})).toEqual([]);
});
it('retains carry and claimed links even when historical source rows were pruned', () => {
  const original = { ...base, state: 'granted', by: 'owner', decided: at, expires, who: 'dana', claimedBy: 'q-89abcdef' };
  const carried = { ...base, id: 'q-89abcdef', house: 'h-124', state: 'revoked', by: 'owner', decided: expires, expires, carriedFrom: base.id };
  expect(parse({ [original.id]: original, [carried.id]: carried })).toEqual([original, carried]);
  expect(parse({ [carried.id]: carried })).toEqual([carried]);
});
it('refuses mismatched identity, self links, unsupported envelopes and unknown or value-bearing fields', () => {
  const sentinel = 'ACCIDENTAL-PRIVATE-VALUE';
  for (const source of [null, [], {}, { v: 2, requests: {} }, { v: 1, requests: [], value: sentinel },
    { v: 1, requests: { 'q-89abcdef': base } }, { v: 1, requests: { [base.id]: { ...base, value: sentinel } } }]) {
    expect(() => parseLegacySecretRequests(Buffer.from(JSON.stringify(source)))).toThrow(/^Invalid legacy secret requests$/);
  }
  for (const field of ['carriedFrom', 'claimedBy']) expect(() => one({ ...base, state: 'granted', by: 'owner', decided: at, expires, [field]: base.id })).toThrow(/^Invalid legacy secret requests$/);
  expect(() => parseLegacySecretRequests(Buffer.from(sentinel))).toThrow(/^Invalid legacy secret requests$/);
});
it('refuses malformed fields and impossible stored decisions instead of inventing or broadening grants', () => {
  for (const edit of [{ id: 'q-no' }, { secret: 'bad name' }, { house: 'host' }, { agent: '' }, { service: '' },
    { why: '' }, { why: 'x'.repeat(301) }, { minutes: 0 }, { minutes: 481 }, { minutes: 1.5 }, { at: 'yesterday' },
    { state: 'expired' }, { state: 'granted' }, { expires }, { by: 'owner' }, { who: 'dana' }, { always: false },
    { state: 'denied', by: 'owner', decided: at, expires },
    { state: 'granted', by: 'policy', decided: at, expires, who: 'dana' },
    { state: 'granted', by: 'owner', decided: at, expires, carriedFrom: 'q-89abcdef', claimedBy: 'q-abcdef01' },
    { state: 'granted', by: 'owner', decided: at, expires, always: true, claimedBy: 'q-89abcdef' }]) {
    expect(() => one({ ...base, ...edit })).toThrow(/^Invalid legacy secret requests$/);
  }
});
it('does not mutate bytes, normalize reasons, drop service or invent answering attribution', () => {
  const fixture = { ...base, why: 'literal  reason', service: 'bridge', state: 'granted', by: 'owner', decided: at, expires, carriedFrom: 'q-89abcdef' };
  const bytes = Buffer.from(JSON.stringify({ v: 1, requests: { [base.id]: fixture } }));
  const before = Buffer.from(bytes);
  expect(parseLegacySecretRequests(bytes)).toEqual([fixture]);
  expect(bytes).toEqual(before);
});
