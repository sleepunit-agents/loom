/** The `ticket` brick: one ticket, its commands and the sessions that worked it (docs/specs/boards.md, "The first
 * bricks"). The rest of what it shows and its edit forms are in ./bricks-ticket-edit.tsx. */
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { Reply } from '../pair/reply';
import { Action, Actions, Chip, Excerpt, Fact, Facts, Lead, Loading, Note, Problem, Row, Rows, Section, State, Time, Unavailable, actorChip, count, useOwnFlag, words, type BodyProps, type Tone } from './brick-kit';
import { useTicketMore } from './bricks-ticket-edit';
import type { Form } from './layout';
import { useTicketAction } from './ticket-action';

type Task = { id: string; title: string; status: string; assignee: string | null; assigneeKind: string | null; goal: string | null; why: string | null; doneWhen: string | null; project: string | null };
type WorkedBy = { conversation: string; title: string; state: string | null; at: string };
const sessionTone = (state: string | null): Tone => (state === 'queued' || state === 'starting' || state === 'running' ? 'working' : state === 'done' ? 'good' : state === 'failed' ? 'bad' : 'muted');
const ticketTone = (status: string): Tone => (status === 'in_progress' ? 'working' : status === 'blocked' ? 'waiting' : status === 'closed' ? 'muted' : 'neutral');
/** The sessions that worked a ticket: the handed-off work whose agent said it was for this ticket, newest first,
 * as loom lists them for the member looking (their own, and no one else's). A closed ticket keeps them. */
function TicketSessions({ ticket, form }: { ticket: string; form: Form }) {
  const read = useDataQuery<{ rows: WorkedBy[] }>(
    'query BrickTicketSessions($t:String!){rows:ticketSessions(ticket:$t){conversation title state at}}', { t: ticket }, { keep: true });
  const rows = read.data?.rows ?? [];
  if (form !== 'primary') return rows.length ? <span data-ticket-sessions="">{count(rows.length, 'session')} worked this</span> : null;
  return (
    <div data-ticket-sessions="">
      <Section title="Sessions">
        {read.status === 'loading' ? <Loading />
          : read.status !== 'live' ? <Note>Its sessions are unavailable.</Note>
          : !rows.length ? <Note>No session is recorded for this ticket.</Note>
          : <Rows>{rows.map((r) => (
              <Row key={r.conversation} place={{ brick: 'session', params: { session: r.conversation } }} title={r.title || 'Session'}
                end={<><State tone={sessionTone(r.state)}>{r.state ?? 'not started'}</State><Time at={r.at} /></>} />
            ))}</Rows>}
      </Section>
    </div>
  );
}
export function Ticket({ params, form, act, raise }: BodyProps) {
  const id = words(params.ticket);
  const read = useDataQuery<{ ticket: Task | null }>(
    'query BrickTicket($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){id title status assignee assigneeKind goal why doneWhen project}}',
    { id }, { keep: true });
  const own = useOwnFlag(read.data?.ticket?.status, raise, (was, now) => (now === 'closed' ? 'Closed' : was === 'closed' ? 'Reopened' : null));
  const { busy, error, run } = useTicketAction(act, own);
  const more = useTicketMore(id, form, act);
  const [closing, setClosing] = useState(false), [reason, setReason] = useState('');
  const t = read.data?.ticket;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !t) return <Unavailable what="ticket" />;
  if (form === 'compact') return <p className="board-brief"><State tone={ticketTone(t.status)}>{t.status}</State> {t.title}</p>;
  const big = form === 'primary';
  const close = async (e: FormEvent) => { e.preventDefault(); if (reason.trim() && await run('close', { id, reason: reason.trim() })) { setClosing(false); setReason(''); } };
  const controls = !more.open && !closing && (
        <Actions>
          {t.status === 'closed'
            ? <Action disabled={busy} onClick={() => void run('reopen', { id })}>Reopen</Action>
            : <>
                {!t.assignee && <Action kind="primary" disabled={busy} onClick={() => void run('claim', { id })}>Claim</Action>}
                {t.assignee && <Action disabled={busy} onClick={() => void run('unclaim', { id })}>Release</Action>}
                <Action disabled={busy} onClick={() => setClosing(true)}>Close…</Action>
              </>}
          {more.controls}
          {!big && <Chip place={{ brick: 'comments', params: { ticket: id } }}>Comments</Chip>}
        </Actions>
        );
  return (
    <>
      <Lead>{t.title}</Lead>
      <div className="board-meta">
        <State tone={ticketTone(t.status)}>{t.status}</State>
        {t.project && <Chip place={{ brick: 'project', params: { project: t.project } }}>{t.project}</Chip>}
        {t.assignee ? actorChip(t.assigneeKind, t.assignee) : <span>Unassigned</span>}
        {more.priority}
        {big && <Chip place={{ brick: 'comments', params: { ticket: id } }}>Comments</Chip>}
        {big ? more.meta : <TicketSessions ticket={id} form={form} />}
      </div>
      {/* Small, its controls come straight under where it stands, so they are never below the fold. */}
      {!big && controls}
      {/* The small form says the goal while the ticket is open, and why it was closed once it is. */}
      {((t.goal && (big || t.status !== 'closed')) || (big && (t.why || t.doneWhen))) && (
        <Facts>
          {t.goal && (big || t.status !== 'closed') && <Fact wide label="Goal">{big ? <Reply words={t.goal} /> : <Excerpt lines={2}><Reply words={t.goal} /></Excerpt>}</Fact>}
          {big && t.why && <Fact wide label="Why"><Reply words={t.why} /></Fact>}
          {big && t.doneWhen && <Fact wide label="Done when"><Reply words={t.doneWhen} /></Fact>}
        </Facts>
      )}
      {more.facts}
      {big && controls}
      {closing && (
        <form className="board-form" onSubmit={(e) => void close(e)}>
          <input className="board-input" aria-label="Why it is closed" placeholder="Why is it closed?" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
          <Actions><Action submit kind="primary" disabled={busy || !reason.trim()}>Close ticket</Action><Action kind="quiet" onClick={() => setClosing(false)}>Cancel</Action></Actions>
        </form>
      )}
      {more.forms}
      <Problem>{error}</Problem>
      {big && <TicketSessions ticket={id} form={form} />}
      {more.history}
    </>
  );
}
