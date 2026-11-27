/** The `new-ticket` brick: the desktop's Create task form (pieces/tasks/shared-form.tsx) for one project, sent
 * through the desktop's door as tasks.command `create` with that form's input. The small form asks for the three
 * things a ticket must say and takes the form's defaults for the rest; the big form has every field. After
 * filing it offers the new ticket as a chip and clears. The board is told `create` and nothing that was typed. */
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { taskTypes } from '../pieces/tasks/words';
import { Loading, Unavailable, ticketChip, words, type Act, type Params } from './brick-kit';
import { Pick, TicketField, ticketChoicesQuery, useSummary, useTaskChoices, useTaskCommand } from './bricks-work';
import type { Form } from './layout';

type Type = keyof typeof taskTypes;
export const newTicketQuery = 'query BrickNewTicket($id:String!){project:projectsSingle(where:{id:{eq:$id}}){id name lifecycle}}';
const typeChoices = (Object.keys(taskTypes) as Type[]).map((value) => ({ value, label: taskTypes[value] }));

export function NewTicket({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const project = words(params.project), big = form === 'primary';
  const read = useDataQuery<{ project: { id: string; name: string; lifecycle: string } | null }>(newTicketQuery, { id: project }, { keep: true });
  const choices = useTaskChoices(!big);
  const tickets = useDataQuery<{ tasks: { id: string; title: string }[] }>(ticketChoicesQuery, {}, { keep: true, pause: !big });
  const draft = useSummary(), { busy, error, run } = useTaskCommand(act);
  const [type, setType] = useState<Type>('task'), [owner, setOwner] = useState('household'), [parent, setParent] = useState(''), [filed, setFiled] = useState<string>();
  const p = read.data?.project;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !p) return <Unavailable what="project" />;
  if (form === 'compact') return <p className="board-brief">File a ticket in {p.name}</p>;
  const offered = tickets.data?.tasks ?? [];
  const person = choices.people.find((who) => `${who.kind}:${who.id}` === owner);
  const ready = draft.valid && (owner === 'household' || !!person) && (!parent || offered.some((t) => t.id === parent));
  const file = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const made = await run('create', { action: 'create', input: { ...draft.summary(), project, type,
      owner: person ? { kind: person.kind, id: person.id } : { kind: 'household' }, ...(parent ? { parent } : {}) } });
    if (!made) return;
    setFiled(made.id ?? ''); draft.clear(); setType('task'); setOwner('household'); setParent('');
  };
  return (
    <form aria-label="File a ticket" onSubmit={(e) => void file(e)}>
      <p className="board-lead">A new ticket in {p.name}</p>
      {draft.fields({ more: big, disabled: busy })}
      {big && <>
        <Pick<Type> label="Type" value={type} options={typeChoices} onChange={setType} disabled={busy} />
        <Pick<string> label="Owner" value={owner} options={[{ value: 'household', label: 'Household' }, ...choices.people.map((who) => ({ value: `${who.kind}:${who.id}`, label: who.label }))]} onChange={setOwner} disabled={busy} />
        <div className="board-line"><span className="text-muted-foreground">Parent</span><TicketField label="Parent ticket" value={parent} onChange={setParent} tickets={offered} disabled={busy} /></div>
      </>}
      <div className="board-line">
        <button type="submit" className="board-action" disabled={busy || !ready}>File ticket</button>
        {filed !== undefined && <span data-filed="">Filed{filed ? <> {ticketChip(filed)}</> : '.'}</span>}
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </form>
  );
}
