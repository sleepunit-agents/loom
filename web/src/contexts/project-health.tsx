import { ProjectNotes } from '../pieces/work/project-notes';
import { ProjectPosts } from '../pieces/work/catch-up';
import { linkedEntity } from './entity-links';
import { WorkJobs } from './work-jobs';
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { ProjectChanges } from '../pieces/work/project-changes';
import type { EntityTarget } from './entities';
type Ticket = {
  id: string;
  title: string;
  type: string;
  status: string;
  isReady: boolean;
  isShelved: boolean;
  assignee: string | null;
  ask: string | null;
};
const query = `query ContextProjectHealth($id:String!){
  project:projectsSingle(where:{id:{eq:$id}}){id tasksByProject(orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}}){id title type status isReady isShelved assignee ask}}
}`;
const filters = ['In progress', 'Open', 'Blocked', 'Questions', 'Epics', 'Closed'] as const;
function matches(t: Ticket, filter: (typeof filters)[number]) {
  switch (filter) {
    case 'Epics':
      return t.type === 'epic';
    case 'Questions':
      return !!t.ask && t.status !== 'closed';
    case 'Blocked':
      return t.type !== 'epic' && t.status === 'open' && !t.isReady && !t.isShelved && !t.ask;
    case 'Open':
      return t.status === 'open';
    case 'Closed':
      return t.status === 'closed';
    case 'In progress':
      return t.status === 'in_progress';
  }
}
export function ProjectHealth({ id, open }: { id: string; open: (target: EntityTarget) => void }) {
  const read = useDataQuery<{ project: { tasksByProject: Ticket[] } | null }>(query, { id });
  const [filter, choose] = useState<(typeof filters)[number]>('In progress');
  const [page, setPage] = useState(0);
  const base = '/p/work/project/' + encodeURIComponent(id) + '/changes';
  const [path, setPath] = useState(base);
  const tickets = read.data?.project?.tasksByProject;
  return (
    <section className="workStatus">
      <section><h2>Project health</h2>
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
                {f} · {tickets.filter((t) => matches(t, f)).length}
              </button>
            ))}
          </div>
          <ul>
            {tickets
              .filter((t) => matches(t, filter))
              .slice(page * 30, (page + 1) * 30)
              .map((t) => (
                <li key={t.id}>
                  <button onClick={() => open({ kind: 'ticket', id: t.id })}>
                    {t.id} · {t.title}
                  </button>{' '}
                  {t.assignee}
                </li>
              ))}
          </ul>
          {!tickets.some((t) => matches(t, filter)) && <p>No matching tickets.</p>}
          {page > 0 && <button onClick={() => setPage(page - 1)}>Previous tickets</button>}
          {tickets.filter((t) => matches(t, filter)).length > (page + 1) * 30 && (
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
      <ProjectChanges
        project={id}
        path={path}
        go={(next) => {
          const match = /\/change\/([^?]+)/.exec(next);
          if (match) open({ kind: 'change', id: decodeURIComponent(match[1]) });
          else setPath(next);
        }}
      />
    </section>
  );
}
