/** The `tickets` brick: every ticket the member may read, across projects, as the desktop's Tasks lists them
 * (pieces/tasks/query.ts and shared-view.tsx). It reads the same root fields the desktop does, `readyTasks` and
 * `tasks`, and the same rules decide what each holds: Ready is `readyTasks` (open, no unclosed blocker, not an epic,
 * not shelved: the server decides, in SQL); In progress and Shelved are `tasks` split by whether the ticket's project
 * is one loom says is retired (its `lifecycle`), which is how loom decides shelved (`taskShelved`, core/data/project-in-use.ts); All is every ticket,
 * closed ones included, latest change first. The desktop reads every ticket and splits them on the page; this brick
 * asks for one page at a time (`ticketsPageSize`, then more on a press, never more than `ticketsMost`).
 *
 * Who may read what is the tasks rule's alone (policy.ts `task`). The retired projects are read under the projects
 * rule, which for a ticket in a project is the same test (a household owner, or someone on the project), so every
 * ticket the member may read has its project's retirement read too, and nothing is widened.
 *
 * Reads: the list and the retired projects are live selections, relaxed as every brick's are. Big, the member can
 * search: the words are this drawn brick's state, sent once to the same read when Enter or Search is pressed
 * (`useDataOnce`, one request, not live), and asked again only when More is pressed. While a search is shown the live
 * list is paused. The words are never a parameter, never told to the board and kept nowhere. */
import { useState, type FormEvent } from 'react';
import { ticketStates } from '../../../src/core/boards/bricks/tickets';
import { useDataOnce, useDataQuery, type DataQuerySnapshot } from '../data/graphql';
import { Action, Chip, Few, Lead, Loading, More, Note, Row, Rows, State, words, type Params, type Tone } from './brick-kit';
import type { Form } from './layout';

type TicketState = (typeof ticketStates)[number];
export type TicketRow = {
  id: string; title: string; status: 'open' | 'in_progress' | 'closed'; closeReason: string | null; priority: number;
  project: string | null; projectRow: { name: string } | null; assigneeKind: string | null; assignee: string | null;
  isReady: boolean; isShelved: boolean;
};
type Where = Record<string, unknown>;

export const ticketsPageSize = 30;
/** The most a list asks for, however often More is pressed: a longer list is narrowed by a search. */
export const ticketsMost = 300;
const priorityOrder = 'orderBy:{priority:{direction:asc,priority:2},position:{direction:asc,priority:1},id:{direction:asc,priority:0}}';
const recentOrder = 'orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}}';
const fields = 'id title status closeReason priority project projectRow { name } assigneeKind assignee isReady isShelved';
/** Every project the member may read with what loom says its state is. The page does not look at a project to decide
 * whether it is retired (src/single-home.contract.test.ts): `lifecycle` is the server's word for it. A household has
 * few projects; the list is bounded all the same. */
export const ticketsRetiredQuery = 'query BrickTicketsRetired { retired:projects(limit:500) { id lifecycle } }';
export const ticketsReadyQuery = `query BrickTicketsReady($where:TasksFilters!,$limit:Int!) { rows:readyTasks(where:$where,${priorityOrder},limit:$limit) { ${fields} } }`;
export const ticketsOpenQuery = `query BrickTicketsOpen($where:TasksFilters!,$limit:Int!) { rows:tasks(where:$where,${priorityOrder},limit:$limit) { ${fields} } }`;
export const ticketsAllQuery = `query BrickTicketsAll($where:TasksFilters!,$limit:Int!) { rows:tasks(where:$where,${recentOrder},limit:$limit) { ${fields} } }`;

/** The words searched for, as one pattern: each word in turn, anything between. SQLite's LIKE ignores the case of
 * ASCII letters. A `%` or `_` typed is LIKE's own wildcard, which can only widen what matches. */
export const searchPattern = (typed: string) => `%${typed.trim().split(/\s+/).filter(Boolean).join('%')}%`;
const searched = ['id', 'title', 'goal', 'why', 'description', 'project', 'assignee'] as const;

/** What each state asks, and of which read. `retired` is the retired projects' ids, needed by In progress and
 * Shelved. Null asks nothing: there is no shelved ticket when no project is retired. The generated filters take
 * either fields or `OR` at one level, never both, so a search is one alternative per field searched, each holding
 * the state's own filters too. */
export function ticketsRead(state: TicketState, retired: readonly string[], search: string): { query: string; where: Where } | null {
  if (state === 'shelved' && !retired.length) return null;
  const query = state === 'ready' ? ticketsReadyQuery : state === 'all' ? ticketsAllQuery : ticketsOpenQuery;
  const own: Where = state === 'shelved' ? { status: { ne: 'closed' }, project: { inArray: [...retired] } }
    // In progress and not shelved: in no project, or in one that is not retired.
    : state === 'in-progress' ? { status: { eq: 'in_progress' }, ...(retired.length ? { project: { OR: [{ isNull: true }, { notInArray: [...retired] }] } } : {}) }
    : {};
  if (!search) return { query, where: own };
  const like = { like: searchPattern(search) };
  return { query, where: { OR: searched.map((field) => {
    if (field !== 'project' || !own.project) return { ...own, [field]: like };
    // A project that matches is not null, so the in-progress state's "no project" alternative falls away.
    const project = state === 'shelved' ? { inArray: [...retired], ...like } : { notInArray: [...retired], ...like };
    return { ...own, project };
  }) } };
}

const stateWords: Record<TicketState, { title: string; none: string; say(n: string, one: boolean): string }> = {
  ready: { title: 'Ready', none: 'No ticket is ready.', say: (n, one) => `${n} ready ticket${one ? '' : 's'}` },
  'in-progress': { title: 'In progress', none: 'No ticket is in progress.', say: (n, one) => `${n} ticket${one ? '' : 's'} in progress` },
  shelved: { title: 'Shelved', none: 'No ticket is shelved with a retired project.', say: (n, one) => `${n} shelved ticket${one ? '' : 's'}` },
  all: { title: 'All tickets', none: 'No tickets yet.', say: (n, one) => `${n} ticket${one ? '' : 's'}` },
};
/** A ticket's state in the desktop's words: shelved first, then ready, then what it is stored as. */
function stateOf(t: TicketRow): [string, Tone] {
  if (t.status === 'closed') return t.closeReason === 'cancelled' ? ['Cancelled', 'muted'] : ['Closed', 'muted'];
  if (t.isShelved) return ['Shelved', 'muted'];
  if (t.status === 'in_progress') return ['In progress', 'working'];
  return t.isReady ? ['Ready', 'good'] : ['Open', 'neutral'];
}
const holder = (t: TicketRow) => (t.assignee ? `with ${t.assignee}` : 'no one has it');

export function Tickets({ params, form }: { params: Params; form: Form }) {
  const state = (ticketStates as readonly string[]).includes(words(params.state)) ? (words(params.state) as TicketState) : 'ready';
  const big = form === 'primary';
  const [pages, setPages] = useState(1), [typed, setTyped] = useState(''), [asked, setAsked] = useState('');
  const search = big ? asked : '';
  const limit = Math.min(pages * ticketsPageSize, ticketsMost) + 1;
  const needsRetired = state === 'in-progress' || state === 'shelved';
  const retiredRead = useDataQuery<{ retired: { id: string; lifecycle: string }[] | null }>(ticketsRetiredQuery, {}, { keep: true, pause: !needsRetired });
  const retired = needsRetired ? (retiredRead.status === 'live' ? retiredRead.data?.retired?.filter((p) => p.lifecycle === 'retired').map((p) => p.id) ?? null : null) : [];
  const read = retired ? ticketsRead(state, retired, search) : null;
  const listed = useDataQuery<{ rows: TicketRow[] | null }>(read?.query ?? ticketsAllQuery, { where: read?.where ?? {}, limit }, { keep: true, pause: !read || !!search });
  const found = useDataOnce<{ rows: TicketRow[] | null }>(read?.query ?? ticketsAllQuery, { where: read?.where ?? {}, limit }, { pause: !read || !search });
  const submit = (e: FormEvent) => { e.preventDefault(); setPages(1); setAsked(typed.trim().slice(0, 200)); };
  const clear = () => { setTyped(''); setAsked(''); setPages(1); };

  // What the list stands on: the retired projects where the state needs them (a live answer without them is a failed
  // one), then the list or the search. 'none' is a state with nothing to ask (Shelved, with no project retired).
  const shown = search ? found : listed;
  const answer: { status: DataQuerySnapshot<unknown>['status']; rows?: TicketRow[] } | 'none' = needsRetired && retiredRead.status !== 'live' ? { status: retiredRead.status }
    : !retired ? { status: 'offline' } : !read ? 'none' : { status: shown.status, rows: shown.data?.rows ?? undefined };
  const head = stateWords[state];
  const searchBox = big && (
    <form className="board-search" role="search" aria-label="Search tickets" onSubmit={submit}>
      <input className="board-input" type="search" aria-label="Search tickets" placeholder="Search tickets…" maxLength={200} value={typed}
        onChange={(e) => { setTyped(e.target.value); if (!e.target.value.trim() && asked) clear(); }} />
      <Action submit disabled={!typed.trim()}>Search</Action>
      {asked && <Action kind="quiet" onClick={clear}>Show the list</Action>}
    </form>
  );
  const others = big && (
    <div className="board-meta">
      <span>{head.title}</span>
      {ticketStates.filter((s) => s !== state).map((s) => <Chip key={s} place={{ brick: 'tickets', params: { state: s } }}>{stateWords[s].title}</Chip>)}
    </div>
  );
  if (answer !== 'none' && answer.status === 'loading') return big ? <>{others}{searchBox}<Loading /></> : <Loading />;
  if (answer !== 'none' && (answer.status !== 'live' || !answer.rows)) {
    const line = <Note>{search ? 'Search is unavailable.' : 'Tickets are unavailable.'}</Note>;
    return big ? <>{others}{searchBox}{line}</> : line;
  }
  const all = answer === 'none' ? [] : answer.rows!;
  const rows = all.slice(0, limit - 1), more = all.length > rows.length;
  const total = rows.length ? head.say(more ? `More than ${rows.length}` : String(rows.length), rows.length === 1 && !more) : head.none.replace(/\.$/, '');
  if (form === 'compact') return <p className="board-brief">{total}</p>;
  const line = (t: TicketRow) => {
    const [word, tone] = stateOf(t);
    return (
      <Row key={t.id} place={{ brick: 'ticket', params: { ticket: t.id } }} title={<>{t.title} <span className="font-mono board-row-ref">{t.id}</span></>}
        meta={<>{t.projectRow?.name ?? t.project ?? 'No project'} · {holder(t)}</>} end={<State tone={tone}>{word}</State>} />
    );
  };
  const none = <Note>{search ? `Nothing matches “${search}”.` : head.none}</Note>;
  if (!big) return rows.length
    ? <Few of={rows} first={6} fit>{(shown, hidden) => <><Rows>{shown.map(line)}</Rows>{hidden > 0 ? <More n={hidden} /> : more && <Note>and more</Note>}</>}</Few>
    : none;
  const atMost = limit - 1 >= ticketsMost;
  return (
    <>
      <Lead>{search ? `${rows.length ? total : 'No tickets'} matching “${search}”` : total}</Lead>
      {others}
      {searchBox}
      {rows.length ? <Rows>{rows.map(line)}</Rows> : none}
      {more && (atMost ? <Note>Showing the first {ticketsMost}. Search to narrow the list.</Note>
        : <Action kind="quiet" onClick={() => setPages((n) => n + 1)}>Show {ticketsPageSize} more</Action>)}
    </>
  );
}
