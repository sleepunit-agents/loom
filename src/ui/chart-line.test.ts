// A chart in one line over a folded side (web/src/chart-line.tsx, t-1925: Tasks in a narrow window): its series as a
// small picture, bars side by side for a bar chart, scaled to the largest value, a missing value drawn as nothing.
import { describe, expect, it } from 'vitest';
import { sparkOf } from '../../web/src/chart-line';

describe('a chart in one line', () => {
  const series = [{ key: 'opened', label: 'Opened', color: 'pink' as const }, { key: 'done', label: 'Done', color: 'olive' as const }];
  it('a bar chart: each point\'s bars side by side, the tallest 20 px, a small one at least 1 px, a missing one none', () => {
    const s = sparkOf({ kind: 'bar', series, data: [{ label: 'a', opened: 10, done: 1 }, { label: 'b', opened: 0, done: null }] });
    expect(s.bars).toEqual([{ x: 0, h: 20, c: 'var(--v-pink)' }, { x: 4, h: 2, c: 'var(--v-olive)' }, { x: 11, h: 0, c: 'var(--v-pink)' }, { x: 15, h: 0, c: 'var(--v-olive)' }]);
    expect(s.w).toBe(19);
    expect(s.lines).toEqual([]);
  });
  it('a line or an area: one path per series across its width, a gap skipped', () => {
    const s = sparkOf({ kind: 'line', series: [series[0]], data: [{ label: 'a', opened: 0 }, { label: 'b', opened: null }, { label: 'c', opened: 4 }] });
    expect(s.lines).toEqual([{ c: 'var(--v-pink)', d: 'M0 20 L24 0' }]);
  });
});
