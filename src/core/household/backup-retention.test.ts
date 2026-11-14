import { describe, expect, it, vi } from 'vitest';
import { planHouseholdBackupRetention as plan } from './backup-retention.js';

// Guard the behavioral no-IO contract as well as the returned decisions.
const { filesystemCall } = vi.hoisted(() => ({ filesystemCall: vi.fn(() => { throw new Error('Unexpected retention filesystem IO'); }) }));
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  const guarded = Object.fromEntries(Object.entries(original).map(([key, value]) => [key, typeof value === 'function' ? filesystemCall : value]));
  guarded.promises = Object.fromEntries(Object.entries(original.promises).map(([key, value]) => [key, typeof value === 'function' ? filesystemCall : value]));
  return { ...guarded, default: guarded };
});
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const guarded = Object.fromEntries(Object.entries(original).map(([key, value]) => [key, typeof value === 'function' ? filesystemCall : value]));
  return { ...guarded, default: guarded };
});

describe('household backup retention planner', () => {
  it('performs no filesystem IO for successful or refused plans', () => {
    filesystemCall.mockClear();
    expect(plan(['20260101-0300', '20260102-0300', '20260103-0300'], 1)).toEqual({ retain: ['20260101-0300', '20260103-0300'], prune: ['20260102-0300'] });
    expect(() => plan(['20260230-0300'], 1)).toThrow();
    expect(() => plan(['20260101-0300'], 0)).toThrow();
    expect(filesystemCall).not.toHaveBeenCalled();
  });

  it('keeps newest configured nights and each month’s first available night', () => {
    const stamps = ['20251231-0300', '20260102-0300', '20260103-0300', '20260104-0300', '20260202-0300', '20260203-0300', '20260204-0300'];
    expect(plan(stamps, 2)).toEqual({
      retain: ['20251231-0300', '20260102-0300', '20260202-0300', '20260203-0300', '20260204-0300'],
      prune: ['20260103-0300', '20260104-0300'],
    });
  });

  it('keeps the newest try even on a monthly anchor and prunes earlier tries of retained nights', () => {
    expect(plan(['20260102-0100', '20260102-0200', '20260103-0100', '20260104-0100', '20260104-0200'], 1)).toEqual({
      retain: ['20260102-0200', '20260104-0200'],
      prune: ['20260102-0100', '20260103-0100', '20260104-0100'],
    });
  });

  it('counts dates rather than elapsed days or number of tries', () => {
    expect(plan(['20260101-0300', '20260117-0100', '20260117-0200', '20260131-0300'], 2)).toEqual({
      retain: ['20260101-0300', '20260117-0200', '20260131-0300'], prune: ['20260117-0100'],
    });
  });

  it('deduplicates multipart stamps, sorts decisions, and leaves frozen input intact', () => {
    const stamps = Object.freeze(['20260303-0300', '20260302-0300', '20260301-0300', '20260303-0300']);
    const result = plan(stamps, 1);
    expect(result).toEqual({ retain: ['20260301-0300', '20260303-0300'], prune: ['20260302-0300'] });
    result.retain.push('changed');
    expect(stamps).toEqual(['20260303-0300', '20260302-0300', '20260301-0300', '20260303-0300']);
    expect(plan([...stamps].reverse(), 1)).toEqual({ retain: ['20260301-0300', '20260303-0300'], prune: ['20260302-0300'] });
  });

  it('handles empty inventory, a single night, and a keep larger than inventory', () => {
    expect(plan([], 7)).toEqual({ retain: [], prune: [] });
    expect(plan(['20260101-0300'], 90)).toEqual({ retain: ['20260101-0300'], prune: [] });
    expect(plan(['20260101-0300', '20260102-0300'], 90).prune).toEqual([]);
  });

  it('retains the first available night independently in every month across years', () => {
    expect(plan(['20251202-0300', '20251203-0300', '20260102-0300', '20260103-0300', '20260202-0300', '20260203-0300'], 1)).toEqual({
      retain: ['20251202-0300', '20260102-0300', '20260202-0300', '20260203-0300'], prune: ['20251203-0300', '20260103-0300'],
    });
  });

  it.each(['20240229-2359', '20000229-0000', '00010101-0000', '99991231-2359'])('accepts calendar stamp %s without Date normalization', stamp => {
    expect(plan([stamp], 1)).toEqual({ retain: [stamp], prune: [] });
  });

  it.each(['20230229-0300', '19000229-0300', '20260431-0300', '20260001-0300', '20261301-0300', '20260100-0300', '00000101-0300', '20260101-2400', '20260101-0360', '20260101-03000', '20260101-0300\n', '../20260101-0300', '2026-01-01T03:00:00Z', '', 'private-target'])('refuses the whole inventory for invalid stamp %j', stamp => {
    expect(() => plan(['20260101-0300', stamp], 1)).toThrow(/^Invalid household backup retention input$/);
  });

  it.each([0, -1, 91, 1.5, NaN, Infinity])('refuses invalid keep %s', keep => {
    expect(() => plan(['20260101-0300'], keep)).toThrow(/^Invalid household backup retention input$/);
  });

  it('refuses malformed runtime inputs without reflecting their contents', () => {
    for (const inventory of [null, {}, ['private-target', 1], new Array(1), [undefined]]) {
      expect(() => plan(inventory as string[], 1)).toThrow(/^Invalid household backup retention input$/);
    }
    expect(() => plan([], '7' as unknown as number)).toThrow(/^Invalid household backup retention input$/);
  });
});
