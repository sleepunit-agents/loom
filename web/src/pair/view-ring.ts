import { useEffect, useState } from 'react';
import { ticketView, viewKey, type View } from './ticket-view';

interface Ring {
  views: View[];
  active: View | null;
}
function restore(key: string, root?: string): Ring {
  const base: View | undefined = root ? { ...ticketView(root), intent: 'work' } : undefined;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (Array.isArray(saved?.views)) {
      const views: View[] = saved.views.filter(
        (v: View) =>
          v &&
          /^t-\d+$/.test(v.ticket) &&
          (v.kind === 'ticket' || (['pull', 'comment'].includes(v.kind) && typeof v.ref === 'string')),
      );
      if (base && !views.some((v) => viewKey(v) === viewKey(base))) views.unshift(base);
      const focus = base && saved.root !== root ? viewKey(base) : saved.active;
      return { views, active: views.find((v) => viewKey(v) === focus) || views[0] || null };
    }
  } catch {
    /* Storage may be unavailable. */
  }
  const views = base ? [base] : [];
  return { views, active: views[0] || null };
}
export function useViewRing(key: string, root?: string) {
  const [ring, set] = useState(() => restore(key, root));
  useEffect(() => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ root, views: ring.views, active: ring.active && viewKey(ring.active) }),
      );
    } catch {
      /* Keep views in memory. */
    }
  }, [key, root, ring]);
  useEffect(() => {
    if (ring.views.length < 2) return;
    const cycle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.altKey || event.code !== 'Backquote') return;
      event.preventDefault();
      set((old) => {
        const step = event.shiftKey ? -1 : 1;
        const next = (old.views.indexOf(old.active!) + step + old.views.length) % old.views.length;
        return { ...old, active: old.views[next] };
      });
    };
    window.addEventListener('keydown', cycle);
    return () => window.removeEventListener('keydown', cycle);
  }, [ring.views.length]);
  function work(v: View) {
    set((old) => {
      const existing = old.views.find((other) => viewKey(other) === viewKey(v));
      return { views: existing ? old.views : [...old.views, v], active: existing || v };
    });
  }
  function close() {
    set((old) => {
      const index = old.views.indexOf(old.active!);
      const views = old.views.filter((v) => v !== old.active);
      return { views, active: views[Math.max(0, index - 1)] || null };
    });
  }
  return { ...ring, work, close };
}
