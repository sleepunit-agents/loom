/** The `agent` brick: one agent as Home's card and the Agents app say it (pieces/attention): who it is, its state
 * and its own report, what it is doing now, its jobs running and recent, its open tickets, and the way to its
 * conversation. Every read is the desktop's own; the words for a state and for a thing being done are its words. */
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { useDeskAgentProfiles } from '../pieces/attention/agent-profiles';
import { useDeskAgentStatuses } from '../pieces/attention/agent-status';
import { doingMeta, doingPhrase, useDoing } from '../pieces/attention/doing-model';
import { useHomeComms } from '../pieces/attention/home-comms-data';
import { agentStateLine, latestStatus, shownState } from '../pieces/attention/home-model';
import { useDeskWaitingCounts } from '../pieces/attention/waiting-counts';
import { threadPath, useAgentNames } from './agents-data';
import { Assigned } from './assigned';
import { Chip, Loading, Unavailable, useOwnFlag, words, type Act, type Params, type Raise } from './brick-kit';
import type { Form } from './layout';

type Job = { id: string; title: string; state: string; conversation: string | null; queuedAt: string; endedAt: string | null };
export const agentJobsQuery = 'query BrickAgentJobs($agent:String!,$first:Int!){jobs:jobHistory(agent:$agent,first:$first){id title state conversation queuedAt endedAt}}';
const running = (state: string) => state === 'queued' || state === 'starting' || state === 'running';
const when = (at: string) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Agent({ params, form, act, raise }: { params: Params; form: Form; act: Act; raise: Raise }) {
  const id = words(params.agent), primary = form === 'primary';
  const profiles = useDeskAgentProfiles(), statuses = useDeskAgentStatuses(), waiting = useDeskWaitingCounts(), comms = useHomeComms();
  const doing = useDoing(id, primary), name = useAgentNames();
  const read = useDataQuery<{ jobs: Job[] }>(agentJobsQuery, { agent: id, first: primary ? 30 : 12 }, { keep: true, pause: form === 'compact' });
  const needs = waiting.status === 'live' ? waiting.agents.get(id) ?? 0 : undefined;
  useOwnFlag(needs, raise, (was, now) => (was === 0 && now > 0 ? 'Waiting on you' : null));
  const [asking, setAsking] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (profiles.status === 'loading') return <Loading />;
  const profile = profiles.status === 'live' ? profiles.records.find((p) => p.agent === id) : undefined;
  if (!profile) return <Unavailable what="agent" />;
  const status = statuses.status === 'live' ? latestStatus(statuses.records, id) : undefined;
  const count = doing.items.length, state = shownState(status?.state, count), line = agentStateLine(status?.state, count, needs);
  if (form === 'compact') return <p className="board-brief"><span className="board-state" data-running={state === 'working'}>{line}</span> {doing.items[0] ? doingPhrase(doing.items[0], name) : name(id)}</p>;
  const jobs = Array.isArray(read.data?.jobs) ? read.data.jobs : [];
  const now = jobs.filter((j) => running(j.state)), earlier = jobs.filter((j) => !running(j.state));
  const shown = primary ? jobs : [...now.slice(0, 3), ...earlier.slice(0, 2)];
  const stop = async (job: string) => {
    setBusy(true); setError('');
    try { await memberOperation('runtime.jobStop', { job, reason: 'write-off' }); act('stop', {}); setAsking(''); }
    catch { setError('That did not stop it.'); }
    finally { setBusy(false); }
  };
  const summary = comms.reading?.summaries.find((s) => s.agent === id), thread = summary?.first ?? summary?.last;
  const things = primary ? doing.items : doing.items.slice(0, 3);
  return (
    <>
      <p className="board-lead">{name(id)}</p>
      <div className="board-line">
        <span className="board-state" data-running={state === 'working'}>{line}</span>
        {status?.work && <span>{status.work}</span>}
      </div>
      {profile.description && <p className="text-muted-foreground">{profile.description}</p>}
      <dl style={{ marginTop: '.8rem' }}>
        <div>
          <dt>Doing now</dt>
          <dd>
            {doing.status === 'loading' ? <Loading /> : doing.status !== 'live' ? <p className="text-muted-foreground">Can’t tell what it is doing right now.</p>
              : !count ? <p className="text-muted-foreground">Nothing right now.</p>
              : things.map((item) => <p key={item.kind + ':' + item.id}>{doingPhrase(item, name)} <span className="text-muted-foreground">{doingMeta(item)}</span></p>)}
            {doing.status === 'live' && doing.more + count - things.length > 0 && <p className="text-muted-foreground">+{doing.more + count - things.length} more</p>}
          </dd>
        </div>
        <div>
          <dt>{primary ? 'Jobs' : 'Jobs, running and latest'}</dt>
          <dd>
            {read.status === 'loading' ? <Loading /> : read.status !== 'live' ? <p className="text-muted-foreground">Can’t read jobs right now.</p>
              : !shown.length ? <p className="text-muted-foreground">None yet.</p>
              : shown.map((j) => (
                  <div className="board-line" key={j.id}>
                    {j.conversation ? <Chip place={{ brick: 'session', params: { session: j.conversation } }}>{j.title || 'Untitled job'}</Chip> : <span>{j.title || 'Untitled job'}</span>}
                    <span className="board-state" data-running={running(j.state)}>{j.state}</span>
                    <span className="text-muted-foreground">{j.endedAt ? 'ended ' + when(j.endedAt) : 'queued ' + when(j.queuedAt)}</span>
                    {running(j.state) && (asking === j.id
                      ? <><button type="button" className="board-action" disabled={busy} onClick={() => void stop(j.id)}>Stop this job</button><button type="button" className="board-action" onClick={() => setAsking('')}>Keep it running</button></>
                      : <button type="button" className="board-action" onClick={() => setAsking(j.id)}>Stop…</button>)}
                  </div>
                ))}
          </dd>
        </div>
        <div><dt>Tickets</dt><dd><Assigned who={id} kind="agent" form={form} /></dd></div>
        {comms.reading?.agents.includes(id) && (
          <div>
            <dt>Conversation</dt>
            <dd>{thread
              ? <a href={threadPath(thread.thread)}>{summary?.first ? 'Open the conversation with an unread reply' : 'Open the latest conversation'}</a>
              : <span className="text-muted-foreground">None yet. Start one from the list of conversations.</span>}{summary && summary.unread > 0 && <span className="text-muted-foreground"> · {summary.unread} unread</span>}</dd>
          </div>
        )}
      </dl>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}
