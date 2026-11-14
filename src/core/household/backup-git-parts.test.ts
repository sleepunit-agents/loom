import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { prepareHouseholdGitPayload as prepare, verifyHouseholdGitPayload as verify } from './backup-git-parts.js';
import type { encryptHouseholdBundle } from './backup-bundle.js';

type Bundle = Awaited<ReturnType<typeof encryptHouseholdBundle>>;

const { ioCall, guardModule } = vi.hoisted(() => {
  const ioCall = vi.fn(() => { throw Error('Unexpected payload IO'); });
  const guardModule = (original: Record<string, unknown>) => Object.fromEntries(
    Object.entries(original).map(([key, value]) => [key, typeof value === 'function' ? ioCall : value]));
  return { ioCall, guardModule };
});
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const guarded = { ...guardModule(actual), promises: guardModule(actual.promises) };
  return { ...guarded, default: guarded };
});
vi.mock('node:fs/promises', async original => {
  const guarded = guardModule(await original<Record<string, unknown>>());
  return { ...guarded, default: guarded };
});
vi.mock('node:child_process', async original => {
  const guarded = guardModule(await original<Record<string, unknown>>());
  return { ...guarded, default: guarded };
});
vi.mock('node:net', async original => {
  const guarded = guardModule(await original<Record<string, unknown>>());
  return { ...guarded, default: guarded };
});
vi.mock('node:http', async original => {
  const guarded = guardModule(await original<Record<string, unknown>>());
  return { ...guarded, default: guarded };
});
vi.mock('node:https', async original => {
  const guarded = guardModule(await original<Record<string, unknown>>());
  return { ...guarded, default: guarded };
});

const stamp = '20261114-0300';
const header = Buffer.from('age-encryption.org/v1\n');
const bundle = (size = 83): Bundle => ({ bytes: Buffer.concat([header, Buffer.from(Array.from({ length: size - header.length }, (_, i) => i % 256))]),
  coverage: 'explicit-household-inputs', drill: { app: true, continuity: true, files: true, cookieKey: true, secrets: true } });
const fail = /^Household backup git payload failed$/;

describe('household encrypted git parts', () => {
  it('performs no filesystem, process or network IO on success or refusal', () => {
    ioCall.mockClear();
    const source = bundle(), payload = prepare(stamp, source, 32);
    verify(payload, source.bytes);
    expect(() => prepare('private-target', source, 32)).toThrow(fail);
    expect(() => prepare(stamp, source, 32, 82)).toThrow(fail);
    payload.parts[0].bytes[0] ^= 1;
    expect(() => verify(payload, source.bytes)).toThrow(fail);
    expect(ioCall).not.toHaveBeenCalled();
  });

  it('enforces lowered total ciphertext ceilings in both preparation and verification', () => {
    const source = bundle(83), payload = prepare(stamp, source, 32, 83);
    expect(() => verify(payload, source.bytes, 83)).not.toThrow();
    expect(() => prepare(stamp, source, 32, 82)).toThrow(fail);
    expect(() => verify(payload, source.bytes, 82)).toThrow(fail);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 897 * 1024 * 1024 + 1])('refuses invalid or raised total ceiling %s', max => {
    const source = bundle(), payload = prepare(stamp, source, 32);
    expect(() => prepare(stamp, source, 32, max)).toThrow(fail);
    expect(() => verify(payload, source.bytes, max)).toThrow(fail);
  });
  it.each([22, 32, 33, 64, 65, 83])('rejoins all %i bytes in lexical restore order', size => {
    const source = bundle(size), payload = prepare(stamp, source, 32);
    expect(payload.parts.map(p => p.path)).toEqual(size <= 32 ? [`bundles/loom-household-${stamp}.bundle`]
      : Array.from({ length: Math.ceil(size / 32) }, (_, i) => `bundles/loom-household-${stamp}.bundle.part-${String(i).padStart(2, '0')}`));
    expect(payload.parts.map(p => p.path)).toEqual(payload.parts.map(p => p.path).sort());
    expect(payload.parts.every(p => p.bytes.length <= 32)).toBe(true);
    expect(Buffer.concat(payload.parts.map(p => p.bytes))).toEqual(source.bytes);
    expect(payload.bytes).toBe(size);
    expect(payload.sha256).toBe(createHash('sha256').update(source.bytes).digest('hex'));
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
