// The live attention set (t-2025; docs/specs/collections.md): one subscription per tab to core's `attention` records,
// the Inbox's own items as loom makes them for this member, shared by every view that shows what needs them: the
// badges, Home's Needs you, the Inbox and its ask cards. While it isn't live (loading, the stream down, an error, no
// household), each view keeps reading its page's own copy, as before; once it is, they all read this one set, so their
// numbers agree and none asks its page again to find out.
//
// It loads the collection runtime as its own chunk (page.ts collectionsRuntime), on the first window that asks.
import { liveViews } from './page';
import { liveSet } from './live-set';
import type { InboxItem } from './views';
import type { QuerySpec, Rec, ViewState } from './collections/runtime';

export const ATTENTION_TYPE = 'loom/attention@^1';
const SPEC: QuerySpec = { type: ATTENTION_TYPE, order: [['sort', 'desc']], limit: 500 };

export interface Attention {
  /** Every item, newest first (one with no time first), as the Inbox files them. */
  items: InboxItem[];
  /** What needs you: the items counted, in order. */
  needs: InboxItem[];
  /** What needs you, per agent. */
  byAgent: Record<string, number>;
}

/** A record as the Inbox's item: its key is the record's id; its expiry back to the time it was. */
export function itemOf(r: Rec): InboxItem {
  const { key, sort: _s, expires, ...rest } = r as Rec & { sort?: unknown; expires?: unknown };
  const id = key.slice(key.lastIndexOf('/') + 1);
  return { ...(rest as unknown as Omit<InboxItem, 'key'>), key: id, unread: r.unread === true, ...(typeof expires === 'string' ? { expires } : {}) } as InboxItem;
}

/** The set from a view's state and its records: null unless it's live and whole (a partial one would undercount). */
export function attentionOf(state: ViewState, records: ReadonlyMap<string, Rec>): Attention | null {
  if (state.status !== 'live' || !state.coverage?.complete) return null;
  const items = state.keys.flatMap((k) => { const r = records.get(k); return r ? [itemOf(r)] : []; });
  const needs = items.filter((i) => i.attention);
  const byAgent: Record<string, number> = {};
  for (const i of needs) if (i.agent) byAgent[i.agent] = (byAgent[i.agent] ?? 0) + 1;
  return { items, needs, byAgent };
}

// One per tab (live-set.ts): kept while anyone listens; a cleared runtime (signed out) is never read again.
const set = liveSet<Attention>(SPEC, attentionOf, (next) => {
  // Said on the page, for anyone looking (and the browser tests): whether what needs you is read live.
  if (typeof document !== 'undefined') document.documentElement.dataset.attention = next ? 'live' : 'page';
});

/** The set now, or null while it isn't live. */
export const attentionNow = (): Attention | null => set.current();

/** Hear the live set move (and keep it live while listening). */
export const onAttention = (f: () => void): (() => void) => set.subscribe(f);

// A page whose every changing part is read live doesn't need asking again on loom's bare "something changed", nor on
// a timer (page.ts usePage): the Inbox, once the set is live (its open item's piece page excepted: rare, and kept by
// its own pick).
liveViews((view) => view === 'inbox' && set.current() !== null);

/**
 * The live attention set for this tab, or null while it isn't live (use the page's copy then). `csrf` is the page's
 * anti-forgery token; none (no signed-in page yet): nothing is asked.
 */
export const useAttention = (csrf: string | undefined): Attention | null => set.use(csrf);

/**
 * What the live set says of one ask, for a card that would otherwise ask loom (ask-open.ts): open when it holds it open,
 * answered when it holds it done. One it doesn't hold, it can't say (a thread can show an ask a moment before the set
 * has it): undefined, and loom is asked.
 */
export function openFromLive(q: { k?: string; a?: string }): boolean | undefined {
  const current = set.current();
  if (!current) return undefined;
  const it = current.items.find((x) => (q.k ? x.key === q.k : [...(x.actions ?? []), ...(x.approval?.actions ?? [])].some((b) => b.fields?.id === q.a)));
  return it ? it.box !== 'done' : undefined;
}

/** Home's first few in place (src/ui/handler.ts HOME_STACK): its band and rail show these. */
export const HOME_STACK = 4;

/** Where a page's own copy and the live set disagreed (the parity check: each move is kept behind it), newest last. */
export const parity: Array<{ at: number; view: string; what: string; page: unknown; live: unknown }> = [];
function differ(view: string, what: string, page: unknown, live: unknown): void {
  if (JSON.stringify(page) === JSON.stringify(live)) return;
  parity.push({ at: Date.now(), view, what, page, live });
  if (parity.length > 50) parity.shift();
  if (typeof console !== 'undefined') console.debug(`loom: attention parity: ${view} ${what} differs`, { page, live });
}
const keysOf = (xs: readonly { key: string }[] | undefined) => (xs ?? []).map((x) => x.key).sort();

/**
 * A page's view with what needs you read from the live set: the shell's badges (the total and each agent's), Home's
 * Needs you (its count, its first and its stack), an agent window's waiting, and the Inbox's items. The page's own
 * copy is what's shown until the set is live; where the two describe the same thing, a difference is noted (parity).
 * Unchanged (the same object) when there's nothing live to read.
 */
export function withAttention<V extends { view: string; chrome?: { shell?: { asks: number; agents: Array<{ id: string; asks?: number }> } }; [k: string]: unknown }>(data: V | null, live: Attention | null): V | null {
  if (!data || !live) return data;
  let out: V = data;
  const shell = data.chrome?.shell;
  if (shell) {
    out = { ...out, chrome: { ...data.chrome, shell: { ...shell, asks: live.needs.length,
      agents: shell.agents.map((a) => ({ ...a, asks: live.byAgent[a.id] ?? 0 })) } } };
  }
  if (data.view === 'house-home' && data.home && typeof data.home === 'object') {
    const home = data.home as { needs?: number; need?: InboxItem; stack?: InboxItem[] };
    differ('home', 'needs', home.needs, live.needs.length);
    out = { ...out, home: { ...home, needs: live.needs.length, need: live.needs[0], stack: live.needs.slice(0, HOME_STACK) } };
  }
  if (data.view === 'inbox' && Array.isArray(data.items)) {
    differ('inbox', 'keys', keysOf(data.items as InboxItem[]), keysOf(live.items));
    out = { ...out, items: live.items };
  }
  const head = (data.view === 'page' ? data.head : undefined) as { id?: string; waiting?: number } | undefined;
  if (head?.id) out = { ...out, head: { ...head, waiting: live.byAgent[head.id] ?? 0 } };
  return out;
}
