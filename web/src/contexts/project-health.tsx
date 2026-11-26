import { ProjectNotes } from '../pieces/work/project-notes';
import { ProjectPosts } from '../pieces/work/catch-up';
import { linkedEntity } from './entity-links';
import { WorkJobs } from './work-jobs';
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { ScopeWork, EpicProgress } from './epic-progress';
import type { EntityTarget } from './entities';
type Ticket = { id: string; title: string; assignee: string | null };
const filters = ['In progress', 'Open', 'Blocked', 'Questions', 'Epics', 'Closed'] as const;
const query =
  'query ContextProjectTickets($id:String!,$group:String!,$offset:Int!){contextProjectTickets(id:$id,group:$group,offset:$offset){rows{id title assignee} counts{group count}}}';
export function ProjectHealth({ id, open }: { id: string; open: (target: EntityTarget) => void }) {
  const [filter, choose] = useState<(typeof filters)[number]>('In progress'),
    [page, setPage] = useState(0);
  const read = useDataQuery<{
    contextProjectTickets: { rows: Ticket[]; counts: { group: string; count: number }[] } | null;
  }>(query, { id, group: filter, offset: page * 30 });
  const tickets = read.data?.contextProjectTickets?.rows;
  const count = (f: string) =>
    read.data?.contextProjectTickets?.counts.find((item) => item.group === f)?.count || 0;
  return (
    <section className="workStatus">
      <section>
        <h2>Project health</h2>
        {read.status !== 'live' || read.settling || !tickets ? (
          <p>
            {read.status === 'loading' || read.settling ? 'Reading project…' : 'Project status unavailable.'}
          </p>
        ) : (
          <>
            <div className="entityActions">
              {filters.map((f) => (
                <button
                  key={f}
                  aria-pressed={f === filter}
                  onClick={() => {
                    choose(f);
                    setPage(0);
                  }}
                >
                  {f} · {count(f)}
                </button>
              ))}
            </div>
            <ul>
              {tickets.map((t) => (
                <li key={t.id}>
                  <button onClick={() => open({ kind: 'ticket', id: t.id })}>
                    {t.id} · {t.title}
                  </button>{' '}
                  {t.assignee}
                </li>
              ))}
            </ul>
            {!tickets.length && <p>No matching tickets.</p>}
            {page > 0 && <button onClick={() => setPage(page - 1)}>Previous tickets</button>}
            {count(filter) > (page + 1) * 30 && (
              <button onClick={() => setPage(page + 1)}>More tickets</button>
            )}
          </>
        )}
      </section>
      <ProjectPosts
        project={id}
        go={(path) => {
          const ref = linkedEntity(path);
          if (ref) open(ref);
        }}
      />
      <ProjectNotes
        project={id}
        go={(path) => open({ kind: 'projectNotes', id: decodeURIComponent(path.split('/').at(-1)!) })}
      />
      <WorkJobs scope="project" id={id} />
      <EpicProgress project={id} open={open} />
      <ScopeWork kind="project" id={id} open={open} />
    </section>
  );
}
