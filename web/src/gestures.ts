// A phone's gestures (Jonathan, 2026-11-04: "swipe gestures to make it feel more like an OS. Maybe left/right swaps
// between pages? Up from the bottom (but obviously not the very bottom) could bring up search"):
//
// - Sideways, on one of the dock's own pages (Home, Inbox, Places, More, in the dock's order): the page follows the
//   finger a little and, on a clear sideways swipe (past 60 px and more than twice as far across as down, or a fast
//   flick), the next or the last one opens. Never from something that scrolls sideways itself (a table, code, the
//   ticker), a row of choices (the Inbox's chips), a field or a selection, nor while a sheet, Find or a dialog is open.
//   In Safari, 24 px at each edge are iOS's (its own back and forward); in the home-screen app they're the page's. A
//   page with a way back (a crumb) has no gestures yet.
// - Up, from the dock (its keys and the strip over them) or Find's pill: past 50 px opens Find. Never from the phone's
//   home-bar inset, iOS's own. A tap on a key is still a tap, and a held key still shows its name.
//
// A second finger lets go of a swipe (it runs back). Pointer events, passive, on the document; the page is `touch-action: pan-y` (index.css html[data-gestures]) so its
// own scrolling never waits on them. The sideways swipe drives the page's own move (transitions.ts), so a swipe and a
// tap on the dock look the same; where pages don't move, the page just leans with the finger. Under reduced motion
// nothing follows the finger, and the pages still change (with the tap's crossfade).
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Move, Scrub } from './transitions';
import { reducedMotion } from './access';

export type GestureSetup = {
  /** The dock's own pages, in its order (hrefs); empty where sideways swipes don't apply. */
  pages: string[];
  /** Which of them is shown: -1 for any other page. */
  here: number;
  /** A page with a way back: no gestures at all (a back swipe is a later question). */
  sub: boolean;
  go: (href: string) => void;
  find: () => void;
  /** Something over the page (a sheet, Find, a dialog). */
  busy: () => boolean;
  /** A light tick (haptic.tsx buzz), when a swipe commits. */
  buzz: () => void;
  /** Show `href` with its move held under the finger (transitions.ts scrub), or null where pages don't move. */
  begin: (href: string, how: Move) => Scrub | null;
};

/** How far a swipe goes before it counts, in CSS px; the edges that are Safari's own. */
export const SIDE = 60, UP = 50, EDGE = 24;
/** How much of the finger's travel the page follows, and at the end of the row (nowhere to go). */
const FOLLOW = 0.35, END = 0.12;

const standalone = () => document.documentElement.classList.contains('loom-ios-app') || matchMedia('(display-mode: standalone)').matches;

let probe: HTMLElement | null = null;
/** The phone's home-bar inset (env(safe-area-inset-bottom)), in px. */
function homeBar(): number {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none';
    probe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probe);
  }
  return probe.offsetHeight;
}

/** What a sideways swipe never starts in: what takes a sideways touch itself, or a choice, or what you're typing in. */
const OWN = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),pre,table,.loom-tick,[role="group"],[role="toolbar"],[role="tablist"],[role="radiogroup"],[role="slider"],[data-no-swipe],.loom-dock-bar,.loom-find-pill,[role="dialog"],[role="alertdialog"]';
function sideways(t: Element): boolean {
  if (t.closest(OWN)) return false;
  for (let e: Element | null = t; e && e !== document.body; e = e.parentElement) {
    const x = getComputedStyle(e).overflowX;
    if ((x === 'auto' || x === 'scroll') && e.scrollWidth > e.clientWidth + 1) return false;
  }
  return true;
}

/** A swipe's last click goes nowhere (the finger lifted on a key or a link it started on). */
function swallowClick(): void {
  const f = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
  addEventListener('click', f, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', f, { capture: true }), 400);
}

const settle = (el: HTMLElement, transform: string, opacity = '') => {
  el.style.transition = 'transform var(--t-max, 300ms) var(--enter, ease-out), opacity var(--t-max, 300ms) var(--enter, ease-out)';
  el.style.transform = transform; el.style.opacity = opacity;
  const done = () => { el.style.transition = ''; if (!el.style.transform || el.style.transform === 'none') { el.style.transform = ''; el.style.opacity = ''; } };
  el.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 450);
};

/** Wire the gestures to the document while `on`; the setup is read fresh at each touch. */
export function attachGestures(get: () => GestureSetup): () => void {
  type G = { id: number; x0: number; y0: number; t0: number; kind: 'side' | 'up'; locked: boolean; el: HTMLElement | null;
    /** The page a sideways swipe goes to (-1, 1: the dock's next or last), and its move under the finger. */
    dir?: -1 | 1; to?: string; scrub?: Scrub | null };
  let g: G | null = null;
  const moving = (k: G) => !reducedMotion() && !!k.el;
  const reset = (k: G) => { if (k.el && k.el.style.transform) settle(k.el, ''); };
  /** Let a gesture go without it counting: a held move runs back, a leaning page settles. */
  const drop = (k: G) => { if (k.scrub) void k.scrub.end(false); else reset(k); };

  const down = (e: PointerEvent) => {
    // A second finger is a pinch, not a swipe: whatever the first was doing is let go, run back.
    if (g) { drop(g); g = null; return; }
    if (e.pointerType === 'mouse' || !e.isPrimary || !(e.target instanceof Element)) return;
    const s = get();
    if (s.sub || s.busy()) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return;
    const t = e.target;
    if (t.closest('.loom-dock-bar, .loom-find-pill')) {
      // Up from the dock or the pill; never from the home bar's inset.
      if (e.clientY >= innerHeight - homeBar()) return;
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, kind: 'up', locked: false, el: document.querySelector<HTMLElement>('.loom-find-pill') };
      return;
    }
    if (s.here < 0 || !s.pages.length || !t.closest('#root')) return;
    if (!standalone() && (e.clientX < EDGE || e.clientX > innerWidth - EDGE)) return;
    if (!sideways(t)) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, kind: 'side', locked: false, el: document.querySelector<HTMLElement>('main') };
  };

  const move = (e: PointerEvent) => {
    const k = g;
    if (!k || e.pointerId !== k.id) return;
    const dx = e.clientX - k.x0, dy = e.clientY - k.y0;
    if (k.kind === 'side') {
      if (!k.locked) {
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) { g = null; return; }   // the page's own scroll
        if (Math.abs(dx) > 10 && Math.abs(dx) > 2 * Math.abs(dy)) {
          k.locked = true;
          const s = get();
          k.dir = dx < 0 ? 1 : -1;
          k.to = s.pages[s.here + k.dir];
          // The page's own move, held under the finger (none under reduced motion: the release changes the page).
          if (k.to && !reducedMotion()) k.scrub = s.begin(k.to, k.dir > 0 ? 'right' : 'left');
        }
      }
      if (!k.locked) return;
      if (k.scrub) { k.scrub.at(Math.max(0, -dx * k.dir!) / innerWidth); return; }
      if (moving(k)) {
        k.el!.style.transition = 'none';
        k.el!.style.transform = `translateX(${(dx * (k.to ? FOLLOW : END)).toFixed(1)}px)`;
      }
      return;
    }
    if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) { reset(k); g = null; return; }
    if (dy < -14) k.locked = true;   // past a tap's wobble
    if (k.locked && moving(k)) { k.el!.style.transition = 'none'; k.el!.style.transform = `translateY(${Math.max(dy * 0.3, -24).toFixed(1)}px)`; }
  };

  const up = (e: PointerEvent) => {
    const k = g;
    if (!k || e.pointerId !== k.id) return;
    g = null;
    const dx = e.clientX - k.x0, dy = e.clientY - k.y0, dt = Math.max(1, e.timeStamp - k.t0);
    const s = get();
    if (k.kind === 'up') {
      reset(k);
      if (k.locked && Math.hypot(dx, dy) > 16) swallowClick();
      if (dy < -UP && Math.abs(dy) > Math.abs(dx)) { s.buzz(); s.find(); }
      return;
    }
    const clear = Math.abs(dx) > 2 * Math.abs(dy);
    const flick = Math.abs(dx) > 30 && Math.abs(dx) / dt > 0.5;
    const to = k.locked && (dx < 0 ? 1 : -1) === k.dir ? k.to : undefined;
    if (k.locked && Math.hypot(dx, dy) > 16) swallowClick();
    const commit = clear && (Math.abs(dx) > SIDE || flick) && !!to;
    if (k.scrub) { if (commit) s.buzz(); void k.scrub.end(commit); return; }
    if (!commit) { reset(k); return; }
    s.buzz();
    s.go(to!);
    // The new page comes in from the side the finger went to.
    if (moving(k)) {
      const el = k.el!;
      el.style.transition = 'none';
      el.style.transform = `translateX(${dx < 0 ? 28 : -28}px)`; el.style.opacity = '.4';
      requestAnimationFrame(() => requestAnimationFrame(() => settle(el, '', '')));
    }
  };

  const cancel = (e: PointerEvent) => { const k = g; if (k && e.pointerId === k.id) { drop(k); g = null; } };

  const o = { capture: true, passive: true } as const;
  addEventListener('pointerdown', down, o);
  addEventListener('pointermove', move, o);
  addEventListener('pointerup', up, o);
  addEventListener('pointercancel', cancel, o);
  document.documentElement.dataset.gestures = '';
  return () => {
    removeEventListener('pointerdown', down, o);
    removeEventListener('pointermove', move, o);
    removeEventListener('pointerup', up, o);
    removeEventListener('pointercancel', cancel, o);
    delete document.documentElement.dataset.gestures;
  };
}

/** The gestures, while `on` (a phone's width, with the dock). */
export function useGestures(on: boolean, setup: GestureSetup): void {
  const ref = useRef(setup);
  useLayoutEffect(() => { ref.current = setup; });
  useEffect(() => (on ? attachGestures(() => ref.current) : undefined), [on]);
}
