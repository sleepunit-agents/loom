// One page, loaded and kept current (docs/specs/desk-tiling.md, "One page loader per tile"): the JSON loom answers for
// an address, its error or its wait, the last copy of it this tab has seen, and the page's own refresh rules (the live
// stream, its timer, coming back online, the tab shown again). App.tsx runs it once for the whole screen; a desktop's
// tiles each run it for their own address.
//
// Where the address lives is the caller's (`nav`): the screen's is the browser's own (history, location), a tile's is
// its own. Everything else is the same for both, except that signing out sends the whole window to sign in.
//
// It moved here from App.tsx unchanged (2026-11-06): what it does is pinned by the browser suites that drive the app
// (ui, app-nav, look-sync, gestures, desk, comms), not by a test of its own.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { fetchView, type View } from './loom';
import { refreshEvery, type Showing } from './refresh';
import type { Note } from './toasts';

/** Where a page's address is kept: what it is now, a new one after it (a link), or this one corrected in place (a
 * redirect, a one-time message leaving it). */
export interface PageNav {
  here(): string;
  push(to: string): void;
  replace(to: string): void;
  /** A new page, from the top (the screen's: the window's own scroll). */
  top(): void;
}

/** The screen's own address: the browser's. */
export const screenNav: PageNav = {
  here: () => location.pathname + location.search,
  push: (to) => history.pushState(null, '', to),
  replace: (to) => history.replaceState(null, '', to),
  top: () => window.scrollTo({ top: 0 }),
};

type Answer = { status: number; data?: View; redirect?: string; savedAt?: string; etag?: string };

/** The last copy of each page this tab has seen, and its fingerprint: a page opens at once from it while loom is asked
 * behind it, and a 304 ("nothing new") leaves it as it is (Jonathan, 2026-10-29: "this site is sloooow"). One for the
 * tab: a tile opening a page another has seen opens it at once too. */
const kept = new Map<string, { etag?: string; data: View }>();

const keep = (to: string, r: Answer) => {
  if (r.data && r.etag && !r.savedAt) kept.set(to, { etag: r.etag, data: { ...r.data, chrome: { ...r.data.chrome, flash: undefined } } });
};
/** Whether this tab has a copy of a page (a swipe's next page is fetched ahead only when it hasn't). */
export const hasKept = (to: string): boolean => kept.has(to);

export type Load = (to: string, push: boolean, quiet?: boolean) => Promise<void>;

// The live stream (docs/specs/ui-app.md, "Live"): one per open app, however many pages it shows. Each page listens to
// it; it opens with the first and closes with the last.
const hearers = new Set<{ change: () => void; open: (on: boolean) => void }>();
let stream: EventSource | null = null;
let streamOpen = false;
function listen(h: { change: () => void; open: (on: boolean) => void }): () => void {
  hearers.add(h);
  if (!stream && 'EventSource' in window) {
    const es = stream = new EventSource('/events');
    es.onopen = () => { streamOpen = true; for (const x of hearers) x.open(true); };
    es.onerror = () => { streamOpen = false; for (const x of hearers) x.open(false); };
    es.addEventListener('change', () => { for (const x of hearers) x.change(); });
  }
  h.open(streamOpen);
  return () => {
    hearers.delete(h);
    if (!hearers.size && stream) { stream.close(); stream = null; streamOpen = false; }
  };
}

export interface PageState {
  url: string;
  data: View | null;
  error: string | null;
  /** Nothing to show while a page with no copy kept yet is asked for (the first page, or after an error): its header
   * and its shape (states.tsx Skeleton) until it lands. */
  waiting: boolean;
  /** Where a page that's on its way is going. The page shown stays, mounted, until it lands (t-1925 F: only what
   * changes is replaced, so an app's list, its scroll and a draft hold across a click). */
  pending: string | null;
  /** When the copy shown was saved, while loom can't be reached. */
  savedAt: string | undefined;
  /** The address being shown or asked for: the one a quiet refresh asks again. */
  showing: RefObject<string>;
  /** Open a page: `push` puts it after the one shown (a link); `quiet` refreshes what's shown without a wait. */
  load: Load;
}

/**
 * A page at `start`, and every page after it. `say` hears a page's one-time message (?_flash=, after a form's post).
 * The live stream (src/ui/live.ts) says "something changed" and the page asks again with its fingerprint (a 304 when
 * nothing it shows moved); while it's open the timer (refresh.ts) is only a slow fallback.
 */
export function usePage(start: string, say: (n: Omit<Note, 'id'>) => void, nav: PageNav = screenNav): PageState {
  const [url, setUrl] = useState(start);
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const showing = useRef(start);
  const navNow = useRef(nav);
  navNow.current = nav;
  // Whether there's a page on screen to keep while the next is asked for (not an error's card, not nothing).
  const shown = useRef(false);
  shown.current = !!data && !error;

  const load = useCallback<Load>(async (to, push, quiet = false) => {
    const n = navNow.current;
    const have = kept.get(to);
    if (!quiet) {
      showing.current = to;
      if (have) {
        if (push && to !== n.here()) n.push(to);
        setError(null); setData(have.data); setUrl(to); setSavedAt(undefined); n.top();
      }
      setWaiting(!have && !shown.current); setPending(have ? null : to);
    }
    const r: Answer = await fetchView(to, have?.etag).catch(() => ({ status: 0 }));
    if (!quiet && showing.current === to) { setWaiting(false); setPending(null); }
    if (showing.current !== to) {   // another page was asked for meanwhile: keep this answer for later, show nothing
      if (!r.redirect) keep(to, r);
      return;
    }
    if (r.status === 304) return;   // nothing new: what's shown is current
    if ((quiet || have) && !r.data && !r.redirect) return;   // a refresh that missed keeps what's shown
    if (!r.data && (r.redirect || r.status === 401)) { location.href = r.redirect ?? '/login'; return; }   // signed out: loom's own sign-in page
    if (r.redirect) { to = r.redirect; if (!push || have) n.replace(to); }   // loom moved it (/mind → an agent's Mind): show where it landed
    if (!r.data) {
      if (push && to !== n.here()) n.push(to);
      setSavedAt(undefined); setUrl(to);
      setError(r.status ? 'server' : 'offline');
      return;
    }
    // A one-time message (?_flash=, after a form's post) is shown once, then leaves the address.
    const once = /[?&]_flash=/.test(to);
    if (once) { const u = new URL(to, location.href); u.searchParams.delete('_flash'); to = u.pathname + u.search; if (!push) n.replace(to); }
    if (push && to !== n.here()) n.push(to);
    showing.current = to;
    setError(null); setData(r.data); setUrl(to); setSavedAt(r.savedAt);
    keep(to, r);
    const flash = r.data.chrome?.flash;
    if (flash) say(flash);
    if (!quiet && !have) n.top();
  }, [say]);

  const [live, setLive] = useState(false);
  useEffect(() => {
    const again = () => { if (!document.hidden) void load(showing.current, false, true); };
    const stop = listen({ change: again, open: setLive });
    document.addEventListener('visibilitychange', again);
    return () => { stop(); document.removeEventListener('visibilitychange', again); };
  }, [load]);

  // A page that stays fresh is fetched again in place (the classic page's data-live), as often as refresh.ts says: a
  // page's own refresh as it asked, live or not; never while a sheet, an editor or a field is in use, or hidden.
  const every = refreshEvery(data as Showing | null, live);
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => {
      const busy = document.hidden || document.querySelector('[role="dialog"],[role="alertdialog"]') || (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
      if (!busy) void load(navNow.current.here(), false, true);
    }, every * 1000);
    return () => clearInterval(t);
  }, [every]);

  useEffect(() => { const f = () => void load(navNow.current.here(), false, true); addEventListener('online', f); return () => removeEventListener('online', f); }, [load]);

  return { url, data, error, waiting, pending, savedAt, showing, load };
}
