/** The rest of the `ticket` brick: its priority, who filed it and when, why it was closed, the tickets it is linked
 * to as chips, and, in the primary form, the desktop's Edit, Parent and Blocked by forms
 * (pieces/tasks/shared-form.tsx) sent through the desktop's door as the same tasks.command actions with the same
 * inputs, with its Ask a person form and its Promote to epic. The board is told `edit`, `link`, `unlink`, `ask` or
 * `promote` and, for a link, which of the two kinds; never a word typed. A ticket to link is chosen in
 * ./ticket-picker.tsx: typed words of its title, then one of the tickets found. */
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { displayName } from '../kit/words';
import { Reply } from '../pair/reply';
import { ticketChip, type Act } from './brick-kit';
import { Pick, Words, priorityWord, ticketChoicesQuery, useSummary, useTaskChoices, useTaskCommand, type Summary } from './bricks-work';
import type { Form } from './layout';
import { TicketPicker } from './ticket-picker';

type Relation = 'blocks' | 'parent-child';
type Near = { id: string; title: string } | null;
type More = Summary & { id: string; status: string; type: string | null; ask: string | null; ifYes: string | null; ifNo: string | null; createdAt: string | null; createdBy: string | null; closedAt: string | null; closeReason: string | null;
  taskLinksByTask: { dependsOn: string; type: Relation; dependsOnRow: Near }[]; taskLinksByDependsOn: { task: string; type: Relation; taskRow: Near }[] };
export const ticketMoreQuery = `query BrickTicketMore($id:String!){
  ticket:tasksSingle(where:{id:{eq:$id}}){id status type title goal why doneWhen description priority project ask ifYes ifNo createdAt createdBy closedAt closeReason
    taskLinksByTask{dependsOn type dependsOnRow{id title}} taskLinksByDependsOn{task type taskRow{id title}}}
}`;
export { ticketChoicesQuery };
const day = (at: string) => new Date(at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

/** A linked ticket: a chip, with its title in the primary form. One the member may not read is its id alone. */
function Linked({ label, rows, titles }: { label: string; rows: { id: string; row: Near }[]; titles: boolean }) {
  if (!rows.length) return null;
  return (
    <div className="board-line" role="group" aria-label={label}>
      <span className="text-muted-foreground">{label}</span>
      {rows.map(({ id, row }) => <span key={id}>{row ? ticketChip(id) : <span className="font-mono">{id}</span>}{titles && row ? ' ' + row.title : ''}</span>)}
    </div>
  );
}

function EditForm({ ticket, act, done }: { ticket: More; act: Act; done(): void }) {
  const draft = useSummary(ticket), { projects } = useTaskChoices(), { busy, error, run } = useTaskCommand(act);
  const save = async (e: FormEvent) => { e.preventDefault(); if (draft.valid && await run('edit', { action: 'edit', id: ticket.id, input: draft.summary() })) done(); };
  return (
    <form aria-label="Edit ticket" onSubmit={(e) => void save(e)}>
      {draft.fields({ more: true, projects, disabled: busy })}
      <div className="board-line">
        <button type="submit" className="board-action" disabled={busy || !draft.valid}>Save changes</button>
        <button type="button" className="board-action" onClick={done}>Cancel</button>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </form>
  );
}

function LinksForm({ ticket, act, done }: { ticket: More; act: Act; done(): void }) {
  const choices = useDataQuery<{ tasks: { id: string; title: string }[] }>(ticketChoicesQuery, {}, { keep: true });
  const { busy, error, run } = useTaskCommand(act);
  const [parent, setParent] = useState(''), [blocker, setBlocker] = useState('');
  const has = (type: Relation) => ticket.taskLinksByTask.filter((l) => l.type === type);
  const offered = (type: Relation) => (choices.data?.tasks ?? []).filter((t) => t.id !== ticket.id && !has(type).some((l) => l.dependsOn === t.id));
  const known = (type: Relation, id: string) => offered(type).some((t) => t.id === id);
  const link = (type: Relation, dependsOn: string) => run('link', { action: 'link', id: ticket.id, dependsOn, type }, { type });
  const unlink = (type: Relation, dependsOn: string) => run('unlink', { action: 'unlink', id: ticket.id, dependsOn, type }, { type });
  const now = (type: Relation, label: string) => has(type).map((l) => (
    <div className="board-line" key={l.dependsOn}>
      <span>{l.dependsOnRow ? `${l.dependsOnRow.title} · ` : ''}<span className="font-mono">{l.dependsOn}</span></span>
      <button type="button" className="board-action" aria-label={`Remove ${label} ${l.dependsOn}`} disabled={busy} onClick={() => void unlink(type, l.dependsOn)}>Remove</button>
    </div>
  ));
  return (
    <div role="group" aria-label="Links to other tickets">
      <dl style={{ marginTop: '.8rem' }}>
        <div>
          <dt>Parent</dt>
          <dd>
            {now('parent-child', 'parent')}
            {/* A parent is changed by taking the one it has away first, so a second is not offered beside it. */}
            {has('parent-child').length ? <p className="text-muted-foreground">To change the parent, remove this one first.</p> : (
              <form className="board-line" onSubmit={(e) => { e.preventDefault(); if (known('parent-child', parent)) void link('parent-child', parent).then((ok) => { if (ok) setParent(''); }); }}>
                <TicketPicker label="Parent ticket" value={parent} onChange={setParent} tickets={offered('parent-child')} disabled={busy} />
                <button type="submit" className="board-action" disabled={busy || !known('parent-child', parent)}>Set parent</button>
              </form>
            )}
          </dd>
        </div>
        <div>
          <dt>Blocked by</dt>
          <dd>
            {now('blocks', 'blocker')}
            <form className="board-line" onSubmit={(e) => { e.preventDefault(); if (known('blocks', blocker)) void link('blocks', blocker).then((ok) => { if (ok) setBlocker(''); }); }}>
              <TicketPicker label="Blocking ticket" value={blocker} onChange={setBlocker} tickets={offered('blocks')} disabled={busy} />
              <button type="submit" className="board-action" disabled={busy || !known('blocks', blocker)}>Add blocker</button>
            </form>
            <p className="text-muted-foreground">This ticket waits until the one you choose is closed.</p>
          </dd>
        </div>
      </dl>
      <div className="board-line"><button type="button" className="board-action" onClick={done}>Done</button></div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}

/** The desktop's "Ask a person" form (pieces/tasks/shared-form.tsx): a member, the question, what yes and no mean,
 * and whether it is answered yes or no or in words. All of it goes to the ticket; the board is told `ask`. */
const askAnswers = [{ value: 'yes-no', label: 'Yes or no' }, { value: 'words', label: 'In words' }] as const;
function AskForm({ ticket, act, done }: { ticket: More; act: Act; done(): void }) {
  const { people } = useTaskChoices(), { busy, error, run } = useTaskCommand(act);
  const members = people.filter((who) => who.kind === 'member');
  const [to, setTo] = useState(''), [ask, setAsk] = useState(ticket.ask ?? ''), [ifYes, setIfYes] = useState(ticket.ifYes ?? ''), [ifNo, setIfNo] = useState(ticket.ifNo ?? '');
  const [answers, setAnswers] = useState<'yes-no' | 'words'>('yes-no');
  const valid = members.some((who) => who.id === to) && !!ask.trim() && !!ifYes.trim() && !!ifNo.trim();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (valid && await run('ask', { action: 'ask', id: ticket.id, input: { to: { kind: 'member', id: to }, ask: ask.trim(), ifYes: ifYes.trim(), ifNo: ifNo.trim(), answers } })) done();
  };
  return (
    <form aria-label="Ask a person" onSubmit={(e) => void save(e)}>
      <Pick<string> label="Person" value={to} options={members.map((who) => ({ value: who.id, label: who.label }))} onChange={setTo} disabled={busy} />
      <Words label="Question" long value={ask} onChange={setAsk} disabled={busy} />
      <Words label="If yes" long value={ifYes} onChange={setIfYes} disabled={busy} />
      <Words label="If no" long value={ifNo} onChange={setIfNo} disabled={busy} />
      <Pick<'yes-no' | 'words'> label="Answer" value={answers} options={askAnswers} onChange={setAnswers} disabled={busy} />
      <div className="board-line">
        <button type="submit" className="board-action" disabled={busy || !valid}>Ask</button>
        <button type="button" className="board-action" onClick={done}>Cancel</button>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </form>
  );
}
/** The desktop's "Promote to epic": the ticket's type set to epic by `tasks.command` edit, after asking. */
function Promote({ ticket, act, done }: { ticket: More; act: Act; done(): void }) {
  const { busy, error, run } = useTaskCommand(act);
  return (
    <>
      <div className="board-line" role="group" aria-label="Promote to epic">
        <button type="button" className="board-action" disabled={busy} onClick={() => void run('promote', { action: 'edit', id: ticket.id, input: { type: 'epic' } }).then((ok) => { if (ok) done(); })}>Make this ticket an epic</button>
        <button type="button" className="board-action" onClick={done}>Cancel</button>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}

export function TicketMore({ id, form, act }: { id: string; form: Form; act: Act }) {
  const read = useDataQuery<{ ticket: More | null }>(ticketMoreQuery, { id }, { keep: true });
  const [open, setOpen] = useState<'edit' | 'links' | 'ask' | 'promote'>();
  const t = read.status === 'live' ? read.data?.ticket : undefined;
  if (!t || form === 'compact') return null;
  const big = form === 'primary';
  const up = (t.taskLinksByTask ?? []).map((l) => ({ type: l.type, id: l.dependsOn, row: l.dependsOnRow }));
  const down = (t.taskLinksByDependsOn ?? []).map((l) => ({ type: l.type, id: l.task, row: l.taskRow }));
  return (
    <div data-ticket-more="">
      <div className="board-line">
        <span className="board-state">{priorityWord(t.priority)}</span>
        {t.createdBy && <span className="text-muted-foreground">Filed by {displayName(t.createdBy)}{t.createdAt ? ' · ' + day(t.createdAt) : ''}</span>}
      </div>
      {big && t.description && <dl style={{ marginTop: '.8rem' }}><div><dt>Description</dt><dd><Reply words={t.description} /></dd></div></dl>}
      {t.status === 'closed' && t.closeReason && <dl style={{ marginTop: '.8rem' }}><div><dt>Closed{t.closedAt ? ' · ' + day(t.closedAt) : ''}</dt><dd><Reply words={t.closeReason} /></dd></div></dl>}
      <Linked label="Parent" titles={big} rows={up.filter((l) => l.type === 'parent-child')} />
      <Linked label="Children" titles={big} rows={down.filter((l) => l.type === 'parent-child')} />
      <Linked label="Blocked by" titles={big} rows={up.filter((l) => l.type === 'blocks')} />
      <Linked label="Blocks" titles={big} rows={down.filter((l) => l.type === 'blocks')} />
      {big && !open && (
        <div className="board-line">
          <button type="button" className="board-action" onClick={() => setOpen('edit')}>Edit…</button>
          <button type="button" className="board-action" onClick={() => setOpen('links')}>Links…</button>
          {t.status !== 'closed' && <button type="button" className="board-action" onClick={() => setOpen('ask')}>Ask a person…</button>}
          {t.type !== 'epic' && <button type="button" className="board-action" onClick={() => setOpen('promote')}>Promote to epic…</button>}
        </div>
      )}
      {big && open === 'edit' && <EditForm ticket={t} act={act} done={() => setOpen(undefined)} />}
      {big && open === 'ask' && <AskForm ticket={t} act={act} done={() => setOpen(undefined)} />}
      {big && open === 'promote' && <Promote ticket={t} act={act} done={() => setOpen(undefined)} />}
      {big && open === 'links' && <LinksForm ticket={{ ...t, taskLinksByTask: t.taskLinksByTask ?? [] }} act={act} done={() => setOpen(undefined)} />}
    </div>
  );
}
