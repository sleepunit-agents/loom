/** The `session` brick (docs/specs/boards.md, "The first bricks"). */
import { useEffect, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { Reply } from '../pair/reply';
import { Chip, Loading, Unavailable, useOwnFlag, words, type BodyProps } from './brick-kit';
import { SessionLatestStep, SessionTrace } from './session-trace';

type SessionJob = { id: string; title: string; state: string; queuedAt: string; usage: { model: string | null; harness: string | null; tools: { name: string; count: number | null }[] | null } | null };
type SessionDetail = { brief: string | null; logTail: string | null; endedNote: string | null; claimedAt: string | null; endedAt: string | null };
const running = (state: string) => state === 'queued' || state === 'starting' || state === 'running';
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
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !job) return <Unavailable what="session" />;
  const detail = more.data?.rows[0];
  const tools = [...(job.usage?.tools ?? [])].filter((t) => t.count).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const stop = async () => {
    setBusy(true); setError('');
    try { own(); await memberOperation('runtime.jobStop', { job: job.id, reason: 'write-off' }); act('stop', {}); setAsking(false); }
    catch { setError('That did not stop it.'); }
    finally { setBusy(false); }
  };
  if (form === 'compact') return <p className="board-brief"><span className="board-state" data-running={running(job.state)}>{job.state}</span> {job.title}</p>;
  return (
    <>
      <p className="board-lead">{job.title || read.data?.cv?.label || 'Session'}</p>
      <div className="board-line">
        <span className="board-state" data-running={running(job.state)}>{job.state}</span>
        {agent && <Chip place={{ brick: 'agent', params: { agent } }}>{agent}</Chip>}
        <span className="text-muted-foreground">{running(job.state) ? 'for ' + lasted(job.queuedAt, now) : detail?.endedAt ? 'ran ' + lasted(detail.claimedAt ?? job.queuedAt, Date.parse(detail.endedAt)) : ''}</span>
      </div>
      {tools.length > 0 && <p className="board-line text-muted-foreground">{tools.slice(0, form === 'primary' ? 12 : 3).map((t) => <span key={t.name}>{t.name} ×{t.count}</span>)}</p>}
      {form === 'primary' && (
        <dl style={{ marginTop: '.8rem' }}>
          {detail?.brief && <div><dt>Asked</dt><dd><Reply words={detail.brief} /></dd></div>}
          {job.usage?.model && <div><dt>Running on</dt><dd>{[job.usage.harness, job.usage.model].filter(Boolean).join(' · ')}</dd></div>}
          {detail?.endedNote && <div><dt>How it ended</dt><dd>{detail.endedNote}</dd></div>}
          {!running(job.state) && job.state !== 'done' && detail?.logTail && <div><dt>Last output</dt><dd><pre className="board-tail">{detail.logTail}</pre></dd></div>}
          <div><dt>Result</dt><dd className="text-muted-foreground">{job.state === 'done' ? 'Its answer is in the conversation.' : running(job.state) ? 'Its answer will arrive in the conversation.' : 'It gave no answer.'}</dd></div>
          {read.data?.cv?.venue === 'handoff' && <div><dt>Steps</dt><dd><SessionTrace conversation={conversation} job={job.id} running={running(job.state)} /></dd></div>}
        </dl>
      )}
      {form === 'side' && read.data?.cv?.venue === 'handoff' && <SessionLatestStep conversation={conversation} job={job.id} />}
      {running(job.state) && (
        <div className="board-line">
          {asking
            ? <><button type="button" className="board-action" disabled={busy} onClick={() => void stop()}>Stop this session</button><button type="button" className="board-action" onClick={() => setAsking(false)}>Keep it running</button></>
            : <button type="button" className="board-action" onClick={() => setAsking(true)}>Stop…</button>}
        </div>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}
