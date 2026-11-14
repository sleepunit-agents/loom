import { expect, it } from 'vitest';
import { accountCapacity, type QuotaWindow } from './quota.js';

const start = Date.parse('2026-11-14T00:00:00.000Z');
const hour = 3_600_000;
const at = (hours: number) => new Date(start + hours * hour).toISOString();
function window(usage: number, elapsed = 5, duration = 10): QuotaWindow {
  return { name: 'ten-hour', usage, readAt: at(elapsed), resetsAt: at(duration), durationMs: duration * hour };
}

it('combines windows of the actual account, with the tightest window limiting every agent', () => {
  const windows = [window(0.4), { ...window(0.96), name: 'week' }];
  const shared = accountCapacity(windows, at(5));
  expect(shared.hasRoom).toBe(false);
  expect(shared.level).toBe('almost full');
  expect(shared.windows[1]).toMatchObject({ hasRoom: false, reserveLent: false });
  expect(accountCapacity([window(0.4)], at(5))).toMatchObject({ hasRoom: true, level: 'plenty' });
  expect(accountCapacity([window(0.7)], at(5)).level).toBe('getting full');
});

it('lends the reserve near reset only when the observed rate predicts remaining capacity', () => {
  expect(accountCapacity([window(0.96, 9.8)], at(9.8))).toMatchObject({
    hasRoom: true, windows: [{ reserveLent: true, forecast: expect.closeTo(0.96 / 0.98) }],
  });
  expect(accountCapacity([window(0.96, 9.1)], at(9.1))).toMatchObject({
    hasRoom: false, windows: [{ reserveLent: false }],
  });
  expect(accountCapacity([window(0.95, 9.8)], at(9.8)).hasRoom).toBe(true);
  expect(accountCapacity([window(0.95, 8.9)], at(8.9)).hasRoom).toBe(false);
  expect(accountCapacity([window(1, 9.9)], at(9.9)).hasRoom).toBe(false);
});

it('accounts for time since observation, without inventing a fresh allowance at reset', () => {
  expect(accountCapacity([window(0.9, 9)], at(9.8))).toMatchObject({
    hasRoom: false, windows: [{ estimatedUsage: expect.closeTo(0.98), forecast: 1 }],
  });
  expect(accountCapacity([window(0.96, 9.8)], at(10))).toMatchObject({ hasRoom: false, level: 'almost full' });
  expect(accountCapacity([window(0.1, 6)], at(5)).hasRoom).toBe(false);
  expect(accountCapacity([], at(5))).toMatchObject({ hasRoom: false, level: 'almost full' });
  expect(accountCapacity([{ ...window(0.1), usage: null, readAt: null }], at(5)).hasRoom).toBe(false);
});

it('uses configured reserves and leaves observations unchanged', () => {
  const windows = [Object.freeze({ ...window(0.91), reserve: 0.1 })];
  expect(accountCapacity(Object.freeze(windows), at(5)).hasRoom).toBe(false);
  expect(accountCapacity([{ ...window(0.99), reserve: 0 }], at(5)).hasRoom).toBe(true);
  expect(windows[0].usage).toBe(0.91);
  expect(accountCapacity([window(0, 0)], at(0)).hasRoom).toBe(true);
});

it('rejects invalid time, usage and window configuration', () => {
  for (const bad of [
    { durationMs: 0 }, { durationMs: Infinity }, { usage: -1 }, { usage: NaN },
    { reserve: 1.1 }, { reserve: -0.1 }, { reserve: NaN }, { resetsAt: 'no' },
    { readAt: 'no' }, { readAt: at(-1) }, { name: '' },
  ]) expect(() => accountCapacity([{ ...window(0.1), ...bad }], at(5))).toThrow();
  expect(() => accountCapacity([window(0.1)], 'no')).toThrow();
  // Some providers report usage beyond the nominal allowance; it stays exhausted.
  expect(accountCapacity([window(1.1)], at(5)).hasRoom).toBe(false);
});
it('does not lend reserve when an exact full-window forecast rounds below one', () => {
  expect(accountCapacity([window(0.5, 1, 2)], at(1 + 59 / 60))).toMatchObject({
    hasRoom: false, windows: [{ reserveLent: false }],
  });
});
