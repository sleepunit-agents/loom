/** The board's layout (docs/specs/boards.md, "The page"): rank, fit and area in; a form and a rectangle out.
 * Pure. It reads nothing else, so the same board on the same screen always draws the same way, and nobody,
 * agent or member, ever chooses a rectangle. */

export type Form = 'primary' | 'side' | 'compact';
/** The room a brick can use in one form, in px. */
export interface Fit { min: number; ideal: number; max: number; height: number }
export interface Fits { primary: Fit; side: Fit; compact: Fit }
/** `big` marks the one placement drawn in the primary form: the server says which, from rank and brick. */
export interface Placed { id: string; fits: Fits; big?: boolean }
export type Slot =
  | { form: Form; x: number; y: number; w: number; h: number }
  /** No room: shown as its chip in the row at the end of the board. */
  | { form: 'folded' };

export const GAP = 14;
/** Below this the board is one column: the primary, and everything else folded. */
export const ONE_COLUMN = 620;

/** A column of small placements in rank order: each takes its side form while there is still room for a
 * compact row for every one after it, then its compact form, then folds. */
function column(out: Map<string, Slot>, list: readonly Placed[], x: number, w: number, h: number) {
  let y = 0;
  list.forEach((p, i) => {
    const after = list.slice(i + 1).reduce((sum, q) => sum + q.fits.compact.height + GAP, 0);
    const side = p.fits.side.height, compact = p.fits.compact.height;
    if (y + side + after <= h) { out.set(p.id, { form: 'side', x, y, w, h: side }); y += side + GAP; }
    else if (y + compact <= h) { out.set(p.id, { form: 'compact', x, y, w, h: compact }); y += compact + GAP; }
    else out.set(p.id, { form: 'folded' });
  });
}

/** `placements` in rank order. The big one takes the primary form and never folds. The rest go down one side
 * column in rank order. A board with no big placement is columns of small ones. */
export function layout(placements: readonly Placed[], area: { w: number; h: number }): Map<string, Slot> {
  const out = new Map<string, Slot>();
  if (!placements.length) return out;
  const first = placements.find((p) => p.big);
  if (!first) {
    // No brick here can be big: as many equal columns as fit, filled in rank order.
    const colW = Math.min(area.w, Math.max(...placements.map((p) => p.fits.side.ideal)));
    const cols = area.w < ONE_COLUMN ? 1 : Math.max(1, Math.min(placements.length, Math.floor((area.w + GAP) / (colW + GAP))));
    const w = cols === 1 ? Math.min(area.w, colW) : colW, left = (area.w - (cols * w + (cols - 1) * GAP)) / 2;
    for (let c = 0; c < cols; c++) column(out, placements.filter((_, i) => i % cols === c), left + c * (w + GAP), w, area.h);
    return out;
  }
  const rest = placements.filter((p) => p !== first);
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
  column(out, rest, x, w, area.h);
  return out;
}
