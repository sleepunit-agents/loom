import type { changes } from '../../../../src/core/data/schema';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Split, List, Row, Empty, Error, Loading, Button, Actions, LinkButton, Search, Menu, Reader, Meta, Title, Facts, Fact, Section, Body, Chip, RefCard, type SplitFolder } from '../../kit';
import { briefTime, fullTime } from '../../kit/time';
import { displayName } from '../../kit/words';
import { ChangeCard } from '../change-view';
import { taskFormTitles } from './shared-form';

/** Field projection accepted from the shared query client; no runtime schema or record adapter. */
export interface SharedTask {
  id: string; title: string; type: 'task' | 'bug' | 'feature' | 'epic';
  status: 'open' | 'in_progress' | 'closed'; priority: number; position: number;
  ownerKind: 'member' | 'agent' | 'household'; owner: string | null; project: string | null;
  assigneeKind: 'member' | 'agent' | null; assignee: string | null;
  goal: string; why: string; doneWhen: string; description: string;
  ask: string | null; ifYes: string | null; ifNo: string | null; closeReason: string | null;
  sourceKind: string | null; sourceId: string | null;
  /** Unfinished, in a retired project: shown under its project marked shelved, and counted nowhere as open work. */
  isShelved?: boolean;
}
export interface SharedTaskLink { task: string; dependsOn: string; type: 'blocks' | 'parent-child' }
export interface SharedTaskComment { task: string; seq: number; actorKind: 'member' | 'agent'; actor: string; at: string; text: string }
export type SharedTaskChange = Pick<typeof changes.$inferSelect, 'id' | 'repository' | 'number' | 'title' | 'state' | 'draft' | 'checks' | 'review' | 'waitingOn'> & { task: string };
type Task = SharedTask;
type Link = SharedTaskLink;
type Comment = SharedTaskComment;
export type TaskAction = 'create' | 'claim' | 'unclaim' | 'close' | 'reopen' | 'comment' | 'edit' | 'priority' | 'project' | 'parent' | 'link' | 'ask';
export interface SharedTasksProps {
  status: 'loading' | 'live' | 'unavailable' | 'denied';
  tasks: readonly Task[];
  links: readonly Link[];
  comments: readonly Comment[];
  loadingComments?: boolean;
  commentsUnavailable?: boolean;
  changes?: readonly SharedTaskChange[];
  /** IDs returned by the authorized ready query, never inferred from partial visible links. */
  ready: readonly string[];
  selected?: string;
  /** What the path asked to open on: a folder's id, and one agent whose tasks alone are listed until the person says otherwise. */
  startFolder?: string; startAssignee?: string;
  liveAgentIds?: ReadonlySet<string>;
  questionFor: string;
  select(id?: string): void;
  /** The composition acts at once (Claim, Unclaim, Reopen) or opens a form; its authenticated operation supplies the actor. */
  act?(action: TaskAction, task?: Task): void;
  /** The form the composition has open: under the open task's actions, or (Create task) in the reader's place. */
  form?: { action: TaskAction; node: ReactNode };
  /** An action sent at once is on its way; and what the program said if it refused one. */
  busy?: boolean; problem?: string;
  conversation?(id: string): void;
  /** Opens a pull request in Changes, where the composition can. */
  openChange?(id: string): void;
  /** Display names by id, where the composition has read them; the zone times are said in (the household's). */
  names?: Readonly<Record<string, string>>; zone?: string;
}
const labels: Record<TaskAction, string> = {create:'Create task',claim:'Claim',unclaim:'Unclaim',close:'Close',reopen:'Reopen',comment:'Comment',edit:'Edit',priority:'Priority',project:'Project',parent:'Parent',link:'Blocked by…',ask:'Ask a person'};
/** Behind More: what is done to a task less often than the six beside it. */
const more: readonly TaskAction[] = ['ask','parent','link'];
function actions(task: Task): TaskAction[] {
  // A shelved task cannot be claimed; moving it to another project (Project) is how one is taken up.
  return [ ...(task.status === 'closed' ? ['reopen' as const] : [ ...(!task.ask && !(task.isShelved && task.status === 'open') ? [task.status === 'open' ? 'claim' as const : 'unclaim' as const] : []), 'close' as const, 'ask' as const]), 'comment','edit','priority','project','parent','link'];
}
/** A task's stored state in plain words ("in_progress" is "in progress"). */
const stateWord = (task: Task) => task.closeReason === 'cancelled' && task.status === 'closed' ? 'cancelled' : task.status.replace('_',' ');
/** Shared-schema presentation only. Root owns reads, authorization, routing and writes. */
export function SharedTasks(props: SharedTasksProps) {
  const [folder,setFolder] = useState(props.startFolder ?? 'ready'), [query,setQuery] = useState('');
  const [requestedAssignee,setAssignee] = useState(props.startAssignee);
  const assignee = requestedAssignee && (!props.liveAgentIds || props.liveAgentIds.has(requestedAssignee)) ? requestedAssignee : undefined;
  // A later path that asks again (the app was already open) is followed; a path that asks nothing changes nothing.
  useEffect(() => { if (props.startFolder) setFolder(props.startFolder); if (props.startAssignee) setAssignee(props.startAssignee); }, [props.startFolder, props.startAssignee]);
  // A form that closes gives focus back to the button that opened it.
  const opener = useRef<HTMLElement | null>(null), formOpen = !!props.form;
  useEffect(() => { if (!formOpen && opener.current?.isConnected) opener.current.focus?.(); }, [formOpen]);
  const act = (action: TaskAction, task?: Task) => { opener.current = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null; props.act?.(action, task); };
  // Losing the authorized snapshot also hides selected detail and comments immediately.
  const live = props.status === 'live';
  const tasks = live ? props.tasks : [];
  const links = live ? props.links : [];
  const selected = tasks.find(t => t.id === props.selected);
  const name = (id: string | null) => displayName(id, props.names);
  const openTaskIds = new Set(tasks.filter(task => task.status !== 'closed').map(task => task.id));
  const epicChildren = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.type !== 'parent-child') continue;
    const child = link.task;
    if (!openTaskIds.has(child)) continue;
    let children = epicChildren.get(link.dependsOn);
    if (!children) {
      children = new Set();
      epicChildren.set(link.dependsOn, children);
    }
    children.add(child);
  }
  const inFolder = (task: Task, id: string) => {
    if (id === 'closed') return task.status === 'closed';
    if (task.status === 'closed') return false;
    // Shelved with its retired project: under Shelved, its project and its epic, and in no list of open work.
    if (id === 'shelved') return !!task.isShelved;
    if (task.isShelved && ['ready','progress','questions','open'].includes(id)) return false;
    if (id === 'ready') return props.ready.includes(task.id);
    if (id === 'progress') return task.status === 'in_progress';
    if (id === 'questions') return task.assigneeKind === 'member' && task.assignee === props.questionFor && !!task.ask;
    if (id.startsWith('project:')) return task.project === id.slice(8);
    if (id.startsWith('epic:')) return epicChildren.get(id.slice(5))?.has(task.id) ?? false;
    return true;
  };
  const count = (id: string) => tasks.filter(t => inFolder(t,id)).length;
  // A project whose work is all closed has nothing to list, so it is not offered; a heading shows only over something.
  const projects = [...new Set(tasks.flatMap(t => t.project ? [t.project] : []))].sort().map(project => ({id:`project:${project}`,label:project,count:count(`project:${project}`)})).filter(f => f.count > 0);
  const epics = tasks.filter(t => t.type === 'epic' && t.status !== 'closed').map(t => ({id:`epic:${t.id}`,label:t.title,count:epicChildren.get(t.id)?.size ?? 0}));
  const folders: SplitFolder[] = [
    ...[['ready','Ready'],['progress','In progress'],['questions',props.questionFor ? `Needs ${name(props.questionFor)}` : 'Needs you'],['open','All open'],['closed','Recently closed'],['shelved','Shelved']].map(([id,label]) => ({id,label,count:count(id)})),
    ...(projects.length ? [{heading:'Projects'}, ...projects] : []),
    ...(epics.length ? [{heading:'Epics'}, ...epics] : []),
  ];
  const current = folders.find((f): f is Extract<SplitFolder,{id:string}> => 'id' in f && f.id === folder);
  const words = query.toLowerCase().trim().split(/\s+/);
  const shown = tasks.filter(t => inFolder(t,folder) && (!assignee || t.assigneeKind === 'agent' && t.assignee === assignee) && words.every(word => [t.id,t.title,t.goal,t.why,t.description,t.project,t.owner,t.assignee].join(' ').toLowerCase().includes(word)))
    .sort((a,b) => a.priority-b.priority || a.position-b.position || a.id.localeCompare(b.id));
  // A related task: its title, then its id as a chip that opens it. One this person may not see is its id alone.
  const relations = (title: string, ids: string[]) => ids.length > 0 && <Fact label={title}><div role="group" aria-label={title} className="grid gap-1">{ids.map(id => {
    const task = tasks.find(t => t.id === id);
    return <div key={id}>{task && `${task.title} `}<Chip onClick={task ? () => props.select(id) : undefined} label={task ? `Open ${task.title}, ${id}` : undefined}>{id}</Chip></div>;
  })}</div></Fact>;
  const comments = selected ? props.comments.filter(c => c.task === selected.id).toSorted((a,b) => a.seq-b.seq) : [];
  const changes = selected ? props.changes?.filter(change => change.task === selected.id) ?? [] : [];
  const mine = !!selected && selected.assigneeKind === 'member' && !!props.questionFor && selected.assignee === props.questionFor;
  const offered = selected ? actions(selected) : [];
  const button = (action: TaskAction, after?: () => void) => <Button key={action} disabled={props.busy}
    variant={action === 'claim' || action === 'close' && mine && selected!.status === 'in_progress' ? 'primary' : undefined}
    {...(action in taskFormTitles ? {'aria-expanded': props.form?.action === action} : {})}
    onClick={() => { after?.(); act(action,selected); }}>{labels[action]}</Button>;
  const creating = live && props.form?.action === 'create';
  return <Split label="Tasks" folders={folders} folder={folder} onFolder={setFolder}
    search={<Search label="Search tasks" value={query} onChange={setQuery}/>}
    listTitle={current?.label ?? 'Tasks'} listCount={live ? shown.length : undefined} listKey={JSON.stringify([folder,query,assignee])}
    listAction={<Button disabled={!live || !props.act} onClick={() => act('create')}>Create task</Button>}
    listTop={live && assignee && <Body quiet>Only {name(assignee)}’s tasks · <LinkButton onClick={() => setAssignee(undefined)}>show everyone’s</LinkButton></Body>}
    list={props.status === 'loading' ? <Loading label="Opening tasks…"/> : !live ? <Error text={props.status === 'denied' ? 'Sign in to see tasks.' : 'Waiting for connection.'}/> : shown.length ? <List label="Task list">{shown.map(t => <Row key={t.id} title={t.title} meta={t.goal} status={`${t.id} · P${t.priority} · ${t.isShelved ? `shelved · was ${stateWord(t)}` : stateWord(t)}`} selected={t.id === selected?.id} onClick={() => props.select(t.id)}/>)}</List> : <Empty title="No tasks here" text="Choose another folder or change your search."/>}
    open={!!props.selected || creating} onBack={() => props.select()} backLabel="Back to Tasks" blank={<Empty title="Open a task" text="Choose work from the list."/>}
    reader={creating ? <Reader aria-label="Create task"><Title>Create task</Title>{props.form!.node}</Reader>
    : selected ? <Reader aria-label="Task">
      <Meta>{selected.id} · {selected.type}</Meta>
      <Title>{selected.title}</Title>
      <Meta>{selected.isShelved ? `shelved with its project · was ${stateWord(selected)}` : stateWord(selected)} · P{selected.priority}{selected.project && ` · ${selected.project}`}</Meta>
      {props.act && <Actions label="Task actions">
        {offered.filter(action => !more.includes(action)).map(action => button(action))}
        {offered.some(action => more.includes(action)) && <Menu label="More" name="More for this task" disabled={props.busy}>{close => offered.filter(action => more.includes(action)).map(action => button(action, close))}</Menu>}
      </Actions>}
      {props.problem && <Error text={props.problem}/>}
      {props.form && props.form.action !== 'create' && <Section data-form="" label={taskFormTitles[props.form.action] ?? labels[props.form.action]}>{props.form.node}</Section>}
      <Facts>
        <Fact label="Goal">{selected.goal}</Fact>
        <Fact label="Why">{selected.why}</Fact>
        <Fact label="Done when">{selected.doneWhen}</Fact>
        {relations('Parent',links.filter(l => l.task === selected.id && l.type === 'parent-child').map(l => l.dependsOn))}
        {relations('Children',links.filter(l => l.dependsOn === selected.id && l.type === 'parent-child').map(l => l.task))}
        {relations('Blocked by',links.filter(l => l.task === selected.id && l.type === 'blocks').map(l => l.dependsOn))}
        {relations('Blocks',links.filter(l => l.dependsOn === selected.id && l.type === 'blocks').map(l => l.task))}
        <Fact label="Owner">{selected.ownerKind === 'household' ? 'Household' : name(selected.owner)}</Fact>
        <Fact label="Assigned to">{name(selected.assignee)}</Fact>
        <Fact label="Closed because">{selected.closeReason}</Fact>
      </Facts>
      {selected.sourceKind === 'conversation' && selected.sourceId && (props.conversation
        ? <LinkButton onClick={() => props.conversation!(selected.sourceId!)}>From a conversation</LinkButton> : <Body quiet>From a conversation</Body>)}
      {selected.sourceKind === 'old-conversation' && selected.sourceId && <Body quiet>From an archived conversation</Body>}
      {selected.description && <Section label="Description"><Body>{selected.description}</Body></Section>}
      {selected.ask && <Section label="Question"><Body>{selected.ask}</Body>
        {(selected.ifYes || selected.ifNo) && <Facts><Fact label="If yes">{selected.ifYes}</Fact><Fact label="If no">{selected.ifNo}</Fact></Facts>}</Section>}
      {changes.length > 0 && <Section label="Pull requests">{changes.map(change => {
        const repository = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(change.repository)?.[1];
        const label = repository ? `${repository}#${change.number}` : change.id;
        const href = repository && Number.isInteger(change.number) && change.number > 0 ? `https://github.com/${repository}/pull/${change.number}` : undefined;
        return <RefCard key={change.id} label={`Pull request ${label}`}><ChangeCard id={change.id} snapshot={{status:'live',changes:[change]}} open={props.openChange} link={{label,href}} name={name}/></RefCard>;
      })}</Section>}
      {props.commentsUnavailable && <Error text="Could not load comments."/>}
      {props.loadingComments && <Loading label="Loading comments…"/>}
      {comments.length > 0 && <Section label="Comments"><ol className="grid gap-2.5">{comments.map(c => <li key={c.seq} className="grid gap-0.5">
        <Body><strong>{name(c.actor)}</strong> <time className="loom-reader__meta" dateTime={c.at} title={fullTime(c.at,props.zone)}>{briefTime(c.at,props.zone)}</time></Body>
        <Body>{c.text}</Body></li>)}</ol></Section>}
    </Reader> : live && props.selected ? <Empty title="This task is no longer in view" text="Choose another task."/> : null}/>;
}
