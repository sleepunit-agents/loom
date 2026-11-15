import type { changes } from '../../../../src/core/data/schema';
import { useState } from 'react';
import { Split, List, Row, Empty, Error, Loading, Button, Input, type SplitFolder } from '../../kit';

/** Field projection accepted from the shared query client; no runtime schema or record adapter. */
export interface SharedTask {
  id: string; title: string; type: 'task' | 'bug' | 'feature' | 'epic';
  status: 'open' | 'in_progress' | 'closed'; priority: number; position: number;
  ownerKind: 'member' | 'agent' | 'household'; owner: string | null; project: string | null;
  assigneeKind: 'member' | 'agent' | null; assignee: string | null;
  goal: string; why: string; doneWhen: string; description: string;
  ask: string | null; ifYes: string | null; ifNo: string | null; closeReason: string | null;
  sourceKind: string | null; sourceId: string | null;
}
export interface SharedTaskLink { task: string; dependsOn: string; type: 'blocks' | 'parent-child' }
export interface SharedTaskComment { task: string; seq: number; actorKind: 'member' | 'agent'; actor: string; at: string; text: string }
export type SharedTaskChange = Pick<typeof changes.$inferSelect, 'id' | 'repository' | 'number' | 'state' | 'checks' | 'review'> & { task: string };
type Task = SharedTask;
type Link = SharedTaskLink;
type Comment = SharedTaskComment;
export type TaskAction = 'create' | 'claim' | 'unclaim' | 'close' | 'reopen' | 'comment' | 'edit' | 'priority' | 'project' | 'parent' | 'link' | 'ask';
export interface SharedTasksProps {
  status: 'loading' | 'live' | 'unavailable' | 'denied';
  tasks: readonly Task[];
  links: readonly Link[];
  comments: readonly Comment[];
  changes?: readonly SharedTaskChange[];
  /** IDs returned by the authorized ready query, never inferred from partial visible links. */
  ready: readonly string[];
  selected?: string;
  questionFor: string;
  select(id?: string): void;
  /** The composition opens a form; its authenticated operation supplies the actor. */
  act?(action: TaskAction, task?: Task): void;
  conversation?(id: string): void;
}
const labels: Record<TaskAction, string> = {create:'Create task',claim:'Claim',unclaim:'Unclaim',close:'Close',reopen:'Reopen',comment:'Comment',edit:'Edit',priority:'Priority',project:'Project',parent:'Parent',link:'Blockers',ask:'Ask a person'};
function actions(task: Task): TaskAction[] {
  return [ ...(task.status === 'closed' ? ['reopen' as const] : [ ...(!task.ask ? [task.status === 'open' ? 'claim' as const : 'unclaim' as const] : []), 'close' as const, 'ask' as const]), 'comment','edit','priority','project','parent','link'];
}
/** Shared-schema presentation only. Root owns reads, authorization, routing and writes. */
export function SharedTasks(props: SharedTasksProps) {
  const [folder,setFolder] = useState('ready'), [query,setQuery] = useState('');
  // Losing the authorized snapshot also hides selected detail and comments immediately.
  const tasks = props.status === 'live' ? props.tasks : [];
  const links = props.status === 'live' ? props.links : [];
  const selected = tasks.find(t => t.id === props.selected);
  const inFolder = (task: Task, id: string) => {
    if (id === 'closed') return task.status === 'closed';
    if (task.status === 'closed') return false;
    if (id === 'ready') return props.ready.includes(task.id);
    if (id === 'progress') return task.status === 'in_progress';
    if (id === 'questions') return task.assigneeKind === 'member' && task.assignee === props.questionFor && !!task.ask;
    if (id.startsWith('project:')) return task.project === id.slice(8);
    if (id.startsWith('epic:')) return links.some(l => l.task === task.id && l.dependsOn === id.slice(5) && l.type === 'parent-child');
    return true;
  };
  const folders: SplitFolder[] = [
    ...[['ready','Ready'],['progress','In progress'],['questions',`Needs ${props.questionFor}`],['open','All open'],['closed','Closed']].map(([id,label]) => ({id,label,count:tasks.filter(t => inFolder(t,id)).length})),
    {heading:'Projects'}, ...[...new Set(tasks.flatMap(t => t.project ? [t.project] : []))].sort().map(project => ({id:`project:${project}`,label:project})),
    {heading:'Epics'}, ...tasks.filter(t => t.type === 'epic' && t.status !== 'closed').map(t => ({id:`epic:${t.id}`,label:t.title})),
  ];
  const words = query.toLowerCase().trim().split(/\s+/);
  const shown = tasks.filter(t => inFolder(t,folder) && words.every(word => [t.id,t.title,t.goal,t.why,t.description,t.project,t.owner,t.assignee].join(' ').toLowerCase().includes(word)))
    .sort((a,b) => a.priority-b.priority || a.position-b.position || a.id.localeCompare(b.id));
  const relations = (title: string, ids: string[]) => <section><h3>{title}</h3>{ids.length ? <List label={title}>{ids.map(id => {
    const task = tasks.find(t => t.id === id);
    return task ? <Row key={id} title={task.title} meta={id} onClick={() => props.select(id)}/> : <li key={id}>{id}</li>;
  })}</List> : <p>None</p>}</section>;
  return <Split label="Tasks" className="h-full" folders={folders} folder={folder} onFolder={setFolder}
    search={<label>Search tasks<Input type="search" value={query} onChange={e => setQuery(e.target.value)}/></label>}
    listTitle="Tasks" listMeta={shown.length} listTop={<Button disabled={props.status !== 'live' || !props.act} onClick={() => props.act?.('create')}>Create task</Button>}
    list={props.status === 'loading' ? <Loading label="Opening tasks…"/> : props.status !== 'live' ? <Error text={props.status === 'denied' ? 'Sign in to see tasks.' : 'Waiting for connection.'}/> : <><List label="Task list">{shown.map(t => <Row key={t.id} title={t.title} meta={t.goal} status={`${t.id} · P${t.priority} · ${t.closeReason === 'cancelled' && t.status === 'closed' ? 'cancelled' : t.status.replace('_',' ')}`} selected={t.id === selected?.id} onClick={() => props.select(t.id)}/>)}</List>{!shown.length && <Empty title="No tasks here" text="Choose another folder or change your search."/>}</>}
    open={!!props.selected} onBack={() => props.select()} backLabel="Tasks" blank={<Empty title="Open a task" text="Choose work from the list."/>}
    reader={selected ? <article className="grid gap-5 p-5">
      <header><p>{selected.id} · {selected.type}</p><h1>{selected.title}</h1><p>{selected.status.replace('_',' ')} · P{selected.priority}{selected.project && ` · ${selected.project}`}</p></header>
      <p>Owner: {selected.ownerKind === 'household' ? 'Household' : `${selected.ownerKind} ${selected.owner}`}</p>
      {selected.assignee && <p>Assigned to {selected.assigneeKind} {selected.assignee}</p>}
      {props.act && <div role="group" aria-label="Task actions" className="flex flex-wrap gap-2">{actions(selected).map(action => <Button variant="outline" key={action} onClick={() => props.act?.(action,selected)}>{labels[action]}</Button>)}</div>}
      {([['Goal',selected.goal],['Why',selected.why],['Done when',selected.doneWhen],['Description',selected.description],['Question',selected.ask],['If yes',selected.ifYes],['If no',selected.ifNo],['Closed because',selected.closeReason]] as const).filter(([,value]) => value).map(([label,value]) => <section key={label}><h3>{label}</h3><p className="whitespace-pre-wrap break-words">{value}</p></section>)}
      {!!props.changes?.some(change => change.task === selected.id) && <section><h3>Pull requests</h3>{props.changes.filter(change => change.task === selected.id).map(change => {
        const repository = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(change.repository)?.[1];
        const label = repository ? `${repository}#${change.number}` : change.id;
        const href = repository && Number.isInteger(change.number) && change.number > 0 ? `https://github.com/${repository}/pull/${change.number}` : undefined;
        const status = change.state === 'open' ? `${change.checks} · ${change.review.replaceAll('_',' ')}` : change.state;
        return <p key={change.id}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a> : label}{` · ${status}`}</p>;
      })}</section>}
      {selected.sourceKind === 'conversation' && selected.sourceId && <section><h3>Source conversation</h3><p>{selected.sourceId}</p></section>}
      {selected.sourceKind === 'conversation' && selected.sourceId && props.conversation && <Button variant="outline" onClick={() => props.conversation!(selected.sourceId!)}>From conversation</Button>}
      {relations('Parent',links.filter(l => l.task === selected.id && l.type === 'parent-child').map(l => l.dependsOn))}
      {relations('Children',links.filter(l => l.dependsOn === selected.id && l.type === 'parent-child').map(l => l.task))}
      {relations('Blocked by',links.filter(l => l.task === selected.id && l.type === 'blocks').map(l => l.dependsOn))}
      {relations('Blocks',links.filter(l => l.dependsOn === selected.id && l.type === 'blocks').map(l => l.task))}
      <section><h3>Comments</h3><ol>{props.comments.filter(c => c.task === selected.id).toSorted((a,b) => a.seq-b.seq).map(c => <li key={c.seq}><p>{c.actorKind} {c.actor} · <time dateTime={c.at}>{new Date(c.at).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT</time></p><p className="whitespace-pre-wrap break-words">{c.text}</p></li>)}</ol></section>
    </article> : props.status === 'live' && props.selected ? <Empty title="This task is no longer in view" text="Choose another task."/> : null}/>;
}
