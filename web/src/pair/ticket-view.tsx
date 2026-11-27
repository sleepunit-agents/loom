import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useDataQuery } from '../data/graphql';
import { Badge } from './ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Button } from './ui/button';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationEllipsis,
} from './ui/pagination';
import { ModuleCard } from './module-card';
import { EntityPreview, ProjectPreview, ViewPreview, MiniCard, ActorReference } from './entity-preview';
import { Reply } from './reply';

type TicketView = { ticket: string; kind: 'ticket' | 'comment'; ref?: string; intent?: 'work' };
export type ScopeView = { kind: 'repository' | 'agent' | 'member'; project: string; ref: string };
export type PullView = { kind: 'pull'; ref: string; ticket?: string };
export const indexNames = {
  browse: 'Browse',
  projects: 'Projects',
  people: 'People',
  agents: 'Agents',
  repositories: 'Repositories',
  tickets: 'Tickets',
  epics: 'Epics',
  pulls: 'Pull requests',
  comments: 'Comments',
} as const;
export type IndexName = keyof typeof indexNames;
export type IndexView = { kind: 'index'; ref: IndexName };
export type ProfileView = { kind: 'profile'; role: 'member' | 'agent' | 'repository' | 'contact'; ref: string };
export type View =
  IndexView | ProfileView | TicketView | PullView | ScopeView | { kind: 'project'; project: string };
export const ticketView = (ticket: string): TicketView => ({ ticket, kind: 'ticket' });
export const viewKey = (v: View) =>
  v.kind === 'index'
    ? JSON.stringify([v.kind, v.ref])
    : v.kind === 'profile'
      ? JSON.stringify([v.kind, v.role, v.ref])
      : 'project' in v
        ? JSON.stringify(v.kind === 'project' ? [v.kind, v.project] : [v.kind, v.project, v.ref])
        : JSON.stringify([v.kind, v.kind === 'pull' ? '' : v.ticket, v.ref, 'intent' in v ? v.intent : null]);
export function viewLabel(v: View) {
  if (v.kind === 'index') return indexNames[v.ref];
  if (v.kind === 'profile') return v.ref.replace(/^github:/, '') + ' · ' + v.role;
  if (v.kind === 'project') return 'Overview · ' + v.project;
  if ('project' in v) return v.ref.replace(/^github:/, '') + ' · ' + v.project;
  if (v.kind === 'comment') return v.ticket + ' · note ' + v.ref;
  if (v.kind === 'pull') return 'Review ' + v.ref?.split('/').slice(-3).join('/').replace('/pull/', '#');
  return (v.intent === 'work' ? 'Work on ' : 'Review ') + v.ticket;
}
export type Related = {
  type: string;
  changedAt: string;
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  goal: string;
};
type Pull = {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: string;
  checks: string;
  waitingOn: string;
};
type Note = { seq: number; text: string; actor: string; at: string };
export interface Ticket extends Related {
  project: string | null;
  why: string;
  doneWhen: string;
  description: string;
  taskLinksByDependsOn: { type: string; taskRow: Related | null }[];
  taskLinksByTask: { type: string; dependsOnRow: Related | null }[];
  changeTasksByTask: { changeRow: Pull | null }[];
  taskCommentsByTask: Note[];
}
export const relatedFields = 'id title type status assignee goal changedAt';
export const detailsQuery = `query PairTicketView($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){
  ${relatedFields} project why doneWhen description
  taskLinksByDependsOn{type taskRow{${relatedFields}}} taskLinksByTask{type dependsOnRow{${relatedFields}}}
  changeTasksByTask{changeRow{repository number title url state checks waitingOn}}
  taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}}){seq text actor at}
}}`;
type Row = { title: string; state?: string; heading?: string; meta?: string; detail: string; target: View };
function RowPreview({ row, children }: { row: Row; children: React.ReactElement }) {
  return (
    <ViewPreview
      menu="entity"
      view={row.target}
      intent="Show details here."
      preview={
        <MiniCard
          title={row.heading || row.title}
          meta={[row.meta, row.state && !row.meta?.includes(row.state) && row.state]
            .filter(Boolean)
            .join(' · ')}
          detail={row.detail}
        />
      }
    >
      {children}
    </ViewPreview>
  );
}
export const listPageSize = 5;
export type ListPage = { rows: Row[]; hasNext: boolean; pending?: boolean; total?: number; status?: string };
export type Group = {
  browse?: (offset: number, render: (page?: ListPage) => ReactNode) => ReactNode;
  total?: number;
  content?: ReactNode;
  name: string;
  rows: Row[];
  boardProject?: string;
};
type PanelState = { page: number; item?: string };
export type SecondaryState = { selected: string; panels: Record<string, PanelState> };
export function ListPager({
  name,
  page,
  size,
  count,
  pending,
  total,
  hasNext,
  update,
}: {
  name: string;
  page: number;
  size: number;
  count: number;
  pending?: boolean;
  total?: number;
  hasNext: boolean;
  update: (state: PanelState) => void;
}) {
  if (!page && !hasNext) return null;
  const start = page * size;
  const current = page + 1;
  const last = total == null ? current + Number(hasNext) : Math.max(current, Math.ceil(total / size));
  const firstVisible = Math.max(1, Math.min(current - 1, last - 2));
  const numbers = [
    ...new Set([1, firstVisible, Math.min(firstVisible + 1, last), Math.min(firstVisible + 2, last), last]),
  ].sort((a, b) => a - b);
  return (
    <Pagination aria-label={name + ' pages'} className="pair-pager">
      <PaginationContent>
        <PaginationItem>
          <PaginationLink
            size="icon-sm"
            aria-label="Previous"
            disabled={!page}
            onClick={() => update({ page: page - 1 })}
          >
            <ChevronLeftIcon />
          </PaginationLink>
        </PaginationItem>
        {numbers.flatMap((n, i) => {
          const from = numbers[i - 1] + 1;
          const gap =
            n > from ? (
              <PaginationItem key={'gap' + i} className="relative">
                <PaginationEllipsis className="size-7" />
                <select
                  className="absolute inset-0 w-full cursor-pointer opacity-0"
                  aria-label={'Jump to pages ' + from + ' through ' + (n - 1)}
                  value=""
                  onChange={(event) => update({ page: Number(event.target.value) - 1 })}
                >
                  <option disabled value="">
                    Jump to page
                  </option>
                  {Array.from({ length: n - from }, (_, j) => (
                    <option key={from + j} value={from + j}>
                      {from + j}
                    </option>
                  ))}
                </select>
              </PaginationItem>
            ) : null;
          return [
            gap,
            <PaginationItem key={n}>
              <PaginationLink
                size="icon-sm"
                className="w-auto min-w-7 px-1 tabular-nums"
                aria-label={'Page ' + n}
                isActive={current === n}
                onClick={() => update({ page: n - 1 })}
              >
                {n}
              </PaginationLink>
            </PaginationItem>,
          ];
        })}
        <PaginationItem className="ml-auto">
          <PaginationLink
            size="icon-sm"
            aria-label="Next"
            disabled={!hasNext}
            onClick={() => update({ page: page + 1 })}
          >
            <ChevronRightIcon />
          </PaginationLink>
        </PaginationItem>
      </PaginationContent>
      <span
        aria-live="polite"
        aria-atomic="true"
        className="block h-4 text-xs tabular-nums text-muted-foreground"
      >
        {pending
          ? 'Loading page ' + current + '…'
          : count
            ? start + 1 + '–' + (start + count) + (total != null ? ' of ' + total : '')
            : ''}
      </span>
    </Pagination>
  );
}
function SecondaryPanel({
  group,
  renderList,
  remote,
  state,
  update,
  work,
}: {
  group: Group;
  remote?: ListPage;
  renderList?: (open: (row: Row) => void) => ReactNode;
  state: PanelState;
  update: (next: PanelState) => void;
  work: (v: View) => void;
}) {
  const page =
    group.browse || renderList
      ? state.page
      : Math.min(state.page, Math.max(0, Math.ceil(group.rows.length / listPageSize) - 1));
  const start = page * listPageSize;
  const rows = remote
    ? remote.pending && !remote.rows.length
      ? group.rows.slice(0, listPageSize)
      : remote.rows
    : group.rows.slice(start, start + listPageSize);
  const total = remote?.total ?? group.total ?? (group.browse ? undefined : group.rows.length);
  const hasNext =
    total != null
      ? start + listPageSize < total
      : (remote?.hasNext ?? start + listPageSize < group.rows.length);
  const records = renderList ? group.rows : rows;
  const selected = records.find((row) => viewKey(row.target) === state.item);
  const [previous, setPrevious] = useState<string>();
  const detail = selected || records.find((row) => viewKey(row.target) === previous);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const origin = list.current?.querySelector<HTMLButtonElement>(
      'button[data-row="' + CSS.escape(previous || '') + '"]',
    );
    (selected ? back.current : origin || list.current)?.focus({ preventScroll: true });
  }, [state.item, previous, selected]);
  function openRow(row: Row) {
    moveFocus.current = true;
    update({ page: state.page, item: viewKey(row.target) });
  }
  function goBack() {
    setPrevious(state.item);
    moveFocus.current = true;
    update({ page: state.page });
  }
  return (
    <div
      className="pair-drill"
      data-detail={!!selected}
      onKeyDown={(event) => {
        if (selected && event.key === 'Escape') {
          event.stopPropagation();
          event.preventDefault();
          goBack();
        }
      }}
    >
      <div ref={list} tabIndex={-1} className="pair-drill-list" inert={!!selected} aria-hidden={!!selected}>
        {renderList ? (
          renderList(openRow)
        ) : (
          <>
            {remote?.status && <p role="status">{remote.status}</p>}
            <ul className="divide-y" aria-busy={remote?.pending} inert={remote?.pending}>
              {rows.map((row) => (
                <li key={viewKey(row.target)}>
                  <RowPreview row={row}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 py-2 text-left text-sm"
                      data-row={viewKey(row.target)}
                      onClick={() => openRow(row)}
                    >
                      <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">
                        {row.title}
                        {row.state && <span className="ml-2 text-xs text-muted-foreground">{row.state}</span>}
                      </span>
                      <ChevronRightIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    </button>
                  </RowPreview>
                </li>
              ))}
            </ul>
            <ListPager
              name={group.name}
              page={page}
              size={listPageSize}
              count={rows.length}
              pending={remote?.pending}
              total={total}
              hasNext={hasNext}
              update={update}
            />
          </>
        )}
      </div>
      <div className="pair-drill-detail" inert={!selected} aria-hidden={!selected}>
        {detail && (
          <>
            <div className="flex items-center justify-between gap-2">
              <Button ref={back} size="sm" variant="ghost" onClick={goBack}>
                <ChevronLeftIcon />
                Back
              </Button>
              <Button size="sm" variant="ghost" onClick={() => work(detail.target)}>
                Work on this
                <ArrowUpRightIcon />
              </Button>
            </div>
            <div key={viewKey(detail.target)} className="space-y-1 pb-1 text-sm [overflow-wrap:anywhere]">
              <h3 className="font-semibold">{detail.heading || detail.title}</h3>
              {detail.meta && <p className="text-xs text-muted-foreground">{detail.meta}</p>}
              {detail.detail && (
                <div className="text-card-body">
                  <Reply words={detail.detail} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
type BoardTicket = {
  id: string;
  title: string;
  lane: string;
  reason: string | null;
  assignee: string | null;
};
const boardPageSize = 12;
function BoardPanel({
  project,
  state,
  update,
  work,
}: {
  project: string;
  state: PanelState;
  update: (next: PanelState) => void;
  work: (view: View) => void;
}) {
  const read = useDataQuery<{ projectBoardTickets: BoardTicket[] }>(
    'query PairProjectBoard($project:String!,$offset:Int!,$limit:Int!){projectBoardTickets(project:$project,offset:$offset,limit:$limit){id title lane reason assignee}}',
    { project, offset: state.page * boardPageSize, limit: boardPageSize + 1 },
    { keep: true },
  );
  const tickets = read.data?.projectBoardTickets || [];
  const rows: Row[] = tickets.slice(0, boardPageSize).map((t) => ({
    title: t.title,
    state: t.lane,
    meta: [t.id, t.assignee, t.lane].filter(Boolean).join(' · '),
    detail: t.reason || '',
    target: ticketView(t.id),
  }));
  return (
    <SecondaryPanel
      group={{ name: 'Board', rows }}
      state={state}
      update={update}
      work={work}
      renderList={(open) => (
        <>
          {read.status !== 'live' ? (
            <p role="status">{read.status === 'loading' ? 'Opening board…' : 'Board unavailable.'}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {state.page ? 'No more active tickets.' : 'No active tickets on this board.'}
            </p>
          ) : (
            <div className="pair-board" aria-busy={read.settling} inert={read.settling}>
              {['Working', 'Verifying', 'Waiting'].map((lane) => (
                <section key={lane} aria-label={lane}>
                  <h3 className="mb-2 border-b pb-1 text-sm font-semibold">{lane}</h3>
                  <ul className="space-y-2">
                    {rows
                      .filter((row) => row.state === lane)
                      .map((row) => (
                        <li key={viewKey(row.target)}>
                          <RowPreview row={row}>
                            <button
                              type="button"
                              className="w-full rounded-lg border border-border bg-card/70 p-2 text-left text-sm leading-snug hover:bg-card"
                              data-row={viewKey(row.target)}
                              onClick={() => open(row)}
                            >
                              <span className="block font-medium [overflow-wrap:anywhere]">{row.title}</span>
                              {row.detail && (
                                <span className="mt-1 block text-xs text-card-body [overflow-wrap:anywhere]">
                                  {row.detail}
                                </span>
                              )}
                            </button>
                          </RowPreview>
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
          <ListPager
            name="Board"
            page={state.page}
            pending={read.settling}
            size={boardPageSize}
            count={rows.length}
            hasNext={tickets.length > boardPageSize}
            update={update}
          />
        </>
      )}
    />
  );
}
export function Secondary({
  groups,
  work,
  memory,
  view,
}: {
  groups: Group[];
  work: (v: View) => void;
  memory: Map<string, SecondaryState>;
  view: View;
}) {
  const key = viewKey(view);
  const [state, setState] = useState<SecondaryState>(() => memory.get(key) || { selected: '', panels: {} });
  function update(next: SecondaryState) {
    memory.set(key, next);
    setState(next);
  }
  const group = groups.find((g) => g.name === state.selected) || groups[0];
  if (!group) return null;
  return (
    <aside aria-label="Related work" className="pair-secondary min-w-0">
      <Tabs value={group.name} onValueChange={(name) => update({ ...state, selected: name })}>
        <div className="pair-tab-scroll">
          <TabsList variant="line" aria-label="Related work categories">
            {groups.map((g) => (
              <TabsTrigger key={g.name} value={g.name}>
                {g.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="grid">
          {groups.map((g) => {
            const panel = state.panels[g.name] || { page: 0 };
            function updatePanel(next: PanelState) {
              update({ ...state, panels: { ...state.panels, [g.name]: next } });
            }
            return (
              <TabsContent
                key={g.name}
                value={g.name}
                forceMount
                inert={g !== group}
                aria-hidden={g !== group}
                className="col-start-1 row-start-1 min-w-0 data-[state=inactive]:invisible"
              >
                {g.content ? (
                  g === group && (
                    <div className="pair-board-panel">
                      <div className="absolute inset-x-0 top-0">{g.content}</div>
                    </div>
                  )
                ) : g.boardProject ? (
                  g === group && (
                    <div className="pair-board-panel">
                      <BoardPanel project={g.boardProject} state={panel} update={updatePanel} work={work} />
                    </div>
                  )
                ) : g.browse && g === group ? (
                  g.browse(panel.page * listPageSize, (remote) => (
                    <SecondaryPanel
                      group={g}
                      remote={remote}
                      state={panel}
                      update={updatePanel}
                      work={work}
                    />
                  ))
                ) : (
                  <SecondaryPanel group={g} state={panel} update={updatePanel} work={work} />
                )}
              </TabsContent>
            );
          })}
        </div>
      </Tabs>
    </aside>
  );
}
export const ticketRow = (r: Related): Row => ({
  title: r.title,
  state: [r.type === 'epic' && 'Epic', r.status.replaceAll('_', ' ')].filter(Boolean).join(' · '),
  meta: [r.id, r.status.replaceAll('_', ' '), r.assignee].filter(Boolean).join(' · '),
  detail: r.goal,
  target: ticketView(r.id),
});

export function TicketCanvas({
  ticket: t,
  projectOpen,
  view,
  work,
  memory,
}: {
  ticket: Ticket;
  projectOpen: boolean;
  memory: Map<string, SecondaryState>;
  view: View;
  work: (v: View) => void;
}) {
  const pulls = t.changeTasksByTask.flatMap((l) => (l.changeRow ? [l.changeRow] : []));
  const parent: Group = { name: 'Source ticket', rows: [ticketRow(t)] };
  if (view.kind === 'comment') {
    const note = view.kind === 'comment' && t.taskCommentsByTask.find((n) => String(n.seq) === view.ref);
    return (
      <>
        <ModuleCard
          title={note ? 'Comment on ' + t.id : 'Record unavailable'}
          description={
            note ? (
              <>
                {t.project ? <ActorReference project={t.project} id={note.actor} work={work} /> : note.actor}{' '}
                · {new Date(note.at).toLocaleString()}
              </>
            ) : (
              t.id
            )
          }
        >
          {note && <Reply words={note.text} />}
        </ModuleCard>
        <Secondary view={view} memory={memory} groups={[parent]} work={work} />
      </>
    );
  }
  const relations = t.taskLinksByDependsOn.flatMap((l) =>
    l.taskRow ? [{ type: l.type, ticket: l.taskRow }] : [],
  );
  const related = [
    ...relations.filter((l) => l.type !== 'parent-child'),
    ...t.taskLinksByTask.flatMap((l) => (l.dependsOnRow ? [{ type: l.type, ticket: l.dependsOnRow }] : [])),
  ];
  const rank = (p: Pull) =>
    p.checks === 'failing' || p.waitingOn === 'you' ? 0 : p.state === 'open' ? 1 : 2;
  const ticketRank = (r: Related) =>
    r.status === 'blocked' ? 0 : r.status === 'in_progress' ? 1 : r.status === 'closed' ? 3 : 2;
  const groups: Group[] = [
    {
      name: 'Child tickets',
      rows: relations
        .filter((l) => l.type === 'parent-child')
        .sort((a, b) => ticketRank(a.ticket) - ticketRank(b.ticket))
        .map((l) => ticketRow(l.ticket)),
    },
    {
      name: 'Changes',
      rows: pulls
        .sort((a, b) => rank(a) - rank(b))
        .map((p) => ({
          title: p.title,
          state: p.checks === 'failing' ? 'Failing checks' : p.state,
          meta: p.repository + ' #' + p.number + ' · ' + p.state,
          detail: ['Checks: ' + p.checks, p.waitingOn && 'Waiting on: ' + p.waitingOn]
            .filter(Boolean)
            .join('\n'),
          target: { kind: 'pull', ticket: t.id, ref: p.url },
        })),
    },
    {
      name: 'Comments',
      rows: t.taskCommentsByTask.map((n) => ({
        title: n.actor + ' · ' + n.text.slice(0, 85).replace(/\s+/g, ' ') + (n.text.length > 85 ? '…' : ''),
        heading: n.actor,
        meta: t.id + ' · ' + new Date(n.at).toLocaleString(),
        detail: n.text,
        target: { kind: 'comment', ticket: t.id, ref: String(n.seq) },
      })),
    },
    {
      name: 'Related tickets',
      rows: Array.from(new Map(related.map((l) => [l.ticket.id, ticketRow(l.ticket)])).values()),
    },
  ];
  return (
    <>
      <ModuleCard
        title={t.title}
        description={
          <>
            {t.project && (
              <>
                <EntityPreview
                  intent={
                    projectOpen
                      ? 'Return to the open project overview.'
                      : 'Open the project overview in this context.'
                  }
                  menu={{view:{kind:'project',project:t.project}}}
                  preview={<ProjectPreview id={t.project} />}
                  link={
                    <a
                      className="underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
                      href={'#project=' + encodeURIComponent(t.project)}
                      onClick={(e) => {
                        if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && t.project) {
                          e.preventDefault();
                          work({ kind: 'project', project: t.project });
                        }
                      }}
                    >
                      {t.project}
                    </a>
                  }
                />
                {' · '}
              </>
            )}
            {t.type === 'epic' && 'Epic · '}
            {t.id}
            {t.assignee && (
              <>
                {' '}
                · Assigned to{' '}
                {t.project ? <ActorReference project={t.project} id={t.assignee} work={work} /> : t.assignee}
              </>
            )}
          </>
        }
        action={<Badge variant="secondary">{t.status.replaceAll('_', ' ')}</Badge>}
      >
        {Object.entries({
          Goal: t.goal,
          Why: t.why,
          'Done when': t.doneWhen,
          Description: t.description,
        }).map(
          ([name, words]) =>
            words && (
              <section key={name}>
                <h2 className="font-medium">{name}</h2>
                <div className="text-sm text-card-body">
                  <Reply words={words} />
                </div>
              </section>
            ),
        )}
      </ModuleCard>
      <Secondary view={view} memory={memory} groups={groups.filter((g) => g.rows.length)} work={work} />
    </>
  );
}
