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
import { Action, Actions, Excerpt, Fact, Facts, Problem, Segmented, Time, ticketChip, type Act } from './brick-kit';
import { Words, priorityWord, ticketChoicesQuery, useSummary, useTaskChoices, useTaskCommand, type Summary } from './bricks-work';
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

/** A linked ticket: a chip, with its title in the primary form. One the member may not read is its id alone. */
function Linked({ label, rows, titles }: { label: string; rows: { id: string; row: Near }[]; titles: boolean }) {
  if (!rows.length) return null;
  // The small form says its links in one quiet line; the big one gives each kind its own, with titles.
  if (!titles) return <>{<span>{label}</span>}{rows.map(({ id, row }) => (row ? <span key={id}>{ticketChip(id)}</span> : <span key={id} className="font-mono">{id}</span>))}</>;
  return (
    <Fact label={label}>
      {rows.map(({ id, row }) => <span key={id} className="board-linked">{row ? ticketChip(id) : <span className="font-mono">{id}</span>}{titles && row ? <span> {row.title}</span> : null}</span>)}
    </Fact>
  );
}

function EditForm({ ticket, act, done }: { ticket: More; act: Act; done(): void }) {
  const draft = useSummary(ticket), { projects } = useTaskChoices(), { busy, error, run } = useTaskCommand(act);
  const save = async (e: FormEvent) => { e.preventDefault(); if (draft.valid && await run('edit', { action: 'edit', id: ticket.id, input: draft.summary() })) done(); };
  return (
    <form className="board-form" aria-label="Edit ticket" onSubmit={(e) => void save(e)}>
      {draft.fields({ more: true, projects, disabled: busy })}
      <Actions><Action submit kind="primary" disabled={busy || !draft.valid}>Save changes</Action><Action kind="quiet" onClick={done}>Cancel</Action></Actions>
      <Problem>{error}</Problem>
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
    <div className="board-linked-now" key={l.dependsOn}>
      <span>{l.dependsOnRow ? `${l.dependsOnRow.title} · ` : ''}<span className="font-mono">{l.dependsOn}</span></span>
      <Action kind="quiet" label={`Remove ${label} ${l.dependsOn}`} disabled={busy} onClick={() => void unlink(type, l.dependsOn)}>Remove</Action>
    </div>
  ));
  return (
    <div className="board-form" role="group" aria-label="Links to other tickets">
      <dl>
        <div>
          <dt>Parent</dt>
          <dd className="board-form">
            {now('parent-child', 'parent')}
            {/* A parent is changed by taking the one it has away first, so a second is not offered beside it. */}
            {has('parent-child').length ? <p className="board-note">To change the parent, remove this one first.</p> : (
              <form className="board-pick" onSubmit={(e) => { e.preventDefault(); if (known('parent-child', parent)) void link('parent-child', parent).then((ok) => { if (ok) setParent(''); }); }}>
                <TicketPicker label="Parent ticket" value={parent} onChange={setParent} tickets={offered('parent-child')} disabled={busy} />
                <Action submit disabled={busy || !known('parent-child', parent)}>Set parent</Action>
              </form>
            )}
          </dd>
        </div>
        <div>
          <dt>Blocked by</dt>
          <dd className="board-form">
            {now('blocks', 'blocker')}
            <form className="board-pick" onSubmit={(e) => { e.preventDefault(); if (known('blocks', blocker)) void link('blocks', blocker).then((ok) => { if (ok) setBlocker(''); }); }}>
              <TicketPicker label="Blocking ticket" value={blocker} onChange={setBlocker} tickets={offered('blocks')} disabled={busy} />
              <Action submit disabled={busy || !known('blocks', blocker)}>Add blocker</Action>
            </form>
            <p className="board-note">This ticket waits until the one you choose is closed.</p>
          </dd>
        </div>
      </dl>
      <Actions><Action onClick={done}>Done</Action></Actions>
      <Problem>{error}</Problem>
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
    <form className="board-form" aria-label="Ask a person" onSubmit={(e) => void save(e)}>
      <Segmented<string> label="Person" value={to} options={members.map((who) => ({ value: who.id, label: who.label }))} onChange={setTo} disabled={busy} />
      <Words label="Question" long value={ask} onChange={setAsk} disabled={busy} />
      <Words label="If yes" long value={ifYes} onChange={setIfYes} disabled={busy} />
      <Words label="If no" long value={ifNo} onChange={setIfNo} disabled={busy} />
      <Segmented<'yes-no' | 'words'> label="Answer" value={answers} options={askAnswers} onChange={setAnswers} disabled={busy} />
      <Actions><Action submit kind="primary" disabled={busy || !valid}>Ask</Action><Action kind="quiet" onClick={done}>Cancel</Action></Actions>
      <Problem>{error}</Problem>
    </form>
  );
}
/** The desktop's "Promote to epic": the ticket's type set to epic by `tasks.command` edit, after asking. */
function Promote({ ticket, act, done }: { ticket: More; act: Act; done(): void }) {
  const { busy, error, run } = useTaskCommand(act);
  return (
    <>
      <Actions label="Promote to epic">
        <Action kind="primary" disabled={busy} onClick={() => void run('promote', { action: 'edit', id: ticket.id, input: { type: 'epic' } }).then((ok) => { if (ok) done(); })}>Make this ticket an epic</Action>
        <Action kind="quiet" onClick={done}>Cancel</Action>
      </Actions>
      <Problem>{error}</Problem>
    </>
  );
}

/** The rest of a ticket, read once and drawn in three places of the brick: a line under its title (`meta`), its
 * longer facts and links (`facts`), and its forms (`forms`), whose opening controls join the brick's own (`controls`). */
export function useTicketMore(id: string, form: Form, act: Act) {
  const read = useDataQuery<{ ticket: More | null }>(ticketMoreQuery, { id }, { keep: true });
  const [open, setOpen] = useState<'edit' | 'links' | 'ask' | 'promote'>();
  const t = read.status === 'live' ? read.data?.ticket : undefined;
  if (!t || form === 'compact') return { priority: null, meta: null, facts: null, controls: null, forms: null, open: false };
  const big = form === 'primary', done = () => setOpen(undefined);
  const up = (t.taskLinksByTask ?? []).map((l) => ({ type: l.type, id: l.dependsOn, row: l.dependsOnRow }));
  const down = (t.taskLinksByDependsOn ?? []).map((l) => ({ type: l.type, id: l.task, row: l.taskRow }));
  const linked = up.length + down.length > 0;
  return {
    open: big && !!open,
    priority: <span className="board-priority">{priorityWord(t.priority)}</span>,
    meta: <>{t.createdBy && <span>Filed by {displayName(t.createdBy)}{t.createdAt && <> · <Time at={t.createdAt} /></>}</span>}</>,
    facts: (
      <>
        {((big && t.description) || (t.status === 'closed' && t.closeReason)) && (
          <Facts>
            {big && t.description && <Fact wide label="Description"><Reply words={t.description} /></Fact>}
            {t.status === 'closed' && t.closeReason && <Fact wide label="Closed">{t.closedAt && <Time at={t.closedAt} />}{big ? <Reply words={t.closeReason} /> : <Excerpt lines={2}><Reply words={t.closeReason} /></Excerpt>}</Fact>}
          </Facts>
        )}
        {linked && !big && (
          <div className="board-meta">
            <Linked label="Parent" titles={false} rows={up.filter((l) => l.type === 'parent-child')} />
            <Linked label="Children" titles={false} rows={down.filter((l) => l.type === 'parent-child')} />
            <Linked label="Blocked by" titles={false} rows={up.filter((l) => l.type === 'blocks')} />
            <Linked label="Blocks" titles={false} rows={down.filter((l) => l.type === 'blocks')} />
          </div>
        )}
        {linked && big && (
          <Facts>
            <Linked label="Parent" titles={big} rows={up.filter((l) => l.type === 'parent-child')} />
            <Linked label="Children" titles={big} rows={down.filter((l) => l.type === 'parent-child')} />
            <Linked label="Blocked by" titles={big} rows={up.filter((l) => l.type === 'blocks')} />
            <Linked label="Blocks" titles={big} rows={down.filter((l) => l.type === 'blocks')} />
          </Facts>
        )}
      </>
    ),
    controls: big && !open ? (
      <>
        <Action kind="quiet" onClick={() => setOpen('edit')}>Edit…</Action>
        <Action kind="quiet" onClick={() => setOpen('links')}>Links…</Action>
        {t.status !== 'closed' && <Action kind="quiet" onClick={() => setOpen('ask')}>Ask a person…</Action>}
        {t.type !== 'epic' && <Action kind="quiet" onClick={() => setOpen('promote')}>Promote to epic…</Action>}
      </>
    ) : null,
    forms: !big ? null : open === 'edit' ? <EditForm ticket={t} act={act} done={done} />
      : open === 'ask' ? <AskForm ticket={t} act={act} done={done} />
      : open === 'promote' ? <Promote ticket={t} act={act} done={done} />
      : open === 'links' ? <LinksForm ticket={{ ...t, taskLinksByTask: t.taskLinksByTask ?? [] }} act={act} done={done} /> : null,
  };
}
