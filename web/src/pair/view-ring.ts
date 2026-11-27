import { hashView } from './project-entities';
import { useEffect, useState } from 'react';
import { indexNames, ticketView, viewKey, type View } from './ticket-view';

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
          (v.kind === 'index'
            ? Object.hasOwn(indexNames, v.ref)
            : v.kind === 'profile'
              ? ['agent', 'member', 'repository', 'contact'].includes(v.role) &&
                typeof v.ref === 'string' &&
                !!v.ref
              : 'project' in v
                ? typeof v.project === 'string' &&
                  !!v.project &&
                  (v.kind === 'project' ||
                    (['repository', 'agent', 'member'].includes(v.kind) && typeof v.ref === 'string'))
                : v.kind === 'pull'
                  ? typeof v.ref === 'string'
                  : /^t-\d+$/.test(v.ticket) &&
                    (v.kind === 'ticket' || (v.kind === 'comment' && typeof v.ref === 'string'))),
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
  const [ring, set] = useState(() => {
    const saved = restore(key, root);
    const target = hashView(location.hash);
    if (!target) return saved;
    const existing = saved.views.find((v) => viewKey(v) === viewKey(target));
    return { views: existing ? saved.views : [...saved.views, target], active: existing || target };
  });
  useEffect(() => {
    if (hashView(location.hash)) {
      const url = new URL(location.href);
      url.hash = '';
      history.replaceState(history.state, '', url);
    }
  }, []);
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
  function work(v: View, background = false) {
    set((old) => {
      const existing = old.views.find((other) => viewKey(other) === viewKey(v));
      return {
        views: existing ? old.views : [...old.views, v],
        active: background ? old.active : existing || v,
      };
    });
  }
  function close(target: View) {
    set((old) => {
      if (target.kind === 'ticket' && target.intent === 'work' && target.ticket === root) return old;
      const index = old.views.findIndex((v) => viewKey(v) === viewKey(target));
      if (index < 0) return old;
      const views = old.views.filter((_, i) => i !== index);
      return {
        views,
        active: old.active === old.views[index] ? views[Math.max(0, index - 1)] || null : old.active,
      };
    });
  }
  return { ...ring, work, close };
}
