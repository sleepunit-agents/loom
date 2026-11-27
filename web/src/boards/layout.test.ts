import { describe, expect, it } from 'vitest';
import { GAP, layout, type Fits, type Placed, type Slot } from './layout';

const fits = (side = 200): Fits => ({
  primary: { min: 460, ideal: 720, max: 900, height: 420 },
  side: { min: 260, ideal: 360, max: 420, height: side },
  compact: { min: 220, ideal: 320, max: 420, height: 44 },
});
const board = (n: number, side?: number): Placed[] => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, fits: fits(side) }));
const wide = { w: 1100, h: 800 };
const rect = (s: Slot | undefined) => { if (!s || s.form === 'folded') throw new Error('not placed'); return s; };

describe('the board layout', () => {
  it('is empty for an empty board', () => { expect(layout([], wide).size).toBe(0); });

  it('centres a lone primary at no more than its widest', () => {
    const only = rect(layout(board(1), wide).get('p0'));
    expect(only.form).toBe('primary');
    expect(only.w).toBe(900);
    expect(only.x).toBe(100);
  });

  it('gives rank 0 the primary form and the rest a side column in rank order', () => {
    const out = layout(board(3), wide), [a, b, c] = ['p0', 'p1', 'p2'].map((id) => rect(out.get(id)));
    expect([a.form, b.form, c.form]).toEqual(['primary', 'side', 'side']);
    expect(b.x).toBe(a.w + GAP);
    expect(c.y).toBe(b.y + b.h + GAP);
    expect(b.x + b.w).toBeLessThanOrEqual(wide.w);
    expect(a.h).toBe(wide.h);
  });

  it('turns later placements compact, then folds them, and never folds the primary', () => {
    const out = layout(board(9, 300), { w: 1100, h: 700 });
    const forms = [...out.values()].map((s) => s.form);
    expect(forms[0]).toBe('primary');
    expect(forms.indexOf('compact')).toBeGreaterThan(forms.indexOf('side'));
    expect(forms.lastIndexOf('side')).toBeLessThan(forms.indexOf('compact'));
    // Everything placed is inside the area and nothing overlaps in the column.
    const column = [...out.values()].slice(1).filter((s): s is Exclude<Slot, { form: 'folded' }> => s.form !== 'folded');
    column.forEach((s, i) => { expect(s.y + s.h).toBeLessThanOrEqual(700); if (i) expect(s.y).toBeGreaterThanOrEqual(column[i - 1].y + column[i - 1].h + GAP); });
    const tall = layout(board(40, 300), { w: 1100, h: 400 });
    expect(tall.get('p0')!.form).toBe('primary');
    expect([...tall.values()].some((s) => s.form === 'folded')).toBe(true);
  });

  it('is one column below 620px: the primary takes the width and the rest fold', () => {
    const out = layout(board(4), { w: 390, h: 600 });
    expect(rect(out.get('p0'))).toMatchObject({ form: 'primary', x: 0, w: 390, h: 600 });
    expect(['p1', 'p2', 'p3'].map((id) => out.get(id)!.form)).toEqual(['folded', 'folded', 'folded']);
  });

  it('gives the same answer for the same input, and depends on nothing but rank, fit and area', () => {
    const a = layout(board(5), wide), b = layout(board(5), wide);
    expect([...a]).toEqual([...b]);
    const renamed = layout(board(5).map((p, i) => ({ ...p, id: 'x' + i })), wide);
    expect([...renamed.values()]).toEqual([...a.values()]);
  });
});
