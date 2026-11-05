// How a phone's page changes (Jonathan, 2026-11-04: something "future Steve Jobs" would sign off on: restrained,
// physical, quick). The View Transitions API, same-document: only the page (main) moves and the page's name
// crossfades; the phone bar, the dock, its fade and Find's pill stay where they are (index.css, "Page moves").
//
// - Between the dock's own pages, by the dock's order: going right the new page comes in from the right and the old one
//   gives way a quarter of that, a little dimmed; going left, the mirror.
// - Into a page under this one, a push from the right; back up, a pop (the old page slides off to the right over the
//   one it came from).
// - Reduced motion: a short crossfade. No API (an older browser), or a desktop: the page simply changes.
//
// A swipe drives the same transition (scrub): started as the finger commits to a direction, held, moved with the
// finger, then let run to its end or run back, on the same curve as a tap's.
export type Move = 'right' | 'left' | 'push' | 'pop';

/** The moves' length and curve (index.css keeps the same two: --loom-move-t, --loom-move-ease). */
export const MOVE_MS = 280;
const EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];

type VT = { ready: Promise<void>; finished: Promise<void>; skipTransition: () => void };
type Doc = Document & { startViewTransition?: (update: () => void) => VT };

/** Whether this page can move at all (the API, and a phone's width: the dock). */
export const canMove = (): boolean => typeof (document as Doc).startViewTransition === 'function' && !matchMedia('(min-width: 1024px)').matches;

/** Change the page with a move: `update` must change the DOM synchronously (flushSync). Without the API, just `update`. */
export function moveTo(how: Move | undefined, update: () => void): VT | null {
  const d = document as Doc;
  if (!how || !canMove()) { update(); return null; }
  const root = document.documentElement;
  root.dataset.move = how;
  const vt = d.startViewTransition!(update);
  const done = () => { if (root.dataset.move === how) delete root.dataset.move; };
  vt.finished.then(done, done);
  return vt;
}

/** The move's own animations (its pseudo-elements'), once it's ready. */
const animsOf = (): Animation[] => document.getAnimations().filter((a) => {
  const pe = (a.effect as KeyframeEffect | null)?.pseudoElement;
  return !!pe && pe.startsWith('::view-transition');
});

/** The time (0..1) at which the move's curve reaches `p` of the way: so a scrubbed page sits exactly under the finger. */
export function timeAt(p: number, [x1, y1, x2, y2] = EASE): number {
  const bez = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  p = Math.min(1, Math.max(0, p));
  let lo = 0, hi = 1;
  for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; if (bez(m, y1, y2) < p) lo = m; else hi = m; }
  return bez((lo + hi) / 2, x1, x2);
}

export type Scrub = { to: (p: number) => void; end: (commit: boolean, back?: () => void) => Promise<boolean> };

/** Hold a move under the finger: `to(p)` places it `p` of the way; `end` lets it finish or run back (true: it finished). */
export function scrub(vt: VT): Scrub {
  let anims: Animation[] | null = null;
  let at = 0;
  const place = () => { for (const a of anims ?? []) a.currentTime = timeAt(at) * MOVE_MS; };
  const ready = vt.ready.then(() => { anims = animsOf(); for (const a of anims) a.pause(); place(); }).catch(() => { anims = []; });
  return {
    to: (p) => { at = p; if (anims) place(); },
    end: async (commit, back) => {
      await ready;
      for (const a of anims ?? []) { if (!commit) a.playbackRate = -1; a.play(); }
      // Run back: the page it left goes back under the move as its last frame plays, so the other is never seen bare.
      if (!commit) { await Promise.all((anims ?? []).map((a) => a.finished.catch(() => {}))); back?.(); }
      await vt.finished.catch(() => {});
      return commit;
    },
  };
}
