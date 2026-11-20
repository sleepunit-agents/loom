// Where you've been lately, on this device (Find's "Recent", before you type): the last pages you opened, newest first.
// Kept in this browser; a private window simply has none.

export type Recent = { label: string; href: string };
const KEY = 'loom-recent';
/** Kept: enough that each app's Recent here (tiling/tiles.tsx) still has some after the others' visits; Find shows the first five. */
const KEEP = 40;
/** Pages not worth going back to from Find: Home (the dock has it), Find itself, signing in and out. */
const SKIP = /^\/(find|login|logout)?(\?|$)/;

export function readRecent(): Recent[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((r) => r && typeof r.href === 'string' && typeof r.label === 'string') : []; }
  catch { return []; }
}

export function noteRecent(label: string, href: string): void {
  if (!label || SKIP.test(href)) return;
  try { localStorage.setItem(KEY, JSON.stringify([{ label, href }, ...readRecent().filter((r) => r.href !== href)].slice(0, KEEP))); }
  catch { /* private window */ }
}
