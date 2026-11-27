import { describe, expect, it } from 'vitest';
import { perDay, since } from './trend';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const row = (id: string, time: number) => ({ id, title: id, at: new Date(time).toISOString() });

describe('the trend brick', () => {
  it('starts at the first moment of the first day, so the last day is today', () => {
    expect(since(at(2026, 11, 27, 9), 7)).toBe(new Date(2026, 10, 21).getTime());
  });
  it('gives one entry per day, oldest first, and puts each ticket on its own day', () => {
    const now = at(2026, 11, 27, 9);
    const days = perDay([row('t-1', at(2026, 11, 27, 1)), row('t-2', at(2026, 11, 21, 23)), row('t-0', at(2026, 11, 20))], [row('t-2', at(2026, 11, 25))], 7, now);
    expect(days.map((d) => d.date)).toEqual(['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
    expect(days.map((d) => d.opened.length)).toEqual([1, 0, 0, 0, 0, 0, 1]);
    expect(days.map((d) => d.closed.length)).toEqual([0, 0, 0, 0, 1, 0, 0]);
  });
});
