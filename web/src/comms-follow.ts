// Comms' scrolling, as Discord's and Slack's (t-1918): the thread follows its newest message only while the reader is
// at the bottom (within NEAR px); scrolled up, nothing yanks them down, and a "New messages ↓" pill counts what came
// in below. What grows above the reader (a card opening, an older message's words) keeps them where they are: the
// browser's scroll anchoring (overflow-anchor), which this never turns off. The scroller is the thread's own on a
// desktop, the page on a phone (where the page scrolls, not the thread).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Within this many pixels of the bottom, the reader is at the bottom. */
export const NEAR = 80;

/** The element that scrolls `el` into view: its nearest scrolling ancestor, else the page. */
export function scrollerOf(el: Element | null): HTMLElement {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return document.scrollingElement as HTMLElement;
}

const gap = (s: HTMLElement) => s.scrollHeight - s.scrollTop - s.clientHeight;

/**
 * Follow the bottom of a thread whose end is marked by `end` (an element after its last message). `count` is how many
 * messages it holds (each new one counts toward the pill unless it's `mine`, which always brings the reader down, as
 * sending does in every chat app). Answers the pill's count (0: none) and the way down.
 */
export function useFollow(end: React.RefObject<HTMLElement | null>, count: number, mineAt: number) {
  const near = useRef(true);
  const [unread, setUnread] = useState(0);
  const seen = useRef(count);
  const mine = useRef(mineAt);
  const down = useCallback(() => {
    const s = scrollerOf(end.current);
    s.scrollTo({ top: s.scrollHeight, behavior: 'instant' as ScrollBehavior });
    near.current = true;
    setUnread(0);
  }, [end]);
  // Where the reader is, kept on every scroll (read before new content lands, so a message arriving can't move it).
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    // Every scroll, wherever it is (scroll events don't bubble, but they can be caught on the way down): the thread's own
    // scroller may only become one once its words outgrow it, after this first runs.
    const on = (e: Event) => {
      const s = scrollerOf(el);
      const t = e.target === document ? document.scrollingElement : e.target;
      if (t !== s) return;
      near.current = gap(s) <= NEAR;
      if (near.current) setUnread(0);
    };
    document.addEventListener('scroll', on, { passive: true, capture: true });
    // The thread's own scroller can appear once its words outgrow it: look again when anything resizes.
    const ro = new ResizeObserver(() => {
      const t = scrollerOf(el);
      // Grown while the reader was at the bottom (a working line, a card, an image): stay at the bottom.
      if (near.current) t.scrollTo({ top: t.scrollHeight, behavior: 'instant' as ScrollBehavior });
    });
    ro.observe(el.parentElement ?? el);
    return () => { document.removeEventListener('scroll', on, { capture: true }); ro.disconnect(); };
  }, [end]);
  // First drawn: at the bottom.
  useLayoutEffect(() => { down(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // New messages: followed when the reader was at the bottom, or when they're the reader's own; else counted.
  useLayoutEffect(() => {
    const added = count - seen.current;
    seen.current = count;
    const sent = mineAt > mine.current;
    mine.current = mineAt;
    if (added <= 0 && !sent) return;
    if (near.current || sent) down();
    else setUnread((n) => n + added);
  }, [count, mineAt, down]);
  return { unread, down };
}
