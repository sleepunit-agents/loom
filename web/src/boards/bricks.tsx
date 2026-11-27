/** How each brick draws itself (docs/specs/boards.md, "The first bricks"). A brick reads its own data, live, as
 * the member looking, and takes only the parameters the server already checked. Three forms are drawn by Body;
 * the chip and the hover are the same words in one line. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { memberOperation } from '../data/operation';
import { useDataQuery } from '../data/graphql';
import { Trend } from './trend';
import { Reply } from '../pair/reply';
import type { Fits, Form } from './layout';

export type Params = Record<string, string | number | undefined>;
export type Place = { brick: string; params: Params };
export interface BrickView {
  fits: Fits;
  /** Its name and what it is about, as words: the heading, the chip, the folded row. */
  title(params: Params): string;
  sub(params: Params): string;
  Body(props: { params: Params; form: Form; act: Act; raise: Raise }): ReactNode;
}
/** Report a brick's action after its own operation succeeded. */
export type Act = (action: string, detail: Record<string, string>) => void;
/** Mark this placement: its record changed in a way the brick flags itself for, and the member did not do it. */
export type Raise = (name: string) => void;

/** Watches one value of a brick's record. When it changes while the page is open, and the change was not the
 * member's own doing here a moment ago, the brick flags itself with the name the change is given. */
function useOwnFlag<T>(value: T | undefined, raise: Raise, name: (before: T, now: T) => string | null) {
  const before = useRef<T | undefined>(undefined), mine = useRef(0);
  useEffect(() => {
    const was = before.current;
    before.current = value;
    if (was === undefined || value === undefined || was === value) return;
    if (Date.now() - mine.current < 5000) { mine.current = 0; return; }
    const called = name(was, value);
    if (called) raise(called);
  });
  return () => { mine.current = Date.now(); };
}

const fit = (primary: [number, number, number, number], side: number): Fits => ({
  primary: { min: primary[0], ideal: primary[1], max: primary[2], height: primary[3] },
  side: { min: 260, ideal: 360, max: 420, height: side },
  compact: { min: 220, ideal: 320, max: 420, height: 68 },
});
const words = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const Unavailable = ({ what }: { what: string }) => <p className="text-muted-foreground">This {what} is unavailable.</p>;
const Loading = () => <p role="status" className="text-muted-foreground">Loading…</p>;

/** A reference to another brick's record. Clicking it places that brick, at once, with no job. */
export function Chip({ place, children }: { place: Place; children: ReactNode }) {
  return (
    <button type="button" className="board-chip" data-place={JSON.stringify(place)}>
      <i aria-hidden="true" />
      {children}
    </button>
  );
}
export const ticketChip = (id: string) => <Chip place={{ brick: 'ticket', params: { ticket: id } }}><span className="font-mono">{id}</span></Chip>;
function actorChip(kind: string | null | undefined, id: string) {
  return kind === 'agent'
    ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip>
    : <Chip place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip>;
}

type Lane = { id: string; title: string; lane: string; reason: string | null; assignee: string | null };
function Lanes({ params, form }: { params: Params; form: Form }) {
  const read = useDataQuery<{ projectBoardTickets: Lane[] }>(
    'query BrickLanes($project:String!){projectBoardTickets(project:$project,offset:0,limit:60){id title lane reason assignee}}',
    { project: words(params.project) }, { keep: true });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <Unavailable what="project" />;
  const cap = form === 'primary' ? 8 : 3;
  const count = (lane: string) => read.data!.projectBoardTickets.filter((t) => t.lane === lane).length;
  if (form === 'compact') return <p className="board-brief">{count('Working')} working · {count('Verifying')} verifying · {count('Waiting')} waiting</p>;
  return (
    <div className="board-lanes">
      {['Working', 'Verifying', 'Waiting'].map((lane) => {
        const rows = read.data!.projectBoardTickets.filter((t) => t.lane === lane);
        return (
          <section key={lane} aria-label={lane}>
            <h3><span>{lane}</span><span>{rows.length}</span></h3>
            <ul>
              {rows.slice(0, cap).map((t) => (
                <li key={t.id}>
                  <button type="button" className="board-ticket" data-flip={'tk-' + t.id} data-place={JSON.stringify({ brick: 'ticket', params: { ticket: t.id } })}>
                    {t.title}
                    <small><span className="font-mono">{t.id}</span>{t.reason ? ' · ' + t.reason : ''}</small>
                  </button>
                </li>
              ))}
              {rows.length > cap && <li className="text-xs text-muted-foreground">and {rows.length - cap} more</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

type Task = { id: string; title: string; status: string; assignee: string | null; assigneeKind: string | null; goal: string | null; why: string | null; doneWhen: string | null; project: string | null };
/** One of loom's own ticket commands, then the report to the board that the member used it. */
function useTicketAction(act: Act, own: () => void = () => {}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function run(action: string, input: Record<string, unknown>) {
    if (busy) return false;
    setBusy(true); setError('');
    try { own(); await memberOperation('tasks.command', { action, ...input }); act(action, {}); return true; }
    catch { setError('That did not save.'); return false; }
    finally { setBusy(false); }
  }
  return { busy, error, run };
}
function Ticket({ params, form, act, raise }: { params: Params; form: Form; act: Act; raise: Raise }) {
  const id = words(params.ticket);
  const read = useDataQuery<{ ticket: Task | null }>(
    'query BrickTicket($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){id title status assignee assigneeKind goal why doneWhen project}}',
    { id }, { keep: true });
  const own = useOwnFlag(read.data?.ticket?.status, raise, (was, now) => (now === 'closed' ? 'Closed' : was === 'closed' ? 'Reopened' : null));
  const { busy, error, run } = useTicketAction(act, own);
  const [closing, setClosing] = useState(false), [reason, setReason] = useState('');
  const t = read.data?.ticket;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !t) return <Unavailable what="ticket" />;
  if (form === 'compact') return <p className="board-brief"><span className="board-state">{t.status.replaceAll('_', ' ')}</span> {t.title}</p>;
  const close = async (e: FormEvent) => { e.preventDefault(); if (reason.trim() && await run('close', { id, reason: reason.trim() })) { setClosing(false); setReason(''); } };
  return (
    <>
      <p className="board-lead">{t.title}</p>
      <dl>
        {t.goal && <div><dt>Goal</dt><dd><Reply words={t.goal} /></dd></div>}
        {form === 'primary' && t.why && <div><dt>Why</dt><dd><Reply words={t.why} /></dd></div>}
        {form === 'primary' && t.doneWhen && <div><dt>Done when</dt><dd><Reply words={t.doneWhen} /></dd></div>}
      </dl>
      <div className="board-line">
        <span className="board-state">{t.status.replaceAll('_', ' ')}</span>
        {t.project && <Chip place={{ brick: 'project', params: { project: t.project } }}>{t.project}</Chip>}
        {t.assignee ? actorChip(t.assigneeKind, t.assignee) : <span className="text-muted-foreground">Unassigned</span>}
        <Chip place={{ brick: 'comments', params: { ticket: id } }}>Comments</Chip>
      </div>
      <div className="board-line">
        {t.status === 'closed'
          ? <button type="button" className="board-action" disabled={busy} onClick={() => void run('reopen', { id })}>Reopen</button>
          : <>
              {!t.assignee && <button type="button" className="board-action" disabled={busy} onClick={() => void run('claim', { id })}>Claim</button>}
              {t.assignee && <button type="button" className="board-action" disabled={busy} onClick={() => void run('unclaim', { id })}>Release</button>}
              {!closing && <button type="button" className="board-action" disabled={busy} onClick={() => setClosing(true)}>Close…</button>}
            </>}
      </div>
      {closing && (
        <form className="board-line" onSubmit={(e) => void close(e)}>
          <input className="board-input" aria-label="Why it is closed" placeholder="Why is it closed?" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
          <button type="submit" className="board-action" disabled={busy || !reason.trim()}>Close ticket</button>
          <button type="button" className="board-action" onClick={() => setClosing(false)}>Cancel</button>
        </form>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}

type Note = { seq: number; text: string; actor: string; at: string };
function Comments({ params, form, act, raise }: { params: Params; form: Form; act: Act; raise: Raise }) {
  const id = words(params.ticket);
  const read = useDataQuery<{ ticket: { title: string; taskCommentsByTask: Note[] } | null }>(
    'query BrickComments($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){title taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}}){seq text actor at}}}',
    { id }, { keep: true });
  const own = useOwnFlag(read.data?.ticket?.taskCommentsByTask.length, raise, (was, now) => (now > was ? 'New comment' : null));
  const { busy, error, run } = useTicketAction(act, own);
  const [text, setText] = useState('');
  const t = read.data?.ticket;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !t) return <Unavailable what="ticket" />;
  const add = async (e: FormEvent) => { e.preventDefault(); if (text.trim() && await run('comment', { id, text: text.trim() })) setText(''); };
  if (form === 'compact') return <p className="board-brief">{t.taskCommentsByTask.length ? `${t.taskCommentsByTask.length} · latest from ${t.taskCommentsByTask[0].actor}: ${t.taskCommentsByTask[0].text}` : 'No comments yet'}</p>;
  const notes = t.taskCommentsByTask.slice(0, form === 'primary' ? 30 : 4);
  return (
    <>
      <p className="board-lead">{t.title}</p>
      <form className="board-line" onSubmit={(e) => void add(e)}>
        <input className="board-input" aria-label="Add a comment" placeholder="Add a comment…" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="board-action" disabled={busy || !text.trim()}>Add</button>
      </form>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {notes.length ? (
        <ol className="board-notes">
          {notes.map((n) => (
            <li key={n.seq}>
              <small>{n.actor} · {new Date(n.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
              <Reply words={n.text} />
            </li>
          ))}
        </ol>
      ) : <p className="text-muted-foreground">No comments yet.</p>}
    </>
  );
}

function Project({ params, form }: { params: Params; form: Form }) {
  const read = useDataQuery<{ project: { name: string; goal: string | null; lifecycle: string } | null }>(
    'query BrickProject($id:String!){project:projectsSingle(where:{id:{eq:$id}}){name goal lifecycle}}', { id: words(params.project) }, { keep: true });
  const p = read.data?.project;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !p) return <Unavailable what="project" />;
  if (form === 'compact') return <p className="board-brief"><span className="board-state">{p.lifecycle}</span> {p.goal || p.name}</p>;
  return (
    <>
      {p.goal ? <Reply words={p.goal} /> : <p className="text-muted-foreground">No goal written.</p>}
      <div className="board-line">
        <span className="board-state">{p.lifecycle}</span>
        <Chip place={{ brick: 'lanes', params: { project: words(params.project) } }}>Lanes</Chip>
        <Chip place={{ brick: 'trend', params: { project: words(params.project), days: 30 } }}>Trend</Chip>
      </div>
    </>
  );
}

function Assigned({ who, kind, form }: { who: string; kind: 'member' | 'agent'; form?: Form }) {
  const read = useDataQuery<{ rows: { id: string; title: string; status: string }[] }>(
    `query BrickAssigned($ref:String!){rows:tasks(where:{assignee:{eq:$ref},assigneeKind:{eq:${kind}},status:{ne:closed}},orderBy:{changedAt:{direction:desc,priority:0}},limit:6){id title status}}`,
    { ref: who }, { keep: true });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <Unavailable what={kind === 'agent' ? 'agent' : 'person'} />;
  const rows = read.data.rows;
  if (form === 'compact') return <p className="board-brief">{rows.length ? `${rows.length === 6 ? 'At least six' : rows.length} open ticket${rows.length === 1 ? '' : 's'}` : 'No open tickets'}</p>;
  return rows.length ? (
    <>
      <p>{rows.length === 6 ? 'At least six' : rows.length} open ticket{rows.length === 1 ? '' : 's'}.</p>
      <div className="board-line">{rows.map((t) => <span key={t.id} title={t.title}>{ticketChip(t.id)}</span>)}</div>
    </>
  ) : <p className="text-muted-foreground">No open tickets.</p>;
}

type SessionJob = { id: string; title: string; state: string; queuedAt: string; usage: { model: string | null; harness: string | null; tools: { name: string; count: number | null }[] | null } | null };
type SessionDetail = { brief: string | null; logTail: string | null; endedNote: string | null; claimedAt: string | null; endedAt: string | null };
const running = (state: string) => state === 'queued' || state === 'starting' || state === 'running';
const lasted = (from: string, to: number) => { const m = Math.max(0, Math.round((to - Date.parse(from)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
/** One session of agent work, by its conversation: the latest job there. Loom keeps no step-by-step trace for
 * work outside a thread, so this shows what it was asked, where it stands and which tools it has used. */
function Session({ params, form, act, raise }: { params: Params; form: Form; act: Act; raise: Raise }) {
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
        </dl>
      )}
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

/** A brick the server knows and this page does not draw yet. It says so; it never guesses. */
const NotDrawn = ({ params }: { params: Params }) => (
  <p className="text-muted-foreground">This page does not draw this brick yet. {Object.entries(params).map(([k, v]) => `${k}: ${words(v)}`).join(', ')}</p>
);
const later = (name: string, about: string): BrickView => ({ fits: fit([420, 640, 760, 260], 130), title: () => name, sub: (p) => words(p[about]), Body: NotDrawn });

export const bricks: Record<string, BrickView> = {
  project: { fits: fit([440, 680, 820, 300], 190), title: () => 'Project', sub: (p) => words(p.project), Body: Project },
  lanes: { fits: fit([520, 820, 980, 480], 330), title: () => 'Lanes', sub: (p) => words(p.project), Body: Lanes },
  trend: { fits: fit([460, 720, 860, 360], 200), title: () => 'Opened and closed', sub: (p) => `${words(p.project)} · ${words(p.days)} days`,
    Body: ({ params, form }) => <Trend project={words(params.project)} days={Number(params.days) || 30} form={form} chip={ticketChip} /> },
  ticket: { fits: fit([460, 700, 820, 380], 230), title: () => 'Ticket', sub: (p) => words(p.ticket), Body: Ticket },
  person: { fits: fit([420, 640, 760, 260], 150), title: (p) => words(p.person).split(':')[1] || 'Person', sub: (p) => words(p.person).split(':')[0],
    Body: ({ params, form }) => { const [kind, id] = words(params.person).split(':'); return kind === 'member' ? <Assigned who={id} kind="member" form={form} /> : <NotDrawn params={params} />; } },
  agent: { fits: fit([420, 640, 760, 260], 150), title: (p) => words(p.agent), sub: () => 'agent', Body: ({ params, form }) => <Assigned who={words(params.agent)} kind="agent" form={form} /> },
  comments: { fits: fit([440, 680, 820, 420], 260), title: () => 'Comments', sub: (p) => words(p.ticket), Body: Comments },
  session: { fits: fit([440, 680, 820, 360], 170), title: () => 'Session', sub: (p) => words(p.session).slice(0, 11), Body: Session },
  pull: later('Pull request', 'change'),
  repository: later('Repository', 'repository'),
  question: later('Question', 'item'),
  approval: later('Approval', 'approval'),
};
export const brickView = (name: string): BrickView => bricks[name] ?? later(name, '');
