// The tiled desktop (docs/specs/desk-tiling.md): apps share the screen by the rule (layout.ts), each in a tile with its
// own page (page.ts usePage), its own history (trail.ts, keyed as the window's was) and its own frame. Opening an app
// adds a tile, or focuses it if it's open, or brings it back if it's in the dock; the focused app's own key minimizes
// it; Home sends every app to the dock and shows the desktop, and Home again brings them back. The address is the
// focused tile's page with the set in its query (address.ts); this device keeps its last set for a bare `/`.
//
// The Appearance setting "Tiling" turns it on (App.tsx); "One window at a time" is today's window. Loaded with the
// desk's own chunk (desk.tsx), at 1024 px and wider only: a phone never fetches it.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { usePage, type PageNav, type PageState } from '../page';
import * as trail from '../trail';
import { iconFor } from '../safe';
import type { Note } from '../toasts';
import { admit, capFor, layout, promote, underMinimum, type AppTile, type Rect } from './layout';
import { nameOf, readSet, writeSet, type TileSet } from './address';
import { AGENT_FIT, fitFor, type Fit } from './fit';
import './tiles.css';

/** An app as a tile knows it: its key (the dock key it's open under, as trail.ts keys it), its label and its fit. */
export type AppRef = { key: string; label: string; fit: Fit };
type Open = AppRef & { url: string; pinned?: boolean };
type State = { apps: Open[]; min: Open[]; focus: string | null; /** what Home sent to the dock, to bring back */ home: string[] | null };

export type TilesApi = {
  /** Open a page: in its app's tile (added, focused, or back from the dock). False when it isn't a tile's (Home). */
  open: (href: string, from?: string) => boolean;
  /** A dock key: Home, the focused app's own key (minimize), or open. */
  pick: (href: string) => void;
  /** The browser's Back or Forward landed on an address. */
  pop: () => void;
  /** The desktop: every app to the dock (a link to Home). */
  desktop: () => void;
};
export type Focused = { key: string; label: string; title: string } | null;

const SAVED = 'loom-tiles';
/** A tile this wide or wider has the page's side column beside it (docs/specs/desk-tiling.md, "The frame"). */
const SIDE_WIDE = 1100;
const keepSet = (set: TileSet) => { try { localStorage.setItem(SAVED, JSON.stringify(set)); } catch { /* private window */ } };
const savedSet = (): TileSet | null => {
  try { const v = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as TileSet | null; return v && Array.isArray(v.t) && Array.isArray(v.m) ? v : null; } catch { return null; }
};
const sameOrigin = (u: URL) => u.origin === location.origin;
const titleOf = (p: PageState, o: Open): string => {
  const d = p.data as { view?: string; page?: { title?: string }; dashboard?: { label?: string } } | null;
  if (p.error || p.waiting || !d) return o.label;
  return d.page?.title || d.dashboard?.label || o.label;
};

type Named = { key: string; label: string };
/** An app's fit: an agent's pages are one kind; every other app by its label (fit.ts). */
const withFit = <T extends Named>(r: T | null): (T & { fit: Fit }) | null => (r ? { ...r, fit: r.key.startsWith('/a/') ? AGENT_FIT : fitFor(r.label) } : null);

export function TileDesk({ api, appOf: appOfRaw, byName: byNameRaw, render, home, say, lead, tint, onFocus, outerGo }: {
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
  onFocus: (f: Focused) => void;
  /** Anything that isn't a tile's (Find, signing out, another site). */
  outerGo: (href: string) => void;
}) {
  const appOf = (path: string) => withFit(appOfRaw(path));
  const byName = (name: string) => withFit(byNameRaw(name));
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const S = useRef<State>(null as unknown as State);
  // The set at first: the address's, else this device's last (a bare /, a link, a window widened back past 1024 px);
  // the page in the address opens focused in its app's tile either way.
  if (!S.current) {
    const { set, page } = readSet(location.pathname + location.search);
    const path = page.split('?')[0];
    const from = set ?? savedSet();
    const s: State = { apps: [], min: [], focus: null, home: null };
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
  });
  const addressOf = (s: State) => writeSet(s.apps.find((a) => a.key === s.focus)?.url ?? '/', set(s));
  /** The new state, and the address for it: a page change in a tile is a new entry (Back walks it); opening, closing,
   * swapping and promoting replace the one there is, so Back never closes a tile. */
  const commit = (next: State, how: 'push' | 'replace' = 'replace') => {
    S.current = next;
    const to = addressOf(next);
    if (how === 'push') history.pushState({ tile: next.focus }, '', to);
    else if (to !== location.pathname + location.search) history.replaceState({ tile: next.focus }, '', to);
    keepSet(set(next));
    bump();
  };
  const tiles = (apps: Open[]): AppTile[] => apps.map((a) => ({ id: a.key, name: a.label, fit: a.fit, ...(a.pinned ? { pinned: true } : {}) }));
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
  /** An app into the layout: placed by the rule, and whatever doesn't fit then goes to the dock, said in a toast. */
  const add = (o: Open, from?: string) => {
    const s = S.current;
    const r = admit(tiles(s.apps), tiles([o])[0], [], area, innerWidth, { from: from ? { tile: from } : undefined, usedAt: usedAt.current });
    let next: State = { ...s, min: s.min.filter((a) => a.key !== o.key), home: null };
    next.apps = r.apps.map((t) => (t.id === o.key ? o : { ...s.apps.find((a) => a.key === t.id)!, pinned: t.pinned }));
    for (const d of r.docked) {
      const gone = s.apps.find((a) => a.key === d.app.id)!;
      next = toDock({ ...next, apps: [...next.apps, gone] }, gone);
      say({ ok: true, message: d.why });
    }
    usedAt.current[o.key] = Date.now();
    next.focus = o.key;
    commit(next);
    const i = next.apps.findIndex((a) => a.key === o.key);
    announce([`${o.label} opened, tile ${i + 1} of ${next.apps.length}`, ...r.docked.map((d) => d.why)].join('. '));
  };

  const open = (href: string, from?: string): boolean => {
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
    add({ ...r, url: was && (to === r.key || to === was.url) ? back?.url ?? was.url : to, ...(back ? { restoreTop: back.top } : {}) } as Open, from);
    return true;
  };
  const minimize = (key: string) => {
    const o = S.current.apps.find((a) => a.key === key);
    if (!o) return;
    commit(toDock(S.current, o));
    announce(`${o.label} minimized to the dock`);
  };
  const close = (key: string) => {
    const s = S.current;
    const o = s.apps.find((a) => a.key === key);
    if (!o) return;
    trail.forget(key);
    const apps = s.apps.filter((a) => a.key !== key);
    commit({ ...s, apps, focus: s.focus === key ? apps[apps.length - 1]?.key ?? null : s.focus });
    announce(`${o.label} closed`);
  };
  /** While there are more apps than the cap, or one is under its minimum, the least recently used (never the focused,
   * never the pinned) goes to the dock, said in a toast. After anything that changes the set other than opening (which
   * `admit` does): the screen resized, Home again, make this the big one. */
  const shed = (s: State, why: string): State => {
    for (;;) {
      const over = s.apps.length > capFor(innerWidth) || underMinimum(tiles(s.apps), [], area, innerWidth);
      const may = s.apps.filter((a) => a.key !== s.focus && !a.pinned);
      if (!over || !may.length || !area.w) return s;
      const o = may.reduce((x, y) => ((usedAt.current[y.key] ?? 0) < (usedAt.current[x.key] ?? 0) ? y : x));
      s = toDock(s, o);
      say({ ok: true, message: `${o.label} went to the dock: ${why}` });
    }
  };
  const makeBig = (key: string) => {
    const s = S.current;
    const order = promote(tiles(s.apps), key);
    commit(shed({ ...s, apps: order.map((t) => ({ ...s.apps.find((a) => a.key === t.id)!, pinned: t.pinned })), focus: key }, 'it didn’t fit beside the big one'));
  };
  const homeKey = () => {
    const s = S.current;
    if (s.apps.length) {
      const sent = s.apps.reduce((x, o) => toDock(x, o), s);
      commit({ ...sent, home: s.apps.map((a) => a.key) });
      announce('The desktop: every app is in the dock');
      return;
    }
    if (!s.home) return;
    // Home again: back in their order.
    const back = s.home.map((k) => s.min.find((a) => a.key === k)).filter((a): a is Open => !!a)
      .map((a) => ({ ...a, url: trail.restore(a.key)?.url ?? a.url }));
    commit(shed({ ...s, apps: back, min: s.min.filter((a) => !s.home!.includes(a.key)), home: null, focus: back[0]?.key ?? null }, 'not all of them fit this screen now'));
  };

  api.current = {
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
    void p.load(to, true);
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
  // The address and this device's copy, as the set first stands.
  useEffect(() => { commit(S.current); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const s = S.current;
  const l = useMemo(() => layout(tiles(s.apps), [], area, innerWidth), [s.apps, area]);   // eslint-disable-line react-hooks/exhaustive-deps
  const f = s.apps.find((a) => a.key === s.focus) ?? null;
  const focusedTitle = f ? titleOf(pages.current.get(f.key) ?? ({ data: null } as PageState), f) : '';
  const told = useRef('');
  useEffect(() => {
    const k = f ? `${f.key}\0${f.label}\0${focusedTitle}` : '';
    if (k === told.current) return;
    told.current = k;
    onFocus(f ? { key: f.key, label: f.label, title: focusedTitle } : null);
  });

  return (
    <div className="loom-tiles" ref={box} data-count={s.apps.length}>
      {s.apps.length === 0 ? home : s.apps.map((o, i) => (
        <Tile key={o.key} o={o} n={i} of={s.apps.length} rect={l.apps[o.key]} focused={o.key === s.focus} say={say} nav={navFor}
          pages={pages} bodies={bodies} intents={intents} go={goFrom(o.key)} render={render} lead={lead(o)} tint={tint(o)}
          landed={(url) => landed(o.key, url)} onFocus={() => focus(o.key)} minimize={() => minimize(o.key)} close={() => close(o.key)} makeBig={() => makeBig(o.key)} />
      ))}
      <p className="sr-only" aria-live="polite">{said}</p>
    </div>
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

function Tile({ o, n, of, rect, focused, say, nav, pages, bodies, intents, go, render, lead, tint, landed, onFocus, minimize, close, makeBig }: {
  o: Open & { restoreTop?: number }; n: number; of: number; rect: Rect | undefined; focused: boolean;
  say: (n: Omit<Note, 'id'>) => void; nav: (key: string) => PageNav;
  pages: React.MutableRefObject<Map<string, PageState>>; bodies: React.MutableRefObject<Map<string, HTMLElement>>;
  intents: React.MutableRefObject<Map<string, { how: trail.How; url: string; top?: number }>>;
  go: (href: string, o?: { how?: 'back' | 'forward'; top?: number }) => void;
  render: (p: PageState, go: (href: string) => void, wide: boolean) => React.ReactNode;
  lead: React.ReactNode; tint: string; landed: (url: string) => void; onFocus: () => void; minimize: () => void; close: () => void; makeBig: () => void;
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
    landed(p.url);
    const top = mine ? i!.top : first.current;
    first.current = undefined;
    if (top !== undefined && body.current) holdScroll(body.current, top);
  }, [p.url, p.data, p.waiting, p.error]);   // eslint-disable-line react-hooks/exhaustive-deps
  const back = trail.step(o.key, -1), forward = trail.step(o.key, 1);
  const step = (by: -1 | 1) => { const v = by < 0 ? back : forward; if (v) go(v.url, { how: by < 0 ? 'back' : 'forward', top: v.top }); };
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
  return (
    <section className="loom-tile" role="region" aria-roledescription="tile" aria-label={label} data-tile={o.key} data-focused={focused || undefined}
      style={Object.assign({ '--t': tint }, rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { visibility: 'hidden' }) as React.CSSProperties}
      onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
      <div className="loom-tile__bar" onDoubleClick={(e) => {
        if (e.button !== 0 || (e.target as Element).closest('button, a, input, select, textarea, [role="button"]')) return;
        e.preventDefault(); minimize();
      }}>
        <span className="loom-tile__key" aria-hidden>{lead}</span>
        <span className="loom-tile__steps">{arrow(-1)}{arrow(1)}</span>
        {up && <a className="loom-tile__crumb" href={up.url} onClick={(e) => { e.preventDefault(); go(up.url); }}>{o.label}</a>}
        <h2 tabIndex={-1} title={title}>{title}</h2>
        <span className="loom-tile__path loom-data" aria-hidden>loom{path}</span>
        <span className="loom-tile__acts">
          {n > 0 && <button type="button" className="loom-tile__btn" aria-label={`Make ${o.label} the big one`} title="Make this the big one" onClick={makeBig}>
            <AnimatedIcon name={iconFor('maximize-2')} size="sm" /></button>}
          <button type="button" className="loom-tile__btn" aria-label={`Minimize ${o.label} to the dock`} title="Minimize to the dock" onClick={minimize}>
            <AnimatedIcon name={iconFor('minus')} size="sm" /></button>
          <button type="button" className="loom-tile__btn" aria-label={`Close ${o.label}`} title="Close" onClick={close}>
            <AnimatedIcon name={iconFor('x')} size="sm" /></button>
        </span>
      </div>
      <div className="loom-tile__body" ref={body}>
        <div className="loom-tile__page" aria-busy={p.waiting || undefined}>{render(p, go, (rect?.w ?? 0) >= SIDE_WIDE)}</div>
      </div>
    </section>
  );
}
