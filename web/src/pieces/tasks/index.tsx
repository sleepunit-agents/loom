import { talkPath } from '../comms/shared-query';
import { useEffect, useRef, useState } from 'react';
import { useDataQuery } from '../../data/graphql';
import { SharedTasks, type SharedTask, type TaskAction } from './shared-view';
import { SharedTaskForm, type TaskFormProps } from './shared-form';
import { taskId, taskSegment } from '../../../../src/task-route';
import { taskCommentsQuery, taskSourceQuery, tasksQuery, type TasksSelection } from './query';

export interface TasksAppProps {
  path?: string;
  go?: (path: string) => void;
  questionFor?: string;
  conversation?: string;
  openConversation?: (id: string) => void;
  /** Supplied by the authenticated shared operation adapter in composition. */
  submit?: TaskFormProps['submit'];
  people?: TaskFormProps['people'];
  projects?: TaskFormProps['projects'];
  /** Display names by id and the household's zone, where the composition has read them. */
  names?: Readonly<Record<string, string>>;
  zone?: string;
  liveAgentIds?: ReadonlySet<string>;
}
export default function TasksApp({ path: shellPath, go, questionFor = '', conversation, openConversation, submit, people = [], projects = [], names, zone, liveAgentIds }: TasksAppProps = {}) {
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? '/p/tasks-preview' : location.pathname);
  const [whole, search = ''] = (shellPath ?? localPath).split('?');
  // The path may ask for a folder and one agent's tasks (Home's "tasks in progress" does):
  // /p/tasks-preview/?folder=progress&assignee=art
  const asked = new URLSearchParams(search), startFolder = asked.get('folder') ?? undefined, startAssignee = asked.get('assignee') ?? undefined;
  const path = whole;
  const base = path.split('/task/')[0].replace(/\/$/, '');
  const selected = taskId(path);
  const [action, setAction] = useState<{ action: TaskAction; id?: string }>();
  // A direct link opens list and detail in one request. On first departure
  // release that combined subscription. Subsequent selections reuse the list.
  const [entryTask, setEntryTask] = useState(selected);
  if (entryTask !== undefined && entryTask !== selected) setEntryTask(undefined);
  const combined = entryTask !== undefined && entryTask === selected;
  const listVariables = { selected: combined ? entryTask : '', withComments: combined };
  const snapshot = useDataQuery<TasksSelection>(tasksQuery, listVariables, { keep: true });
  const status = snapshot.status === 'offline' ? 'unavailable' : snapshot.status;
  const tasks = status === 'live' ? snapshot.data?.tasks ?? [] : [];
  const selectedTask = tasks.find(task => task.id === selected);
  const sourceId = selectedTask?.sourceKind === 'conversation' ? selectedTask.sourceId : null;
  const sourceFeed = useDataQuery<{source: Parameters<typeof talkPath>[0] | null}>(
    taskSourceQuery, {id:sourceId}, {pause:!sourceId || !go || !!openConversation});
  const source = sourceFeed.status === 'live' ? sourceFeed.data?.source : null;
  const openSource = openConversation ?? (go && source && source.id === sourceId ? () => go(talkPath(source)) : undefined);
  const readComments = !combined && selected !== undefined && tasks.some(task => task.id === selected);
  const comments = useDataQuery<Pick<TasksSelection, 'selectedTask'>>(taskCommentsQuery, { selected }, { pause: !readComments });
  // Claim, Unclaim and Reopen are sent at once: one at a time, and what the program says if it refuses is shown.
  const [sending, setSending] = useState(false), [problem, setProblem] = useState('');
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const navigate = (id?: string) => {
    setAction(undefined); setProblem('');
    const next = id === undefined ? base : `${base}/task/${taskSegment(id)}`;
    if (go) go(next);
    else { if (typeof history !== 'undefined') history.pushState(null, '', next); setLocalPath(next); }
  };
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => { setLocalPath(location.pathname); setAction(undefined); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const target = tasks.find(task => task.id === action?.id);
  // A removed row also revokes its draft while the rest of the query stays live.
  useEffect(() => { if (status !== 'live' || (action?.id && !target)) setAction(undefined); }, [status, action?.id, target]);
  const act = submit ? (next: TaskAction, task?: SharedTask) => {
    if (next === 'claim' || next === 'unclaim' || next === 'reopen') {
      if (!task || lock.current) return;
      lock.current = true; setSending(true); setProblem(''); setAction(undefined);
      void submit({ action: next, id: task.id }).catch((error: unknown) => { if (alive.current) setProblem(error instanceof Error ? error.message : 'Could not save. Try again.'); })
        .finally(() => { lock.current = false; if (alive.current) setSending(false); });
      return;
    }
    // One form at a time; the button that opened a form closes it again.
    if (action?.action === next && action.id === task?.id) { setAction(undefined); return; }
    if (task?.id !== selected) navigate(task?.id); else setProblem('');
    setAction({ action: next, id: task?.id });
  } : undefined;
  const open = !!submit && !!action && status === 'live' && (action.action === 'create' || !!target);
  const commentFeed = combined ? snapshot : comments;
  const detail = status === 'live' && commentFeed.status === 'live' && !commentFeed.settling
    ? commentFeed.data?.selectedTask : undefined;
  const visibleDetail = selectedTask && detail?.id === selectedTask.id ? detail : undefined;
  const links = tasks.flatMap(task => task.taskLinksByTask);
  return <SharedTasks status={status} tasks={tasks} selected={selected} select={navigate} questionFor={questionFor} startFolder={startFolder} startAssignee={startAssignee} liveAgentIds={liveAgentIds}
    changes={visibleDetail?.changeTasksByTask.flatMap(link => link.changeRow ? [{ ...link.changeRow, task: visibleDetail.id }] : [])}
    links={links} comments={visibleDetail?.taskCommentsByTask ?? []}
    loadingComments={(combined || readComments) && (commentFeed.status === 'loading' || commentFeed.settling)}
    commentsUnavailable={readComments && (comments.status === 'offline' || comments.status === 'denied')}
    ready={tasks.filter(task => task.isReady).map(task => task.id)} conversation={openSource}
    openChange={go ? id => go(`/p/changes-preview/change/${encodeURIComponent(id)}`) : undefined}
    names={names} zone={zone} busy={sending} problem={problem || undefined} act={act}
    form={open ? { action: action.action, node: <SharedTaskForm status={status} action={action.action} task={target} tasks={tasks} links={links}
      people={people} projects={projects} conversation={conversation} submit={submit}
      done={() => setAction(undefined)} cancel={() => setAction(undefined)}/> } : undefined}/>;
}
