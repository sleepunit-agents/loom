// The member's Comms threads, live (t-2027; docs/specs/collections.md): one subscription per tab to their open threads
// (core's `thread` records: never another member's, never a word), read by the dock's Comms count, the desktop's
// agent cards and the Comms list itself (its rows: thread-rows.ts listOf). Archived threads and Background work are their
// own live sets, held only while the list shows them. Unread is counted in threads everywhere (the owner's decision 3,
// collections.md "Owner decisions"); the count of messages is a thread's own. Null while it isn't live and whole: each
// view reads its page's copy then.
import { liveSet } from './live-set';
import { liveViews } from './page';
import { attentionNow } from './attention';
import { listOf, SPEC, type ListThread } from './thread-rows';
import type { Rec, ViewState } from './collections/runtime';

export type { ListThread };

export interface Threads {
  /** Threads with a reply their member hasn't read. */
  unread: number;
  /** The same, per agent. */
  byAgent: Record<string, number>;
  /** What moves a card's summary (comms/agents): each thread's unread and newest message, as one string. */
  moved: string;
  /** The Comms list's rows (listOf). */
  list: ListThread[];
}

export function threadsOf(state: ViewState, records: ReadonlyMap<string, Rec>): Threads | null {
  if (state.status !== 'live' || !state.coverage?.complete) return null;
  const byAgent: Record<string, number> = {};
  let unread = 0;
  const marks: string[] = [];
  for (const k of state.keys) {
    const r = records.get(k);
    if (!r) continue;
    marks.push(`${k}:${r.unread ? 1 : 0}:${String(r.last_seq ?? '')}:${String(r.updated ?? '')}`);
    if (r.unread === true) { unread++; const a = String(r.agent ?? ''); byAgent[a] = (byAgent[a] ?? 0) + 1; }
  }
  return { unread, byAgent, moved: marks.join('|'), list: listOf(state, records) ?? [] };
}

const set = liveSet<Threads>(SPEC, threadsOf);

// Comms (the list, and a thread, whose own stream and reads keep it current: comms.tsx ThreadPane) isn't asked again
// on loom's bare "something changed" or a timer once its threads are live, and what needs you too (its chrome's
// badges, attention.ts): the list and the counts move on the stream.
liveViews((view) => view === 'comms' && set.current() !== null && attentionNow() !== null);
export const useThreads = (csrf: string | undefined): Threads | null => set.use(csrf);
export const onThreads = (f: () => void): (() => void) => set.subscribe(f);
export const threadsNow = (): Threads | null => set.current();

// The list's other two views (comms.ts threadsOf: `archived`, `background: 'only'`), each its own set, live only while
// a list shows it. Both together are archived Background work, as GET /comms?archived=1&background=1 answers.
const other = (archived: boolean, background: boolean) => liveSet<ListThread[]>({
  ...SPEC, where: [archived ? ['archived', 'has'] : ['archived', 'eq', null], ['background', 'eq', background]],
}, listOf);
const others = { archived: other(true, false), background: other(false, true), both: other(true, true) };
/** The archived threads, Background work, or both, live; null while it isn't. Its caller mounts only while the list
 * shows that view, so the set is held only then (a set with no one listening stops). */
export const useOtherThreads = (csrf: string | undefined, which: keyof typeof others): ListThread[] | null => others[which].use(csrf);

/** A page's view with the dock's Comms count read from the live set (unchanged while it isn't live). */
export function withThreads<V extends { chrome?: { shell?: { core: Array<{ href: string; count?: number }> } } }>(data: V | null, live: Threads | null): V | null {
  const shell = data?.chrome?.shell;
  if (!data || !live || !shell) return data;
  return { ...data, chrome: { ...data.chrome, shell: { ...shell, core: shell.core.map((c) => (c.href === '/comms' ? { ...c, count: live.unread } : c)) } } };
}
