import { useDataQuery } from '../data/graphql';
type Job = {
  id: string;
  agent: string;
  state: string;
  basis: string;
  heardAt: string | null;
  queuedAt: string;
};
export function WorkJobs({ scope, id }: { scope: 'task' | 'project'; id: string }) {
  const feed = useDataQuery<{
    contextWorkJobs: Job[];
    sessions: { id: string; agent: string; at: string; heardAt: string; tasks: string[] }[];
  }>(
    'query ContextJobs($id:String!){contextWorkJobs(' +
      scope +
      ':$id){id agent state basis heardAt queuedAt} sessions:contextReportedSessions(' +
      scope +
      ':$id){id agent at heardAt tasks}}',
    { id },
  );
  const reports = feed.data?.sessions || [];
  const jobs = (feed.data?.contextWorkJobs || []).filter((job) => !reports.some((r) => r.id === job.id));
  return (
    <section>
      <h3>Agent work</h3>
      {feed.status !== 'live' || feed.settling || !feed.data ? (
        <p>
          {feed.status === 'loading' || feed.settling ? 'Reading runtime…' : 'Runtime evidence unavailable.'}
        </p>
      ) : jobs.length || reports.length ? (
        <ul>
          {reports.map((r) => (
            <li key={r.id}>
              <strong>{r.agent} · running</strong> · Reported work on {r.tasks.join(', ')}
              <div>
                Reported {new Date(r.at).toLocaleString()} · Last heard {new Date(r.heardAt).toLocaleString()}
              </div>
            </li>
          ))}
          {jobs.map((job) => (
            <li key={job.id}>
              <strong>
                {job.agent} · {job.state}
              </strong>{' '}
              · {job.basis}
              <div>
                {job.heardAt
                  ? 'Last heard ' + new Date(job.heardAt).toLocaleString()
                  : 'Queued ' + new Date(job.queuedAt).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>No visible queued or running job linked to this {scope}.</p>
      )}
    </section>
  );
}
