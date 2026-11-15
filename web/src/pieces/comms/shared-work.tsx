import { useMemo } from 'react';
import { useQuery, type QuerySelection } from '../../data/query';
import { taskSegment } from '../tasks/route';
type Task = { id: string; title: string; status: string };
const sourceQuery = 'query ConversationWork($conversation:String!){tasks(where:{sourceKind:{eq:"conversation"},sourceId:{eq:$conversation}},limit:50){id title status}}';
const taskQuery = 'query MentionedWork($id:String!){tasks(where:{id:{eq:$id}},limit:1){id title status}}';
function selection(query: string, variables: Record<string, unknown>): QuerySelection<Task[]> {
  return { query, variables, decode(data) { if (!Array.isArray(data.tasks)) throw Error('Invalid work selection'); return data.tasks as Task[]; } };
}
const path = (id: string) => `/p/tasks-preview/task/${taskSegment(id)}`;
function TaskRows({ tasks, go }: { tasks: readonly Task[]; go(path: string): void }) {
  return <ul>{tasks.map(task => <li key={task.id}><button type="button" onClick={() => go(path(task.id))}>{task.title} · {task.id} · {task.status}</button></li>)}</ul>;
}
function MentionedTask({ id, go }: { id: string; go(path: string): void }) {
  const reading = useQuery(useMemo(() => selection(taskQuery, { id }), [id]));
  return reading.status === 'live' ? <TaskRows tasks={reading.data ?? []} go={go} /> : null;
}
export function SharedWork({ conversation, refs, go }: { conversation: string; refs: readonly { ref: string }[]; go(path: string): void }) {
  const reading = useQuery(useMemo(() => selection(sourceQuery, { conversation }), [conversation]));
  const source = reading.status === 'live' ? reading.data ?? [] : [];
  const mentioned = [...new Set(refs.map(row => row.ref))].filter(id => /^t-\d+$/.test(id) && !source.some(task => task.id === id));
  return <><TaskRows tasks={source} go={go} />{mentioned.map(id => <MentionedTask key={id} id={id} go={go} />)}
    {refs.filter(row => !/^t-\d+$/.test(row.ref)).map((row, n) => <p key={`${row.ref}:${n}`}>{/^github:[\w.-]+\/[\w.-]+#\d+$/.test(row.ref)
      ? <a href={`https://github.com/${row.ref.slice(7).replace('#','/pull/')}`} target="_blank" rel="noreferrer">{row.ref}</a> : row.ref}</p>)}</>;
}
export { sourceQuery, taskQuery };
