import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Textarea } from '../../kit';
import type { SharedTask, TaskAction } from './shared-view';

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
  | { action: 'ask'; id: string; input: { to: { kind: 'member'; id: string }; ask: string; ifYes: string; ifNo: string; answers: 'yes-no' | 'words' } };
export interface TaskFormProps {
  status: 'live' | 'loading' | 'denied' | 'unavailable';
  action: TaskAction;
  task?: SharedTask;
  /** Authorized choices from the existing shared feed, never a separate fetch. */
  people: readonly (Person & { label: string })[];
  projects: readonly { id: string; label: string }[];
  tasks: readonly Pick<SharedTask, 'id' | 'title'>[];
  conversation?: string;
  submit(command: TaskCommand): Promise<void>;
  done(): void;
  cancel(): void;
}
const titles: Record<TaskAction, string> = { create: 'Create task', edit: 'Edit task', priority: 'Set priority', project: 'Set project', parent: 'Parent', link: 'Blockers', ask: 'Ask a person', claim: 'Claim task', unclaim: 'Unclaim task', close: 'Close task', reopen: 'Reopen task', comment: 'Add comment' };
/** Mount beside SharedTasks when act() is invoked. Snapshot loss discards drafts. */
export function SharedTaskForm(props: TaskFormProps) {
  if (props.status !== 'live' || (props.action !== 'create' && !props.task)) return null;
  return <Draft key={`${props.action}:${props.task?.id ?? 'new'}:${props.conversation ?? ''}`} {...props}/>;
}
function Draft(p: TaskFormProps) {
  const t = p.task;
  const [title, setTitle] = useState(t?.title ?? ''), [goal, setGoal] = useState(t?.goal ?? ''), [why, setWhy] = useState(t?.why ?? '');
  const [doneWhen, setDoneWhen] = useState(t?.doneWhen ?? ''), [description, setDescription] = useState(t?.description ?? '');
  const [priority, setPriority] = useState(t?.priority ?? 2), [project, setProject] = useState(t?.project ?? '');
  const [type, setType] = useState<SharedTask['type']>('task'), [owner, setOwner] = useState('household');
  const [text, setText] = useState(''), [related, setRelated] = useState(''), [remove, setRemove] = useState(false);
  const [to, setTo] = useState(''), [ask, setAsk] = useState(t?.ask ?? ''), [ifYes, setIfYes] = useState(t?.ifYes ?? ''), [ifNo, setIfNo] = useState(t?.ifNo ?? '');
  const [answers, setAnswers] = useState<'yes-no' | 'words'>('yes-no');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
      case 'claim': case 'unclaim': case 'reopen': return { action: p.action, id };
      case 'parent': case 'link': return { action: remove ? 'unlink' : 'link', id, dependsOn: related, type: p.action === 'parent' ? 'parent-child' : 'blocks' };
      case 'ask':
        if (!p.people.some(person => person.kind === 'member' && person.id === to)) throw new Error('Choose a person.');
        return { action: 'ask', id, input: { to: { kind: 'member', id: to }, ask: ask.trim(), ifYes: ifYes.trim(), ifNo: ifNo.trim(), answers } };
    }
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await p.submit(command()); if (alive.current) p.done(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Could not save the task.'); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const summaryFields = p.action === 'create' || p.action === 'edit';
  const projectField = <label>Project<select value={project} onChange={e => setProject(e.target.value)}><option value="">No project</option>{p.projects.map(project => <option key={project.id} value={project.id}>{project.label}</option>)}</select></label>;
  const priorityField = <label>Priority<select value={priority} onChange={e => setPriority(Number(e.target.value))}>{[0,1,2,3,4].map(n => <option key={n} value={n}>P{n}</option>)}</select></label>;
  const relationField = <label>{p.action === 'link' ? 'Blocking task' : 'Parent task'}<select required={p.action !== 'create'} value={related} onChange={e => setRelated(e.target.value)}><option value="">Choose a task</option>{p.tasks.filter(task => task.id !== t?.id).map(task => <option key={task.id} value={task.id}>{task.title} · {task.id}</option>)}</select></label>;
  return <form aria-label={titles[p.action]} onSubmit={save} className="grid gap-3 p-4">
    <h2>{titles[p.action]}{t && ` · ${t.id}`}</h2>
    <fieldset disabled={busy} className="grid gap-3">
      {summaryFields && <>
        <label>Title<Input required value={title} onChange={e => setTitle(e.target.value)}/></label>
        <label>Goal<Textarea required value={goal} onChange={e => setGoal(e.target.value)}/></label>
        <label>Why<Textarea required value={why} onChange={e => setWhy(e.target.value)}/></label>
        <label>Done when<Textarea value={doneWhen} onChange={e => setDoneWhen(e.target.value)}/></label>
        <label>Description<Textarea value={description} onChange={e => setDescription(e.target.value)}/></label>
      </>}
      {(summaryFields || p.action === 'priority') && priorityField}
      {(summaryFields || p.action === 'project') && projectField}
      {p.action === 'create' && <>
        <label>Type<select value={type} onChange={e => setType(e.target.value as SharedTask['type'])}>{['task','bug','feature','epic'].map(type => <option key={type}>{type}</option>)}</select></label>
        <label>Owner<select value={owner} onChange={e => setOwner(e.target.value)}><option value="household">Household</option>{p.people.map(person => <option key={`${person.kind}:${person.id}`} value={`${person.kind}:${person.id}`}>{person.label} · {person.kind}</option>)}</select></label>
        {relationField}
      </>}
      {(p.action === 'comment' || p.action === 'close') && <label>{p.action === 'close' ? 'Reason (cancelled marks it cancelled)' : 'Comment'}<Textarea required value={text} onChange={e => setText(e.target.value)}/></label>}
      {(p.action === 'parent' || p.action === 'link') && <>{relationField}<label><input type="checkbox" checked={remove} onChange={e => setRemove(e.target.checked)}/>Remove this relation</label>{p.action === 'parent' && <p>To change a parent, remove the existing relation first.</p>}</>}
      {p.action === 'ask' && <>
        <label>Person<select required value={to} onChange={e => setTo(e.target.value)}><option value="">Choose a person</option>{p.people.filter(person => person.kind === 'member').map(person => <option key={person.id} value={person.id}>{person.label}</option>)}</select></label>
        <label>Question<Textarea required value={ask} onChange={e => setAsk(e.target.value)}/></label>
        <label>If yes<Textarea required value={ifYes} onChange={e => setIfYes(e.target.value)}/></label>
        <label>If no<Textarea required value={ifNo} onChange={e => setIfNo(e.target.value)}/></label>
        <label>Answer<select value={answers} onChange={e => setAnswers(e.target.value as typeof answers)}><option value="yes-no">Yes or no</option><option value="words">In words</option></select></label>
      </>}
      <Button type="submit">{busy ? 'Saving…' : titles[p.action]}</Button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <Button type="button" variant="outline" onClick={p.cancel}>Cancel</Button>
  </form>;
}
