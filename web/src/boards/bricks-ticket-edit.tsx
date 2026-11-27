/** The rest of the `ticket` brick: its priority, who filed it and when, why it was closed, the tickets it is linked
 * to as chips, and, in the primary form, the desktop's Edit, Parent and Blocked by forms
 * (pieces/tasks/shared-form.tsx) sent through the desktop's door as the same tasks.command actions with the same
 * inputs. The board is told `edit`, `link` or `unlink` and, for a link, which of the two kinds; never a word typed. */
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { displayName } from '../kit/words';
import { Reply } from '../pair/reply';
import { ticketChip, type Act } from './brick-kit';
import { TicketField, priorityWord, ticketChoicesQuery, useSummary, useTaskChoices, useTaskCommand, type Summary } from './bricks-work';
import type { Form } from './layout';

type Relation = 'blocks' | 'parent-child';
type Near = { id: string; title: string } | null;
type More = Summary & { id: string; status: string; createdAt: string | null; createdBy: string | null; closedAt: string | null; closeReason: string | null;
  taskLinksByTask: { dependsOn: string; type: Relation; dependsOnRow: Near }[]; taskLinksByDependsOn: { task: string; type: Relation; taskRow: Near }[] };
export const ticketMoreQuery = `query BrickTicketMore($id:String!){
  ticket:tasksSingle(where:{id:{eq:$id}}){id status title goal why doneWhen description priority project createdAt createdBy closedAt closeReason
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
                <TicketField label="Parent ticket" value={parent} onChange={setParent} tickets={offered('parent-child')} disabled={busy} />
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
              <TicketField label="Blocking ticket" value={blocker} onChange={setBlocker} tickets={offered('blocks')} disabled={busy} />
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

export function TicketMore({ id, form, act }: { id: string; form: Form; act: Act }) {
  const read = useDataQuery<{ ticket: More | null }>(ticketMoreQuery, { id }, { keep: true });
  const [open, setOpen] = useState<'edit' | 'links'>();
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
        </div>
      )}
      {big && open === 'edit' && <EditForm ticket={t} act={act} done={() => setOpen(undefined)} />}
      {big && open === 'links' && <LinksForm ticket={{ ...t, taskLinksByTask: t.taskLinksByTask ?? [] }} act={act} done={() => setOpen(undefined)} />}
    </div>
  );
}
