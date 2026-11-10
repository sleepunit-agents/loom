// The member's Comms threads, live (t-2027; docs/specs/collections.md): one subscription per tab to their open threads
// (core's `thread` records: never another member's, never a word), read by the dock's Comms count and the desktop's
// agent cards. Unread is counted in threads everywhere (the owner's decision 3, collections.md "Owner decisions"); the
// count of messages is a thread's own. Null while it isn't live and whole: each view reads its page's copy then.
import { liveSet } from './live-set';
import type { QuerySpec, Rec, ViewState } from './collections/runtime';

const SPEC: QuerySpec = {
  type: 'loom/thread@^1',
  // Its list (comms.ts threadsOf): open threads, not Background work.
  where: [['archived', 'eq', null], ['background', 'eq', false]],
  order: [['updated', 'desc']],
  limit: 200,
  fields: ['agent', 'title', 'updated', 'unread', 'working', 'last_seq'],
};

export interface Threads {
  /** Threads with a reply their member hasn't read. */
  unread: number;
  /** The same, per agent. */
  byAgent: Record<string, number>;
  /** What moves a card's summary (comms/agents): each thread's unread and newest message, as one string. */
  moved: string;
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
  return { unread, byAgent, moved: marks.join('|') };
}

const set = liveSet<Threads>(SPEC, threadsOf);
export const useThreads = (csrf: string | undefined): Threads | null => set.use(csrf);
export const onThreads = (f: () => void): (() => void) => set.subscribe(f);
export const threadsNow = (): Threads | null => set.current();

/** A page's view with the dock's Comms count read from the live set (unchanged while it isn't live). */
export function withThreads<V extends { chrome?: { shell?: { core: Array<{ href: string; count?: number }> } } }>(data: V | null, live: Threads | null): V | null {
  const shell = data?.chrome?.shell;
  if (!data || !live || !shell) return data;
  return { ...data, chrome: { ...data.chrome, shell: { ...shell, core: shell.core.map((c) => (c.href === '/comms' ? { ...c, count: live.unread } : c)) } } };
}
