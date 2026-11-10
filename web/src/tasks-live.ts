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

const FIELDS = ['refState', 'title', 'type', 'status', 'priority', 'assignee', 'ask', 'goal', 'blocked', 'ready', 'updated', 'source'];
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
    if (st.status !== 'live') paged = -1;
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

/**
 * A few whole sets held together while anyone listens: live only when every one is, and what moved across them. One
 * for the tasks; one for the changes (sleepunit-agents/loom-changes, `changes/change`), so a household without the
 * Changes piece still has its tasks live.
 */
function group(specs: () => QuerySpec[]) {
  let sets: Array<ReturnType<typeof wholeSet>> = [];
  let held: Map<string, Rec> | null = null;
  const hearers = new Set<Moved>();
  const snapshots = new Set<Moved>();
  const all = (): Map<string, Rec> | null => {
    const got = sets.map((x) => x.current());
    return got.length && got.every((x) => x) ? new Map(got.flatMap((x) => [...x!])) : null;
  };
  const publish = () => {
    const now = all();
    const was = held;
    held = now;
    if (!now) {
      // Consumers holding a derived copy must drop it when the set stops being live (including sign-out).
      if (was) for (const f of [...snapshots]) f(new Set(), new Map());
      return;
    }
    // Just live: everything is news to what's shown (a page drawn before the set came may be older than it).
    const keys = was ? movedKeys(was, now) : new Set(now.keys());
    for (const f of [...hearers]) if (keys.size || (!was && snapshots.has(f))) f(keys, now);
  };
  return {
    /** Hear them move (the keys that moved, and every record held), keeping them live while heard. */
    watch(csrf: string, f: Moved, snapshot = false): () => void {
      hearers.add(f);
      if (snapshot) snapshots.add(f);
      if (hearers.size === 1) {
        // A recent window starts when it's asked for: a tab open for days only holds a little more.
        sets = specs().map((sp) => wholeSet(sp, publish));
        for (const x of sets) x.start(csrf);
      } else if (held && snapshot) {
        // A second window needs the current snapshot even if nothing moves after it opens.
        f(new Set(held.keys()), held);
      }
      return () => {
        hearers.delete(f);
        snapshots.delete(f);
        if (!hearers.size) { for (const x of sets) x.stop(); sets = []; held = null; }
      };
    },
    live: (): boolean => held !== null,
  };
}

const tasks = group(() => [OPEN_SPEC, recentSpec()]);
/** Hear the tasks move (the keys that moved, and every record held), keeping the set live while heard. */
export const watchTasks = (csrf: string, f: Moved, snapshot = false): (() => void) => tasks.watch(csrf, f, snapshot);
/** Whether the tasks are live and whole now. */
export const tasksLive = (): boolean => tasks.live();

const CHANGE_FIELDS = ['ref', 'title', 'state', 'draft', 'checks', 'review', 'mergeable', 'head', 'updated', 'closed'];
export const OPEN_CHANGES: QuerySpec = { type: 'changes/change@^1', where: [['state', 'eq', 'open']], order: [['updated', 'desc']], limit: 500, fields: CHANGE_FIELDS };
export const recentChanges = (now = Date.now()): QuerySpec => ({
  type: 'changes/change@^1', where: [['updated', 'gte', new Date(now - RECENT_DAYS * DAY).toISOString()]], order: [['updated', 'desc']], limit: 500, fields: CHANGE_FIELDS,
});
const changes = group(() => [OPEN_CHANGES, recentChanges()]);
/** Hear the changes move (Changes' own records: state, checks, review, head), keeping them live while heard. */
export const watchChanges = (csrf: string, f: Moved): (() => void) => changes.watch(csrf, f);
/** Whether the changes are live and whole now. */
export const changesLive = (): boolean => changes.live();

/** The Projects directory, including paused/done cards. Only a whole live set can replace page membership. */
export const PROJECTS_SPEC: QuerySpec = { type: 'loom/project@^1', order: [['activity', 'desc']], limit: 500,
  fields: ['agent', 'slug', 'name', 'status', 'links', 'activity', 'updated'] };
const projects = group(() => [PROJECTS_SPEC]);
export const watchProjects = (csrf: string, f: Moved): (() => void) => projects.watch(csrf, f, true);
export const projectsLive = (): boolean => projects.live();

/** A quiet live page is drawn again this often all the same: what it says depends on the day too ("Done in the last 7
 * days", a time that was today), which no record's move would tell it. */
export const REDRAW_MS = 10 * 60_000;

/**
 * A page that reads tasks or changes (page.ts; `which`, tasks-pages.ts pulseOf): `ask` when they move, a moment later so
 * a burst of moves is one ask; one heard while the tab is hidden is asked for when it's shown again (a live page isn't
 * asked on its own then); and every REDRAW_MS.
 */
function watchPage(csrf: string, ask: () => void, which: string): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  let missed = false;
  const later = () => { if (document.hidden) missed = true; else ask(); };
  const shown = () => { if (missed && !document.hidden) { missed = false; ask(); } };
  document.addEventListener('visibilitychange', shown);
  const slow = setInterval(later, REDRAW_MS);
  const moved = () => { clearTimeout(t); t = setTimeout(later, 250); };
  const offs = [...(which.includes('tasks') ? [watchTasks(csrf, moved)] : []), ...(which.includes('changes') ? [watchChanges(csrf, moved)] : [])];
  return () => { clearTimeout(t); clearInterval(slow); document.removeEventListener('visibilitychange', shown); for (const off of offs) off(); };
}

/** For page.ts, which loads this chunk only when a page that reads tasks or changes is shown (tasks-pages.ts). */
export const tasksPulse = { watchPage, live: tasksLive };
