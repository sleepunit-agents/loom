// An agent's widget and its window are one app at two sizes (t-1925 D; the app mockups, 2026-11-06): Expand grows the
// card into the window, Shrink folds the window back into the card. A lit outline in the agent's colour travels from
// one box to the other while the real one appears; reduced motion: no travel, the change is instant.
import { createContext } from 'react';
import { reducedMotion } from '../access';

/** What an agent's window and its card can ask of the desktop (tiles.tsx provides it). */
export type AgentOps = {
  /** Grow an agent's card into its window, beside it (from the card's box). */
  expand: (agent: string, from?: Element | null) => void;
  /** Fold an agent's window back into its card (added to the desktop when it isn't there). */
  shrink: (agent: string) => void;
};
export const AgentOpsContext = createContext<AgentOps | null>(null);

const MS = 280;

/** The outline's trip from `from` to whatever `to` finds once it's drawn (tried for a few frames). */
export function morph(from: DOMRect | null, to: () => Element | null, color: string): void {
  if (!from || reducedMotion() || typeof document === 'undefined') return;
  let tries = 0;
  const go = () => {
    const el = to();
    if (!el) { if (++tries < 20) requestAnimationFrame(go); return; }
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { if (++tries < 20) requestAnimationFrame(go); return; }
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
