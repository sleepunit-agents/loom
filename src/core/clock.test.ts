/** The real clock under a wall clock that is stepped: a deadline is a wall time, and is kept as one. */
import { afterEach, expect, it, vi } from 'vitest';
import { clock, STEP_CHECK_MS } from './clock.js';

afterEach(() => { vi.useRealTimers(); });
const start = Date.parse('2026-11-14T08:00:00Z'), minute = 60_000;

it('runs a deadline when the wall clock reaches it after a forward step, not later by the size of the step', () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  let ranAt: number | undefined;
  clock.at(start + 60 * minute, () => { ranAt = Date.now(); });
  vi.advanceTimersByTime(5 * minute);
  // The host's clock is set forward by 45 minutes (a resume, an unpaused machine, a time correction).
  vi.setSystemTime(start + 50 * minute);
  vi.advanceTimersByTime(10 * minute + STEP_CHECK_MS);
  expect(ranAt).toBeDefined();
  expect(ranAt! - (start + 60 * minute)).toBeGreaterThanOrEqual(0);
  expect(ranAt! - (start + 60 * minute)).toBeLessThanOrEqual(STEP_CHECK_MS);
});

it('runs a deadline the clock was stepped past at the next look', () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const ran = vi.fn();
  clock.at(start + 60 * minute, ran);
  vi.setSystemTime(start + 90 * minute);
  vi.advanceTimersByTime(STEP_CHECK_MS);
  expect(ran).toHaveBeenCalledOnce();
});

it('waits for the wall clock again after a backward step, and runs nothing once cancelled', () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const ran = vi.fn(), cancelled = vi.fn();
  clock.at(start + 10 * minute, ran);
  clock.at(start + 10 * minute, cancelled)();
  vi.advanceTimersByTime(5 * minute);
  vi.setSystemTime(start);
  vi.advanceTimersByTime(9 * minute); expect(ran).not.toHaveBeenCalled();
  vi.advanceTimersByTime(minute + STEP_CHECK_MS); expect(ran).toHaveBeenCalledOnce();
  expect(cancelled).not.toHaveBeenCalled();
});
