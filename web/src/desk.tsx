// Neon Noir on a big screen (Jonathan, 2026-11-05, the desktop OS prototype's "Level 1: Shell": "if 1 is done well,
// there's no need to do [the others]"). Home is a desktop: widgets on the ground, each drawn from what Home already
// has (src/ui/handler.ts house-home): what needs you, answered where it stands; one card per agent with its face and
// what it's on; the pieces' own tiles; the nightly backup. Never a number loom doesn't have.
//
// Its own chunk, loaded only on a screen this wide under Neon (App.tsx): a phone never fetches it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readRecent } from './recent';
import { visited } from './trail';
import './desk.css';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import type { Shell } from './loom';
import { Agent, BackupW, Needs, NoAgents, Vitals, type DeskHomeData } from './desk-widgets';
export type { DeskHomeData } from './desk-widgets';
import { reducedMotion } from './access';
// The tiled desktop (tiling/tiles.tsx, docs/specs/desk-tiling.md), in this chunk: a phone never fetches it.
export { TileDesk } from './tiling/tiles';

// ---- the desktop --------------------------------------------------------------------------------

export function DeskHome({ home, shell }: { home: DeskHomeData; shell: Shell }) {
  // Back from a window: focus on the dock key it came from, or Home's.
  useEffect(() => {
    if (!closing) return;
    const k = keyFor(closing) ?? keyFor('/');
    closing = null;
    k?.focus({ preventScroll: true });
  }, []);
  const backup = shell.backup;
  return (
    <div className="loom-desk-home">
      {/* How everyone is, across the top: above all three columns, never inside one, so their first widgets share a
          top edge (Jonathan, 2026-11-05). What each agent is on is its own card's: no strip repeats it. */}
      <p className="loom-desk-headline">{home.headline}</p>
      <div className="loom-desk-col loom-desk-col--left">
        <Needs d={home} />
      </div>
      <div className="loom-desk-col loom-desk-col--mid">
        {home.cards.length === 0 ? <NoAgents />
          : <div className="loom-desk-agents">{home.cards.map((c) => <Agent key={c.id} c={c} />)}</div>}
      </div>
      <div className="loom-desk-col loom-desk-col--right">
        <Vitals shell={shell} />
        {backup && <BackupW b={backup} />}
      </div>
    </div>
  );
}

// ---- an app's window -----------------------------------------------------------------------------

type Tab = { label: string; href: string };
/** The household dock's places, as App.tsx last drew them (DeskKeys), for the key a window grows out of. */
let tabs: Tab[] = [];
/** The page a window was closed from, for focus to go back to its key. */
let closing: string | null = null;

/** The dock key for the place a page is in. */
function keyFor(href: string): HTMLElement | null {
  const t = tabs.filter((x) => !x.href.startsWith('#')).find((x) => href === x.href || (x.href !== '/' && href.startsWith(`${x.href}/`)));
  return t ? document.querySelector<HTMLElement>(`.loom-dock-bar [data-part="item"][aria-label="${CSS.escape(t.label)}"]`) : null;
}

type VT = { finished: Promise<void> };
type Doc = Document & { startViewTransition?: (update: () => void) => VT };

/**
 * Going into an app from the desktop, or home from one: the window grows out of its dock key and shrinks back into it,
 * the desktop crossfading behind (View Transitions, desk.css). Its own attribute (data-desk-move), so none of a phone's
 * page moves apply. A window opened from Find or a link has no key: it simply grows in. Reduced motion (access.ts), or
 * no API: the page simply changes. Returns false for any other change (App.tsx moves it as it would).
 */
export function deskGo(from: string, to: string, update: () => void): boolean {
  const how = from === '/' && to !== '/' ? 'open' : from !== '/' && to === '/' ? 'close' : undefined;
  if (!how) return false;
  if (how === 'close') closing = from;
  const d = document as Doc;
  const root = document.documentElement;
  if (typeof d.startViewTransition !== 'function' || reducedMotion()) { update(); return true; }
  root.dataset.deskMove = how;
  let named: HTMLElement | null = how === 'open' ? keyFor(to) : null;
  if (named) named.style.viewTransitionName = 'loom-win';
  const vt = d.startViewTransition(() => {
    // One element per name in each state: the key gives its name to the window, or takes it back.
    if (named) named.style.viewTransitionName = '';
    update();
    if (how === 'close') { named = keyFor(from); if (named) named.style.viewTransitionName = 'loom-win'; }
  });
  const done = () => { if (root.dataset.deskMove === how) delete root.dataset.deskMove; if (named) named.style.viewTransitionName = ''; };
  vt.finished.then(done, done);
  return true;
}

/** Something open that Esc must leave alone: a sheet, a dialog, a list or a menu (Radix's, in a portal). */
const popUpOpen = () => !!document.querySelector(':is([role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]):not([data-state="closed"])');
/** A field has the keys. */
const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable); };

/** The desktop's keys: Esc closes the window back to the desktop (`close`: App.tsx, which forgets where it was), not
 * while a sheet, a dialog, a list or a menu is open (Esc closes that), nor while a field has the keys (Esc there is the
 * field's). And the dock's places, for keyFor. */
export function DeskKeys({ close, places }: { close: () => void; places: Tab[] }) {
  tabs = places;
  const now = useRef(close);
  now.current = close;
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || location.pathname === '/' || popUpOpen() || typing()) return;
      e.preventDefault();
      now.current();
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  return null;
}

type Crumb = { label: string; href: string };
type Step = { url: string; label?: string } | undefined;

/** A page the window's side column offers when the page puts nothing there itself: in this app, by its path. */
const inApp = (href: string, app?: string) => { const p = href.split('?')[0]; return !!app && (p === app || p.startsWith(`${app}/`)); };

/** The trail in a window's strip (Jonathan, 2026-11-05: "back/breadcrumbs/etc first"): the app, the page this one is
 * under, then this one's title. When it's longer than the strip, everything between the app and this page folds into
 * "…" (a link to the page just above this one) before the title is cut short; a title that still doesn't fit ends in
 * an ellipsis. It never scrolls. */
function Trail({ crumbs, title, head, go }: { crumbs: Crumb[]; title: string; head: React.RefObject<HTMLHeadingElement | null>; go: (href: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  const key = crumbs.map((c) => c.label).join('\0') + '\0' + title;
  useLayoutEffect(() => { setFolded(false); }, [key]);
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    // Whole, and the page's own title not cut short: the middle of the trail gives way before the page's name does.
    const h = head.current;
    const fits = () => b.scrollWidth <= b.clientWidth + 1 && (!h || h.scrollWidth <= h.clientWidth + 1);
    const check = () => { if (!folded && crumbs.length > 1 && !fits()) setFolded(true); };
    check();
    // Narrower: fold if it no longer fits. Wider again: try it whole (and fold again if it still doesn't fit).
    let w = b.clientWidth;
    const ro = new ResizeObserver(() => { if (folded && b.clientWidth > w + 1) setFolded(false); else check(); w = b.clientWidth; });
    ro.observe(b);
    return () => ro.disconnect();
  }, [key, folded, crumbs.length]);
  const shown: Array<Crumb & { more?: string }> = folded && crumbs.length > 1
    ? [crumbs[0], { ...crumbs[crumbs.length - 1], label: '…', more: crumbs.slice(1).map((c) => c.label).join(' › ') }] : crumbs;
  return (
    <div className="loom-window__where" ref={box}>
      {shown.length > 0 && (
        <nav className="loom-window__trail" aria-label="Where you are">
          <ol>{shown.map((c, i) => (
            <li key={i}><a href={c.href} title={c.more ?? c.label} aria-label={c.more ? `Up to ${c.more}` : undefined}
              onClick={(e) => { e.preventDefault(); go(c.href); }}>{c.label}</a></li>
          ))}</ol>
        </nav>
      )}
      <h2 id="loom-window-title" tabIndex={-1} ref={head} title={title}>{title || ' '}</h2>
    </div>
  );
}

/** One big window over the ground (desk.css): its title strip in the app's colour (its key, Back and Forward in this
 * app's own history, the trail to where it is, Close (and Esc) back to the desktop); a double-click on the strip (not
 * on a control in it) minimizes it, as its open key does (App.tsx). Alt+← and Alt+→ are its Back and Forward while the
 * window has the keys, and only when it has somewhere to go that way: otherwise (and with a field, a sheet or a menu
 * taking the keys, or the dock or Find having them) they stay the browser's own. Focus goes to its title as each page
 * opens in it, once per page (a page drawn again, Try again or a refresh, leaves focus be).
 *
 * At 1280 px and wider it has a side column (App.tsx SIDE_COLUMN): the page's own side sections, drawn into it, or,
 * when the page has none, Recent here: the pages of this app you've been to lately. Nothing in it scrolls sideways. */
export function DeskWindow({ tint, lead, title, url, waiting, go, close, minimize, crumbs, back, forward, move, side, children }: {
  tint: string; lead: React.ReactNode; title: string; url: string; waiting: boolean;
  go: (href: string) => void; close: () => void; minimize: () => void;
  crumbs: Crumb[]; back: Step; forward: Step; move: (by: -1 | 1) => void;
  /** The side column, when the screen has room for it: whether the page has sections for it, where they're drawn, and
   * for Recent here the app (its key, as its history has it) and the path its pages are under. */
  side?: { has: boolean; el: (e: HTMLElement | null) => void; app?: string; under?: string };
  children: React.ReactNode }) {
  const head = useRef<HTMLHeadingElement>(null);
  const focusedFor = useRef('');
  useEffect(() => {
    if (waiting || focusedFor.current === url) return;
    focusedFor.current = url;
    head.current?.focus({ preventScroll: true });
  }, [url, waiting]);
  const now = useRef({ back, forward, move });
  now.current = { back, forward, move };
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.defaultPrevented) return;
      if (typing() || popUpOpen()) return;
      const a = document.activeElement;
      if (a && a !== document.body && !a.closest('.loom-window')) return;
      const by = e.key === 'ArrowLeft' ? -1 : 1;
      if (!(by < 0 ? now.current.back : now.current.forward)) return;
      e.preventDefault();
      now.current.move(by);
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  // Recent here: this app's pages, as its own history has them (one Setup window holds Appearance and Accessibility
  // alike), then the ones this device opened under its path in earlier visits. Never another app's.
  const app = side?.app, under = side?.under;
  const recent = useMemo(() => {
    const seen = new Set([url]);
    return [...visited(app).filter((v) => v.label).map((v) => ({ href: v.url, label: v.label! })), ...readRecent().filter((r) => inApp(r.href, under))]
      .filter((r) => !seen.has(r.href) && (seen.add(r.href), true)).slice(0, 8);
  }, [url, app, under]);
  const path = url.split('?')[0];
  const arrow = (by: -1 | 1, to: Step) => {
    const word = by < 0 ? 'Back' : 'Forward';
    return (
      <button type="button" className="loom-window__step" disabled={!to} onClick={() => move(by)}
        aria-label={to ? `${word} to ${to.label ?? 'the page before'}` : `${word}: nowhere yet`} title={`${word} (Alt+${by < 0 ? '←' : '→'})`}>
        <AnimatedIcon name={iconFor(by < 0 ? 'chevron-left' : 'chevron-right')} size="sm" /></button>
    );
  };
  return (
    <section className="loom-window" aria-labelledby="loom-window-title" style={{ '--t': tint } as React.CSSProperties}>
      <div className="loom-window__bar" onDoubleClick={(e) => {
        if (e.button !== 0 || (e.target as Element).closest('button, a, input, select, textarea, [role="button"]')) return;
        e.preventDefault();
        minimize();
      }}>
        <span className="loom-window__key" aria-hidden>{lead}</span>
        <span className="loom-window__steps">{arrow(-1, back)}{arrow(1, forward)}</span>
        <Trail crumbs={crumbs} title={title} head={head} go={go} />
        <span className="loom-window__path loom-data" aria-hidden>loom{path}</span>
        <button type="button" className="loom-window__close" aria-label="Close, back to the desktop" title="Close (Esc)" onClick={close}>
          <AnimatedIcon name={iconFor('x')} size="sm" /></button>
      </div>
      <div className="loom-window__body">
        {children}
        {side?.has ? <aside className="loom-window__side" aria-label="More on this page" ref={side.el} />
          : side && recent.length > 0 && (
          <nav className="loom-window__side" aria-label="Recent here">
            <div className="loom-side-col">
              <h3>Recent here</h3>
              <ul>{recent.map((r) => <li key={r.href}><a href={r.href} title={r.label} onClick={(e) => { e.preventDefault(); go(r.href); }}>{r.label}</a></li>)}</ul>
            </div>
          </nav>
        )}
      </div>
    </section>
  );
}

// ---- the boot ----------------------------------------------------------------------------------

/** How long the boot stands before it leaves by itself, and how long it takes to leave (desk.css .loom-boot's fade). */
const BOOT_MS = 2200;
const BOOT_FADE_MS = 250;
/** When its last line (the licence) is up: every line is in by then, however many agents the household has. */
const BOOT_LINES_MS = 1100;

/** A name as a licence has it: "Jonathan Barket" → "Jonathan B."; one word stays as it is. */
const initialled = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  const first = w[0][0].toUpperCase() + w[0].slice(1);
  return w.length > 1 ? `${first} ${w[w.length - 1][0].toUpperCase()}.` : first;
};

type BootLine = { k: string; v: string; tone?: 'ok' | 'warn' };

/** What the boot says: only what the shell has. The link, the household and how each agent is (loom's own words for
 * it), the apps in its dock, what needs you, and the licence line, which is the one joke. */
function bootLines(shell: Shell, offline: boolean): BootLine[] {
  const n = shell.agents.length;
  const apps = shell.pieces.length;
  const shown = shell.agents.filter((a) => a.sub).slice(0, 5);
  const more = n - shown.length;
  return [
    { k: 'link', v: offline ? 'offline · saved copy' : 'live', tone: offline ? 'warn' : 'ok' },
    { k: 'household', v: `${n} agent${n === 1 ? '' : 's'}` },
    ...shown.map((a) => ({ k: a.label.toLowerCase(), v: a.sub! })),
    ...(more > 0 && shown.length ? [{ k: `+${more} more`, v: '' }] : []),
    { k: 'apps', v: String(apps) },
    { k: 'needs you', v: String(shell.asks), ...(shell.asks ? { tone: 'warn' as const } : {}) },
    { k: 'validating LOOM//OS™ license', v: 'compliant', tone: 'ok' },
  ];
}

/**
 * A desktop's boot (Jonathan, the prototype's power-on): once a session, never under reduced motion (App.tsx decides,
 * and runs the app's own arrival after it), a couple of seconds of a machine coming up. Its chatter is what loom has;
 * the licence line is the joke. Any key or tap skips it, and a tap that skips it presses nothing under it. It never takes
 * focus, and a screen reader doesn't hear it.
 */
export function DeskBoot({ shell, offline, onDone }: { shell: Shell; offline: boolean; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  // Who it's licensed to: the household owner's name as People has it ("Jonathan Barket"), as Find asks for it; until
  // that answers, the name loom's shell has.
  const [name, setName] = useState(shell.owner);
  useEffect(() => {
    const c = new AbortController();
    fetch('/find', { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: c.signal }).then((r) => r.json())
      .then((d: { suggest?: { people?: { label: string; href: string }[] } }) => {
        const me = d.suggest?.people?.find((p) => p.href === `/people/${shell.owner}`);
        if (me?.label) setName(me.label);
      }).catch(() => {});
    return () => c.abort();
  }, [shell.owner]);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let t2: ReturnType<typeof setTimeout> | undefined;
    const leave = () => { setLeaving(true); t2 = setTimeout(() => done.current(), BOOT_FADE_MS); };
    const t1 = setTimeout(leave, BOOT_MS);
    const skip = (e: Event) => { if (e.type === 'pointerdown') e.preventDefault(); clearTimeout(t1); if (!t2) leave(); };
    addEventListener('keydown', skip, true); addEventListener('pointerdown', skip, true);
    return () => { clearTimeout(t1); clearTimeout(t2); removeEventListener('keydown', skip, true); removeEventListener('pointerdown', skip, true); };
  }, []);
  const lines = bootLines(shell, offline);
  const step = (BOOT_LINES_MS - 350) / Math.max(1, lines.length - 1);
  return (
    <div className="loom-boot" data-leaving={leaving || undefined} aria-hidden="true">
      <div className="loom-boot__panel">
        <p className="loom-boot__brand">LOOM<i>//</i>OS<sup>™</sup></p>
        <p className="loom-boot__lic">licensed to {initialled(name)}</p>
        <ol className="loom-boot__log">
          {lines.map((l, i) => (
            <li key={i} style={{ '--at': `${Math.round(350 + i * step)}ms` } as React.CSSProperties}>
              <span className="loom-boot__k">{l.k}</span><span className="loom-boot__dots" /><span className="loom-boot__v" data-tone={l.tone}>{l.v}</span></li>
          ))}
        </ol>
        <p className="loom-boot__skip">any key to skip</p>
      </div>
    </div>
  );
}

/** Whether a desktop boots now: not yet this session (nor the app's arrival), and motion allowed (access.ts). Marked at
 * once, so a reload in the middle of it doesn't boot again. */
export function bootsNow(): boolean {
  if (reducedMotion()) return false;
  try {
    if (sessionStorage.getItem('loom-arrived') || sessionStorage.getItem('loom-booted')) return false;
    sessionStorage.setItem('loom-booted', '1');
    return true;
  } catch { return false; }
}
