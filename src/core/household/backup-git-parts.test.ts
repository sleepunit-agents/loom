import { describe, expect, it } from 'vitest';
import { prepareHouseholdGitPayload as prepare, verifyHouseholdGitPayload as verify } from './backup-git-parts.js';
import type { encryptHouseholdBundle } from './backup-bundle.js';

type Bundle = Awaited<ReturnType<typeof encryptHouseholdBundle>>;
const stamp = '20261114-0300';
const header = Buffer.from('age-encryption.org/v1\n');
const bundle = (size = 83): Bundle => ({ bytes: Buffer.concat([header, Buffer.from(Array.from({ length: size - header.length }, (_, i) => i % 256))]),
  coverage: 'explicit-household-inputs', drill: { app: true, continuity: true, files: true, cookieKey: true, secrets: true } });
const fail = /^Household backup git payload failed$/;

describe('household encrypted git parts', () => {
  it.each([22, 32, 33, 64, 65, 83])('rejoins all %i bytes in lexical restore order', size => {
    const source = bundle(size), payload = prepare(stamp, source, 32);
    expect(payload.parts.map(p => p.path)).toEqual(size <= 32 ? [`bundles/loom-household-${stamp}.bundle`]
      : Array.from({ length: Math.ceil(size / 32) }, (_, i) => `bundles/loom-household-${stamp}.bundle.part-${String(i).padStart(2, '0')}`));
    expect(payload.parts.map(p => p.path)).toEqual(payload.parts.map(p => p.path).sort());
    expect(payload.parts.every(p => p.bytes.length <= 32)).toBe(true);
    expect(Buffer.concat(payload.parts.map(p => p.bytes))).toEqual(source.bytes);
    expect(payload.bytes).toBe(size);
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verify(payload, source.bytes)).not.toThrow();
  });

  it('keeps exactly 90 MiB unsplit and splits one byte above it', () => {
    for (const size of [90 * 1024 * 1024, 90 * 1024 * 1024 + 1]) {
      const source = bundle(22); source.bytes = Buffer.alloc(size); header.copy(source.bytes);
      const payload = prepare(stamp, source);
      expect(payload.parts.map(p => p.bytes.length)).toEqual(size === 90 * 1024 * 1024 ? [size] : [size - 1, 1]);
      expect(payload.parts[0].path.endsWith(size === 90 * 1024 * 1024 ? '.bundle' : '.part-00')).toBe(true);
    }
  });

  it('allows part-99 but refuses a 101st part without ambiguous names', () => {
    const payload = prepare(stamp, bundle(2200), 22);
    expect(payload.parts).toHaveLength(100);
    expect(payload.parts[99].path).toBe(`bundles/loom-household-${stamp}.bundle.part-99`);
    expect(() => prepare(stamp, bundle(2201), 22)).toThrow(fail);
  });

  it('owns copies independent of the producer and every sibling part', () => {
    const source = bundle(), original = Buffer.from(source.bytes), payload = prepare(stamp, source, 32);
    source.bytes.fill(0);
    expect(Buffer.concat(payload.parts.map(p => p.bytes))).toEqual(original);
    const sibling = Buffer.from(payload.parts[1].bytes);
    payload.parts[0].bytes.fill(1);
    expect(payload.parts[1].bytes).toEqual(sibling);
    expect(() => verify(payload, original)).toThrow(fail);
  });

  it.each(['corrupt', 'missing', 'duplicate', 'reordered', 'extra', 'truncated', 'overlong', 'renamed', 'metadata', 'forged-digest', 'sparse'])('refuses %s materialized parts', change => {
    const source = bundle(), payload = prepare(stamp, source, 32);
    if (change === 'corrupt') payload.parts[1].bytes[0] ^= 1;
    if (change === 'missing') payload.parts.splice(1, 1);
    if (change === 'duplicate') payload.parts[1] = payload.parts[0];
    if (change === 'reordered') payload.parts.reverse();
    if (change === 'extra') payload.parts.push(payload.parts[0]);
    if (change === 'truncated') payload.parts[1].bytes = payload.parts[1].bytes.subarray(1);
    if (change === 'overlong') payload.parts[1].bytes = Buffer.concat([payload.parts[1].bytes, Buffer.from([0])]);
    if (change === 'renamed') payload.parts[1].path += '/private-target';
    if (change === 'metadata') payload.bytes++;
    if (change === 'forged-digest') payload.sha256 = '0'.repeat(64);
    if (change === 'sparse') delete payload.parts[1];
    expect(() => verify(payload, source.bytes)).toThrow(fail);
  });

  it('refuses changed ciphertext even when payload metadata agrees with itself', () => {
    const source = bundle(), payload = prepare(stamp, source, 32), other = bundle();
    other.bytes[30] ^= 1;
    expect(() => verify(payload, other.bytes)).toThrow(fail);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 90 * 1024 * 1024 + 1])('refuses part budget %s', size => {
    expect(() => prepare(stamp, bundle(), size)).toThrow(fail);
  });

  it.each(['20260229-0300', '20261114-2400', '../private-target', '20261114-0300\n', ''])('refuses malformed stamp %j', value => {
    expect(() => prepare(value, bundle(), 32)).toThrow(fail);
  });

  it('refuses invalid drill results and non-ciphertext without reflecting input', () => {
    for (const key of ['app', 'continuity', 'files', 'cookieKey', 'secrets'] as const) {
      const source = bundle(); (source.drill as Record<string, unknown>)[key] = false;
      expect(() => prepare(stamp, source, 32)).toThrow(fail);
    }
    const source = bundle(); source.bytes.fill(0);
    expect(() => prepare(stamp, source, 32)).toThrow(fail);
    expect(() => prepare(stamp, { ...bundle(), coverage: 'private-target' } as unknown as Bundle)).toThrow(fail);
    for (const value of [null, {}, { bytes: 'private-target' }, { ...bundle(), bytes: Buffer.alloc(0) }])
      expect(() => prepare(stamp, value as Bundle)).toThrow(fail);
    for (const value of [null, {}, { ...prepare(stamp, bundle(), 32), parts: null }])
      expect(() => verify(value as ReturnType<typeof prepare>, bundle().bytes)).toThrow(fail);
    expect(() => verify(prepare(stamp, bundle(), 32), null as unknown as Buffer)).toThrow(fail);
  });
});
