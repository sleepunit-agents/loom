// The dock's keys, when they're swapped for another set (the household's for an agent's own, and back): the old keys
// slide down off the screen and the new ones rise in, a key at a time (index.css, "Dock swap"). The dock's rule and its
// bar stay put. Going back runs the other way. Reduced motion: a quick fade.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** How long the old keys stay to leave (ms): the slide's length and its stagger, with room. */
const LEAVE_MS = 320;

export function DockSwap({ id, children }: { id: string; children: ReactNode }) {
  const last = useRef<{ id: string; node: ReactNode }>({ id, node: children });
  const [gone, setGone] = useState<{ id: string; node: ReactNode; back: boolean } | null>(null);
  // On a new set: the last one's keys stay a moment to leave (read before the next effect keeps this render's).
  useLayoutEffect(() => {
    const was = last.current;
    if (was.id === id) return;
    setGone({ id: was.id, node: was.node, back: id === 'household' });   // back to the household's own dock: the way back
    const t = setTimeout(() => setGone(null), LEAVE_MS);
    return () => clearTimeout(t);
  }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { last.current = { id, node: children }; });
  return (
    <div className="loom-dock-swap" data-swap={gone ? (gone.back ? 'back' : 'go') : undefined}>
      {gone && <div key={`gone:${gone.id}`} className="loom-dock-gone" aria-hidden inert>{gone.node}</div>}
      <div key={id} className="loom-dock-now">{children}</div>
    </div>
  );
}
