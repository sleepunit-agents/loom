// The tiling rule (docs/specs/desk-tiling.md, "The rule"): where every app tile goes, as a pure function of the tiles in
// their order, what each declares (fit.ts) and the room. It has no state of its own: the same tiles in the same order
// at the same size give the same screen. Which app goes where in the order, and which goes back to the dock when they
// don't all fit, are pure functions here too (place, admit). The agents' rail beside the apps (docs/specs/agent-desk.md)
// isn't the rule's: the desktop takes its width off the area first (railWidth).
//
// No React here, so it's tested on its own (src/ui/desk-tiling-layout.test.ts).
import type { Fit } from './fit';

export const GUTTER = 10;
/** Wider than tall by more than this, a region splits side by side; otherwise it's stacked. */
const WIDE = 1.15;

export type Rect = { x: number; y: number; w: number; h: number };
export type AppTile = { id: string; name: string; fit: Fit; /** made the big one (position 0) by the person */ pinned?: boolean };
export type Mode = 'empty' | 'apps';
export type Layout = {
  mode: Mode;
  apps: Record<string, Rect>;
  appArea: Rect | null;
  /** Why each thing is the size it is, in plain words (the tiles' reasons). */
  why: string[];
};

/** The agents' rail beside the apps, a fixed width for a screen this wide (docs/specs/agent-desk.md, "Work"); none under
 * 1280 px, where two apps need the room. */
export const railWidth = (screen: number): number => (screen >= 1440 ? 320 : screen >= 1280 ? 296 : 0);
/** The most apps on screen at once for a screen this wide. */
export const capFor = (screen: number): number => (screen >= 2560 ? 6 : screen >= 1600 ? 4 : screen >= 1280 ? 3 : 2);

type Edge = 'min' | 'ideal' | 'max';
const widthOf = (a: AppTile, k: Edge): number => (k === 'min' ? a.fit.min[0] : k === 'ideal' ? a.fit.ideal : a.fit.max ?? Infinity);
/** The width a run of apps needs, split as the rule splits them: the first beside the rest, then over the rest, and so on. */
function need(ts: AppTile[], k: Edge, side = true): number {
  if (!ts.length) return 0;
  if (ts.length === 1) return widthOf(ts[0], k);
  return side ? widthOf(ts[0], k) + GUTTER + need(ts.slice(1), k, false) : Math.max(widthOf(ts[0], k), need(ts.slice(1), k, true));
}

/** The tiles' boxes: apps in `apps` order (position 0 is the big slot) in `area`, on a screen `screen` px wide. */
export function layout(apps: AppTile[], area: Rect, screen: number): Layout {
  void screen;
  const out: Layout = { mode: 'empty', apps: {}, appArea: null, why: [] };
  if (!apps.length) return out;
  out.mode = 'apps';
  const A = { ...area };
  out.appArea = A;
  const first = apps[0];
  out.why.push(apps.length === 1 ? `1 app: ${first.name} fills the app area.`
    : `${apps.length} apps: ${first.name} has the big slot${first.pinned ? ' (you made it the big one)' : first.fit.big ? ` (it wants room: ${first.fit.why})` : ''}. Each newer one subdivides the newest.`);
  split(apps, A, out);
  return out;
}

/** One fills its region; more: the first beside (or over) the rest, and the rest share what's left the same way. */
function split(ts: AppTile[], R: Rect, out: Layout): void {
  if (ts.length === 1) { out.apps[ts[0].id] = { ...R }; return; }
  const [a, ...rest] = ts;
  if (R.w > R.h * WIDE) {
    // Side by side, by their ideal widths, clamped to a third and two thirds; a max stops the first, and minimums win.
    const ia = a.fit.ideal, ib = Math.max(...rest.map((t) => t.fit.ideal));
    const share = Math.min(0.66, Math.max(0.34, ia / (ia + ib)));
    const inner = R.w - GUTTER;
    let w0 = Math.round(inner * share);
    const restMin = need(rest, 'min', false), restMax = need(rest, 'max', false);
    if (a.fit.max != null && restMax === Infinity) w0 = Math.min(w0, a.fit.max);
    if (a.fit.max == null && restMax !== Infinity) w0 = Math.max(w0, inner - restMax);
    w0 = Math.max(Math.min(w0, inner - restMin), Math.min(a.fit.min[0], inner - restMin));
    out.why.push(`${a.name} beside ${rest.map((t) => t.name).join(' and ')}: ${Math.round((w0 / inner) * 100)}%, from ideal widths ${ia} and ${ib}.`);
    out.apps[a.id] = { x: R.x, y: R.y, w: w0, h: R.h };
    split(rest, { x: R.x + w0 + GUTTER, y: R.y, w: R.w - w0 - GUTTER, h: R.h }, out);
  } else {
    // Stacked: half each, then neither under its minimum height.
    const restMin = Math.max(...rest.map((t) => t.fit.min[1]));
    const inner = R.h - GUTTER;
    let h0 = Math.round(inner / 2);
    h0 = Math.max(Math.min(h0, inner - restMin), Math.min(a.fit.min[1], inner - restMin));
    out.why.push(`${a.name} over ${rest.map((t) => t.name).join(' and ')}: stacked, the region is taller than wide.`);
    out.apps[a.id] = { x: R.x, y: R.y, w: R.w, h: h0 };
    split(rest, { x: R.x, y: R.y + h0 + GUTTER, w: R.w, h: R.h - h0 - GUTTER }, out);
  }
}

/** The first app the layout puts under its minimum, and which way, if any does. */
export function underMinimum(apps: AppTile[], area: Rect, screen: number): { app: AppTile; px: number; edge: 'width' | 'height' } | undefined {
  const l = layout(apps, area, screen);
  for (const a of apps) {
    const r = l.apps[a.id];
    if (r.w < a.fit.min[0] - 0.5) return { app: a, px: a.fit.min[0], edge: 'width' };
    if (r.h < a.fit.min[1] - 0.5) return { app: a, px: a.fit.min[1], edge: 'height' };
  }
  return undefined;
}

/** Where a new app goes in the order. Opened from another app's tile: right after it. From the agents' rail or Home:
 * last, next to the rail. Wanting the big slot, while the app there doesn't and the person didn't make it the big one: first. Else
 * last, so it subdivides the newest. */
export function place(apps: AppTile[], add: AppTile, from?: { tile?: string; rail?: boolean }): AppTile[] {
  const at = from?.tile ? apps.findIndex((a) => a.id === from.tile) : -1;
  if (at >= 0) return [...apps.slice(0, at + 1), add, ...apps.slice(at + 1)];
  if (!from?.rail && add.fit.big && apps[0] && !apps[0].fit.big && !apps[0].pinned) return [add, ...apps];
  return [...apps, add];
}

/** Make this the big one: first, and pinned there (the only one pinned). */
export function promote(apps: AppTile[], id: string): AppTile[] {
  const a = apps.find((t) => t.id === id);
  if (!a) return apps;
  return [{ ...a, pinned: true }, ...apps.filter((t) => t.id !== id).map((t) => (t.pinned ? { ...t, pinned: false } : t))];
}

/** Swap two tiles' places; a pinned tile swapped out of the big slot isn't pinned any more. */
export function swap(apps: AppTile[], i: number, j: number): AppTile[] {
  if (i === j || !apps[i] || !apps[j]) return apps;
  const next = [...apps];
  [next[i], next[j]] = [next[j], next[i]];
  return next.map((t, n) => (t.pinned && n !== 0 ? { ...t, pinned: false } : t));
}

export type Docked = { app: AppTile; why: string };

/**
 * Open `add` among `apps`: it goes where `place` says, then, while there are more than the screen's cap or the layout
 * would put any app under its minimum, the app used least recently (`usedAt`, by focus; never the one being opened,
 * never the one it was opened from, never a pinned one; a tie goes to the one earlier in the order) goes to the dock.
 * When no app may go, what's left stays, each at what the split gives it.
 */
export function admit(apps: AppTile[], add: AppTile, area: Rect, screen: number,
  o: { from?: { tile?: string; rail?: boolean }; usedAt?: Record<string, number> } = {}): { apps: AppTile[]; docked: Docked[] } {
  let order = place(apps.filter((a) => a.id !== add.id), add, o.from);
  const docked: Docked[] = [];
  const cap = capFor(screen);
  for (;;) {
    const over = order.length > cap;
    const under = over ? undefined : underMinimum(order, area, screen);
    if (!over && !under) break;
    const may = order.filter((a) => a.id !== add.id && a.id !== o.from?.tile && !a.pinned);
    if (!may.length) break;
    const used = (a: AppTile) => o.usedAt?.[a.id] ?? 0;
    const go = may.reduce((x, y) => (used(y) < used(x) ? y : x));
    const why = over ? `${cap} apps is the most this screen holds`
      : `${under!.app.id === go.id ? 'it' : under!.app.name} would have been under its ${under!.px} px minimum${under!.edge === 'height' ? ' height' : ''}`;
    docked.push({ app: go, why: `${go.name} went to the dock to make room for ${add.name}: ${why}` });
    order = order.filter((a) => a.id !== go.id);
  }
  return { apps: order, docked };
}
