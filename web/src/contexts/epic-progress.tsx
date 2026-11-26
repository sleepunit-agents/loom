import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import type { EntityTarget } from './entities';
type Card = { id: string; title: string; assignee: string | null; lane: string; reason: string | null };
export function EpicProgress({
  project,
  epic,
  open,
}: {
  project: string;
  epic?: string;
  open: (target: EntityTarget) => void;
}) {
  const [offset, page] = useState(0);
  const read = useDataQuery<{ projectBoardTickets: Card[] }>(
    'query ContextEpicBoard($project:String!,$epic:String,$offset:Int!){projectBoardTickets(project:$project,epic:$epic,offset:$offset,limit:31){id title assignee lane reason}}',
    { project, epic, offset },
  );
  const cards = read.data?.projectBoardTickets;
  return (
    <section>
      <h3>{epic ? 'Work underway in this epic' : 'Work underway'}</h3>
      {read.status !== 'live' || !cards ? (
        <p>{read.status === 'loading' ? 'Reading child work…' : 'Child work unavailable.'}</p>
      ) : (
        <>
          {!cards.length && <p>No visible active board items.</p>}
          {cards.slice(0, 30).map((c) => (
            <article key={c.id}>
              <button onClick={() => open({ kind: 'ticket', id: c.id })}>
                {c.id} · {c.title}
              </button>
              <p>
                {c.lane}
                {c.assignee && ' · ' + c.assignee}
                {c.reason && ' · ' + c.reason}
              </p>
            </article>
          ))}
          {offset > 0 && <button onClick={() => page(offset - 30)}>Previous</button>}
          {cards.length > 30 && <button onClick={() => page(offset + 30)}>More</button>}
        </>
      )}
    </section>
  );
}

type Rollup = {
  totals: { status: string; count: number }[];
  pullTotals: { status: string; count: number }[];
  pullCount: number;
  pulls: {
    id: string;
    title: string;
    number: number;
    repository: string;
    state: string;
    review: string;
    checks: string;
  }[];
};
export function ScopeWork({
  id,
  kind,
  open,
}: {
  id: string;
  kind: 'task' | 'project';
  open: (target: EntityTarget) => void;
}) {
  const [offset, page] = useState(0),
    [filter, choose] = useState('');
  const read = useDataQuery<{
    contextScopeWork: Rollup | null;
    changeSync: { failed: boolean; readAt: string | null }[];
  }>(
    'query ContextScope($id:String!,$offset:Int!,$state:String){contextScopeWork(' +
      kind +
      ':$id,offset:$offset,state:$state){totals{status count} pullTotals{status count} pullCount pulls{id repository number title state checks review}} changeSync{readAt failed}}',
    { id, offset, state: filter || null },
  );
  const scope = read.data?.contextScopeWork,
    sync = read.data?.changeSync[0];
  const count = filter
    ? scope?.pullTotals.find((t) => t.status === filter)?.count || 0
    : scope?.pullCount || 0;
  return (
    <section>
      <h3>{kind === 'task' ? 'Across this epic' : 'Project pull requests'}</h3>
      {!scope || read.status !== 'live' ? (
        <p>{read.status === 'loading' ? 'Reading work…' : 'Work summary unavailable.'}</p>
      ) : (
        <>
          {kind === 'task' && (
            <p>
              {['open', 'in_progress', 'closed']
                .map(
                  (status) =>
                    (scope.totals.find((t) => t.status === status)?.count || 0) +
                    ' ' +
                    status.replaceAll('_', ' '),
                )
                .join(' · ')}{' '}
              across all visible descendants
            </p>
          )}
          <div className="entityActions">
            {['', 'open', 'merged', 'closed'].map((f) => (
              <button
                key={f}
                aria-pressed={f === filter}
                onClick={() => {
                  choose(f);
                  page(0);
                }}
              >
                {f || 'All PRs'} ·{' '}
                {f ? scope.pullTotals.find((r) => r.status === f)?.count || 0 : scope.pullCount}
              </button>
            ))}
          </div>
          <small>
            {sync?.failed && 'Latest GitHub read failed. '}
            {sync?.readAt
              ? 'GitHub last read ' + new Date(sync.readAt).toLocaleString()
              : 'GitHub read time unavailable.'}
          </small>
          {!count && <p>No matching pull requests.</p>}
          {scope.pulls.map((p) => (
            <article key={p.id}>
              <button onClick={() => open({ kind: 'change', id: p.id })}>
                {p.repository} #{p.number} · {p.title}
              </button>
              <p>
                {p.state} · Checks {p.checks} · Review {p.review.replaceAll('_', ' ')}
              </p>
            </article>
          ))}
          {offset > 0 && <button onClick={() => page(offset - 30)}>Previous pull requests</button>}
          {count > offset + 30 && <button onClick={() => page(offset + 30)}>More pull requests</button>}
        </>
      )}
    </section>
  );
}
