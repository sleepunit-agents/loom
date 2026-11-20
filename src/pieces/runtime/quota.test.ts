import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { mergeUsage, hasRoom, roomAt, nextQuotaHold, HOLD_MAX_S } from './quota.js';

let clock: FakeClock;
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(async () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-quota-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  clock = new FakeClock(1_800_000_000_000);
  const app = await startLoom({ home, clock, next: true, sharing: fixtureSharing });
  cleanup.push(app.close);
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const seconds = () => Math.floor(clock.now() / 1000);

it('merges one quota per window across box and house readings, leaving unread copies neutral', () => {
  const s = seconds();
  const readings = [
    { windows: { '7d': 0.2, '5h': 0.4 }, checked: s - 100 },
    undefined,
    { windows: { '7d': 0.99 }, resets: { '7d': s + 9000 }, checked: s - 10 },
  ];
  const usage = mergeUsage(readings);
  expect(usage).toEqual({ '7d': 0.99, '5h': 0.4, reset_7d: s + 9000, checked: s - 10 });
  expect(hasRoom(usage, undefined, clock.now())).toBe(false);
  const reset = mergeUsage([...readings, { windows: { '7d': 0.05 }, checked: s }]);
  expect(reset['7d']).toBe(0.05);
  expect(hasRoom(reset, undefined, clock.now())).toBe(true);
});
it('chooses fuller equal-time readings and retains a future reset regardless of source order', () => {
  const s = seconds();
  const old = { windows: { '7d': 0.9 }, resets: { '7d': s + 100 }, checked: s - 20 };
  const newer = { windows: { '7d': 0.99 }, checked: s - 10 };
  const tie = { windows: { '7d': 0.8 }, checked: s - 10 };
  for (const readings of [[old, newer, tie], [tie, newer, old], [newer, old, tie]]) {
    const u = mergeUsage(readings);
    expect(u).toEqual({ '7d': 0.99, reset_7d: s + 100, checked: s - 10 });
    expect(roomAt(u, undefined, clock.now())).toBe(s + 100);
  }
  expect(mergeUsage([{ ...old, resets: { '7d': s - 11 } }, newer]).reset_7d).toBeUndefined();
});
it('has room at reset and hold boundaries, with the latest known blocker determining roomAt', () => {
  const s = seconds();
  const usage = { '7d': 0.99, reset_7d: s + 3600, '5h': 1, reset_5h: s + 200, held: s + 600 };
  expect(roomAt(usage, undefined, clock.now())).toBe(s + 3600);
  clock.advance(3_600_000);
  expect(hasRoom(usage, undefined, clock.now())).toBe(true);
  expect(roomAt(usage, undefined, clock.now())).toBeNull();
  expect(hasRoom({ '7d': 0.2, held: seconds() + 1 }, undefined, clock.now())).toBe(false);
  clock.advance(1000);
  expect(hasRoom({ '7d': 0.2, held: seconds() }, undefined, clock.now())).toBe(true);
});
it('uses the 97 percent boundary, model windows only when requested, and unknown reset remains unknown', () => {
  expect(hasRoom({}, undefined, clock.now())).toBe(true);
  expect(hasRoom({ '7d': 0.9699 }, undefined, clock.now())).toBe(true);
  expect(hasRoom({ '7d': 0.97 }, undefined, clock.now())).toBe(false);
  expect(roomAt({ '7d': 0.97, held: seconds() + 10 }, undefined, clock.now())).toBeNull();
  const u = { '7d': 0.2, '7d_opus': 0.99, reset_7d_opus: seconds() + 100 };
  expect(hasRoom(u, undefined, clock.now())).toBe(true);
  expect(hasRoom(u, '7d_opus', clock.now())).toBe(false);
  expect(roomAt(u, '7d_opus', clock.now())).toBe(seconds() + 100);
  expect(hasRoom(u, '5h', clock.now())).toBe(true);
  expect(hasRoom({ '7d': null }, undefined, clock.now())).toBe(false);
  expect(hasRoom({ '7d': Number.NaN }, undefined, clock.now())).toBe(false);
});
it('ignores unrelated fields, retains epoch readings, and never mutates inputs', () => {
  const reading = Object.freeze({ windows: Object.freeze({ '7d': 0.8, nonsense: 1 }), checked: 0 });
  expect(mergeUsage([reading])).toEqual({ '7d': 0.8, checked: 0 });
  expect(hasRoom({ checked: 0, plan: 'pro' }, undefined, 0)).toBe(true);
  expect(hasRoom({ '7d': 1, reset_7d: 0 }, undefined, 0)).toBe(true);
});
it('backs off blind refusals from 30 minutes, resets the streak on a known reset, and never shortens a live hold', () => {
  const s = seconds();
  const first = nextQuotaHold(undefined, {}, clock.now());
  expect(first).toEqual({ until: s + 1800, at: s, blind: 0 });
  clock.advance(1_801_000);
  const second = nextQuotaHold(first, {}, clock.now());
  expect(second).toEqual({ until: seconds() + 3600, at: seconds(), blind: 1 });
  clock.advance(3_601_000);
  const third = nextQuotaHold(second, {}, clock.now());
  expect(third.until).toBe(seconds() + 7200);
  expect(third.blind).toBe(2);
  const known = nextQuotaHold(third, { until: seconds() + 100, why: 'x'.repeat(250) }, clock.now());
  expect(known).toEqual({ until: third.until, at: seconds(), why: 'x'.repeat(200) });
  expect(nextQuotaHold(known, {}, clock.now()).blind).toBe(1);
});
it('caps holds at eight days and starts a fresh streak after a day without a refusal', () => {
  expect(nextQuotaHold(undefined, { until: seconds() + 99 * 86400 }, clock.now()).until).toBe(seconds() + HOLD_MAX_S);
  const old = { until: seconds() + 100, at: seconds() - 86400, blind: 10 };
  expect(nextQuotaHold(old, {}, clock.now())).toEqual({ until: seconds() + 1800, at: seconds(), blind: 0 });
  expect(nextQuotaHold({ ...old, at: seconds() }, {}, clock.now()).until).toBe(seconds() + HOLD_MAX_S);
  for (const until of [seconds(), seconds() - 1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(nextQuotaHold(undefined, { until }, clock.now()).until).toBe(seconds() + 1800);
});
