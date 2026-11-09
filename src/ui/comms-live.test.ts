import { afterEach, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ movedSince: vi.fn((_home: string, _since: number) => []), seqsOf: vi.fn(), threadState: vi.fn(), onBump: vi.fn(() => () => {}) }));
vi.mock('../comms.js', () => reads);
vi.mock('./live.js', () => ({ changedFor: vi.fn() }));
import { stopCommsWatch, watchComms } from './comms-live.js';

afterEach(() => { stopCommsWatch(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['SQLITE_BUSY', 'SQLITE_LOCKED'])('retries %s on the next poll without terminating the listener', (code) => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  reads.movedSince.mockClear();
  reads.movedSince.mockImplementationOnce(() => { throw Object.assign(new Error('database is locked'), { code }); });
  watchComms('/missing-comms-busy-test');
  expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  expect(reads.movedSince).toHaveBeenCalledTimes(1);
  const since = reads.movedSince.mock.calls[0];
  vi.advanceTimersByTime(2000);
  expect(reads.movedSince).toHaveBeenCalledTimes(2);
  expect(reads.movedSince.mock.calls[1]).toEqual(since);
});

it('does not hide unexpected polling failures', () => {
  vi.useFakeTimers();
  reads.movedSince.mockImplementationOnce(() => { throw new Error('unexpected'); });
  watchComms('/missing-comms-bug-test');
  expect(() => vi.advanceTimersByTime(2000)).toThrow('unexpected');
});
