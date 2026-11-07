// A widget and its app are one app at two sizes (t-1925 D; the app mockups, 2026-11-06): an agent's card and its window,
// Needs you and the Inbox (widgets.ts pairOf). Expand grows the widget into its app's tile, Shrink folds the tile back
// into the widget. A lit outline in the widget's colour travels from one box to the other while the real one appears;
// reduced motion: no travel, the change is instant.
import { createContext } from 'react';
import { reducedMotion } from '../access';

/** What a widget and its app's tile can ask of the desktop (tiles.tsx provides it), by the widget's id. */
export type WidgetOps = {
  /** Grow a widget into its app's tile, beside the rest (from the widget's box); `href`, a page of that app to open on
   * (an item of the Inbox's), else the widget's own (widgets.ts pairOf). */
  expand: (widget: string, from?: Element | null, href?: string) => void;
  /** Fold an app's tile back into its widget (added to the desktop when it isn't there). */
  shrink: (widget: string) => void;
};
export const WidgetOpsContext = createContext<WidgetOps | null>(null);

const MS = 280;

/** The outline's trip from `from` to whatever `to` finds once it's drawn (tried for a few frames). */
export function morph(from: DOMRect | null, to: () => Element | null, color: string): void {
  if (!from || reducedMotion() || typeof document === 'undefined') return;
  // The box it travels to may only be drawn after a transition or a page load: looked for until it is, up to 2 s.
  const until = performance.now() + 2000;
  const go = () => {
    const el = to();
    const r = el?.getBoundingClientRect();
    if (!el || !r || !r.width || !r.height) { if (performance.now() < until) requestAnimationFrame(go); return; }
    const g = document.createElement('div');
    g.className = 'loom-morph';
    g.setAttribute('aria-hidden', 'true');
    g.style.setProperty('--c', color);
    Object.assign(g.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.append(g);
    const a = g.animate([
      { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, opacity: 1 },
      { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, opacity: 0.15 },
    ], { duration: MS, easing: 'cubic-bezier(.2,.8,.2,1)' });
    el.animate([{ opacity: 0, clipPath: 'inset(0 0 100% 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }], { duration: MS, easing: 'ease-out' });
    a.onfinish = a.oncancel = () => g.remove();
  };
  requestAnimationFrame(go);
}
