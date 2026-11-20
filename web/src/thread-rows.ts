// A Comms thread record as a list row (t-2027): pure, so the server's parity test (src/collections/threads-live.
// integration.test.ts) holds the list the app draws from the live set to GET /comms's own, field for field.
import type { QuerySpec, Rec, ViewState } from './collections/runtime';

export const SPEC: QuerySpec = {
  type: 'loom/thread@^1',
  // Its list (comms.ts threadsOf): open threads, not Background work.
  where: [['archived', 'eq', null], ['background', 'eq', false]],
  order: [['updated', 'desc']],
  limit: 200,
  fields: ['agent', 'title', 'updated', 'unread', 'working', 'last_seq', 'opened', 'pinned', 'archived', 'project', 'channel', 'titled_by', 'read_seq',
    'conversation', 'working_since', 'queued', 'failed'],
};

/** A Comms list row (web/src/comms.tsx Thread; the server's comms-routes.ts view), as the list draws it. */
export interface ListThread {
  id: string; agent: string; title: string | null; titled_by: string | null; project: string | null; pinned: boolean; archived: string | null;
  opened: string; last: string; read_seq: number; channel: number; conversation: string; unread: boolean; last_seq: number;
  state: { working: boolean; working_since: string | null; queued: boolean; failed: boolean };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
/** One record as a list row. */
export function rowOf(r: Rec): ListThread {
  return {
    id: r.key.split('/').slice(2).join('/'), agent: String(r.agent ?? ''), title: str(r.title), titled_by: str(r.titled_by), project: str(r.project),
    pinned: r.pinned === true, archived: str(r.archived), opened: String(r.opened ?? ''), last: String(r.updated ?? ''), read_seq: num(r.read_seq),
    channel: num(r.channel), conversation: String(r.conversation ?? ''), unread: r.unread === true, last_seq: num(r.last_seq),
    state: { working: r.working === true, working_since: str(r.working_since), queued: r.queued === true, failed: r.failed === true },
  };
}

/** The rows of a live list in the Comms list's order (comms.ts threadsOf): pinned, then unread, then the rest, each newest first. */
export function listOf(state: ViewState, records: ReadonlyMap<string, Rec>): ListThread[] | null {
  if (state.status !== 'live' || !state.coverage?.complete) return null;
  const rows = state.keys.map((k) => records.get(k)).filter((r): r is Rec => !!r).map(rowOf);
  const rank = (t: ListThread) => (t.pinned ? 0 : t.unread ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}
