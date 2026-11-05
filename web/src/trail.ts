// Where you've been inside each app (Jonathan, 2026-11-05: "I open tasks, I open details for a particular task... I have
// no real way back to the task list"): a history of its own per app, this tab's. A desktop window's Back and Forward
// walk it, and a phone bar's back chevron pops it. Back from a task goes to the list you came from, with its filters,
// its query and how far down it was.
//
// One record per app, so the window's history and where it was left agree: what a minimized window opens at again
// (desk.tsx, its key or a double-click on its strip) is simply where its history stands. Close forgets both.
//
// No React here: App.tsx tells it each page that lands, and how it was reached.

/** A page in an app's history: its address (path and query), its title, and how far down it was scrolled. */
export type Place = { url: string; top: number; label?: string };
/** How a page was reached: a link or a key (go), the window's own Back or Forward, or the browser's (pop). */
export type How = 'go' | 'back' | 'forward' | 'pop';
type Stack = { pages: Place[]; at: number; min?: boolean };

const KEY = 'loom-trail';
/** Pages kept per app: the oldest go first. */
const KEEP = 50;
const read = (): Record<string, Stack> => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? v as Record<string, Stack> : {};
  } catch { return {}; }
};
const stacks = read();
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(stacks)); } catch { /* a private window: in memory only */ } };

/** A page landed in `app`. Back and Forward (the window's, or the browser's that match a neighbour) move along its
 * history; anything else is a new page after the one you're on, and what was ahead of it is dropped. True when where it
 * stands moved (the same page drawn again, a refresh, doesn't). */
export function note(app: string, url: string, how: How, label?: string): boolean {
  const s = stacks[app] ??= { pages: [], at: -1 };
  const here = s.pages[s.at];
  if (here?.url === url) { if (label && here.label !== label) { here.label = label; save(); } return false; }
  const prev = s.pages[s.at - 1], next = s.pages[s.at + 1];
  if ((how === 'back' || how === 'pop') && prev?.url === url) s.at--;
  else if ((how === 'forward' || how === 'pop') && next?.url === url) s.at++;
  else {
    s.pages = [...s.pages.slice(0, s.at + 1), { url, top: 0 }].slice(-KEEP);
    s.at = s.pages.length - 1;
  }
  if (label) s.pages[s.at].label = label;
  save();
  return true;
}

/** How far down the page you're leaving was: kept with it, for Back to come back to. */
export function keepTop(app: string | undefined, url: string, top: number): void {
  const here = app ? stacks[app]?.pages[stacks[app].at] : undefined;
  if (here && here.url === url) { here.top = Math.max(0, Math.round(top)); save(); }
}

/** The page Back (-1) or Forward (+1) goes to in `app`, if there is one. */
export function step(app: string | undefined, by: -1 | 1): Place | undefined {
  const s = app ? stacks[app] : undefined;
  return s ? s.pages[s.at + by] : undefined;
}

/** The latest page in `app`'s history, up to where it stands, whose path is `path`: its query and scroll are kept (a
 * crumb back to the list goes to the list as you left it). */
export function lastAt(app: string | undefined, path: string): Place | undefined {
  const s = app ? stacks[app] : undefined;
  for (let i = s ? s.at : -1; i >= 0; i--) if (s!.pages[i].url.split('?')[0] === path) return s!.pages[i];
  return undefined;
}

/** Minimize: `app` is kept where it stands (its page and how far down). */
export function minimize(app: string, at: Place): void {
  const s = stacks[app] ??= { pages: [], at: -1 };
  if (s.pages[s.at]?.url !== at.url) note(app, at.url, 'go');
  s.pages[s.at].top = Math.max(0, Math.round(at.top));
  s.min = true;
  save();
}

/** Where `app` was minimized, if it was: taken, so opening it again is open, not kept. */
export function restore(app: string): Place | undefined {
  const s = stacks[app];
  if (!s?.min) return undefined;
  delete s.min;
  save();
  return s.pages[s.at];
}

/** Closed: the app opens at its start again, with no history behind it. */
export function forget(app: string | undefined): void {
  if (app && stacks[app]) { delete stacks[app]; save(); }
}
