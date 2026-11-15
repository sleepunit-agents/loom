import { useLayoutEffect, useRef } from 'react';
import { useDataQuery } from '../../data/graphql';
import { Loading, Error } from '../../kit';
import { stamp } from './time';

export const currentJobsQuery = `query DeskCurrentJobs($agent: String!) {
  currentJobs(agent: $agent) { id agent title state box queuedAt }
}`;
export type CurrentJob = { id: string; agent: string; title: string; state: string; box: string | null; queuedAt: string };
type Data = { currentJobs: CurrentJob[] };
/** One selection on the shared live client, scoped to a currently owned card.
 * Preserve server queuedAt/id order and never retain unavailable job words. */
export function CurrentJobs({ agent, name, compact = false, onChange }: { agent: string; name: string; compact?: boolean; onChange?: () => void }) {
  const query = useDataQuery<Data>(currentJobsQuery, { agent });
  const previous = useRef(query);
  useLayoutEffect(() => {
    const before = previous.current; previous.current = query;
    if (before.status !== query.status || before.data !== query.data) onChange?.();
  }, [query.status, query.data, onChange]);
  const live = query.status === 'live' && !!query.data;
  const jobs = live ? query.data!.currentJobs.filter(job => job.agent === agent) : [];
  if (compact) return <div className="desk-rail-jobs" aria-label={`${name} current jobs`}>
    <span className="desk-rail-kicker">Current jobs{live ? ` · ${jobs.length}` : ''}</span>
    {!live ? <p>Jobs unavailable</p> : !jobs.length ? <p>No current jobs.</p> : <ul>{jobs.map(job => <li key={job.id}>
      <strong>{job.title || job.id}</strong><span>{job.state} · {job.box ?? 'Unassigned'}</span>
    </li>)}</ul>}
  </div>;
  return <section aria-label={`${name} runtime jobs`} className="grid min-w-0 gap-2">
    <h3>Runtime jobs{live ? ` · ${jobs.length}` : ''}</h3>
    {!live ? query.status === 'loading' ? <Loading label="Opening runtime jobs…" /> : <Error title="Couldn’t load runtime jobs" text={query.status === 'denied' ? 'Sign in with access to see this.' : 'Waiting for connection.'} /> :
      !jobs.length ? <p>No current runtime jobs.</p> : <ul className="grid min-w-0 gap-3" aria-label={`${name} current runtime jobs`}>{jobs.map(job => <li key={job.id} className="min-w-0 border-b pb-2">
        <h4>{job.title || job.id}</h4><p>{job.state} · {job.box === null ? 'Unassigned' : `Box ${job.box}`}</p>
        <p>Queued <time dateTime={job.queuedAt}>{stamp(Date.parse(job.queuedAt))}</time></p>
      </li>)}</ul>}
  </section>;
}
