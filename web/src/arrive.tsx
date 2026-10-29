// Anything new on the page you're looking at arrives (Jonathan, 2026-10-29: "anything new coming in should look
// magical as fuck as it happens"): its words resolve out of noise (000h's decode, lib/cojeev/reference-additions-
// math), it comes into focus, and it glows once. Only what's new since the last answer for this same page: a page
// you open draws still, and so does everything already on it. Reduced motion: it simply appears.
import { createContext, createElement, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { decodeHeading } from '@/lib/cojeev/reference-additions-math';

/** What this page showed last time (null: a page just opened, so nothing is new), and what it shows now. */
export type Arrivals = { before: Set<string> | null; now: Set<string> };
export const ArrivalContext = createContext<Arrivals | null>(null);

const DECODE_MS = 950;
const STAGGER_MS = 70;
const MAX_TEXTS = 40;

export function Arrive({ as = 'div', k, className, children }: { as?: string; k: string; className?: string; children: ReactNode }) {
  const c = useContext(ArrivalContext);
  c?.now.add(k);
  const fresh = !!c?.before && !c.before.has(k);
  const ref = useRef<HTMLElement>(null);
  // Decided when it appears (or its content changes): a later redraw of the same thing doesn't cut it short.
  useLayoutEffect(() => {
    if (fresh && ref.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) return arrive(ref.current);
  }, [k]);   // eslint-disable-line react-hooks/exhaustive-deps
  return createElement(as, { ref, className }, children);
}

/** The arrival itself: the class runs focus and glow (index.css .loom-arrive); the text resolves here. */
function arrive(el: HTMLElement): () => void {
  el.classList.remove('loom-arrive');
  void el.offsetWidth;   // restart the animation if it's arriving again
  el.classList.add('loom-arrive');
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue?.trim() && !n.parentElement?.closest('svg,input,textarea,select,[data-slot=animated-icon]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode() && nodes.length < MAX_TEXTS) nodes.push(walker.currentNode as Text);
  const texts = nodes.map((n) => n.nodeValue ?? '');
  const wrote = [...texts];
  el.setAttribute('aria-busy', 'true');
  let start = 0, raf = 0, tick = -1;
  // A text React changed meanwhile is React's again: never written over, never "restored" to the old words.
  const mine = (i: number) => nodes[i].nodeValue === wrote[i];
  const finish = () => {
    nodes.forEach((n, i) => { if (mine(i)) n.nodeValue = texts[i]; });
    el.removeAttribute('aria-busy');
  };
  const step = (t: number) => {
    if (!start) start = t;
    const elapsed = t - start;
    const now = Math.floor(elapsed / 45);
    if (now !== tick) {
      tick = now;
      nodes.forEach((n, i) => {
        if (!mine(i)) return;
        const p = Math.max(0, Math.min(1, (elapsed - i * STAGGER_MS) / DECODE_MS));
        wrote[i] = decodeHeading(texts[i], p, now + i * 3, { scrambleLength: 12, preserveChance: 0.15, tailChance: 0.08 }).join('');
        n.nodeValue = wrote[i];
      });
    }
    if (elapsed < DECODE_MS + STAGGER_MS * nodes.length) raf = requestAnimationFrame(step);
    else finish();
  };
  raf = requestAnimationFrame(step);
  return () => { cancelAnimationFrame(raf); finish(); };
}
