import { useEffect, useRef, useState } from 'react';
import { useRecords, call, type Call } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button, Input, type SplitFolder } from '../../kit';
import { ActionForm, actionsFor, actionLabel, useAnswer, type Action } from './actions';
import { inFolder, matches, pullRequests, type Task, type TaskAnswer } from './model';

function Relations({ label, tasks, ids = tasks.map(t => t.id), open }: { label: string; tasks: readonly Task[]; ids?: string[]; open(id: string): void }) {
  return <section><h3>{label}</h3>{ids.length ? <List label={label}>{ids.map(id => <Row key={id} title={tasks.find(t => t.id === id)?.title ?? id} meta={id} onClick={() => open(id)} />)}</List> : <p>None</p>}</section>;
}
function Reader({ task, records, open, act }: { task: Task; records: readonly Task[]; open(id: string): void; act(action: Action): void }) {
  return <article className="grid gap-5 p-5">
    <header><p>{task.id} · {task.type}</p><h1 className="text-2xl font-semibold">{task.title}</h1><p>{task.status.replace('_', ' ')} · P{task.priority}{task.assignee && ` · ${task.assignee}`}{task.project && ` · ${task.project}`}{task.blocked && ' · Blocked'}</p></header>
    <div role="group" aria-label="Task actions" className="flex flex-wrap gap-2">{actionsFor(task).map(action => <Button variant="outline" size="sm" key={action} type="button" onClick={() => act(action)}>{actionLabel[action]}</Button>)}</div>
    {([['Goal',task.goal],['Why',task.why],['Done when',task.doneWhen],['Description',task.description],['Question for Jonathan',task.ask],['If yes',task.ifYes],['If no',task.ifNo],['Closed because',task.closeReason]] as const).filter(([,text]) => text).map(([label,text]) => <section key={label}><h3>{label}</h3><p className="whitespace-pre-wrap break-words">{text}</p></section>)}
    <Relations label="Parent" ids={task.parent ? [task.parent] : []} tasks={records.filter(t => t.id === task.parent)} open={open} />
    <Relations label="Children" tasks={records.filter(t => t.parent === task.id)} open={open} />
    <Relations label="Blocked by" ids={task.dependsOn} tasks={records.filter(t => task.dependsOn.includes(t.id))} open={open} />
    <Relations label="Blocks" tasks={records.filter(t => (t.dependsOn ?? []).includes(task.id))} open={open} />
    <section><h3>Pull requests</h3>{pullRequests(task).length ? <ul>{pullRequests(task).map(([ref,url]) => <li key={ref}><a href={url} target="_blank" rel="noreferrer">{ref}</a></li>)}</ul> : <p>None linked</p>}</section>
    <section><h3>Comments</h3>{task.comments.length ? <ol className="grid gap-4">{[...task.comments].sort((a,b) => Date.parse(a.at) - Date.parse(b.at)).map((comment,n) => <li key={n}><p>{comment.actor} · <time dateTime={comment.at}>{new Date(comment.at).toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</time></p><p className="whitespace-pre-wrap break-words">{comment.text}</p></li>)}</ol> : <p>No comments yet</p>}</section>
  </article>;
}
function TaskRow({ task, selected, open, act }: { task: Task; selected: boolean; open(id: string): void; act(action: Action, id: string): void }) {
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = row.current;
    const handle = (event: Event) => { const a = (event as CustomEvent).detail; if (a === 'open') open(task.id); else if (actionsFor(task).includes(a)) act(a,task.id); };
    element?.addEventListener('loom-menu',handle);
    return () => element?.removeEventListener('loom-menu',handle);
  },[task,open,act]);
  return <Row ref={row} title={task.title} meta={task.goal} status={`${task.id} · P${task.priority} · ${task.status.replace('_',' ')}`} selected={selected}
    onClick={() => open(task.id)} data-row-menu={['open:Open', ...actionsFor(task).map(a => `${a}:${actionLabel[a]}`)].join('|')} data-row-menu-title={task.title}
    actions={<details><summary aria-label={`Actions for ${task.title}`}>Actions</summary>{actionsFor(task).map(a => <Button variant="outline" size="sm" key={a} onClick={() => act(a,task.id)}>{actionLabel[a]}</Button>)}</details>} />;
}
export default function TasksApp({ path: shellPath, go }: { path?: string; go?: (path: string) => void } = {}) {
  const [localPath,setLocalPath] = useState(() => typeof location === 'undefined' ? '/_dev/tasks-preview' : location.pathname);
  const path = (shellPath ?? localPath).split('?')[0];
  const base = path.split('/task/')[0];
  const selected = /\/task\/(t-\d+)$/.exec(path)?.[1];
  const navigate = (id?: string) => {
    const next = id ? `${base}/task/${id}` : base;
    if (go) go(next);
    else { if (typeof history !== 'undefined') history.pushState(null,'',next); setLocalPath(next); }
  };
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => { setLocalPath(location.pathname); setAction(undefined); };
    window.addEventListener('popstate',pop); return () => window.removeEventListener('popstate',pop);
  },[go]);
  const { records, status } = useRecords<Task>('task');
  const [folder,setFolder] = useState('ready'), [query,setQuery] = useState('');
  const [action,setAction] = useState<{ action: Action; id?: string }>();
  const [olderAt,setOlderAt] = useState<readonly Task[]>();
  const [archiveAt,setArchiveAt] = useState<readonly Task[]>();
  const [olderTask,setOlderTask] = useState<Call<TaskAnswer>>();
  const olderState = useAnswer(olderTask);
  const [archive,setArchive] = useState<Call<TaskAnswer>>();
  const archiveState = useAnswer(archive);
  // Older closed tasks are fetched only by an explicit request. Never retain them across a lost subscription.
  const old = status === 'live' && archiveAt === records && archiveState.result?.ok && archiveState.result.value.result.ok ? archiveState.result.value.result.entries ?? [] : [];
  const all = [...records, ...old.filter(t => !records.some(live => live.id === t.id))];
  const loadedTask = olderAt === records && olderState.result?.ok && olderState.result.value.result.ok ? olderState.result.value.result.task : undefined;
  const current = status === 'live' ? records.find(t => t.id === selected) ?? (loadedTask?.id === selected ? loadedTask : undefined) : undefined;
  const shown = records.filter(t => inFolder(t,folder) && matches(t,query)).sort((a,b) => a.priority-b.priority || a.createdAt.localeCompare(b.createdAt));
  const folders: SplitFolder[] = [
    ...[['ready','Ready'],['progress','In progress'],['jonathan','Needs Jonathan'],['open','All open'],['closed','Recently closed']].map(([id,label]) => ({ id,label,count: records.filter(t => inFolder(t,id)).length })),
    { heading:'Projects' }, ...[...new Set(records.flatMap(t => t.project ? [t.project] : []))].sort().map(project => ({ id:`project:${project}`,label:project,count:records.filter(t => inFolder(t,`project:${project}`)).length })),
    { heading:'Epics' }, ...records.filter(t => t.type === 'epic' && records.some(child => child.parent === t.id && child.status !== 'closed')).map(t => ({ id:`epic:${t.id}`,label:t.title,count:records.filter(child => inFolder(child,`epic:${t.id}`)).length })),
  ];
  const open = (id: string) => {
    navigate(id); setAction(undefined);
    if (!records.some(t => t.id === id)) { setOlderAt(records); setOlderTask(call<TaskAnswer>('tasks.show',{id})); }
  };
  const act = (a: Action, id = selected) => { const target = a === 'create' ? undefined : id; navigate(target); setAction({ action:a,id:target }); };
  const activeForm = action && (action.action === 'create' || (current && action.id === current.id));
  return <Split className="h-full" label="Tasks" folders={folders} folder={folder} onFolder={id => { setFolder(id); setAction(undefined); }}
    search={<label className="grid gap-1">Search tasks<Input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>}
    listTitle="Tasks" listMeta={shown.length} listTop={<div className="flex flex-wrap gap-2 p-3"><Button variant="outline" size="sm" disabled={status !== 'live'} onClick={() => act('create',undefined)}>Create task</Button>{folder === 'closed' && <Button variant="outline" size="sm" disabled={status !== 'live' || archiveState.pending} onClick={() => { setArchiveAt(records); setArchive(call<TaskAnswer>('tasks.list',{status:'closed'})); }}>Load older closed tasks</Button>}</div>}
    list={status === 'loading' ? <Loading label="Opening tasks…" /> : status !== 'live' ? <Error text={status === 'denied' ? 'denied: Sign in to see tasks.' : 'unavailable: Waiting for connection.'} /> : <>
      <List label="Task list">{shown.map(t => <TaskRow key={t.id} task={t} selected={t.id === selected} open={open} act={act} />)}</List>
      {!shown.length && <Empty title={query ? `Nothing matches “${query}”` : 'No tasks here'} text={query ? 'Try another search.' : 'Create a task or choose another folder.'} />}
      {folder === 'closed' && archiveState.pending && <Loading label="Opening older tasks…" />}
      {folder === 'closed' && archiveState.result?.ok === false && <Error text={`${archiveState.result.code}: ${archiveState.result.message}`} />}
      {folder === 'closed' && archiveState.result?.ok && !archiveState.result.value.result.ok && <Error text={archiveState.result.value.result.errors?.join(', ') ?? 'invalid'} />}
      {folder === 'closed' && old.length > 0 && <List label="Older closed tasks">{old.filter(t => !records.some(r => r.id === t.id) && matches(t,query)).map(t => <Row key={t.id} title={t.title} status={`${t.id} · Closed`} onClick={() => open(t.id)} />)}</List>}
    </>}
    reader={activeForm ? <div className="p-5"><ActionForm key={`${action.action}:${action.id ?? ''}`} action={action.action} task={current} enabled={status === 'live'} onCancel={() => setAction(undefined)} /></div> : current ? <Reader task={current} records={all} open={open} act={act} /> : olderState.pending ? <Loading label="Opening task…" /> : olderState.result?.ok === false ? <Error text={`${olderState.result.code}: ${olderState.result.message}`} /> : selected ? <Empty title="This task is no longer in view" text="It may have moved, aged out or become unavailable." /> : null}
    open={!!selected || !!activeForm} onBack={() => { navigate(); setAction(undefined); }} backLabel="Tasks" blank={<Empty title="Open a task" text="Choose work from the list to read it here." />} />;
}
