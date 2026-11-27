/** The `ticket` brick: one ticket, its commands and the sessions that worked it (docs/specs/boards.md, "The first
 * bricks"). The rest of what it shows and its edit forms are in ./bricks-ticket-edit.tsx. */
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { Reply } from '../pair/reply';
import { Chip, Loading, Unavailable, actorChip, useOwnFlag, words, type BodyProps } from './brick-kit';
import { TicketMore } from './bricks-ticket-edit';
import type { Form } from './layout';
import { useTicketAction } from './ticket-action';

type Task = { id: string; title: string; status: string; assignee: string | null; assigneeKind: string | null; goal: string | null; why: string | null; doneWhen: string | null; project: string | null };
type WorkedBy = { conversation: string; title: string; state: string | null; at: string };
const sessionRunning = (state: string | null) => state === 'queued' || state === 'starting' || state === 'running';
/** The sessions that worked a ticket: the handed-off work whose agent said it was for this ticket, newest first,
 * as loom lists them for the member looking (their own, and no one else's). A closed ticket keeps them. */
function TicketSessions({ ticket, form }: { ticket: string; form: Form }) {
  const read = useDataQuery<{ rows: WorkedBy[] }>(
    'query BrickTicketSessions($t:String!){rows:ticketSessions(ticket:$t){conversation title state at}}', { t: ticket }, { keep: true });
  const rows = read.data?.rows ?? [];
  if (form !== 'primary') return rows.length ? <p className="board-line text-muted-foreground" data-ticket-sessions="">{rows.length === 1 ? '1 session' : `${rows.length} sessions`} worked this</p> : null;
  return (
    <dl style={{ marginTop: '.8rem' }} data-ticket-sessions="">
      <div>
        <dt>Sessions</dt>
        <dd>
          {read.status === 'loading' ? <Loading />
            : read.status !== 'live' ? <p className="text-muted-foreground">Its sessions are unavailable.</p>
            : !rows.length ? <p className="text-muted-foreground">No session is recorded for this ticket.</p>
            : rows.map((r) => (
                <div className="board-line" key={r.conversation}>
                  <Chip place={{ brick: 'session', params: { session: r.conversation } }}>{r.title || 'Session'}</Chip>
                  <span className="board-state" data-running={sessionRunning(r.state)}>{r.state ?? 'not started'}</span>
                  <span className="text-muted-foreground">{new Date(r.at).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              ))}
        </dd>
      </div>
    </dl>
  );
}
export function Ticket({ params, form, act, raise }: BodyProps) {
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
      <TicketMore id={id} form={form} act={act} />
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
      <TicketSessions ticket={id} form={form} />
    </>
  );
}
