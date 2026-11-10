// The tasks' own records, live (t-2029; docs/specs/collections.md, "As built: tasks"): the tasks piece publishes every
// task as `tasks/task`, and this tab holds the ones its Tasks pages show: every open or started task, and every task that
// moved in the last eight days (done, commented, made). Held only while something shown reads them: a Tasks page, a
// project's page, a Comms thread's work panel.
//
// Those pages stay the piece's own, drawn by it (collections.md: "Piece pages stay piece-rendered"); what moves them now
// is their records. A Tasks page is asked again when a task it could show moves, and no longer on loom's bare "something
// changed" or a timer while the records are live (page.ts). A project's page is asked again on a task's move as
// well as on those (it shows other pieces' work too). A thread's work panel asks again when a task it shows, or one made
// in it, moves (comms-work.tsx). Household owners only, as the Tasks pages are: anyone else's set is refused, and their
// pages are asked for as before. Loaded as its own chunk, with the first page that reads it.
import { collectionsRuntime } from './page';
import type { CollectionRuntime, QuerySpec, Rec, ViewState } from './collections/runtime';

const FIELDS = ['title', 'type', 'status', 'priority', 'assignee', 'ask', 'goal', 'blocked', 'ready', 'updated', 'source'];
const DAY = 86_400_000;
/** Recently moved: a Tasks page's "Done in the last 7 days" and "Recently updated", with a day to spare. */
export const RECENT_DAYS = 8;

export const OPEN_SPEC: QuerySpec = { type: 'tasks/task@^1', where: [['status', 'in', ['open', 'in_progress']]], order: [['created', 'asc']], limit: 500, fields: FIELDS };
export const recentSpec = (now = Date.now()): QuerySpec => ({
  type: 'tasks/task@^1', where: [['updated', 'gte', new Date(now - RECENT_DAYS * DAY).toISOString()]], order: [['updated', 'desc']], limit: 500, fields: FIELDS,
});

/** The most records a subscription holds (src/collections/subs.ts MAX_WINDOW): past it, its tail leaves. */
const WINDOW = 1000;

/**
 * A set's records by key, or null until it's live and whole: every page read (core calls only a one-page answer
 * complete, so a set read in pages is whole when there's no next one), and inside the window core keeps current.
 */
export function recordsOf(state: ViewState, records: ReadonlyMap<string, Rec>): Map<string, Rec> | null {
  if (state.status !== 'live' || state.more || state.keys.length >= WINDOW) return null;
  return new Map(state.keys.flatMap((k) => { const r = records.get(k); return r ? [[k, r] as [string, Rec]] : []; }));
}

/** The keys whose record is new, gone or another copy (the runtime writes a new object for each upsert). */
export function movedKeys(was: ReadonlyMap<string, Rec>, now: ReadonlyMap<string, Rec>): Set<string> {
  const out = new Set<string>();
  for (const [k, r] of now) if (was.get(k) !== r) out.add(k);
  for (const k of was.keys()) if (!now.has(k)) out.add(k);
  return out;
}

export type Moved = (keys: ReadonlySet<string>, records: ReadonlyMap<string, Rec>) => void;

/**
 * One set of records, read whole (every page, up to the server's window), on the tab's shared runtime (page.ts): not on
 * live-set.ts, which the first page carries and this chunk would then split out of it.
 */
function wholeSet(spec: QuerySpec, onMove: () => void) {
  let handle: ReturnType<CollectionRuntime['view']> | null = null;
  let rt: CollectionRuntime | null = null;
  let paged = -1;
  let off = false;
  const publish = () => {
    if (!handle || !rt) return;
    if (rt.isCleared()) { handle = null; onMove(); return; }
    const st = handle.state();
    // Its next page as soon as the last one is in: once per page (a frame meanwhile publishes too).
    if (st.status === 'live' && st.more && st.keys.length !== paged) { paged = st.keys.length; handle.more(); }
    else if (!st.more) paged = -1;
    onMove();
  };
  return {
    start(csrf: string) {
      void collectionsRuntime(() => csrf).then(({ runtime }) => {
        if (off || runtime.isCleared()) return;
        rt = runtime;
        handle = runtime.view(spec, publish);
        publish();
      }, () => { /* no runtime: the pages are asked as before */ });
    },
    current: (): Map<string, Rec> | null => (handle && rt && !rt.isCleared() ? recordsOf(handle.state(), rt.records(spec.type)) : null),
    stop() { off = true; try { handle?.close(); } catch { /* a cleared runtime */ } handle = null; },
  };
}

let sets: Array<ReturnType<typeof wholeSet>> = [];
let held: Map<string, Rec> | null = null;
const hearers = new Set<Moved>();

function both(): Map<string, Rec> | null {
  const [a, b] = sets.map((x) => x.current());
  return a && b ? new Map([...a, ...b]) : null;
}

function publish(): void {
  const now = both();
  const was = held;
  held = now;
  if (!now) return;
  // Just live: everything is news to what's shown (a page drawn before the set came may be older than it).
  const keys = was ? movedKeys(was, now) : new Set(now.keys());
  if (keys.size) for (const f of [...hearers]) f(keys, now);
}

/** Hear the tasks move (the keys that moved, and every record held), keeping the set live while heard. */
export function watchTasks(csrf: string, f: Moved): () => void {
  hearers.add(f);
  if (hearers.size === 1) {
    // The recent window starts when it's asked for: a tab open for days only holds a little more.
    sets = [wholeSet(OPEN_SPEC, publish), wholeSet(recentSpec(), publish)];
    for (const x of sets) x.start(csrf);
  }
  return () => {
    hearers.delete(f);
    if (!hearers.size) { for (const x of sets) x.stop(); sets = []; held = null; }
  };
}

/** Whether the tasks are live and whole now. */
export const tasksLive = (): boolean => held !== null;

/**
 * A page that reads tasks (page.ts): `ask` when they move, a moment later so a burst of moves is one ask; one heard while
 * the tab is hidden is asked for when it's shown again (a live page isn't asked on its own then).
 */
function watchPage(csrf: string, ask: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  let missed = false;
  const shown = () => { if (missed && !document.hidden) { missed = false; ask(); } };
  document.addEventListener('visibilitychange', shown);
  const off = watchTasks(csrf, () => {
    clearTimeout(t);
    t = setTimeout(() => { if (document.hidden) missed = true; else ask(); }, 250);
  });
  return () => { clearTimeout(t); document.removeEventListener('visibilitychange', shown); off(); };
}

/** For page.ts, which loads this chunk only when a page that reads tasks is shown (tasks-pages.ts). */
export const tasksPulse = { watchPage, live: tasksLive };
