import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { useDataQuery } from '../../data/graphql';
import { SharedTasks, type TaskAction } from './shared-view';
import { SharedTaskForm, type TaskFormProps } from './shared-form';
import { taskId, taskSegment } from './route';
import { tasksQuery, type TasksSelection } from './query';

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
}
export default function TasksApp({ path: shellPath, go, questionFor = '', conversation, openConversation, submit, people = [], projects = [] }: TasksAppProps = {}) {
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? '/p/tasks-preview' : location.pathname);
  const path = (shellPath ?? localPath).split('?')[0];
  const base = path.split('/task/')[0];
  const selected = taskId(path);
  const [action, setAction] = useState<{ action: TaskAction; id?: string }>();
  const snapshot = useDataQuery<TasksSelection>(tasksQuery);
  const status = snapshot.status === 'offline' ? 'unavailable' : snapshot.status;
  const tasks = status === 'live' ? snapshot.data?.tasks ?? [] : [];
  const navigate = (id?: string) => {
    setAction(undefined);
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
  return <>
    <SharedTasks status={status} tasks={tasks} selected={selected} select={navigate} questionFor={questionFor}
      changes={tasks.flatMap(task => task.changeTasksByTask.flatMap(link => link.changeRow ? [{ ...link.changeRow, task: task.id }] : []))}
      links={tasks.flatMap(task => task.taskLinksByTask)} comments={tasks.flatMap(task => task.taskCommentsByTask)}
      ready={tasks.filter(task => task.isReady).map(task => task.id)} conversation={openConversation}
      act={submit ? (action, task) => { navigate(task?.id); setAction({action, id: task?.id}); } : undefined}/>
    {submit && <Dialog open={!!action && status === 'live' && (action.action === 'create' || !!target)} onOpenChange={open => { if (!open) setAction(undefined); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Task form</DialogTitle>
        {action && <SharedTaskForm status={status} action={action.action} task={target} tasks={tasks}
      people={people} projects={projects} conversation={conversation} submit={submit}
      done={() => setAction(undefined)} cancel={() => setAction(undefined)}/>}
      </DialogContent>
    </Dialog>}
  </>;
}
