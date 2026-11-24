import {SignInWarning} from '../runtime/sign-in-warning';
import { Fragment, useState } from 'react';
import { briefTime } from '../../kit/time';
import { useHouseholdZone } from '../../data/zone';
import { useDataQuery } from '../../data/graphql';
import { Body, List, Row, Section } from '../../kit';

/** An agent's jobs for its own page: the ones running now, then the ones that ended, newest first. Machine
 * names come only from the machines this viewer may read, in the same request. */
export const agentJobsQuery = `query DeskAgentJobs($agent: String!) {
  jobHistory(agent: $agent, first: 30) { id agent title state signInBlocked box model queuedAt claimedAt endedAt }
  boxes { id name }
}`;
interface Job { id: string; agent: string; title: string; state: string; signInBlocked?: boolean; model: string | null; box: string | null; queuedAt: string; claimedAt: string | null; endedAt: string | null }
type Data = { jobHistory: Job[]; boxes?: { id: string; name: string }[] };
const current = ['queued', 'starting', 'running'];
const stateWords: Record<string, string> = { queued: 'Queued', starting: 'Starting', running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped', lost: 'Lost' };
const capacityQuery = `query JobSubscription($agent: String!, $job: String!) {
  jobSubscription(agent: $agent, job: $job) { label level }
}`;

function JobDetails({job}: {job: Job}) {
  const query = useDataQuery<{jobSubscription: {label: string; level: string} | null}>(capacityQuery, {agent: job.agent, job: job.id});
  const account = query.status === 'live' ? query.data?.jobSubscription : null;
  return <section aria-label="Job details" className="px-4 pb-3">
    {job.model && <Body>Model · {job.model}</Body>}
    {account ? <Body>Subscription now · <span className="loom-job-capacity" data-capacity={account.level}>{account.label} · {account.level}</span></Body>
      : <Body quiet>{query.status === 'loading' ? 'Checking subscription…' : query.status === 'live' ? 'No subscription to show.' : 'Subscription unavailable.'}</Body>}
  </section>;
}

export function AgentJobs({ agent, name }: { agent: string; name: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const zone = useHouseholdZone();
  const query = useDataQuery<Data>(agentJobsQuery, { agent });
  const live = query.status === 'live' && !!query.data && Array.isArray(query.data.jobHistory);
  const jobs = live ? query.data!.jobHistory.filter(job => job.agent === agent) : [];
  const machines = new Map((live ? query.data!.boxes ?? [] : []).map(box => [box.id, box.name]));
  const row = (job: Job) => <Fragment key={job.id}><Row aria-expanded={expanded === job.id} onClick={() => setExpanded(current => current === job.id ? null : job.id)} title={job.title || 'Untitled job'}
    trailing={job.state === 'failed' && job.signInBlocked ? <SignInWarning label="A machine needed sign-in on the last placement check"/> : undefined}
    meta={[stateWords[job.state] ?? job.state, job.box && machines.has(job.box) ? `on ${machines.get(job.box)}` : '', `queued ${briefTime(job.queuedAt, zone)}`,
      job.claimedAt ? `started ${briefTime(job.claimedAt, zone)}` : '', job.endedAt ? `ended ${briefTime(job.endedAt, zone)}` : ''].filter(Boolean).join(' · ')} />
    {expanded === job.id && <JobDetails job={job}/>}</Fragment>;
  const now = jobs.filter(job => current.includes(job.state) && job.state !== 'queued'), queued = jobs.filter(job => job.state === 'queued'), earlier = jobs.filter(job => !current.includes(job.state));
  return <Section label="Jobs">
    {query.status === 'loading' || query.status === 'live' && !live ? <Body quiet>Checking…</Body> : !live ? <Body quiet>Can’t read jobs right now.</Body>
      : !jobs.length ? <Body quiet>None yet.</Body> : <>
        {now.length > 0 && <List label={`${name} jobs now`}>{now.map(row)}</List>}
        {queued.length > 0 && <><Body quiet>Queued</Body><List label={`${name} queued jobs`}>{queued.map(row)}</List></>}
        {earlier.length > 0 && <><Body quiet>Earlier</Body><List label={`${name} earlier jobs`}>{earlier.map(row)}</List></>}
      </>}
  </Section>;
}
