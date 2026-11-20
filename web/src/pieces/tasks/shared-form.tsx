import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Actions, Button, Field, Fields, Input, Textarea } from '../../kit';
import type { SharedTask, SharedTaskLink, TaskAction } from './shared-view';

type Person = { kind: 'member' | 'agent'; id: string };
type Summary = Pick<SharedTask, 'title' | 'goal' | 'why' | 'doneWhen' | 'description' | 'priority' | 'project'>;
/** Commands contain intent only. The authenticated root supplies the actor. */
export type TaskCommand =
  | { action: 'create'; input: Summary & { type: SharedTask['type']; owner: Person | { kind: 'household' }; parent?: string; source?: { kind: 'conversation'; id: string } } }
  | { action: 'edit'; id: string; input: Partial<Summary> }
  | { action: 'claim' | 'unclaim' | 'reopen'; id: string }
  | { action: 'close'; id: string; reason: string }
  | { action: 'comment'; id: string; text: string }
  | { action: 'link' | 'unlink'; id: string; dependsOn: string; type: 'blocks' | 'parent-child' }
  | { action: 'answer'; id: string; question: string; answer: 'yes' | 'no' | 'words'; text?: string }
  | { action: 'ask'; id: string; input: { to: { kind: 'member'; id: string }; ask: string; ifYes: string; ifNo: string; answers: 'yes-no' | 'words' } };
export interface TaskFormProps {
  status: 'live' | 'loading' | 'denied' | 'unavailable';
  action: TaskAction;
  task?: SharedTask;
  /** Authorized choices from the existing shared feed, never a separate fetch. Each label is a display name. */
  people: readonly (Person & { label: string })[];
  projects: readonly { id: string; label: string }[];
  tasks: readonly Pick<SharedTask, 'id' | 'title'>[];
  /** The relations already in view, so Parent and Blocked by can list what the task has and take one away. */
  links?: readonly SharedTaskLink[];
  conversation?: string;
  submit(command: TaskCommand): Promise<void>;
  done(): void;
  cancel(): void;
}
/** What each form is called (its section's label and its accessible name). Claim, Unclaim and Reopen have no form:
 * they are done at once. */
export const taskFormTitles: Partial<Record<TaskAction, string>> = { create: 'Create task', edit: 'Edit task', priority: 'Set priority', project: 'Set project', parent: 'Parent', link: 'Blocked by', ask: 'Ask a person', close: 'Close task', comment: 'Add comment' };
/** The words on each form's one filled button. */
const submits: Partial<Record<TaskAction, string>> = { create: 'Create task', edit: 'Save changes', priority: 'Set priority', project: 'Set project', parent: 'Set parent', link: 'Add blocker', ask: 'Ask', close: 'Close task', comment: 'Add comment' };
const priorities = ['P0 · most urgent', 'P1', 'P2', 'P3', 'P4 · least urgent'];
const types: Record<SharedTask['type'], string> = { task: 'Task', bug: 'Bug', feature: 'Feature', epic: 'Epic' };
/** Drawn in the reader by SharedTasks when act() opens one: under the task's actions, or in the reader's place for
 * Create task. Escape and Cancel close it. Snapshot loss discards drafts. */
export function SharedTaskForm(props: TaskFormProps) {
  if (props.status !== 'live' || !taskFormTitles[props.action] || (props.action !== 'create' && !props.task)) return null;
  return <Draft key={`${props.action}:${props.task?.id ?? 'new'}:${props.conversation ?? ''}`} {...props}/>;
}
function Draft(p: TaskFormProps) {
  const t = p.task;
  const [title, setTitle] = useState(t?.title ?? ''), [goal, setGoal] = useState(t?.goal ?? ''), [why, setWhy] = useState(t?.why ?? '');
  const [doneWhen, setDoneWhen] = useState(t?.doneWhen ?? ''), [description, setDescription] = useState(t?.description ?? '');
  const [priority, setPriority] = useState(t?.priority ?? 2), [project, setProject] = useState(t?.project ?? '');
  const [type, setType] = useState<SharedTask['type']>('task'), [owner, setOwner] = useState('household');
  const [text, setText] = useState(''), [related, setRelated] = useState('');
  const [to, setTo] = useState(''), [ask, setAsk] = useState(t?.ask ?? ''), [ifYes, setIfYes] = useState(t?.ifYes ?? ''), [ifNo, setIfNo] = useState(t?.ifNo ?? '');
  const [answers, setAnswers] = useState<'yes-no' | 'words'>('yes-no');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), alive = useRef(true), form = useRef<HTMLFormElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Focus goes into the form when it opens (SharedTasks gives it back to the button that opened it).
  useEffect(() => { form.current?.querySelector?.<HTMLElement>('input, textarea, select')?.focus?.({ preventScroll: false }); }, []);
  const relation = p.action === 'parent' ? 'parent-child' as const : 'blocks' as const;
  const has = p.action === 'parent' || p.action === 'link' ? (p.links ?? []).filter(link => link.task === t?.id && link.type === relation).map(link => link.dependsOn) : [];
  const summary = (): Summary => ({ title: title.trim(), goal: goal.trim(), why: why.trim(), doneWhen, description, priority, project: project || null });
  const command = (): TaskCommand => {
    const id = t?.id ?? '';
    switch (p.action) {
      case 'create': {
        const person = p.people.find(person => `${person.kind}:${person.id}` === owner);
        if (owner !== 'household' && !person) throw new Error('Choose an owner.');
        return { action: 'create', input: { ...summary(), type, owner: person ? { kind: person.kind, id: person.id } : { kind: 'household' }, ...(related ? { parent: related } : {}), ...(p.conversation ? { source: { kind: 'conversation', id: p.conversation } } : {}) } };
      }
      case 'edit': return { action: 'edit', id, input: summary() };
      case 'priority': return { action: 'edit', id, input: { priority } };
      case 'project': return { action: 'edit', id, input: { project: project || null } };
      case 'close': return { action: 'close', id, reason: text.trim() };
      case 'comment': return { action: 'comment', id, text: text.trim() };
      case 'parent': case 'link': return { action: 'link', id, dependsOn: related, type: relation };
      case 'ask':
        if (!p.people.some(person => person.kind === 'member' && person.id === to)) throw new Error('Choose a person.');
        return { action: 'ask', id, input: { to: { kind: 'member', id: to }, ask: ask.trim(), ifYes: ifYes.trim(), ifNo: ifNo.trim(), answers } };
      default: throw new Error('This has no form.');
    }
  };
  async function send(build: () => TaskCommand) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await p.submit(build()); if (alive.current) p.done(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Could not save the task.'); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const save = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); return p.action === 'parent' && has.length ? undefined : send(command); };
  const summaryFields = p.action === 'create' || p.action === 'edit';
  // A parent is changed by taking the one it has away first, so a second is not offered beside it.
  const choosing = p.action === 'create' || p.action === 'link' || p.action === 'parent' && !has.length;
  const projectField = <Field label="Project"><select value={project} onChange={e => setProject(e.target.value)}><option value="">No project</option>{p.projects.map(project => <option key={project.id} value={project.id}>{project.label}</option>)}</select></Field>;
  const priorityField = <Field label="Priority"><select value={priority} onChange={e => setPriority(Number(e.target.value))}>{priorities.map((words, n) => <option key={n} value={n}>{words}</option>)}</select></Field>;
  const relationLabel = p.action === 'link' ? 'Blocking task' : 'Parent task';
  const relationField = <Field label={relationLabel} hint={p.action === 'link' ? 'This task waits until the one you choose is closed.' : undefined}><select required={p.action !== 'create'} value={related} onChange={e => setRelated(e.target.value)}><option value="">{p.action === 'create' ? 'No parent' : 'Choose a task'}</option>{p.tasks.filter(task => task.id !== t?.id && !has.includes(task.id)).map(task => <option key={task.id} value={task.id}>{task.title} · {task.id}</option>)}</select></Field>;
  return <form ref={form} aria-label={taskFormTitles[p.action]} onSubmit={save} className="grid min-w-0 gap-3"
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); p.cancel(); } }}>
    <Fields disabled={busy}>
      {summaryFields && <>
        <Field label="Title"><Input required value={title} onChange={e => setTitle(e.target.value)}/></Field>
        <Field label="Goal"><Textarea required value={goal} onChange={e => setGoal(e.target.value)}/></Field>
        <Field label="Why"><Textarea required value={why} onChange={e => setWhy(e.target.value)}/></Field>
        <Field label="Done when"><Textarea value={doneWhen} onChange={e => setDoneWhen(e.target.value)}/></Field>
        <Field label="Description"><Textarea value={description} onChange={e => setDescription(e.target.value)}/></Field>
      </>}
      {(summaryFields || p.action === 'priority') && priorityField}
      {(summaryFields || p.action === 'project') && projectField}
      {p.action === 'create' && <>
        <Field label="Type"><select value={type} onChange={e => setType(e.target.value as SharedTask['type'])}>{(Object.keys(types) as SharedTask['type'][]).map(type => <option key={type} value={type}>{types[type]}</option>)}</select></Field>
        <Field label="Owner"><select value={owner} onChange={e => setOwner(e.target.value)}><option value="household">Household</option>{p.people.map(person => <option key={`${person.kind}:${person.id}`} value={`${person.kind}:${person.id}`}>{person.label}</option>)}</select></Field>
      </>}
      {p.action === 'comment' && <Field label="Comment"><Textarea required value={text} onChange={e => setText(e.target.value)}/></Field>}
      {p.action === 'close' && <Field label="Reason" hint="The one word “cancelled” marks the task cancelled instead of done."><Textarea required value={text} onChange={e => setText(e.target.value)}/></Field>}
      {has.length > 0 && <ul aria-label={p.action === 'link' ? 'Blocked by now' : 'Parent now'} className="grid gap-2">{has.map(id => {
        const words = p.tasks.find(task => task.id === id)?.title;
        return <li key={id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1">{words ? `${words} · ${id}` : id}</span>
          <Button type="button" variant="danger-quiet" aria-label={`Remove ${words ?? id}`} onClick={() => void send(() => ({ action: 'unlink', id: t?.id ?? '', dependsOn: id, type: relation }))}>Remove</Button></li>;
      })}</ul>}
      {choosing && relationField}
      {p.action === 'parent' && !choosing && <p className="loom-reader__body" data-quiet="">To change the parent, remove this one first.</p>}
      {p.action === 'ask' && <>
        <Field label="Person"><select required value={to} onChange={e => setTo(e.target.value)}><option value="">Choose a person</option>{p.people.filter(person => person.kind === 'member').map(person => <option key={person.id} value={person.id}>{person.label}</option>)}</select></Field>
        <Field label="Question"><Textarea required value={ask} onChange={e => setAsk(e.target.value)}/></Field>
        <Field label="If yes"><Textarea required value={ifYes} onChange={e => setIfYes(e.target.value)}/></Field>
        <Field label="If no"><Textarea required value={ifNo} onChange={e => setIfNo(e.target.value)}/></Field>
        <Field label="Answer"><select value={answers} onChange={e => setAnswers(e.target.value as typeof answers)}><option value="yes-no">Yes or no</option><option value="words">In words</option></select></Field>
      </>}
    </Fields>
    {error && <p role="alert" className="loom-reader__body">{error}</p>}
    <Actions>
      {(p.action !== 'parent' || choosing) && <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : submits[p.action]}</Button>}
      <Button type="button" onClick={p.cancel}>{p.action === 'parent' && !choosing ? 'Done' : 'Cancel'}</Button>
    </Actions>
  </form>;
}
