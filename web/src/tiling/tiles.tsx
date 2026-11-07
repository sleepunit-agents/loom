// The tiled desktop (docs/specs/desk-tiling.md): apps share the screen by the rule (layout.ts), each in a tile with its
// own page (page.ts usePage), its own history (trail.ts, keyed as the window's was) and its own frame. Opening an app
// adds a tile, or focuses it if it's open, or brings it back if it's in the dock; the focused app's own key minimizes
// it; Home sends every app to the dock and shows the desktop, and Home again brings them back. The address is the
// focused tile's page with the set in its query (address.ts); this device keeps its last set for a bare `/`.
//
// Home's widgets are tiles too (phase 4): with no app open they are the desktop, laid out as Home is; with apps open
// they move to the right edge, in columns, a rail or the strip, as the rule says (layout.ts rule 1). A widget is live
// (it draws from Home's own page, which the live stream keeps current), its × removes it, and what it links to opens
// beside it, last, next to the rail. The desktop's menu (a right-click on it, menu.tsx) and Find add them; an agent's window shrinks back into its card, the Inbox into Needs you.
//
// The only desktop there is (App.tsx; Jonathan, 2026-11-06). Accessibility's One window at a time is this desktop with
// one app tile at most: opening another sends the one there to the dock, as the rule sends one that doesn't fit. A fresh
// device starts with the widgets in widgets.ts SEED. Loaded with the desk's own chunk (desk.tsx), at 1024 px and wider
// only: a phone never fetches it.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { PortalContainer } from '@/components/ui/portal-container';
import { reducedMotion } from '../access';
import { EnvContext, type Env } from '../blocks';
import type { Shell } from '../loom';
import { noteRecent, readRecent } from '../recent';
import { StripKey, WidgetBody, WidgetDesk, type DeskHomeData, type WidgetData } from '../desk-widgets';
import { addable, freshSet, pairOf, widgetOfApp, widgetRef, type WidgetRef } from './widgets';
import { WidgetOpsContext, morph, type WidgetOps } from './morph';
import { markColor } from '../look';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { ahead, hasKept, keepAhead, usePage, type Answer, type PageNav, type PageState } from '../page';
import { fetchView } from '../loom';
import * as trail from '../trail';
import { iconFor } from '../safe';
import type { Note } from '../toasts';
import { admit, capFor, layout, promote, swap, underMinimum, type AppTile, type Rect, type WidgetTile } from './layout';
import { nameOf, readSet, writeSet, type TileSet } from './address';
import { AGENT_FIT, fitFor, type Fit } from './fit';
import { ContextMenu, type MenuAt, type MenuItem } from './menu';
import './tiles.css';

/** An app as a tile knows it: its key (the dock key it's open under, as trail.ts keys it), its label and its fit. */
export type AppRef = { key: string; label: string; fit: Fit };
type Open = AppRef & { url: string; pinned?: boolean };
type State = { apps: Open[]; min: Open[]; focus: string | null; /** what Home sent to the dock, to bring back */ home: string[] | null;
  /** the widgets, by id, in the order added */ w: string[] };

export type TilesApi = {
  /** Open a page: in its app's tile (added, focused, or back from the dock). False when it isn't a tile's (Home). */
  open: (href: string, from?: string) => boolean;
  /** A dock key: Home, the focused app's own key (minimize), or open. */
  pick: (href: string) => void;
  /** The browser's Back or Forward landed on an address. */
  pop: () => void;
  /** The desktop: every app to the dock (a link to Home). */
  desktop: () => void;
  /** What can go on the desktop, and whether each is there (Find's "Add widget: …"). */
  addable: () => (WidgetRef & { on: boolean })[];
};
/** Opened from a widget: placed last, next to the rail (layout.ts place). */
const FROM_WIDGET = '#widget';
export type Focused = { key: string; label: string; title: string; /** what its page says about itself (the bar's ⓘ) */ intro?: string } | null;
export type Accent = { name?: string; style?: React.CSSProperties };

const SAVED = 'loom-tiles';
/** A tile's own move (transition, below): which, and whose. */
type Fx = { kind: 'open' | 'close' | 'min' | 'max' | 'restore'; key: string };
/** The view-transition name the one tile with an effect wears for it (tiles.css). */
const FX = 'loom-fx';
/** A tile this wide or wider has the page's side column beside it (docs/specs/desk-tiling.md, "The frame"). */
const SIDE_WIDE = 1100;
const keepSet = (set: TileSet) => { try { localStorage.setItem(SAVED, JSON.stringify(set)); } catch { /* private window */ } };
/** Pages of this app you've been to lately, for a wide tile's side column (as the window's Recent here, desk.tsx). */
const recentHere = (url: string, app: string) => {
  const seen = new Set([url]);
  const under = (h: string) => { const p = h.split('?')[0]; return p === app || p.startsWith(`${app}/`); };
  return [...trail.visited(app).filter((v) => v.label).map((v) => ({ href: v.url, label: v.label! })), ...readRecent().filter((r) => under(r.href))]
    .filter((r) => !seen.has(r.href) && (seen.add(r.href), true)).slice(0, 8);
};
const savedSet = (): TileSet | null => {
  try { const v = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as TileSet | null; return v && Array.isArray(v.t) && Array.isArray(v.m) && (v.w === undefined || Array.isArray(v.w)) ? v : null; } catch { return null; }
};
const sameOrigin = (u: URL) => u.origin === location.origin;

// ---- keys, pop-ups and moves (docs/specs/desk-tiling.md, "Keys", "Sheets and dialogs stay inside their tile", "Transitions")
/** A field has the keys. */
const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable); };
const POP_UP = ':is([role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]):not([data-state="closed"])';
/** A pop-up that takes the keys from this tile: one of its own, or one of the screen's (Find, a context menu); never
 * another tile's, which is modal to that tile only. */
const popUpFor = (tile: Element | null) => [...document.querySelectorAll(POP_UP)].some((e) => { const t = e.closest('.loom-tile'); return !t || t === tile; });
type VT = { finished: Promise<void> };
type Doc = Document & { startViewTransition?: (update: () => void) => VT };
/** A view-transition name for a tile's key or a widget's id (one per element, letters, digits and dashes). */
const vtName = (prefix: string, id: string) => `${prefix}-${id.replace(/[^a-z0-9]/gi, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;
// Asking ahead (page.ts prefetch; t-1925 F): a row, a link or a dock key the pointer rests on, or focus reaches, is
// fetched then. A desktop's alone: a phone has no pointer to rest. Never the sign-in, an asset, an action, Find, a
// one-time message, an Inbox item (opening one reads it), or Activity (looking moves its "new since").
// A mouse's only: a finger's touch starting a scroll isn't a rest.
/** Two at a time at most, and never a page this tab has a copy of. */
function prefetch(to: string): void {
  if (hasKept(to) || ahead.has(to) || ahead.size > 1) return;
  const r = fetchView(to).catch((): Answer => ({ status: 0 }));
  ahead.set(to, r);
  void r.then((a) => { keepAhead(to, a); ahead.delete(to); });
}
let aheadTimer = 0;
const aheadOf = (e: Event) => {
  // Not a link in a conversation's log (its words link anywhere, a page loom may not have) nor one that leaves.
  const el = (e.target as Element | null)?.closest?.('[data-prefetch], a[href]:not([target],[download],[role="log"] a)');
  const href = el?.getAttribute('data-prefetch') ?? el?.getAttribute('href');
  clearTimeout(aheadTimer);
  if (!href || href[0] === '#' || (e.type === 'pointerover' && (e as PointerEvent).pointerType !== 'mouse')) return;
  const u = new URL(href, location.href);
  if (!sameOrigin(u) || u.hash || /^\/(login|logout|app\/|act\/|find$|activity$)/.test(u.pathname) || u.searchParams.has('i') || u.searchParams.has('_flash')) return;
  // A short rest first: a pointer crossing a list on its way elsewhere asks for nothing.
  aheadTimer = window.setTimeout(() => prefetch(u.pathname + u.search), e.type === 'focusin' ? 0 : 70);
};
addEventListener('pointerover', aheadOf, { passive: true });
addEventListener('focusin', aheadOf);
/** Tabbable elements inside `el`, in order. */
const tabbables = (el: Element) => [...el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
  .filter((x) => x.offsetParent !== null || x === document.activeElement);
const titleOf = (p: PageState, o: Open): string => {
  const d = p.data as { view?: string; which?: string; page?: { title?: string }; dashboard?: { label?: string } } | null;
  if (p.error || p.waiting || !d) return o.label;
  // A sheet (Appearance, Accessibility in the Setup tile) by its own name.
  const sheet = d.view === 'sheet' && d.which && d.which !== 'setup' ? d.which[0].toUpperCase() + d.which.slice(1) : '';
  return d.page?.title || d.dashboard?.label || sheet || o.label;
};

type Named = { key: string; label: string };
/** An app's fit: an agent's pages are one kind; every other app by its label (fit.ts). */
const withFit = <T extends Named>(r: T | null, own: (key: string) => Partial<Omit<Fit, 'why'>> | undefined): (T & { fit: Fit }) | null =>
  (r ? { ...r, fit: r.key.startsWith('/a/') ? AGENT_FIT : fitFor(r.label, own(r.key)) } : null);

export function TileDesk({ api, appOf: appOfRaw, byName: byNameRaw, render, home, say, lead, tint, accent, onFocus, outerGo, shell, homeData, live, widgetEnv, oneWindow }: {
  api: React.MutableRefObject<TilesApi | null>;
  /** The app a page is in, or null for the desktop (Home) and anything that isn't a tile. */
  appOf: (path: string) => Named | null;
  /** An app by its name in the address. */
  byName: (name: string) => (Named & { href: string }) | null;
  /** A page's body, linking and acting in its tile. */
  render: (p: PageState, go: (href: string) => void, wide: boolean) => React.ReactNode;
  /** The desktop, when no app is open. */
  home: React.ReactNode;
  say: (n: Omit<Note, 'id'>) => void;
  lead: (o: AppRef) => React.ReactNode;
  tint: (o: AppRef) => string;
  /** What a tile's page wears as its accent (index.css [data-accent]): its app's colour, or its agent's. */
  accent: (o: AppRef) => Accent;
  onFocus: (f: Focused) => void;
  /** Anything that isn't a tile's (Find, signing out, another site). */
  outerGo: (href: string) => void;
  shell: Shell;
  /** Home's own page (the widgets draw from it), once it's here. */
  homeData: DeskHomeData | null;
  /** loom can be reached (the ticker says live or offline). */
  live: boolean;
  /** The widgets' Env: Home's page's, linking by `go`. */
  widgetEnv: (go: (href: string) => void) => Env | null;
  /** One window at a time (Accessibility): one app tile at most. */
  oneWindow: boolean;
}) {
  // A piece's own fit (its manifest's tab.fit) wins over the table's row for its label (fit.ts).
  const own = (key: string) => shell.pieces.find((p) => p.href === key)?.fit;
  const appOf = (path: string) => withFit(appOfRaw(path), own);
  const byName = (name: string) => withFit(byNameRaw(name), own);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const S = useRef<State>(null as unknown as State);
  // The set at first: the address's, else this device's last (a bare /, a link, a window widened back past 1024 px);
  // the page in the address opens focused in its app's tile either way.
  if (!S.current) {
    const { set, page } = readSet(location.pathname + location.search);
    const path = page.split('?')[0];
    const saved = set ? null : savedSet();
    const from = set ?? saved;
    // The widgets: the address's (none when it has a set without them), else this device's last, else today's Home set.
    const ok = { backup: !!shell.backup };
    const w = (set ? set.w ?? [] : saved?.w ?? freshSet(shell.agents, ok)).filter((id) => widgetRef(id, shell.agents, ok));
    const s: State = { apps: [], min: [], focus: null, home: null, w };
    const here = appOf(path);
    const make = (name: string, focused: boolean): Open | null => {
      const r = byName(name);
      if (!r) return null;
      const url = focused && here?.key === r.key ? page : trail.current(r.key)?.url ?? r.href;
      return { key: r.key, label: r.label, fit: r.fit, url };
    };
    for (const e of from?.t ?? []) {
      const o = make(e.name, !!e.focused);
      if (!o || s.apps.some((a) => a.key === o.key)) continue;
      if (e.pinned && !s.apps.length) o.pinned = true;
      s.apps.push(o);
      if (e.focused) s.focus = o.key;
    }
    for (const n of from?.m ?? []) { const o = make(n, false); if (o && !s.apps.some((a) => a.key === o.key) && !s.min.some((a) => a.key === o.key)) s.min.push(o); }
    // The page in the address is a tile of its own, focused, whatever the set says.
    if (here && path !== '/') {
      const open = s.apps.find((a) => a.key === here.key);
      if (open) open.url = page; else s.apps.push({ ...here, url: page });
      s.min = s.min.filter((a) => a.key !== here.key);
      s.focus = here.key;
    }
    s.focus ??= s.apps[0]?.key ?? null;
    // One window at a time: the focused app alone; the others wait in the dock.
    if (oneWindow && s.apps.length > 1) {
      s.min = [...s.min, ...s.apps.filter((a) => a.key !== s.focus)];
      s.apps = s.apps.filter((a) => a.key === s.focus);
    }
    S.current = s;
  }

  // Each tile's page, for opening another page in it from outside (a link in another app that lands here).
  const pages = useRef(new Map<string, PageState>());
  const bodies = useRef(new Map<string, HTMLElement>());
  const usedAt = useRef<Record<string, number>>({});
  const box = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [said, setSaid] = useState('');

  const set = (s: State): TileSet => ({
    t: s.apps.map((a) => ({ name: nameOf(a.key), ...(a.key === s.focus ? { focused: true } : {}), ...(a.pinned ? { pinned: true } : {}) })),
    m: s.min.map((a) => nameOf(a.key)),
    w: s.w,
  });
  const addressOf = (s: State) => writeSet(s.apps.find((a) => a.key === s.focus)?.url ?? '/', set(s));
  /** The new state, and the address for it: a page change in a tile is a new entry (Back walks it); opening, closing,
   * swapping and promoting replace the one there is, so Back never closes a tile. */
  const commit = (next: State, how: 'push' | 'replace' = 'replace', move = false, fx?: Fx) => {
    const before = S.current;
    S.current = next;
    const to = addressOf(next);
    if (how === 'push') history.pushState({ tile: next.focus }, '', to);
    else if (to !== location.pathname + location.search) history.replaceState({ tile: next.focus }, '', to);
    keepSet(set(next));
    if (move) reflow(before, fx); else bump();
  };
  // A reflow (a tile added, closed, minimized, swapped or made the big one; a widget added or taken off): one document
  // View Transition morphs every tile from its old box to its new one, each named for itself (tiles.css). The screen
  // keeps drawing the state before it (`drawn`) until the transition has its picture of it. One at a time: a change
  // during one simply applies. Reduced motion (access.ts), or no API: the layout simply changes.
  const drawn = useRef<State | null>(null);
  const moving = useRef(false);
  const canMove = () => !moving.current && !reducedMotion() && typeof (document as Doc).startViewTransition === 'function';
  // A tile's own move (t-1925 B; Jonathan, 2026-11-06: "nothing reads as a page refresh"): the one tile opened,
  // closed, minimized, made the big one or brought back from the dock is named `loom-fx` for the transition, in its
  // old picture, its new one or both, and <html data-tile-fx> says which effect it wears (tiles.css): a CRT's power-on
  // and power-off, a scanline wiping it down to the dock and back up, a glitch as it takes the big slot. The rest of
  // the tiles morph as ever, by their own names. Reduced motion, or no View Transitions: none of it (canMove).
  const fxEl = (key: string) => box.current?.querySelector<HTMLElement>(`.loom-tile[data-tile="${CSS.escape(key)}"]`) ?? null;
  const transition = (kind: 'reflow' | 'page', update: () => void, tile?: string, fx?: Fx) => {
    const root = document.documentElement;
    moving.current = true;
    root.dataset.tileMove = kind;
    if (tile) box.current?.querySelector(`[data-tile="${CSS.escape(tile)}"]`)?.setAttribute('data-moving', '');
    // The old picture: a tile that leaves, or changes slot, wears the effect's name as it's captured.
    if (fx) { root.dataset.tileFx = fx.kind; if (fx.kind !== 'open' && fx.kind !== 'restore') fxEl(fx.key)?.style.setProperty('--vt', FX); }
    const done = () => {
      moving.current = false;
      if (root.dataset.tileMove === kind) delete root.dataset.tileMove;
      if (fx && root.dataset.tileFx === fx.kind) delete root.dataset.tileFx;
      if (fx) fxEl(fx.key)?.style.setProperty('--vt', vtName('tile', fx.key));
      box.current?.querySelectorAll('[data-moving]').forEach((e) => e.removeAttribute('data-moving'));
    };
    // The new picture: a tile that arrives, or changes slot, wears it as it's drawn.
    const run = () => { update(); if (fx && fx.kind !== 'close' && fx.kind !== 'min') fxEl(fx.key)?.style.setProperty('--vt', FX); };
    try {
      (document as Doc).startViewTransition!(run).finished.then(done, done);
    } catch {
      // The browser refused to start one: the change simply applies.
      done(); update();
    }
  };
  const reflow = (before: State, fx?: Fx) => {
    if (!canMove()) { drawn.current = null; bump(); return; }
    drawn.current = before;
    transition('reflow', () => { drawn.current = null; flushSync(bump); }, undefined, fx);
  };
  const tiles = (apps: Open[]): AppTile[] => apps.map((a) => ({ id: a.key, name: a.label, fit: a.fit, ...(a.pinned ? { pinned: true } : {}) }));
  // Each widget's height as drawn at the column's width (measured), for the rule; until then its default (fit.ts).
  const [heights, setHeights] = useState<Record<string, number>>({});
  const hs = useRef(heights);
  hs.current = heights;
  const wok = { backup: !!shell.backup };
  const wrefs = (ids: string[]): WidgetRef[] => ids.map((id) => widgetRef(id, shell.agents, wok)).filter((w): w is WidgetRef => !!w);
  /** The widgets drawn: a widget stands aside while its app's tile is open (an agent's card and its window, Needs you and
   * the Inbox: one app at two sizes, t-1925 D; widgets.ts pairOf), and comes back where it was when the tile closes,
   * goes to the dock or shrinks. `also`: a tile about to open. */
  const shownW = (st: { apps: Open[]; w: string[] }, also?: string) => st.w.filter((id) => {
    const k = pairOf(id)?.key;
    return !k || (!st.apps.some((a) => a.key === k) && also !== k);
  });
  const wtiles = (ids = shownW(S.current)): WidgetTile[] => wrefs(ids).map((w) => ({ id: w.id, name: w.name, kind: w.kind, ...(hs.current[w.id] ? { h: hs.current[w.id] } : {}) }));
  const scrollOf = (key: string) => bodies.current.get(key)?.scrollTop ?? 0;
  const announce = (m: string) => { setSaid(''); requestAnimationFrame(() => setSaid(m)); };

  const focus = (key: string) => {
    usedAt.current[key] = Date.now();
    if (S.current.focus !== key) commit({ ...S.current, focus: key });
  };
  /** To the dock, kept where it is (its page and how far down). */
  const toDock = (s: State, o: Open): State => {
    trail.minimize(o.key, { url: o.url, top: scrollOf(o.key) });
    const apps = s.apps.filter((a) => a.key !== o.key);
    const next = apps.reduce<Open | undefined>((x, y) => (!x || (usedAt.current[y.key] ?? 0) > (usedAt.current[x.key] ?? 0) ? y : x), undefined);
    return { ...s, apps, min: [...s.min.filter((a) => a.key !== o.key), o], focus: s.focus === o.key ? next?.key ?? null : s.focus };
  };
  /** The most apps on screen at once: the screen's cap (layout.ts rule 4), or one with One window at a time. */
  const cap = () => (oneWindow ? 1 : capFor(innerWidth));
  /** An app into the layout: placed by the rule, and whatever doesn't fit then goes to the dock, said in a toast. With
   * One window at a time, the app there goes to the dock first, kept where it was, said the same way. */
  const add = (o: Open, from?: string, back = false) => {
    let s = S.current;
    const swapped = oneWindow ? s.apps : [];
    for (const a of swapped) s = toDock(s, a);
    const r = admit(tiles(s.apps), tiles([o])[0], wtiles(shownW(S.current, o.key)), area, innerWidth, { from: from === FROM_WIDGET ? { widget: true } : from ? { tile: from } : undefined, usedAt: usedAt.current });
    let next: State = { ...s, min: s.min.filter((a) => a.key !== o.key), home: null };
    next.apps = r.apps.map((t) => (t.id === o.key ? o : { ...s.apps.find((a) => a.key === t.id)!, pinned: t.pinned }));
    const why = [...swapped.map((a) => `${a.label} went to the dock to make room for ${o.label}: one window at a time is on`), ...r.docked.map((d) => d.why)];
    for (const d of r.docked) {
      const gone = s.apps.find((a) => a.key === d.app.id)!;
      next = toDock({ ...next, apps: [...next.apps, gone] }, gone);
    }
    for (const m of why) say({ ok: true, message: m });
    usedAt.current[o.key] = Date.now();
    next.focus = o.key;
    commit(next, 'replace', true, { kind: back ? 'restore' : 'open', key: o.key });
    const i = next.apps.findIndex((a) => a.key === o.key);
    announce([`${o.label} opened, tile ${i + 1} of ${next.apps.length}`, ...why].join('. '));
  };

  const open = (href: string, from?: string): boolean => {
    if (href.startsWith('#widget:')) { addWidget(href.slice(8)); return true; }
    const u = new URL(href, location.href);
    const to = u.pathname + u.search;
    const r = appOf(u.pathname);
    if (!r) return false;
    const s = S.current;
    const here = s.apps.find((a) => a.key === r.key);
    if (here) {
      focus(r.key);
      // Its tile goes to the page asked for, when that's another page than its key's own start.
      if (to !== here.url && to !== r.key) {
        trail.keepTop(r.key, here.url, scrollOf(r.key));
        void pages.current.get(r.key)?.load(to, true);
      }
      return true;
    }
    const was = s.min.find((a) => a.key === r.key);
    const back = was ? trail.restore(r.key) : undefined;
    add({ ...r, url: was && (to === r.key || to === was.url) ? back?.url ?? was.url : to, ...(back ? { restoreTop: back.top } : {}) } as Open, from, !!was);
    return true;
  };
  const minimize = (key: string) => {
    const o = S.current.apps.find((a) => a.key === key);
    if (!o) return;
    commit(toDock(S.current, o), 'replace', true, { kind: 'min', key });
    announce(`${o.label} minimized to the dock`);
  };
  const close = (key: string) => {
    const s = S.current;
    const o = s.apps.find((a) => a.key === key);
    if (!o) return;
    trail.forget(key);
    const apps = s.apps.filter((a) => a.key !== key);
    commit({ ...s, apps, focus: s.focus === key ? apps[apps.length - 1]?.key ?? null : s.focus }, 'replace', true, { kind: 'close', key });
    announce(`${o.label} closed`);
  };
  /** While there are more apps than the cap, or one is under its minimum, the least recently used (never the focused,
   * never the pinned) goes to the dock, said in a toast. After anything that changes the set other than opening (which
   * `admit` does): the screen resized, Home again, make this the big one. */
  const shed = (s: State, why: string): State => {
    for (;;) {
      const over = s.apps.length > cap() || underMinimum(tiles(s.apps), wtiles(shownW(s)), area, innerWidth);
      // With One window at a time, a pinned app goes too: one is the most there is.
      const may = s.apps.filter((a) => a.key !== s.focus && (oneWindow || !a.pinned));
      if (!over || !may.length || !area.w) return s;
      const o = may.reduce((x, y) => ((usedAt.current[y.key] ?? 0) < (usedAt.current[x.key] ?? 0) ? y : x));
      s = toDock(s, o);
      say({ ok: true, message: `${o.label} went to the dock: ${why}` });
      announce(`${o.label} went to the dock: ${why}`);
    }
  };
  const makeBig = (key: string) => {
    const s = S.current;
    const order = promote(tiles(s.apps), key);
    commit(shed({ ...s, apps: order.map((t) => ({ ...s.apps.find((a) => a.key === t.id)!, pinned: t.pinned })), focus: key }, 'it didn’t fit beside the big one'), 'replace', true, { kind: 'max', key });
    announce(`${s.apps.find((a) => a.key === key)?.label ?? 'It'} is the big one, tile 1 of ${S.current.apps.length}`);
  };
  /** Swap with the tile before (-1) or after (1): its place in the order; a pinned tile swapped out of the big slot isn't
   * pinned any more. A widget swaps with the widget beside it, in the order they were added. */
  const swapBy = (key: string, by: -1 | 1) => {
    const s = S.current;
    const i = s.apps.findIndex((a) => a.key === key);
    if (i >= 0) {
      if (!s.apps[i + by]) return;
      const order = swap(tiles(s.apps), i, i + by);
      commit({ ...s, apps: order.map((t) => ({ ...s.apps.find((a) => a.key === t.id)!, pinned: t.pinned })), focus: key }, 'replace', true);
      announce(`${s.apps[i].label} swapped with ${s.apps[i + by].label}, tile ${i + by + 1} of ${s.apps.length}`);
      return;
    }
    const j = s.w.indexOf(key);
    if (j < 0 || !s.w[j + by]) return;
    const w = [...s.w];
    [w[j], w[j + by]] = [w[j + by], w[j]];
    commit({ ...s, w }, 'replace', true);
    announce(`${widgetRef(key, shell.agents, wok)?.label ?? 'The widget'} swapped with ${widgetRef(s.w[j + by], shell.agents, wok)?.label ?? 'the next'}`);
  };
  const homeKey = () => {
    const s = S.current;
    if (s.apps.length) {
      const sent = s.apps.reduce((x, o) => toDock(x, o), s);
      commit({ ...sent, home: s.apps.map((a) => a.key) }, 'replace', true);
      announce('The desktop: every app is in the dock');
      return;
    }
    if (!s.home) return;
    // Home again: back in their order.
    const back = s.home.map((k) => s.min.find((a) => a.key === k)).filter((a): a is Open => !!a)
      .map((a) => ({ ...a, url: trail.restore(a.key)?.url ?? a.url }));
    commit(shed({ ...s, apps: back, min: s.min.filter((a) => !s.home!.includes(a.key)), home: null, focus: back[0]?.key ?? null }, oneWindow ? 'one window at a time is on' : 'not all of them fit this screen now'), 'replace', true);
    announce(`${back.map((a) => a.label).join(', ')} back from the dock`);
  };

  // ---- widgets ----
  const addWidget = (id: string) => {
    const s = S.current;
    const w = widgetRef(id, shell.agents, wok);
    if (!w) return;
    if (s.w.includes(id)) {
      // On the desktop already: focus it.
      requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-widget="${CSS.escape(id)}"] :is(a, button)`)?.focus());
      return;
    }
    commit(shed({ ...s, w: [...s.w, id] }, `${w.label} needed the room`), 'replace', true);
    announce(`${w.label} added to the desktop`);
  };
  const removeWidget = (id: string) => {
    const s = S.current;
    const w = widgetRef(id, shell.agents, wok);
    commit({ ...s, w: s.w.filter((x) => x !== id) }, 'replace', true);
    announce(`${w?.label ?? 'The widget'} removed from the desktop`);
  };
  /** A widget's link: its app opens beside it (last, next to the rail); anything else is the screen's. */
  const goWidget = (href: string) => {
    const u = new URL(href, location.href);
    if (!sameOrigin(u) || u.pathname === '/' || !appOf(u.pathname)) { outerGo(href); return; }
    open(u.pathname + u.search, FROM_WIDGET);
  };
  /** Chat on an agent's card: its latest Comms thread beside the rail, else Comms. */
  const chat = appOf('/comms') ? (agent: string) => {
    void fetch('/comms', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((d: { threads?: { id: string; agent: string; last: string }[] } | null) => {
        const t = (d?.threads ?? []).filter((x) => x.agent === agent).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))[0];
        open(t ? `/comms/${t.id.replace(/^th:/, '')}` : '/comms', FROM_WIDGET);
      });
  } : undefined;

  // A widget and its app's tile, one app at two sizes (t-1925 D; morph.ts, widgets.ts pairOf): Expand, Shrink to widget.
  // The outline wears the agent's colour, or Needs you's pink.
  const wColor = (id: string) => { const a = shell.agents.find((x) => x.id === id); return a ? markColor(a.bg) : 'var(--v-pink)'; };
  const tileEl = (key: string) => box.current?.querySelector(`.loom-tile[data-tile="${CSS.escape(key)}"]`) ?? null;
  const widgetOps: WidgetOps = {
    expand: (id, from, href) => {
      const pair = pairOf(id);
      if (!pair) return;
      const r = from?.getBoundingClientRect() ?? null;
      if (!open(href ?? pair.href, FROM_WIDGET)) { outerGo(href ?? pair.href); return; }
      morph(r, () => tileEl(pair.key), wColor(id));
    },
    shrink: (id) => {
      const key = pairOf(id)?.key;
      const s = S.current;
      const o = key ? s.apps.find((a) => a.key === key) : undefined;
      if (!key || !o) return;
      const r = tileEl(key)?.getBoundingClientRect() ?? null;
      trail.forget(key);
      const apps = s.apps.filter((a) => a.key !== key);
      const w = widgetRef(id, shell.agents, wok);
      commit(shed({ ...s, apps, focus: s.focus === key ? apps[apps.length - 1]?.key ?? null : s.focus, w: w && !s.w.includes(id) ? [...s.w, id] : s.w }, `${o.label} needed the room`), 'replace', true);
      announce(`${o.label} folded back into ${w?.kind === 'agent' ? 'its card' : w?.label ?? 'its widget'}`);
      morph(r, () => box.current?.querySelector(`[data-widget="${CSS.escape(id)}"]`) ?? null, wColor(id));
    },
  };

  api.current = {
    // A card standing aside while its window is open isn't on the desktop to focus: it's offered (and added back).
    addable: () => addable(shell.agents, wok).map((w) => ({ ...w, on: shownW(S.current).includes(w.id) })),
    open,
    desktop: () => { if (S.current.apps.length) homeKey(); },
    pick: (href) => {
      const u = new URL(href, location.href);
      if (u.pathname === '/') { homeKey(); return; }
      const r = appOf(u.pathname);
      if (r && r.key === S.current.focus) { minimize(r.key); return; }
      if (!open(href)) outerGo(href);
    },
    pop: () => {
      const { page } = readSet(location.pathname + location.search);
      const r = appOf(page.split('?')[0]);
      if (!r) return;
      const s = S.current;
      if (!s.apps.some((a) => a.key === r.key)) { open(page); return; }
      if (s.focus !== r.key) { S.current = { ...s, focus: r.key }; bump(); }
      const p = pages.current.get(r.key);
      if (!p) return;
      const o = s.apps.find((a) => a.key === r.key)!;
      trail.keepTop(r.key, o.url, scrollOf(r.key));
      const near = [trail.step(r.key, -1), trail.step(r.key, 1)].find((v) => v?.url === page);
      intents.current.set(r.key, { how: 'pop', url: page, top: near?.top });
      void p.load(page, false);
    },
  };

  // How each tile's next page is being reached, and where to scroll it (Back, Forward, the browser's).
  const intents = useRef(new Map<string, { how: trail.How; url: string; top?: number }>());
  const goFrom = (key: string) => (href: string, o?: { how?: 'back' | 'forward'; top?: number }) => {
    const u = new URL(href, location.href);
    if (!sameOrigin(u) || u.pathname === '/find' || u.pathname.startsWith('/app/') || /^\/(login|logout)/.test(u.pathname) || u.pathname === '/') { outerGo(href); return; }
    const to = u.pathname + u.search;
    const r = appOf(u.pathname);
    if (r && r.key !== key) { open(to, key); return; }
    const p = pages.current.get(key), here = S.current.apps.find((a) => a.key === key);
    if (!p || !here) return;
    trail.keepTop(key, here.url, scrollOf(key));
    intents.current.set(key, { how: o?.how ?? 'go', url: to, top: o?.top });
    // Only this tile's page moves: its body is the transition's one named part (tiles.css), the other tiles stand still.
    // Only when the page is here already (kept): else the transition would morph into the wait, and the page land after.
    if (canMove() && hasKept(to)) transition('page', () => flushSync(() => { void p.load(to, true); }), key);
    else void p.load(to, true);
  };
  /** Where a tile's page landed, whatever took it there (its links, its Back, the browser's): the set's from now on. */
  const landed = (key: string, url: string) => {
    const s = S.current;
    if (s.apps.find((a) => a.key === key)?.url === url) return;
    S.current = { ...s, apps: s.apps.map((a) => (a.key === key ? { ...a, url } : a)) };
    keepSet(set(S.current));
    bump();
  };
  const navFor = (key: string): PageNav => ({
    here: () => S.current.apps.find((a) => a.key === key)?.url ?? '/',
    push: (to) => { const s = S.current; commit({ ...s, apps: s.apps.map((a) => (a.key === key ? { ...a, url: to } : a)), focus: key }, 'push'); },
    replace: (to) => { const s = S.current; commit({ ...s, apps: s.apps.map((a) => (a.key === key ? { ...a, url: to } : a)) }); },
    top: () => { const b = bodies.current.get(key); if (b) b.scrollTop = 0; },
  });

  // ---- the keys (docs/specs/desk-tiling.md, "Keys"): Alt+Shift moves between and arranges the tiles; Alt+← → is the
  // focused tile's Back and Forward; Alt+H is Home. Never while a field has the keys, nor while a pop-up in this tile
  // (or the screen's, Find) is open. Esc never closes a tile.
  const steps = useRef(new Map<string, (by: -1 | 1) => boolean>());
  /** The tile or widget the keys act on: the one focus is in, else the focused tile. */
  const current = (): HTMLElement | null => {
    const a = document.activeElement;
    const el = a && a !== document.body ? a.closest<HTMLElement>('.loom-tile, .loom-tiles [data-widget]') : null;
    return el ?? (S.current.focus ? box.current?.querySelector<HTMLElement>(`.loom-tile[data-tile="${CSS.escape(S.current.focus)}"]`) ?? null : null);
  };
  /** Focus a tile (its title, which reads its label: "tile 2 of 3, Comms") or a widget, and say so. */
  const focusEl = (el: HTMLElement) => {
    const key = el.dataset.tile;
    if (key) {
      el.querySelector<HTMLElement>('.loom-tile__bar h2')?.focus({ preventScroll: true });
      focus(key);
      announce(el.getAttribute('aria-label') ?? '');
      return;
    }
    // A widget's frame takes focus; a key in the strip is its link.
    const f = el.matches('[tabindex]') ? el : el.querySelector<HTMLElement>('a, button');
    f?.focus({ preventScroll: true });
    announce(`${f?.getAttribute('aria-label') ?? el.getAttribute('aria-label') ?? 'a widget'}, widget`);
  };
  const toward = (dir: 'left' | 'right' | 'up' | 'down') => {
    const from = current();
    if (!from) {
      const first = box.current?.querySelector<HTMLElement>('.loom-tile, .loom-tiles [data-widget]');
      if (first) focusEl(first);
      return;
    }
    const r = from.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const all = [...(box.current?.querySelectorAll<HTMLElement>('.loom-tile, .loom-tiles [data-widget]') ?? [])].filter((e) => e !== from);
    let best: HTMLElement | null = null, bestD = Infinity;
    for (const e of all) {
      const b = e.getBoundingClientRect();
      // Those that start past this one's edge that way; of them, the nearest centre; a tie, the earlier in the order.
      const past = dir === 'right' ? b.x >= r.x + r.width - 1 : dir === 'left' ? b.x + b.width <= r.x + 1 : dir === 'down' ? b.y >= r.y + r.height - 1 : b.y + b.height <= r.y + 1;
      if (!past) continue;
      const d = Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy);
      if (d < bestD - 0.5) { best = e; bestD = d; }
    }
    if (best) focusEl(best);
  };
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || typing()) return;
    const el = current();
    if (popUpFor(el)) return;
    const key = el?.dataset.tile, widget = el?.dataset.widget;
    const arrows: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    // , and . by what they type where that's what they are (AZERTY's , is where QWERTY's M is), else by where they sit
    // (a Mac's Option+Shift types other characters); letters by where they sit.
    const swapKey = [',', '<'].includes(e.key) || (e.code === 'Comma' && !['.', '>'].includes(e.key)) ? -1
      : ['.', '>'].includes(e.key) || e.code === 'Period' ? 1 : 0;
    let done = true;
    if (e.shiftKey) {
      if (arrows[e.code]) toward(arrows[e.code]);
      else if (e.code === 'Enter' && key) makeBig(key);
      else if (swapKey && (key || widget)) swapBy((key ?? widget)!, swapKey);
      else if (e.code === 'KeyM' && key) minimize(key);
      else if (e.code === 'KeyW' && key) close(key);
      else if (e.code === 'KeyW' && widget) removeWidget(widget);
      else done = false;
    } else if (e.code === 'KeyH') homeKey();
    else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && key) done = steps.current.get(key)?.(e.code === 'ArrowLeft' ? -1 : 1) ?? false;
    else done = false;
    if (done) e.preventDefault();
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => onKey.current(e);
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, []);

  // ---- context menus (menu.tsx; docs/specs/desk-tiling.md, "Context menus"): what you can do with the thing under the
  // pointer, or under focus with the Menu key or Shift+F10. The desktop's ground adds a widget (the + key's job, gone);
  // a tile's strip, a dock key and an agent's card each have a short list; a list row in a page offers what it declares
  // (`data-row-menu`, answered by a `loom-menu` event on the row: the Inbox's Open and Mark done). Anything else, the
  // browser's own menu (text to copy, a link, a field).
  const [menu, setMenu] = useState<MenuAt | null>(null);
  /** An app minimized to the dock, closed from there: gone from the dock and its history forgotten. */
  const closeDocked = (key: string) => {
    const s = S.current, o = s.min.find((a) => a.key === key);
    if (!o) return;
    trail.forget(key);
    commit({ ...s, min: s.min.filter((a) => a.key !== key) });
    announce(`${o.label} closed`);
  };
  const menuFor = (t: Element): Omit<MenuAt, 'x' | 'y' | 'back'> | null => {
    if (t.closest('input, textarea, select, [contenteditable="true"], .loom-cmenu')) return null;
    const item = (id: string, label: string, run: () => void, hint?: string): MenuItem => ({ id, label, run, ...(hint ? { hint } : {}) });
    // a row that says what it offers
    const row = t.closest<HTMLElement>('[data-row-menu]');
    if (row && box.current?.contains(row)) {
      const items = (row.dataset.rowMenu ?? '').split('|').map((x) => x.split(':')).filter((x) => x.length === 2 && x[0] && x[1])
        .map(([id, label]) => item(id, label, () => row.dispatchEvent(new CustomEvent('loom-menu', { detail: id }))));
      return items.length ? { title: row.dataset.rowMenuTitle || 'This item', items } : null;
    }
    const tile = t.closest<HTMLElement>('.loom-tile');
    if (tile) {
      if (!t.closest('.loom-tile__bar')) return null;
      const s = S.current, key = tile.dataset.tile!, i = s.apps.findIndex((a) => a.key === key), o = s.apps[i];
      if (!o) return null;
      // An agent's window folds back into its card, the Inbox into Needs you (t-1925 D: one app at two sizes), as its
      // strip's button does.
      const id = widgetOfApp(key, shell.agents, wok);
      return { title: o.label, items: [
        item('min', 'Minimize', () => minimize(key), 'Alt+Shift+M'),
        ...(i > 0 ? [item('big', 'Make it the big one', () => makeBig(key), 'Alt+Shift+Enter')] : []),
        ...(id ? [item('shrink', 'Shrink to widget', () => widgetOps.shrink(id))] : []),
        item('close', 'Close', () => close(key), 'Alt+Shift+W'),
      ] };
    }
    const wEl = t.closest<HTMLElement>('[data-widget]');
    if (wEl && box.current?.contains(wEl)) {
      const id = wEl.dataset.widget!, w = widgetRef(id, shell.agents, wok);
      if (!w) return null;
      const where = w.kind === 'backup' ? shell.backup?.href ?? '/setup' : '/places';
      const paired = !!pairOf(id);
      return { title: w.kind === 'agent' ? w.name : w.label, items: [
        ...(w.kind === 'agent' && chat ? [item('chat', 'Chat', () => chat(id))] : []),
        item('open', paired ? 'Expand' : 'Open', () => (paired ? widgetOps.expand(id, wEl) : goWidget(where))),
        item('unpin', w.kind === 'agent' ? 'Unpin from the desktop' : 'Remove from the desktop', () => removeWidget(id)),
      ] };
    }
    const key = t.closest<HTMLElement>('.loom-dock-bar [data-part="item"][data-value]');
    if (key) {
      // Only an app's own path (never a link to elsewhere, never markup): what the key opens is that app's key, from
      // loom's own table, not the attribute. Home, All apps, More and your own key (Account) have none: they aren't apps
      // you'd minimize or close.
      const path = /^\/[\w\-/]*$/.exec(key.dataset.value ?? '')?.[0];
      if (!path || path === '/' || path === '/account') return null;
      const r = appOf(path);
      if (!r) return null;
      const s = S.current, isOpen = s.apps.some((a) => a.key === r.key), docked = s.min.some((a) => a.key === r.key);
      return { title: r.label, items: [
        item('open', 'Open', () => { open(r.key); }),
        ...(isOpen ? [item('min', 'Minimize', () => minimize(r.key))] : []),
        ...(isOpen || docked ? [item('close', 'Close', () => (isOpen ? close(r.key) : closeDocked(r.key)))] : []),
      ] };
    }
    // the desktop's own ground: between and around the tiles and widgets
    if (t === document.body || t === document.documentElement || (t.closest('.loom-desk-main') && !t.closest('a, button, .loom-w'))) {
      return { title: 'Add a widget', items: addable(shell.agents, wok).map((w) => item(`w:${w.id}`, w.label, () => addWidget(w.id), S.current.w.includes(w.id) ? 'on the desktop' : undefined)) };
    }
    return null;
  };
  const menuRef = useRef(menuFor);
  menuRef.current = menuFor;
  useEffect(() => {
    let keyed = 0;
    const show = (t: Element, x: number, y: number, back: HTMLElement | null) => {
      const m = menuRef.current(t);
      if (!m || !m.items.length) return false;
      setMenu({ ...m, x, y, back });
      return true;
    };
    const onMenu = (e: MouseEvent) => {
      if (Date.now() - keyed < 600) { e.preventDefault(); return; }
      const t = e.target as Element;
      // From the keyboard, some browsers send it with no pointer: at the element, as the keys do.
      const r = (e.clientX || e.clientY) ? null : t.getBoundingClientRect();
      const back = (t.closest('a, button, [tabindex]') as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
      if (show(t, r ? r.left + 8 : e.clientX, r ? r.bottom : e.clientY, back)) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) || e.ctrlKey || e.altKey || e.metaKey) return;
      const a = document.activeElement as HTMLElement | null;
      const t = a && a !== document.body ? a : document.body;
      const r = t === document.body ? { left: innerWidth / 2 - 120, bottom: innerHeight / 3 } : t.getBoundingClientRect();
      if (show(t, r.left + 8, r.bottom, t === document.body ? null : t)) { e.preventDefault(); keyed = Date.now(); }
    };
    addEventListener('contextmenu', onMenu);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('contextmenu', onMenu); removeEventListener('keydown', onKey); };
  }, []);

  // The room the tiles share, as it changes.
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const measure = () => setArea({ x: 0, y: 0, w: b.clientWidth, h: b.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    return () => ro.disconnect();
  }, []);
  // Narrower (a window resized): what no longer fits goes to the dock, least recently used first, never the focused.
  useEffect(() => {
    const s = shed(S.current, 'the screen got too small for it');
    if (s !== S.current) commit(s);
  }, [area.w, area.h]);   // eslint-disable-line react-hooks/exhaustive-deps
  // One window at a time turned on with apps open: the focused one stays, the others go to the dock.
  const wasOne = useRef(oneWindow);
  useEffect(() => {
    if (wasOne.current === oneWindow) return;
    wasOne.current = oneWindow;
    const n = shed(S.current, 'one window at a time is on');
    if (n !== S.current) commit(n, 'replace', true);
  }, [oneWindow]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The address and this device's copy, as the set first stands.
  useEffect(() => { commit(S.current); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // What's drawn: the state before a reflow until its transition has the picture of it, else the state.
  const s = drawn.current ?? S.current;
  const ws = wrefs(shownW(s));
  const l = useMemo(() => layout(tiles(s.apps), wtiles(shownW(s)), area, innerWidth), [s.apps, s.w, area, heights]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Taller widgets than were allowed for (measured): what no longer fits beside them goes to the dock.
  useEffect(() => {
    const n = shed(S.current, 'the widgets needed the room');
    if (n !== S.current) commit(n);
  }, [heights]);   // eslint-disable-line react-hooks/exhaustive-deps
  // What Needs you and Vitals hold changes their height: measured again (drawn in full once) when it does.
  const holds = homeData ? `${homeData.needs}\0${(homeData.stack ?? []).map((i) => i.key).join(',')}\0${shell.pieces.map((p) => `${p.label}:${p.tone ?? ''}`).join(',')}` : '';
  const [full, setFull] = useState<ReadonlySet<string>>(() => new Set());
  const held = useRef(holds);
  useEffect(() => { if (held.current !== holds) { held.current = holds; setFull(new Set(['needs', 'vitals'])); } }, [holds]);
  const measured = (id: string) => (h: number) => {
    setHeights((x) => (Math.abs((x[id] ?? 0) - h) < 2 ? x : { ...x, [id]: h }));
    setFull((f) => (f.has(id) ? new Set([...f].filter((x) => x !== id)) : f));
  };
  const wd: WidgetData | null = homeData ? { home: homeData, shell, live } : null;
  const wenv = widgetEnv(goWidget);
  const frame = (w: { id: string; name: string }, body: React.ReactNode, o: { rect?: Rect; compact?: boolean; measure?: (h: number) => void } = {}) => (
    <WidgetFrame key={w.id} id={w.id} name={w.name} named={!!o.rect} rect={o.rect} compact={o.compact} measure={o.measure} remove={() => removeWidget(w.id)}>{body}</WidgetFrame>
  );
  const wa = l.widgetArea;
  const widgetsDrawn = !wd || !wenv ? null : !s.apps.length ? (
    <WidgetDesk ws={ws} d={wd} chat={chat} frame={(w, b) => frame(w, b)} />
  ) : ws.length > 0 && wa ? (
    <div className="loom-wrail" data-mode={l.mode} data-scroll={l.scroll || undefined} role="group" aria-label="Widgets"
      style={{ left: wa.x, top: wa.y, width: wa.w, height: wa.h }}>
      {/* In the order drawn, column by column, top to bottom: the tab and reading order (spec, "Accessibility"). */}
      {[...ws].sort((a, b) => (l.widgets[a.id]?.x ?? 0) - (l.widgets[b.id]?.x ?? 0) || (l.widgets[a.id]?.y ?? 0) - (l.widgets[b.id]?.y ?? 0)).map((w) => {
        const r = l.widgets[w.id];
        if (!r) return null;
        const rect = { x: r.x - wa.x, y: r.y - wa.y, w: r.w, h: r.h };
        if (l.mode === 'strip') return <div key={w.id} className="loom-wtile loom-wtile--key" data-widget={w.id} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          <StripKey id={w.id} kind={w.kind} name={w.label} d={wd} open={goWidget} /></div>;
        // Drawn in full until it's been measured once (the rule's compact is a guess before that), then as the rule says.
        const compact = !!r.compact && heights[w.id] !== undefined && !full.has(w.id);
        return frame(w, <WidgetBody id={w.id} kind={w.kind} d={wd} compact={compact} chat={chat} />, { rect, compact, measure: compact ? undefined : measured(w.id) });
      })}
    </div>
  ) : null;
  const f = s.apps.find((a) => a.key === s.focus) ?? null;
  const fp = f ? pages.current.get(f.key) : undefined;
  const focusedTitle = f ? titleOf(fp ?? ({ data: null } as PageState), f) : '';
  const fd = fp && !fp.error && !fp.waiting ? fp.data as { view?: string; page?: { intro?: string }; intro?: string } | null : null;
  const focusedIntro = fd?.view === 'page' ? fd.page?.intro : fd?.view === 'sheet' ? fd.intro : undefined;
  const told = useRef('');
  useEffect(() => {
    const k = f ? `${f.key}\0${f.label}\0${focusedTitle}\0${focusedIntro ?? ''}` : '';
    if (k === told.current) return;
    told.current = k;
    onFocus(f ? { key: f.key, label: f.label, title: focusedTitle, intro: focusedIntro } : null);
  });

  return (
    <WidgetOpsContext.Provider value={widgetOps}>
    <div className="loom-tiles" ref={box} data-count={s.apps.length} data-widgets={l.mode}>
      {s.apps.length === 0 ? (wd && wenv ? <EnvContext.Provider value={wenv}>{widgetsDrawn}</EnvContext.Provider> : home) : s.apps.map((o, i) => (
        <Tile key={o.key} o={o} n={i} of={s.apps.length} rect={l.apps[o.key]} focused={o.key === s.focus} say={say} nav={navFor}
          pages={pages} bodies={bodies} intents={intents} go={goFrom(o.key)} render={render} lead={lead(o)} tint={tint(o)} accent={accent(o)}
          landed={(url) => landed(o.key, url)} onFocus={() => focus(o.key)} steps={steps} minimize={() => minimize(o.key)} close={() => close(o.key)} makeBig={() => makeBig(o.key)}
          shrink={widgetOfApp(o.key, shell.agents, wok) ? () => widgetOps.shrink(widgetOfApp(o.key, shell.agents, wok)!) : undefined}
          shrinkTo={widgetOfApp(o.key, shell.agents, wok) === 'needs' ? 'Needs you' : 'its card'} />
      ))}
      {s.apps.length > 0 && wenv && <EnvContext.Provider value={wenv}>{widgetsDrawn}</EnvContext.Provider>}
      {menu && <ContextMenu at={menu} close={() => setMenu(null)} />}
      <p className="sr-only" aria-live="polite">{said}</p>
    </div>
    </WidgetOpsContext.Provider>
  );
}

/** Scrolled to `top`, and kept there while the page is still growing under it (a chunk, a face, a font landing): a
 * page shorter than `top` when it's first drawn would otherwise stop short. Lets go after a second, or at a touch. */
function holdScroll(el: HTMLElement, top: number) {
  el.scrollTop = top;
  const page = el.firstElementChild;
  if (!page || el.scrollTop === top) return;
  const ro = new ResizeObserver(() => { el.scrollTop = top; if (el.scrollTop === top) stop(); });
  const stop = () => { ro.disconnect(); clearTimeout(t); el.removeEventListener('wheel', stop); el.removeEventListener('pointerdown', stop); };
  const t = setTimeout(stop, 1000);
  ro.observe(page);
  el.addEventListener('wheel', stop, { passive: true }); el.addEventListener('pointerdown', stop);
}

function Tile({ o, n, of, rect, focused, say, nav, pages, bodies, intents, go, render, lead, tint, accent, landed, onFocus, minimize, close, makeBig, shrink, shrinkTo, steps }: {
  o: Open & { restoreTop?: number }; n: number; of: number; rect: Rect | undefined; focused: boolean;
  say: (n: Omit<Note, 'id'>) => void; nav: (key: string) => PageNav;
  pages: React.MutableRefObject<Map<string, PageState>>; bodies: React.MutableRefObject<Map<string, HTMLElement>>;
  intents: React.MutableRefObject<Map<string, { how: trail.How; url: string; top?: number }>>;
  go: (href: string, o?: { how?: 'back' | 'forward'; top?: number }) => void;
  render: (p: PageState, go: (href: string) => void, wide: boolean) => React.ReactNode;
  lead: React.ReactNode; tint: string; accent: Accent; landed: (url: string) => void; onFocus: () => void; minimize: () => void; close: () => void; makeBig: () => void;
  /** An agent's tile: its card on the desktop, or not. */
  /** an agent's window, or the Inbox: fold it back into its widget (`shrinkTo` names it: "its card", "Needs you") */
  shrink?: () => void; shrinkTo?: string;
  /** Back and Forward for the keys (Alt+← →): true when there was somewhere to go. */
  steps: React.MutableRefObject<Map<string, (by: -1 | 1) => boolean>>;
}) {
  const myNav = useMemo(() => nav(o.key), [o.key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const p = usePage(o.url, say, myNav);
  pages.current.set(o.key, p);
  useEffect(() => { void p.load(o.url, false); return () => { pages.current.delete(o.key); }; }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (body.current) bodies.current.set(o.key, body.current); return () => { bodies.current.delete(o.key); }; }, [o.key, bodies]);
  // Back where it was: a tile brought back from the dock, or a page come back to with Back or Forward.
  const first = useRef(o.restoreTop);
  const title = titleOf(p, o);
  const [, moved] = useReducer((x: number) => x + 1, 0);
  useLayoutEffect(() => {
    if (p.waiting || p.error || !p.data) return;
    const i = intents.current.get(o.key);
    const mine = i?.url === p.url;
    if (mine) intents.current.delete(o.key);
    if (trail.note(o.key, p.url, mine ? i!.how : 'go', title || undefined)) moved();
    // Where you've been, for Find's Recent and a wide tile's Recent here: each page that opened, by its title.
    if (title) noteRecent(title, p.url);
    landed(p.url);
    const top = mine ? i!.top : first.current;
    first.current = undefined;
    if (top !== undefined && body.current) holdScroll(body.current, top);
  }, [p.url, p.data, p.waiting, p.error]);   // eslint-disable-line react-hooks/exhaustive-deps
  const back = trail.step(o.key, -1), forward = trail.step(o.key, 1);
  const step = (by: -1 | 1) => { const v = by < 0 ? back : forward; if (v) go(v.url, { how: by < 0 ? 'back' : 'forward', top: v.top }); return !!v; };
  useEffect(() => { steps.current.set(o.key, step); });
  useEffect(() => () => { steps.current.delete(o.key); }, [o.key, steps]);
  // Its own layer for pop-ups (components/ui/portal-container.ts): a sheet, a dialog, a menu or a list opened in this
  // tile renders there, over this tile only. While a dialog is open in it, the tile's own page and strip are inert, and
  // Tab goes round the dialog: focus stays in the tile; the other tiles stay usable, and nothing outside is hidden.
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!layer) return;
    const check = () => setBlocked(!!layer.querySelector(':is([role="dialog"],[role="alertdialog"])[data-state="open"]'));
    check();
    const mo = new MutationObserver(check);
    mo.observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
    const tab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const d = layer.querySelector(':is([role="dialog"],[role="alertdialog"])[data-state="open"]');
      if (!d) return;
      const t = tabbables(d);
      if (!t.length) { e.preventDefault(); return; }
      const i = t.indexOf(document.activeElement as HTMLElement);
      // Round the ends; from the dialog itself (focused when it has nothing to focus first), to its first or last.
      if (i < 0 || (e.shiftKey ? i === 0 : i === t.length - 1)) { e.preventDefault(); t[e.shiftKey ? t.length - 1 : 0].focus(); }
    };
    layer.addEventListener('keydown', tab);
    return () => { mo.disconnect(); layer.removeEventListener('keydown', tab); };
  }, [layer]);
  const arrow = (by: -1 | 1) => {
    const to = by < 0 ? back : forward, word = by < 0 ? 'Back' : 'Forward';
    return <button type="button" className="loom-tile__btn" disabled={!to} onClick={() => step(by)}
      aria-label={to ? `${word} to ${to.label ?? 'the page before'}` : `${word}: nowhere yet`}>
      <AnimatedIcon name={iconFor(by < 0 ? 'chevron-left' : 'chevron-right')} size="sm" /></button>;
  };
  const path = p.url.split('?')[0];
  // The trail: the app, as its start was last left, when this page is under it.
  const up = path !== o.key && !p.waiting ? { url: trail.lastAt(o.key, o.key)?.url ?? o.key } : undefined;
  const label = `tile ${n + 1} of ${of}, ${o.label}`;
  /** The page is called what its app is (a Comms thread before it has a title, an app's own page). */
  const named = title.trim().toLowerCase() === o.label.trim().toLowerCase();
  // A wide tile has the side column: the page's own side sections, or, when it has none, Recent here; but the only app
  // tile on the desktop (widgets don't count) with no side of its own keeps the room (Jonathan, 2026-11-06).
  const wide = (rect?.w ?? 0) >= SIDE_WIDE;
  const pageSide = !!(p.data as { page?: { sections?: { place?: string; side?: unknown }[] } } | null)?.page?.sections?.some((x) => x.place === 'side' || !!x.side);
  const recent = useMemo(() => (wide && of > 1 && !pageSide && !p.waiting ? recentHere(p.url, o.key) : []), [wide, of, pageSide, p.url, p.waiting, o.key]);
  return (
    <section className="loom-tile" role="region" aria-roledescription="tile" aria-label={label} data-tile={o.key} data-focused={focused || undefined}
      data-blocked={blocked || undefined} data-accent={accent.name}
      style={Object.assign({ '--t': tint, '--vt': vtName('tile', o.key) }, accent.style, rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { visibility: 'hidden' }) as React.CSSProperties}
      onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
      <div className="loom-tile__bar" inert={blocked || undefined} onDoubleClick={(e) => {
        // The title is the way up on a page named as its app (.loom-tile__up): a double-click there still minimizes.
        if (e.button !== 0 || (e.target as Element).closest('button, a:not(.loom-tile__up), input, select, textarea, [role="button"]')) return;
        e.preventDefault(); minimize();
      }}>
        <span className="loom-tile__key" aria-hidden>{lead}</span>
        <span className="loom-tile__steps">{arrow(-1)}{arrow(1)}</span>
        {/* The app, then the page: never the app's name twice ("COMMS › COMMS"). A page named as its app is the way up
            itself; the app's own start is its name alone. */}
        {up && !named && <a className="loom-tile__crumb" href={up.url} onClick={(e) => { e.preventDefault(); go(up.url); }}>{o.label}</a>}
        <h2 tabIndex={-1} title={title}>{up && named ? <a className="loom-tile__up" href={up.url} aria-label={`${title}: back to its start`}
          onClick={(e) => { e.preventDefault(); go(up.url); }}>{title}</a> : title}</h2>
        <span className="loom-tile__path loom-data" aria-hidden>loom{path}</span>
        <span className="loom-tile__acts">
          {/* An agent's window folds back into its card (t-1925 D; it was Pin card to the desktop), the Inbox into Needs
              you: one app, two sizes. */}
          {shrink && <button type="button" className="loom-tile__btn" onClick={shrink} aria-label={`Shrink ${o.label} to ${shrinkTo ?? 'its card'}`} title="Shrink to widget">
            <AnimatedIcon name={iconFor('minimize-2')} size="sm" /></button>}
          {n > 0 && <button type="button" className="loom-tile__btn" aria-label={`Make ${o.label} the big one`} title="Make this the big one" onClick={makeBig}>
            <AnimatedIcon name={iconFor('maximize-2')} size="sm" /></button>}
          <button type="button" className="loom-tile__btn" aria-label={`Minimize ${o.label} to the dock`} title="Minimize to the dock" onClick={minimize}>
            <AnimatedIcon name={iconFor('minus')} size="sm" /></button>
          <button type="button" className="loom-tile__btn" aria-label={`Close ${o.label}`} title="Close" onClick={close}>
            <AnimatedIcon name={iconFor('x')} size="sm" /></button>
        </span>
      </div>
      <div className="loom-tile__body" ref={body} inert={blocked || undefined}>
        <div className="loom-tile__page" aria-busy={p.waiting || !!p.pending || undefined} data-pending={p.pending && !p.waiting ? '' : undefined}><PortalContainer.Provider value={layer}>{render(p, go, wide)}</PortalContainer.Provider></div>
        {recent.length > 0 && (
          <nav className="loom-tile__side" aria-label="Recent here">
            <div className="loom-side-col">
              <h3>Recent here</h3>
              <ul>{recent.map((r) => <li key={r.href}><a href={r.href} title={r.label} onClick={(e) => { e.preventDefault(); go(r.href); }}>{r.label}</a></li>)}</ul>
            </div>
          </nav>
        )}
      </div>
      <div className="loom-tile__layer" ref={setLayer} />
    </section>
  );
}

/** A widget as a tile: where the rule puts it (absent: in the desktop's own grid), its × to take it off the desktop,
 * and its height as drawn reported for the rule (not while it's drawn compact: that's the rule's own height). */
function WidgetFrame({ id, name, named, rect, compact, measure, remove, children }: {
  id: string; name: string; named?: boolean; rect?: Rect; compact?: boolean; measure?: (h: number) => void; remove: () => void; children: React.ReactNode;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const tell = useRef(measure);
  tell.current = measure;
  const measuring = !!measure;
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || !measuring) return;
    const f = () => tell.current?.(Math.ceil(el.getBoundingClientRect().height));
    f();
    const ro = new ResizeObserver(f);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measuring]);
  return (
    <div className="loom-wtile" data-widget={id} data-compact={compact || undefined} tabIndex={-1} role="region" aria-roledescription="widget" aria-label={name}
      style={Object.assign(named ? { '--vt': vtName('w', id) } : {}, rect ? { position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h } : {}) as React.CSSProperties}>
      <div className="loom-wtile__in" ref={inner}>{children}</div>
      <button type="button" className="loom-wtile__x" aria-label={`Remove ${name} from the desktop`} title="Remove from the desktop" onClick={remove}>
        <AnimatedIcon name={iconFor('x')} size="sm" /></button>
    </div>
  );
}
