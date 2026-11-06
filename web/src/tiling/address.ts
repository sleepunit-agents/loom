// The tiled desktop's address (docs/specs/desk-tiling.md, "The address"): the path is the focused tile's own page, and
// the query carries the set. `t` is the apps on screen in order, each by its name (the last part of its dock key's
// path), a `*` before the focused one and a `!` after the pinned one; `m` is the minimized apps, in the order they went
// to the dock. Anything else in the query is the focused page's own.
//
// No React here, so it's tested on its own (src/ui/desk-tiling-address.test.ts).

export type Entry = { name: string; focused?: boolean; pinned?: boolean };
export type TileSet = { t: Entry[]; m: string[] };

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export { nameOf } from './name';

/** The set an address carries, and the page's own address without it. `set` is null when the query has no `t` or `m`. */
export function readSet(url: string): { set: TileSet | null; page: string } {
  const u = new URL(url, 'http://x');
  const t = u.searchParams.get('t'), m = u.searchParams.get('m');
  u.searchParams.delete('t'); u.searchParams.delete('m');
  const page = u.pathname + u.search;
  if (t === null && m === null) return { set: null, page };
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const raw of (t ?? '').split(',')) {
    const focused = raw.startsWith('*'), pinned = raw.endsWith('!');
    const name = raw.slice(focused ? 1 : 0, pinned ? -1 : undefined);
    if (!NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, ...(focused ? { focused } : {}), ...(pinned ? { pinned } : {}) });
  }
  // One focused and one pinned at most (the first of each), and only position 0 can be pinned.
  let f = false;
  for (const e of entries) { if (e.focused && f) delete e.focused; f ||= !!e.focused; }
  entries.forEach((e, i) => { if (e.pinned && i > 0) delete e.pinned; });
  const mins = (m ?? '').split(',').filter((n) => NAME.test(n) && !seen.has(n) && (seen.add(n), true));
  return { set: { t: entries, m: mins }, page };
}

/** The address for a page (the focused tile's, or `/`) and the set. */
export function writeSet(page: string, set: TileSet): string {
  const u = new URL(page, 'http://x');
  u.searchParams.delete('t'); u.searchParams.delete('m');
  const t = set.t.map((e) => `${e.focused ? '*' : ''}${e.name}${e.pinned ? '!' : ''}`).join(',');
  // Written by hand, not URLSearchParams: `*`, `!` and `,` stay as they are, so the address reads as the spec writes it.
  const own = u.search.replace(/^\?/, '');
  const q = [own, t && `t=${t}`, set.m.length ? `m=${set.m.join(',')}` : ''].filter(Boolean).join('&');
  return u.pathname + (q ? `?${q}` : '');
}
