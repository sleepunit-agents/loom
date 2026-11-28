/** The `session` brick (docs/specs/boards.md, "The first bricks"). */
import { useEffect, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { Reply } from '../pair/reply';
import { Chip, Confirm, Excerpt, Fact, Facts, Lead, Loading, Problem, Section, State, Unavailable, useOwnFlag, words, type BodyProps, type Tone } from './brick-kit';
import { SessionLatestStep, SessionTrace } from './session-trace';

type SessionJob = { id: string; title: string; state: string; queuedAt: string; usage: { model: string | null; harness: string | null; tools: { name: string; count: number | null }[] | null } | null };
type SessionDetail = { brief: string | null; logTail: string | null; endedNote: string | null; claimedAt: string | null; endedAt: string | null };
const running = (state: string) => state === 'queued' || state === 'starting' || state === 'running';
const tone = (state: string): Tone => (running(state) ? 'working' : state === 'done' ? 'good' : state === 'stopped' ? 'muted' : 'bad');
const lasted = (from: string, to: number) => { const m = Math.max(0, Math.round((to - Date.parse(from)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
/** One session of agent work, by its conversation: the latest job there. It shows what it was asked, where it
 * stands and which tools it has used; and, for work handed off from the member's own thread, the steps its body
 * reported, live (session-trace.tsx). */
export function Session({ params, form, act, raise }: BodyProps) {
  const conversation = words(params.session);
  const read = useDataQuery<{ jobs: SessionJob[]; cv: { agent: string; label: string | null; venue: string } | null }>(
    'query BrickSession($c:String!){jobs:conversationJobUsage(conversation:$c){id title state queuedAt usage{model harness tools{name count}}} cv:conversationsSingle(where:{id:{eq:$c}}){agent label venue}}',
    { c: conversation }, { keep: true });
  const job = [...(read.data?.jobs ?? [])].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).at(-1);
  const agent = read.data?.cv?.agent ?? '';
  const more = useDataQuery<{ rows: SessionDetail[] }>(
    'query BrickSessionJob($agent:String!,$id:String!){rows:jobHistory(agent:$agent,id:$id){brief logTail endedNote claimedAt endedAt}}',
    { agent, id: job?.id ?? '' }, { keep: true, pause: !agent || !job || form !== 'primary' });
  const own = useOwnFlag(job?.state, raise, (was, now) => (!running(was) ? null : now === 'done' ? 'Finished' : now === 'stopped' ? 'Stopped' : running(now) ? null : 'Failed'));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !job) return <Unavailable what="session" />;
  const detail = more.data?.rows[0];
  const tools = [...(job.usage?.tools ?? [])].filter((t) => t.count).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const stop = async () => {
    setBusy(true); setError('');
    try { own(); await memberOperation('runtime.jobStop', { job: job.id, reason: 'write-off' }); act('stop', {}); return true; }
    catch { setError('That did not stop it.'); return false; }
    finally { setBusy(false); }
  };
  if (form === 'compact') return <p className="board-brief"><State tone={tone(job.state)}>{job.state}</State> {job.title}</p>;
  const big = form === 'primary', handoff = read.data?.cv?.venue === 'handoff';
  const span = running(job.state) ? 'for ' + lasted(job.queuedAt, now) : detail?.endedAt ? 'ran ' + lasted(detail.claimedAt ?? job.queuedAt, Date.parse(detail.endedAt)) : '';
  return (
    <>
      {big ? <Lead>{job.title || read.data?.cv?.label || 'Session'}</Lead> : <Excerpt lines={2}><Lead>{job.title || read.data?.cv?.label || 'Session'}</Lead></Excerpt>}
      <div className="board-meta">
        <State tone={tone(job.state)}>{job.state}</State>
        {agent && <Chip place={{ brick: 'agent', params: { agent } }}>{agent}</Chip>}
        {span && <span>{span}</span>}
      </div>
      {big && (
        <Facts>
          {detail?.brief && <Fact wide label="Asked"><Reply words={detail.brief} /></Fact>}
          {detail?.endedNote && <Fact wide label="How it ended">{detail.endedNote}</Fact>}
          {!running(job.state) && job.state !== 'done' && detail?.logTail && <Fact wide label="Last output"><pre className="board-tail">{detail.logTail}</pre></Fact>}
          <Fact label="Result"><span className="board-note">{job.state === 'done' ? 'Its answer is in the conversation.' : running(job.state) ? 'Its answer will arrive in the conversation.' : 'It gave no answer.'}</span></Fact>
          {job.usage?.model && <Fact label="Running on">{[job.usage.harness, job.usage.model].filter(Boolean).join(' · ')}</Fact>}
          {tools.length > 0 && <Fact label="Tools"><span className="board-tool-counts">{tools.slice(0, 12).map((t) => <span key={t.name}>{t.name} ×{t.count}</span>)}</span></Fact>}
        </Facts>
      )}
      {big && handoff && <Section title="Steps"><SessionTrace key={job.id} conversation={conversation} job={job.id} running={running(job.state)} /></Section>}
      {!big && handoff && <SessionLatestStep conversation={conversation} job={job.id} />}
      {running(job.state) && <div className="board-actions"><Confirm ask="Stop…" yes="Stop this session" no="Keep it running" busy={busy} act={stop} /></div>}
      <Problem>{error}</Problem>
    </>
  );
}
