// Accessibility (Jonathan, 2026-11-05): Reduce motion and Higher contrast, each the person's, kept by loom like their
// Appearance: Follow the phone (the default), On or Off. One place decides each, on <html>:
//   data-motion="reduce" | "full"     everything that moves asks this, never the media query itself
//   data-contrast="more" | "normal"   the high-contrast tokens (index.css, looks/neon.css) and the glows' off switch
// CSS: the build rewrites every @media (prefers-reduced-motion: …) and (prefers-contrast: more) into a selector on these
// attributes (vite.config.ts, accessMedia), so a stylesheet written for the media query obeys the choice. JS: what
// moves asks reducedMotion() or motionQuery() here. Before first paint, looks/boot.js sets both from this device's copy;
// the app keeps them current (App.tsx), and while one follows the phone, a change on the phone follows here.
// No React here, so it's tested on its own.

/** A choice: follow the phone's own setting, or on, or off whatever the phone says. */
export type Follow = 'follow' | 'on' | 'off';

const MOTION_Q = '(prefers-reduced-motion: reduce)';
const CONTRAST_Q = '(prefers-contrast: more)';

const root = () => document.documentElement;
export const isFollow = (v: unknown): v is Follow => v === 'follow' || v === 'on' || v === 'off';

/** Whether motion is reduced now: the one answer every animation in the app reads. */
export const reducedMotion = (): boolean => root().dataset.motion === 'reduce';

let changes: EventTarget | null = null;
/** Told whenever <html data-motion> is set (a MutationObserver, made the first time anyone listens). */
function motionChanges(): EventTarget {
  if (!changes) {
    const t = new EventTarget();
    let was = reducedMotion();
    new MutationObserver(() => { const now = reducedMotion(); if (now !== was) { was = now; t.dispatchEvent(new Event('change')); } })
      .observe(root(), { attributes: true, attributeFilter: ['data-motion'] });
    changes = t;
  }
  return changes;
}

/** In place of matchMedia('(prefers-reduced-motion: reduce)'): the same shape (matches, a change event), answering
 * the person's choice. */
export function motionQuery(): Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'> {
  return {
    get matches() { return reducedMotion(); },
    addEventListener: ((type: string, f: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => motionChanges().addEventListener(type, f, o)) as MediaQueryList['addEventListener'],
    removeEventListener: ((type: string, f: EventListenerOrEventListenerObject, o?: EventListenerOptions | boolean) => motionChanges().removeEventListener(type, f, o)) as MediaQueryList['removeEventListener'],
  };
}

/** One choice, worn on <html>: on and off as they say; follow, the phone's media query, kept up as it changes. */
function wearer(attr: 'motion' | 'contrast', query: string, yes: string, no: string) {
  let stop = () => {};
  return (pref: Follow, doc: Document = document): void => {
    stop(); stop = () => {};
    const el = doc.documentElement;
    const set = (on: boolean) => { const v = on ? yes : no; if (el.dataset[attr] !== v) el.dataset[attr] = v; };
    if (pref !== 'follow') return set(pref === 'on');
    const m = doc.defaultView?.matchMedia(query);
    set(!!m?.matches);
    if (!m) return;
    const f = () => set(m.matches);
    m.addEventListener('change', f);
    stop = () => m.removeEventListener('change', f);
  };
}

/** Reduce motion: On is reduce, Off is full motion whatever the phone asks, Follow is the phone's. */
export const wearMotion = wearer('motion', MOTION_Q, 'reduce', 'full');
/** Higher contrast: On is more, Off is normal, Follow is the phone's prefers-contrast: more. */
export const wearContrast = wearer('contrast', CONTRAST_Q, 'more', 'normal');

/** This device's copy of a choice (its next first paint), Follow when there's none or it can't be read. */
export function keptFollow(key: 'loom-motion' | 'loom-contrast'): Follow {
  try { const v = localStorage.getItem(key); return isFollow(v) ? v : 'follow'; } catch { return 'follow'; }
}
