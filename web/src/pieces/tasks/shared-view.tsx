import type { changes } from '../../../../src/core/data/schema';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Split, List, Row, Empty, Error, Loading, Button, Actions, LinkButton, Search, Menu, Reader, Meta, Title, Facts, Fact, Section, Body, Chip, RefCard, type SplitFolder } from '../../kit';
import { briefTime, fullTime } from '../../kit/time';
import { displayName } from '../../kit/words';
import type { ReviewRound } from '../change-view/model';
import { ChangeCard } from '../change-view';
import { taskFormTitles } from './shared-form';

function StoryDetail({words}:{words:string}) {
  if(words.length<=360 && words.split('\n').length<=5) return <Body>{words}</Body>;
  const first=words.trim().split('\n',1)[0];
  const cut=first.slice(0,160);
  const preview=first.length<=160 ? first : (cut.replace(/\s+\S*$/u,'') || cut)+'…';
  return <details className="min-w-0">
    <summary className="cursor-pointer">{preview || 'Read full entry'}</summary>
    <Body>{words}</Body>
  </details>;
}

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
  createdAt?: string; createdBy?: string; closedAt?: string | null;
}
export interface SharedTaskLink { task: string; dependsOn: string; type: 'blocks' | 'parent-child' }
export interface SharedTaskComment { task: string; seq: number; actorKind: 'member' | 'agent'; actor: string; at: string; text: string }
export type SharedTaskChange = Pick<typeof changes.$inferSelect, 'id' | 'repository' | 'number' | 'title' | 'state' | 'draft' | 'checks' | 'review' | 'waitingOn'> & { task: string; openedAt?: string; closedAt?: string | null };
export interface TicketPost { task:string; id:string; at:string; agent:string; thread:string; words:string }
export type GithubReview = {id:string;change:string;login:string|null;submittedAt:string;headCommit:string|null;
  state:'COMMENTED'|'CHANGES_REQUESTED'|'DISMISSED'|'APPROVED';body:string;url:string};
const githubVerdicts = {COMMENTED:'commented',CHANGES_REQUESTED:'requested changes',DISMISSED:'review dismissed',APPROVED:'approved'};
export type TicketReview = ReviewRound & {requestedAt: string; completedAt: string | null};
export type TaskReaderFields = Pick<SharedTask, 'createdAt' | 'createdBy' | 'closedAt' | 'doneWhen' | 'ifYes' | 'ifNo' | 'sourceKind' | 'sourceId'>;
export type TaskListRow = Omit<SharedTask, keyof TaskReaderFields>;
type Task = SharedTask;
type Link = SharedTaskLink;
type Comment = SharedTaskComment;
export type TaskAction = 'promote' | 'create' | 'claim' | 'unclaim' | 'close' | 'reopen' | 'comment' | 'edit' | 'priority' | 'project' | 'parent' | 'link' | 'ask';
export interface SharedTasksProps {
  status: 'loading' | 'live' | 'unavailable' | 'denied';
  tasks: readonly TaskListRow[];
  reader?: SharedTask;
  links: readonly Link[];
  comments: readonly Comment[];
  loadingReader?: boolean;
  readerUnavailable?: boolean;
  changes?: readonly SharedTaskChange[];
  githubReviews?: readonly GithubReview[];
  githubNavigation?: React.ReactNode;
  reviews?: readonly TicketReview[];
  reviewsUnavailable?: boolean;
  posts?: TicketPost[];
  discussion?: ReactNode;
  postNavigation?: ReactNode;
  noteNavigation?: ReactNode;
  projectLink?: { id: string; name: string; open(): void };
  openPost?(post:TicketPost): void;
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
const labels: Record<TaskAction, string> = {promote:'Promote to epic',create:'Create task',claim:'Claim',unclaim:'Unclaim',close:'Close',reopen:'Reopen',comment:'Comment',edit:'Edit',priority:'Priority',project:'Project',parent:'Parent',link:'Blocked by…',ask:'Ask a person'};
/** Behind More: what is done to a task less often than the six beside it. */
const more: readonly TaskAction[] = ['ask','parent','link','promote'];
function actions(task: Task): TaskAction[] {
  // A shelved task cannot be claimed; moving it to another project (Project) is how one is taken up.
  return [ ...(task.status === 'closed' ? ['reopen' as const] : [ ...(!task.ask && !(task.isShelved && task.status === 'open') ? [task.status === 'open' ? 'claim' as const : 'unclaim' as const] : []), 'close' as const, 'ask' as const]), 'comment','edit','priority','project','parent','link',...(task.type !== 'epic' ? ['promote' as const] : [])];
}
/** A task's stored state in plain words ("in_progress" is "in progress"). */
const stateWord = (task: TaskListRow) => task.closeReason === 'cancelled' && task.status === 'closed' ? 'cancelled' : task.status.replace('_',' ');
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
  const selected = live ? props.reader : undefined;
  const project = props.projectLink?.id === selected?.project ? props.projectLink : undefined;
  const name = (id: string | null) => displayName(id, props.names);
  const readyIds = new Set(live ? props.ready : []);
  const openTaskIds = new Set<string>();
  const projectCounts = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === 'closed') continue;
    openTaskIds.add(task.id);
    const project = task.project;
    if (project) projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
  }
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
  const inFolder = (task: TaskListRow, id: string) => {
    if (id === 'closed') return task.status === 'closed';
    if (task.status === 'closed') return false;
    // Shelved with its retired project: under Shelved, its project and its epic, and in no list of open work.
    if (id === 'shelved') return !!task.isShelved;
    if (task.isShelved && ['ready','progress','questions','open'].includes(id)) return false;
    if (id === 'ready') return readyIds.has(task.id);
    if (id === 'progress') return task.status === 'in_progress';
    if (id === 'questions') return task.assigneeKind === 'member' && task.assignee === props.questionFor && !!task.ask;
    if (id.startsWith('project:')) return task.project === id.slice(8);
    if (id.startsWith('epic:')) return epicChildren.get(id.slice(5))?.has(task.id) ?? false;
    return true;
  };
  const count = (id: string) => tasks.filter(t => inFolder(t,id)).length;
  // A project whose work is all closed has nothing to list, so it is not offered; a heading shows only over something.
  const projects = [...projectCounts.keys()].sort().map(project => ({
    id:`project:${project}`, label:project, count:projectCounts.get(project)!,
  }));
  const epics = tasks.filter(t => t.type === 'epic' && t.status !== 'closed').map(t => ({id:`epic:${t.id}`,label:t.title,count:epicChildren.get(t.id)?.size ?? 0}));
  const folders: SplitFolder[] = [
    ...[['ready','Ready'],['progress','In progress'],['questions',props.questionFor ? `Needs ${name(props.questionFor)}` : 'Needs you'],['open','All open'],['closed','Recently closed'],['shelved','Shelved']].map(([id,label]) => ({id,label,count:count(id)})),
    ...(projects.length ? [{heading:'Projects'}, ...projects] : []),
    ...(epics.length ? [{heading:'Epics'}, ...epics] : []),
  ];
  const current = folders.find((f): f is Extract<SplitFolder,{id:string}> => 'id' in f && f.id === folder);
  const words = query.toLowerCase().match(/\S+/g);
  const shown = tasks.filter(t => {
    if (!inFolder(t,folder) || (assignee && (t.assigneeKind !== 'agent' || t.assignee !== assignee))) return false;
    if (!words) return true;
    const text = [t.id,t.title,t.goal,t.why,t.description,t.project,t.owner,t.assignee].join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  })
    .sort((a,b) => a.priority-b.priority || a.position-b.position || a.id.localeCompare(b.id));
  // A related task: its title, then its id as a chip that opens it. One this person may not see is its id alone.
  const relations = (title: string, ids: string[]) => ids.length > 0 && <Fact label={title}><div role="group" aria-label={title} className="grid gap-1">{ids.map(id => {
    const task = tasks.find(t => t.id === id);
    return <div key={id}>{task && `${task.title} `}<Chip onClick={task ? () => props.select(id) : undefined} label={task ? `Open ${task.title}, ${id}` : undefined}>{id}</Chip></div>;
  })}</div></Fact>;
  const comments = selected ? props.comments.filter(c => c.task === selected.id).toSorted((a,b) => a.seq-b.seq) : [];
  const changes = selected ? props.changes?.filter(change => change.task === selected.id) ?? [] : [];
  const story: {key: string; at: string; label: string; detail?: string; change?: string; revision?: string; reviewUrl?:string; post?:TicketPost}[] = [];
  if (selected?.createdAt) story.push({key:'filed', at:selected.createdAt, label:'Ticket filed', detail:name(selected.createdBy ?? null)});
  for (const comment of comments) story.push({key:'comment-'+comment.seq, at:comment.at, label:name(comment.actor), detail:comment.text});
  for (const change of changes) {
    if (change.openedAt) story.push({key:'opened-'+change.id, at:change.openedAt, label:'Pull request opened', detail:change.title, change:change.id});
    if (change.closedAt && change.state !== 'open') story.push({key:'closed-'+change.id, at:change.closedAt, label:change.state === 'merged' ? 'Pull request merged' : 'Pull request closed', detail:change.title, change:change.id});
  }
  for (const post of props.posts ?? []) {
    if (post.task === selected?.id) story.push({key:'post-'+post.id,at:post.at,label:name(post.agent),detail:post.words,post});
  }
  for (const review of props.reviews ?? []) {
    const change = changes.find(link => link.id === review.change);
    if (!change) continue;
    const round = `Review ${review.round} · #${change.number} · ${review.headCommit.slice(0, 8)}`;
    story.push({key:'request-'+review.job, at:review.requestedAt, label:round, detail:'Review requested', change:review.change, revision:review.headCommit});
    if (review.completedAt) {
      const verdict = {CLEAR:'Clear', BLOCKING:'Changes requested', NONE:'No reviewer report'}[review.verdict ?? 'NONE'];
      story.push({key:'report-'+review.job, at:review.completedAt, label:round+' · '+verdict, detail:review.findings ?? undefined, change:review.change, revision:review.headCommit});
    }
  }
  for (const review of props.githubReviews ?? []) story.push({
    key:'github-review-'+review.id, at:review.submittedAt,
    label:(review.login ?? 'GitHub reviewer')+' · '+githubVerdicts[review.state],
    detail:review.body, revision:review.headCommit ?? undefined, reviewUrl:review.url,
  });
  if (selected?.status === 'closed' && selected.closedAt) story.push({key:'closed', at:selected.closedAt, label:'Ticket closed', detail:selected.closeReason ?? undefined});
  story.sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
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
    list={props.status === 'loading' ? <Loading label="Opening tasks…"/> : !live ? <Error text={props.status === 'denied' ? 'Sign in to see tasks.' : 'Waiting for connection.'}/> : shown.length ? <List label="Task list">{shown.map(t => <Row key={t.id} title={t.title} meta={t.goal} status={`${t.id} · P${t.priority} · ${t.isShelved ? `shelved · was ${stateWord(t)}` : stateWord(t)}`} selected={t.id === props.selected} onClick={() => props.select(t.id)}/>)}</List> : <Empty title="No tasks here" text="Choose another folder or change your search."/>}
    open={!!props.selected || creating} onBack={() => props.select()} backLabel="Back to Tasks" blank={<Empty title="Open a task" text="Choose work from the list."/>}
    reader={creating ? <Reader aria-label="Create task"><Title>Create task</Title>{props.form!.node}</Reader>
    : selected ? <Reader aria-label="Task">
      <Meta>{selected.id} · {selected.type}</Meta>
      <Title>{selected.title}</Title>
      <Meta>{selected.isShelved ? `shelved with its project · was ${stateWord(selected)}` : stateWord(selected)} · P{selected.priority}{project ? <> · <LinkButton onClick={project.open}>{project.name}</LinkButton></> : selected.project && ` · ${selected.project}`}</Meta>
      {props.act && <Actions label="Task actions">
        {offered.filter(action => !more.includes(action)).map(action => button(action))}
        {offered.some(action => more.includes(action)) && <Menu label="More" name="More for this task" disabled={props.busy}>{close => offered.filter(action => more.includes(action)).map(action => button(action, close))}</Menu>}
      </Actions>}
      {props.problem && <Error text={props.problem}/>}
      {props.form && props.form.action !== 'create' && <Section data-form="" label={taskFormTitles[props.form.action] ?? labels[props.form.action]}>{props.form.node}</Section>}
      {(selected.goal || selected.doneWhen) && <Section label="Commitment">
        {selected.goal && <Body>{selected.goal}</Body>}
        {selected.doneWhen && <Facts><Fact label="Done when">{selected.doneWhen}</Fact></Facts>}
      </Section>}
      {selected.status==='closed' && selected.closeReason && !['done','cancelled'].includes(selected.closeReason) &&
        <Section label="Recorded outcome"><StoryDetail words={selected.closeReason}/></Section>}
      {story.length > 0 && <Section label="Ticket story"><ol className="grid gap-2.5">{story.map(event => <li key={event.key} className="grid gap-0.5">
        <Body><strong title={event.revision}>{event.label}</strong> <time className="loom-reader__meta" dateTime={event.at} title={fullTime(event.at,props.zone)}>{briefTime(event.at,props.zone)}</time></Body>
        {event.detail && (event.change && props.openChange && event.detail.length<=360
          ? <LinkButton onClick={()=>props.openChange!(event.change!)}>{event.detail}</LinkButton>
          : <StoryDetail words={event.detail}/>)}
        {event.change && props.openChange && (event.detail?.length ?? 0)>360 &&
          <LinkButton onClick={()=>props.openChange!(event.change!)}>Open pull request</LinkButton>}
        {event.reviewUrl && <a href={event.reviewUrl} target="_blank" rel="noreferrer">GitHub review{event.revision && ' · '+event.revision.slice(0,8)}</a>}
        {event.post && props.openPost && <LinkButton onClick={()=>props.openPost!(event.post!)}>Activity thread</LinkButton>}
      </li>)}</ol>{props.noteNavigation}{props.githubNavigation}{props.postNavigation}{props.reviewsUnavailable && <Body quiet>Review history is unavailable.</Body>}</Section>}
      <Facts>
        <Fact label="Why">{selected.why}</Fact>
        {relations('Parent',links.filter(l => l.task === selected.id && l.type === 'parent-child').map(l => l.dependsOn))}
        {relations('Children',links.filter(l => l.dependsOn === selected.id && l.type === 'parent-child').map(l => l.task))}
        {relations('Blocked by',links.filter(l => l.task === selected.id && l.type === 'blocks').map(l => l.dependsOn))}
        {relations('Blocks',links.filter(l => l.dependsOn === selected.id && l.type === 'blocks').map(l => l.task))}
        <Fact label="Owner">{selected.ownerKind === 'household' ? 'Household' : name(selected.owner)}</Fact>
        <Fact label="Assigned to">{name(selected.assignee)}</Fact>
      </Facts>
      {props.discussion}
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

    </Reader> : live && props.selected && props.loadingReader ? <Loading label="Opening task…"/>
    : live && props.selected && props.readerUnavailable ? <Error text="Could not load this task."/>
    : live && props.selected ? <Empty title="This task is no longer in view" text="Choose another task."/> : null}/>;
}
