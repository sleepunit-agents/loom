import { TicketUpdates } from './ticket-updates';
import { EpicProgress } from './epic-progress';
import { DeskMember } from '../signin/desk-member';
import { kept, keep } from './ring';
import { entityAddress } from './entities';
import { WorkJobs } from './work-jobs';
import { useContext, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { ticketViews, type EntityTarget } from './entities';

type Ticket = { id: string; title: string; status: string; assignee: string | null; type: string };
type Pull = {
  id: string;
  repository: string;
  number: number;
  title: string;
  state: string;
  checks: string;
  review: string;
  draft: boolean;
  waitingOn: string;
};
type Links = {
  taskLinksByDependsOn: { type: string; taskRow: Ticket | null }[];
  taskLinksByTask: { type: string; dependsOnRow: Ticket | null }[];
  changeTasksByTask: { changeRow: Pull | null }[];
};
type Note = { seq: number; at: string; actor: string; text: string };
const ticketFields = 'id title status assignee type';
export const workLinksQuery = `query ContextWorkLinks($id:String!){
  ticket:tasksSingle(where:{id:{eq:$id}}){
    taskLinksByDependsOn{type taskRow{${ticketFields}}}
    taskLinksByTask{type dependsOnRow{${ticketFields}}}
    changeTasksByTask{changeRow{id repository number title state checks review draft waitingOn}}
  }
  changeSync{readAt failed}
}`;
const historyQuery =
  'query ContextTicketNotes($id:String!,$offset:Int!){rows:taskComments(where:{task:{eq:$id}},orderBy:{seq:{direction:desc,priority:0}},limit:31,offset:$offset){seq at actor text}}';
function Notes({ id }: { id: string }) {
  const [page, setPage] = useState(0);
  const read = useDataQuery<{ rows: Note[] }>(historyQuery, { id, offset: page * 30 });
  if (read.status !== 'live' || read.settling || !read.data)
    return <p>{read.status === 'loading' || read.settling ? 'Reading history…' : 'History unavailable.'}</p>;
  const rows = read.data.rows;
  return (
    <section>
      <h3>Ticket history</h3>
      {rows.length === 0 && <p>No comments on this page.</p>}
      {rows.slice(0, 30).map((n) => (
        <article key={n.seq}>
          <small>
            {n.actor} · {new Date(n.at).toLocaleString()}
          </small>
          <p>{n.text}</p>
        </article>
      ))}
      {page > 0 && <button onClick={() => setPage(page - 1)}>Newer comments</button>}
      {rows.length > 30 && <button onClick={() => setPage(page + 1)}>Older comments</button>}
    </section>
  );
}
export function TicketWork({
  target,
  row,
  open,
}: {
  target: EntityTarget & { id: string };
  row: Record<string, unknown>;
  open: (t: EntityTarget) => void;
}) {
  const read = useDataQuery<{
    ticket: Links | null;
    changeSync: { readAt: string | null; failed: boolean }[];
  }>(workLinksQuery, { id: target.id });
  const links = read.data?.ticket;
  const member = useContext(DeskMember);
  const key = JSON.stringify([
    'work-companions',
    member,
    new URL(location.href).searchParams.get('ctx') || 'loom',
    entityAddress(target),
  ]);
  const [hidden, hide] = useState<string[]>(() => {
    try {
      const values = JSON.parse(kept(key) || '[]');
      return Array.isArray(values) ? values.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  });
  function remember(ids: string[]) {
    hide(ids);
    keep(key, JSON.stringify(ids));
  }
  const children =
    links?.taskLinksByDependsOn.flatMap((l) => (l.type === 'parent-child' && l.taskRow ? [l.taskRow] : [])) ||
    [];
  const pulls = links?.changeTasksByTask.flatMap((l) => (l.changeRow ? [l.changeRow] : [])) || [];
  function reason(pr: Pull) {
    return pr.state !== 'open'
      ? ''
      : pr.checks === 'failing'
        ? 'Checks failed'
        : pr.review === 'changes_requested'
          ? 'Changes requested'
          : pr.waitingOn === 'you'
            ? 'Needs your decision'
            : '';
  }
  const group = (name: string, rows: Ticket[]) =>
    rows.length > 0 && (
      <section>
        <h3>
          {name} · {rows.length}
        </h3>
        <ul>
          {rows.map((t) => (
            <li key={t.id}>
              <button onClick={() => open({ kind: 'ticket', id: t.id })}>
                {t.id} · {t.title}
              </button>{' '}
              {t.status.replaceAll('_', ' ')}
              {t.assignee && ' · ' + t.assignee}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className="workStatus">
      <section><h3>Ticket status</h3><p>
        {String(row.type)} · {String(row.status).replaceAll('_', ' ')} ·{' '}
        {row.assignee ? 'Assigned to ' + row.assignee : 'Unassigned'}
      </p>
      <div className="entityActions">
        {Object.entries(ticketViews).map(([view, label]) => (
          <button
            key={view}
            aria-pressed={target.view === view}
            onClick={() => open({ ...target, view: view as keyof typeof ticketViews })}
          >
            {label}
          </button>
        ))}
        {typeof row.project === 'string' && (
          <button onClick={() => open({ kind: 'project', id: row.project as string })}>Project health</button>
        )}
      </div>
      </section>
      {row.type === 'epic' && typeof row.project === 'string' && (
        <EpicProgress project={row.project} epic={target.id} open={open} />
      )}
      <WorkJobs scope="task" id={target.id} />
      {target.view === 'history' && (
        <>
          <Notes id={target.id} />
          <TicketUpdates id={target.id} open={open} />
        </>
      )}
      {target.view === 'decision' && (
        <section>
          <h3>Decision</h3>
          <p>
            {String(
              row.ask ||
                (row.status === 'closed'
                  ? row.closeReason || 'Ticket closed.'
                  : 'No open question on this ticket.'),
            )}
          </p>
        </section>
      )}
      {read.status !== 'live' || read.settling || !links ? (
        <p>
          {read.status === 'loading' || read.settling ? 'Reading linked work…' : 'Linked work unavailable.'}
        </p>
      ) : (
        <>
          {(row.type === 'epic' || children.length > 0) && (
            <section><h3>Progress</h3><p>
              {children.filter((c) => c.status === 'closed').length} of {children.length} visible children
              closed · {children.filter((c) => c.status === 'in_progress').length} in progress
            </p></section>
          )}
          {group('Child tickets', children)}
          {group(
            'Depends on',
            links.taskLinksByTask.flatMap((l) =>
              l.type === 'blocks' && l.dependsOnRow ? [l.dependsOnRow] : [],
            ),
          )}
          {group(
            'Blocks',
            links.taskLinksByDependsOn.flatMap((l) => (l.type === 'blocks' && l.taskRow ? [l.taskRow] : [])),
          )}
          {group(
            'Parent',
            links.taskLinksByTask.flatMap((l) =>
              l.type === 'parent-child' && l.dependsOnRow ? [l.dependsOnRow] : [],
            ),
          )}
          <section>
            <h3>Linked pull requests</h3>
            {!links.changeTasksByTask.some((l) => l.changeRow) && <p>No visible linked pull requests.</p>}
            {pulls
              .filter((pr) => !hidden.includes(pr.id))
              .sort((a, b) => Number(!!reason(b)) - Number(!!reason(a)))
              .map((pr) => (
                <details
                  className={'prCompanion ' + (reason(pr) ? 'near' : 'far')}
                  key={pr.id}
                  open={!!reason(pr) || target.view === 'history'}
                >
                  <summary>
                    {pr.repository} #{pr.number} · {pr.title}
                    {reason(pr) && ' · ' + reason(pr)}
                  </summary>
                  <p>
                    {pr.draft ? 'Draft · ' : ''}
                    {pr.state} · Checks {pr.checks} · Review {pr.review.replaceAll('_', ' ')} · Waiting on{' '}
                    {pr.waitingOn}
                  </p>
                  <button onClick={() => open({ kind: 'change', id: pr.id })}>Open pull request</button>
                  <button onClick={() => remember([...hidden, pr.id])}>Dismiss from this view</button>
                </details>
              ))}
            {pulls.some((pr) => hidden.includes(pr.id)) && (
              <button onClick={() => remember([])}>Restore dismissed pull requests</button>
            )}
            <small>
              {read.data?.changeSync[0]?.failed && 'Latest GitHub read failed. '}
              {read.data?.changeSync[0]?.readAt
                ? 'GitHub last read ' + new Date(read.data.changeSync[0].readAt).toLocaleString()
                : 'GitHub read time unavailable.'}
            </small>
          </section>
        </>
      )}
    </div>
  );
}
