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
import { AgentFace } from './agent-face';
import { agentMood, agentTone, threadPath, useAgentNames } from './agents-data';
import { Assigned } from './assigned';
import { Confirm, Loading, Note, Problem, Row, Rows, Section, State, Time, Unavailable, useOwnFlag, words, type Act, type Params, type Raise, type Tone } from './brick-kit';
import type { Form } from './layout';

type Job = { id: string; title: string; state: string; conversation: string | null; queuedAt: string; endedAt: string | null };
export const agentJobsQuery = 'query BrickAgentJobs($agent:String!,$first:Int!){jobs:jobHistory(agent:$agent,first:$first){id title state conversation queuedAt endedAt}}';
const running = (state: string) => state === 'queued' || state === 'starting' || state === 'running';
const jobTone = (state: string): Tone => (running(state) ? 'working' : state === 'done' ? 'good' : state === 'stopped' ? 'muted' : 'bad');

export function Agent({ params, form, act, raise }: { params: Params; form: Form; act: Act; raise: Raise }) {
  const id = words(params.agent), primary = form === 'primary';
  const profiles = useDeskAgentProfiles(), statuses = useDeskAgentStatuses(), waiting = useDeskWaitingCounts(), comms = useHomeComms();
  const doing = useDoing(id, primary), name = useAgentNames();
  const read = useDataQuery<{ jobs: Job[] }>(agentJobsQuery, { agent: id, first: primary ? 30 : 12 }, { keep: true, pause: form === 'compact' });
  const needs = waiting.status === 'live' ? waiting.agents.get(id) ?? 0 : undefined;
  useOwnFlag(needs, raise, (was, now) => (was === 0 && now > 0 ? 'Waiting on you' : null));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (profiles.status === 'loading') return <Loading />;
  const profile = profiles.status === 'live' ? profiles.records.find((p) => p.agent === id) : undefined;
  if (!profile) return <Unavailable what="agent" />;
  const status = statuses.status === 'live' ? latestStatus(statuses.records, id) : undefined;
  const count = doing.items.length, state = shownState(status?.state, count), line = agentStateLine(status?.state, count, needs);
  if (form === 'compact') return <p className="board-brief"><State tone={agentTone(state, needs)}>{line}</State> {doing.items[0] ? doingPhrase(doing.items[0], name) : name(id)}</p>;
  const jobs = Array.isArray(read.data?.jobs) ? read.data.jobs : [];
  const now = jobs.filter((j) => running(j.state)), earlier = jobs.filter((j) => !running(j.state));
  const shown = primary ? jobs : [...now.slice(0, 3), ...earlier.slice(0, 2)];
  const stop = async (job: string) => {
    setBusy(true); setError('');
    try { await memberOperation('runtime.jobStop', { job, reason: 'write-off' }); act('stop', {}); return true; }
    catch { setError('That did not stop it.'); return false; }
    finally { setBusy(false); }
  };
  const summary = comms.reading?.summaries.find((s) => s.agent === id), thread = summary?.first ?? summary?.last;
  const things = primary ? doing.items : doing.items.slice(0, 3);
  const hidden = doing.status === 'live' ? doing.more + count - things.length : 0;
  return (
    <>
      <div className="board-agent-head">
        <AgentFace agent={id} state={agentMood(state, needs)} />
        <div>
          <p className="board-lead">{name(id)}</p>
          <div className="board-meta"><State tone={agentTone(state, needs)}>{line}</State>{status?.work && <span>{status.work}</span>}</div>
        </div>
      </div>
      {profile.description && <Note>{profile.description}</Note>}
      <Section title="Doing now">
        {doing.status === 'loading' ? <Loading /> : doing.status !== 'live' ? <Note>Can’t tell what it is doing right now.</Note>
          : !count ? <Note>Nothing right now.</Note>
          : <Rows>{things.map((item) => <Row key={item.kind + ':' + item.id} title={doingPhrase(item, name)} end={doingMeta(item)} />)}</Rows>}
        {hidden > 0 && <Note>+{hidden} more</Note>}
      </Section>
      <Section title={primary ? 'Jobs' : 'Jobs, running and latest'}>
        {read.status === 'loading' ? <Loading /> : read.status !== 'live' ? <Note>Can’t read jobs right now.</Note>
          : !shown.length ? <Note>None yet.</Note>
          : <Rows>{shown.map((j) => (
              <Row key={j.id} title={j.title || 'Untitled job'} place={j.conversation ? { brick: 'session', params: { session: j.conversation } } : undefined}
                end={<><State tone={jobTone(j.state)}>{j.state}</State><Time at={j.endedAt ?? j.queuedAt} />{running(j.state) && <Confirm ask="Stop…" yes="Stop this job" no="Keep it running" busy={busy} act={() => stop(j.id)} />}</>} />
            ))}</Rows>}
      </Section>
      <Section title="Tickets"><Assigned who={id} kind="agent" form={form} /></Section>
      {comms.reading?.agents.includes(id) && (
        <Section title="Conversation">
          {thread
            ? <div className="board-actions"><a className="board-action" href={threadPath(thread.thread)}>{summary?.first ? 'Open the conversation with an unread reply' : 'Open the latest conversation'}</a>{summary && summary.unread > 0 && <span className="board-note">{summary.unread} unread</span>}</div>
            : <Note>None yet. Start one from the list of conversations.</Note>}
        </Section>
      )}
      <Problem>{error}</Problem>
    </>
  );
}
