import { useMemo, useState } from 'react';
import { useSelection, type QuerySelection } from '../../data/graphql/selection';
import { taskSegment } from '../tasks/route';
type Task = { id: string; title: string; status: string };
const sourceQuery = 'query ConversationWork($conversation:String!,$offset:Int!){tasks(where:{sourceKind:{eq:"conversation"},sourceId:{eq:$conversation}},limit:51,offset:$offset){id title status}}';
const taskQuery = 'query MentionedWork($id:String!){tasks(where:{id:{eq:$id}},limit:1){id title status}}';
function selection(query: string, variables: Record<string, unknown>): QuerySelection<Task[]> {
  return { query, variables, decode(data) { if (!Array.isArray(data.tasks)) throw Error('Invalid work selection'); return data.tasks as Task[]; } };
}
const path = (id: string) => `/p/tasks-preview/task/${taskSegment(id)}`;
function TaskRows({ tasks, go }: { tasks: readonly Task[]; go(path: string): void }) {
  return <ul>{tasks.map(task => <li key={task.id}><button type="button" onClick={() => go(path(task.id))}>{task.title} · {task.id} · {task.status}</button></li>)}</ul>;
}
function MentionedTask({ id, go }: { id: string; go(path: string): void }) {
  const reading = useSelection(useMemo(() => selection(taskQuery, { id }), [id]));
  return reading.status === 'live' ? <TaskRows tasks={reading.data ?? []} go={go} /> : null;
}
export function SharedWork({ conversation, refs, go }: { conversation: string; refs: readonly { ref: string }[]; go(path: string): void }) {
  const [offset, setOffset] = useState(0);
  const reading = useSelection(useMemo(() => selection(sourceQuery, { conversation, offset }), [conversation, offset]));
  const rows = reading.status === 'live' ? reading.data ?? [] : [], source = rows.slice(0,50);
  const mentioned = [...new Set(refs.map(row => row.ref))].filter(id => /^t-\d+$/.test(id) && !source.some(task => task.id === id));
  return <><nav aria-label="Conversation work pages"><button type="button" disabled={reading.status !== 'live' || !offset} onClick={() => setOffset(value => Math.max(0,value-50))}>Previous work</button><button type="button" disabled={reading.status !== 'live' || rows.length <= 50} onClick={() => setOffset(value => value+50)}>Next work</button></nav><TaskRows tasks={source} go={go} />{mentioned.map(id => <MentionedTask key={id} id={id} go={go} />)}
    {refs.filter(row => !/^t-\d+$/.test(row.ref)).map((row, n) => <p key={`${row.ref}:${n}`}>{/^github:[\w.-]+\/[\w.-]+#\d+$/.test(row.ref)
      ? <a href={`https://github.com/${row.ref.slice(7).replace('#','/pull/')}`} target="_blank" rel="noreferrer">{row.ref}</a> : row.ref}</p>)}</>;
}
export { sourceQuery, taskQuery };
