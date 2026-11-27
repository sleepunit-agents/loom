/** The board's layout (docs/specs/boards.md, "The page"): rank, fit and area in; a form and a rectangle out.
 * Pure. It reads nothing else, so the same board on the same screen always draws the same way, and nobody,
 * agent or member, ever chooses a rectangle. */

export type Form = 'primary' | 'side' | 'compact';
/** The room a brick can use in one form, in px. */
export interface Fit { min: number; ideal: number; max: number; height: number }
export interface Fits { primary: Fit; side: Fit; compact: Fit }
export interface Placed { id: string; fits: Fits }
export type Slot =
  | { form: Form; x: number; y: number; w: number; h: number }
  /** No room: shown as its chip in the row at the end of the board. */
  | { form: 'folded' };

export const GAP = 14;
/** Below this the board is one column: the primary, and everything else folded. */
export const ONE_COLUMN = 620;

/** `placements` in rank order. Rank 0 is the primary and never folds. The rest go down one side column in
 * rank order: each takes its side form while there is still room for a compact row for every one after it,
 * then its compact form, then folds. */
export function layout(placements: readonly Placed[], area: { w: number; h: number }): Map<string, Slot> {
  const out = new Map<string, Slot>();
  const [first, ...rest] = placements;
  if (!first) return out;
  if (!rest.length || area.w < ONE_COLUMN) {
    // Alone, the primary takes its ideal width, centred. With others on a narrow screen it takes the width.
    const w = rest.length ? area.w : Math.min(area.w, first.fits.primary.max);
    const h = rest.length ? area.h : Math.min(area.h, Math.max(first.fits.primary.height, area.h * 0.7));
    out.set(first.id, { form: 'primary', x: (area.w - w) / 2, y: 0, w, h });
    for (const p of rest) out.set(p.id, { form: 'folded' });
    return out;
  }
  const widest = Math.max(...rest.map((p) => p.fits.side.ideal));
  const sideW = Math.max(Math.min(widest, area.w * 0.38), Math.min(...rest.map((p) => p.fits.side.min)));
  const mainW = Math.min(area.w - sideW - GAP, first.fits.primary.max);
  const x = mainW + GAP, w = Math.min(area.w - x, Math.max(sideW, ...rest.map((p) => p.fits.side.min)));
  out.set(first.id, { form: 'primary', x: 0, y: 0, w: mainW, h: area.h });
  let y = 0;
  rest.forEach((p, i) => {
    const row = (q: Placed) => q.fits.compact.height + GAP;
    const after = rest.slice(i + 1).reduce((sum, q) => sum + row(q), 0);
    const side = p.fits.side.height, compact = p.fits.compact.height;
    if (y + side + (after ? GAP + after - GAP : 0) <= area.h) { out.set(p.id, { form: 'side', x, y, w, h: side }); y += side + GAP; }
    else if (y + compact <= area.h) { out.set(p.id, { form: 'compact', x, y, w, h: compact }); y += compact + GAP; }
    else out.set(p.id, { form: 'folded' });
  });
  return out;
}
