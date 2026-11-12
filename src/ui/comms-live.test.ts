import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeriodicOwner } from '../transport/periodic-owner.js';
import { withLog } from '../collections/log.js';
import { changedFor } from './live.js';
import { afterEach, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ COMMS_DB: 'comms.db', movedSince: vi.fn((_home: string, _since: number): Array<{ id: string; member: string; updated: number }> => []), seqsOf: vi.fn(), threadState: vi.fn(), onBump: vi.fn(() => () => {}) }));
vi.mock('../comms.js', () => reads);
vi.mock('./live.js', () => ({ changedFor: vi.fn() }));
import { stopCommsWatch, watchComms } from './comms-live.js';

afterEach(() => { stopCommsWatch(); vi.useRealTimers(); vi.restoreAllMocks(); });

// SQLITE_BUSY_RECOVERY is busy too: a WAL recovery in another connection (the deploy that refused Comms posts).
it.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_RECOVERY'])('retries %s on the next poll without terminating the listener', async (code) => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  reads.movedSince.mockClear();
  reads.movedSince.mockImplementationOnce(() => { throw Object.assign(new Error('database is locked'), { code }); });
  watchComms('/missing-comms-busy-test');
  await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
  expect(reads.movedSince).toHaveBeenCalledTimes(1);
  const since = reads.movedSince.mock.calls[0];
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads.movedSince).toHaveBeenCalledTimes(2);
  expect(reads.movedSince.mock.calls[1]).toEqual(since);
});

it('reports unexpected polling failures without terminating the listener', async () => {
  vi.useFakeTimers();
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  reads.movedSince.mockImplementationOnce(() => { throw new Error('unexpected'); });
  watchComms('/missing-comms-bug-test');
  await vi.advanceTimersByTimeAsync(2000);
  expect(report).toHaveBeenCalledWith(expect.stringContaining('Comms live update failed'), expect.objectContaining({ message: 'unexpected' }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads.movedSince.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('names the actual Comms timer continuation after its async database probe', async () => {
  const { watchStalls } = await import('../transport/stall-watch.js');
  const lines: string[] = [];
  const w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  reads.movedSince.mockImplementationOnce(() => {
    const end = performance.now() + 220;
    while (performance.now() < end) { /* the real tick's work, after its awaited probe */ }
    return [];
  });
  try {
    watchComms('/missing-comms-attribution');
    await expect.poll(() => lines.some((l) => /slowest: comms live tick 2\d\d ms/.test(l))).toBe(true);
  } finally { w.stop(); }
});

it('followers read shared member markers without scanning Comms, then scan on ownership takeover', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-owner-'));
  const owner = new PeriodicOwner(home, () => undefined);
  reads.movedSince.mockReset();
  vi.mocked(changedFor).mockClear();
  watchComms(home, () => owner);
  try {
    withLog(home, db => db.prepare('INSERT INTO comms_member_moves(member) VALUES (?)').run('jonathan'));
    await expect.poll(() => vi.mocked(changedFor).mock.calls).toContainEqual(['jonathan', false]);
    expect(reads.movedSince).not.toHaveBeenCalled();
    reads.movedSince.mockReturnValueOnce([{ id: 'thread', member: 'jonathan', updated: Date.now() + 10 }]);
    owner.setEligible(true);
    await expect.poll(() => vi.mocked(changedFor).mock.calls).toContainEqual(['jonathan', true]);
    expect(reads.movedSince).toHaveBeenCalledTimes(1);
  } finally { stopCommsWatch(); await owner.close(); rmSync(home, { recursive: true, force: true }); }
}, 15_000);

it('multiple listener registrations keep the active Comms owner and dispose independently', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-registrations-'));
  const owner = new PeriodicOwner(home, () => {}), follower = new PeriodicOwner(home, () => {});
  owner.setEligible(true); reads.movedSince.mockReset(); reads.movedSince.mockReturnValue([]);
  const first = watchComms(home, () => owner), second = watchComms(home, () => follower);
  try {
    await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(0);
    second(); const before = reads.movedSince.mock.calls.length;
    await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(before);
  } finally { first(); second(); await owner.close(); await follower.close(); rmSync(home, { recursive: true, force: true }); }
}, 15_000);
