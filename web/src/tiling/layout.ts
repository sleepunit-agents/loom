// The tiling rule (docs/specs/desk-tiling.md, "The rule"): where every tile goes, as a pure function of the tiles in
// their order, what each declares (fit.ts) and the room. It has no state of its own: the same tiles in the same order
// at the same size give the same screen. Which app goes where in the order, and which goes back to the dock when they
// don't all fit, are pure functions here too (place, admit).
//
// No React here, so it's tested on its own (src/ui/desk-tiling-layout.test.ts).
import { WIDGET_FIT, type Fit, type WidgetKind } from './fit';

export const GUTTER = 10;
/** The strip: one key per widget, this wide. */
export const STRIP = 64;
/** Wider than tall by more than this, a region splits side by side; otherwise it's stacked. */
const WIDE = 1.15;

export type Rect = { x: number; y: number; w: number; h: number };
export type AppTile = { id: string; name: string; fit: Fit; /** made the big one (position 0) by the person */ pinned?: boolean };
export type WidgetTile = { id: string; name: string; kind: WidgetKind; /** its height as drawn, when it's been measured */ h?: number };
export type Mode = 'empty' | 'apps' | 'desk' | 'board' | 'rail' | 'strip';
export type Layout = {
  mode: Mode;
  apps: Record<string, Rect>;
  /** Each widget's box: in the rail, the board's columns or the strip. The desktop (no apps) has none: its groups. */
  widgets: Record<string, Rect & { compact?: boolean }>;
  /** The desktop's grouping (no apps): Needs you, the agents, everything else, each a column. */
  groups: string[][];
  /** Widget columns beside the apps (the board's, or 1 for the rail). */
  cols: number;
  appArea: Rect | null;
  widgetArea: Rect | null;
  /** The widgets are taller than the screen even compact: their column scrolls inside itself. */
  scroll: boolean;
  /** Why each thing is the size it is, in plain words (the tiles' reasons). */
  why: string[];
};

/** The rail's width for a screen this wide. */
export const columnWidth = (screen: number): number => (screen >= 1920 ? 340 : screen >= 1440 ? 300 : 280);
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

/** The desktop's groups: Needs you, then the agents, then everything else; each in the order added. */
function groupsOf(ws: WidgetTile[]): WidgetTile[][] {
  return [ws.filter((w) => w.kind === 'needs'), ws.filter((w) => w.kind === 'agent'), ws.filter((w) => w.kind !== 'needs' && w.kind !== 'agent')]
    .filter((g) => g.length);
}

const heightOf = (w: WidgetTile) => w.h ?? WIDGET_FIT[w.kind].ideal[1];
/** A card or Needs you drawn compact (a face, a name and its line; the first ask and "N more"); the rest as they are. */
const compactOf = (w: WidgetTile) => (w.kind === 'agent' || w.kind === 'needs' ? Math.min(heightOf(w), WIDGET_FIT[w.kind].min[1]) : heightOf(w));

/** Widgets stacked down a column: as tall as they are, compact when that's taller than the column, scrolling inside it
 * when even that is. */
function stack(ws: WidgetTile[], col: Rect, out: Layout['widgets']): { compact: boolean; scroll: boolean } {
  const total = (h: (w: WidgetTile) => number) => ws.reduce((s, w) => s + h(w), 0) + GUTTER * Math.max(0, ws.length - 1);
  const compact = total(heightOf) > col.h;
  const h = compact ? compactOf : heightOf;
  let y = col.y;
  for (const w of ws) {
    out[w.id] = { x: col.x, y, w: col.w, h: h(w), ...(compact && h(w) !== heightOf(w) ? { compact: true } : {}) };
    y += h(w) + GUTTER;
  }
  return { compact, scroll: total(h) > col.h };
}

/** The tiles' boxes: apps in `apps` order (position 0 is the big slot), widgets in the order added, in `area` on a
 * screen `screen` px wide. */
export function layout(apps: AppTile[], widgets: WidgetTile[], area: Rect, screen: number): Layout {
  const out: Layout = { mode: 'empty', apps: {}, widgets: {}, groups: [], cols: 0, appArea: null, widgetArea: null, scroll: false, why: [] };
  const cw = columnWidth(screen);
  let A = { ...area };
  if (!apps.length && !widgets.length) return out;
  if (!apps.length) {
    out.mode = 'desk'; out.widgetArea = A; out.groups = groupsOf(widgets).map((g) => g.map((w) => w.id));
    out.why.push('No apps open: the widgets are the desktop, Needs you, the agents, then the rest.');
    return out;
  }
  if (widgets.length) {
    const room = A.w - GUTTER, most = need(apps, 'max'), least = need(apps, 'min');
    const groups = groupsOf(widgets);
    if (room - most >= cw) {
      out.cols = Math.min(3, groups.length, Math.max(1, Math.floor((room - most + GUTTER) / (cw + GUTTER))));
      out.mode = out.cols > 1 ? 'board' : 'rail';
      out.why.push(`The apps use at most ${most} px, so the widgets get ${out.cols} column${out.cols > 1 ? 's' : ''} beside them.`);
    } else if (room - least >= cw) {
      out.mode = 'rail'; out.cols = 1;
      out.why.push(`The widgets stack in a ${cw} px rail on the right; the apps share the rest.`);
    } else {
      out.mode = 'strip'; out.cols = 1;
      out.why.push(`No room for a rail beside these apps: the widgets fold to a ${STRIP} px strip of keys.`);
    }
    const ww = out.mode === 'strip' ? STRIP : out.cols * cw + (out.cols - 1) * GUTTER;
    out.widgetArea = { x: A.x + A.w - ww, y: A.y, w: ww, h: A.h };
    A = { x: A.x, y: A.y, w: A.w - ww - GUTTER, h: A.h };
    if (out.mode === 'strip') {
      widgets.forEach((w, i) => { out.widgets[w.id] = { x: out.widgetArea!.x, y: A.y + i * (STRIP + GUTTER), w: STRIP, h: STRIP }; });
      out.scroll = widgets.length * (STRIP + GUTTER) - GUTTER > A.h;
    } else if (out.mode === 'rail') {
      out.scroll = stack(widgets, out.widgetArea, out.widgets).scroll;
    } else {
      // The board: the desktop's groups, a column each; past the columns there are, the last ones share the last.
      const cols: WidgetTile[][] = groups.slice(0, out.cols - 1);
      cols.push(groups.slice(out.cols - 1).flat());
      cols.forEach((ws, i) => {
        const s = stack(ws, { x: out.widgetArea!.x + i * (cw + GUTTER), y: A.y, w: cw, h: A.h }, out.widgets);
        out.scroll ||= s.scroll;
      });
    }
  } else out.mode = 'apps';
  out.appArea = A;
  const first = apps[0];
  out.why.push(apps.length === 1 ? `1 app: ${first.name} fills the app area.`
    : `${apps.length} apps: ${first.name} has the big slot${first.pinned ? ' (you made it the big one)' : first.fit.big ? ` (it wants room: ${first.fit.why})` : ''}. Each newer one subdivides the newest.`);
  split(apps, A, out, 0);
  return out;
}

/** One fills its region; more: the first beside (or over) the rest, and the rest share what's left the same way. */
function split(ts: AppTile[], R: Rect, out: Layout, depth: number): void {
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
    if (depth < 2) out.why.push(`${a.name} beside ${rest.map((t) => t.name).join(' and ')}: ${Math.round((w0 / inner) * 100)}%, from ideal widths ${ia} and ${ib}.`);
    out.apps[a.id] = { x: R.x, y: R.y, w: w0, h: R.h };
    split(rest, { x: R.x + w0 + GUTTER, y: R.y, w: R.w - w0 - GUTTER, h: R.h }, out, depth + 1);
  } else {
    // Stacked: half each, then neither under its minimum height.
    const restMin = Math.max(...rest.map((t) => t.fit.min[1]));
    const inner = R.h - GUTTER;
    let h0 = Math.round(inner / 2);
    h0 = Math.max(Math.min(h0, inner - restMin), Math.min(a.fit.min[1], inner - restMin));
    if (depth < 3) out.why.push(`${a.name} over ${rest.map((t) => t.name).join(' and ')}: stacked, the region is taller than wide.`);
    out.apps[a.id] = { x: R.x, y: R.y, w: R.w, h: h0 };
    split(rest, { x: R.x, y: R.y + h0 + GUTTER, w: R.w, h: R.h - h0 - GUTTER }, out, depth + 1);
  }
}

/** The first app the layout puts under its minimum, and which way, if any does. */
export function underMinimum(apps: AppTile[], widgets: WidgetTile[], area: Rect, screen: number): { app: AppTile; px: number; edge: 'width' | 'height' } | undefined {
  const l = layout(apps, widgets, area, screen);
  for (const a of apps) {
    const r = l.apps[a.id];
    if (r.w < a.fit.min[0] - 0.5) return { app: a, px: a.fit.min[0], edge: 'width' };
    if (r.h < a.fit.min[1] - 0.5) return { app: a, px: a.fit.min[1], edge: 'height' };
  }
  return undefined;
}

/** Where a new app goes in the order. Opened from another app's tile: right after it. From a widget: last, next to the
 * rail. Wanting the big slot, while the app there doesn't and the person didn't make it the big one: first. Else
 * last, so it subdivides the newest. */
export function place(apps: AppTile[], add: AppTile, from?: { tile?: string; widget?: boolean }): AppTile[] {
  const at = from?.tile ? apps.findIndex((a) => a.id === from.tile) : -1;
  if (at >= 0) return [...apps.slice(0, at + 1), add, ...apps.slice(at + 1)];
  if (!from?.widget && add.fit.big && apps[0] && !apps[0].fit.big && !apps[0].pinned) return [add, ...apps];
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
export function admit(apps: AppTile[], add: AppTile, widgets: WidgetTile[], area: Rect, screen: number,
  o: { from?: { tile?: string; widget?: boolean }; usedAt?: Record<string, number> } = {}): { apps: AppTile[]; docked: Docked[] } {
  let order = place(apps.filter((a) => a.id !== add.id), add, o.from);
  const docked: Docked[] = [];
  const cap = capFor(screen);
  for (;;) {
    const over = order.length > cap;
    const under = over ? undefined : underMinimum(order, widgets, area, screen);
    if (!over && !under) break;
    const may = order.filter((a) => a.id !== add.id && a.id !== o.from?.tile && !a.pinned);
    if (!may.length) break;
    const used = (a: AppTile) => o.usedAt?.[a.id] ?? 0;
    const go = may.reduce((x, y) => (used(y) < used(x) ? y : x));
    const why = over ? `${cap} apps is the most this screen holds`
      : `${under!.app.id === go.id ? 'it' : under!.app.name} would have been under ${under!.app.id === go.id ? 'its' : 'its own'} ${under!.px} px minimum${under!.edge === 'height' ? ' height' : ''}`;
    docked.push({ app: go, why: `${go.name} went to the dock to make room for ${add.name}: ${why}` });
    order = order.filter((a) => a.id !== go.id);
  }
  return { apps: order, docked };
}
