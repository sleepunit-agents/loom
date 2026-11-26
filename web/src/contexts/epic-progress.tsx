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
  epic: string;
  open: (target: EntityTarget) => void;
}) {
  const [offset, page] = useState(0);
  const read = useDataQuery<{ projectBoardTickets: Card[] }>(
    'query ContextEpicBoard($project:String!,$epic:String!,$offset:Int!){projectBoardTickets(project:$project,epic:$epic,offset:$offset,limit:31){id title assignee lane reason}}',
    { project, epic, offset },
  );
  const cards = read.data?.projectBoardTickets;
  return (
    <section>
      <h3>Work underway in this epic</h3>
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
