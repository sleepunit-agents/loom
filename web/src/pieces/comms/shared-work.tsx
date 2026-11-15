import { useMemo, useState } from 'react';
import { useSelection, type QuerySelection } from '../../data/graphql/selection';
import { ChangeCard } from '../change-view';
import type { Change } from '../change-view/model';
import { taskSegment } from '../tasks/route';
type Task = { id: string; title: string; status: string };
import { sourceQuery, taskQuery, changeQuery } from './work-query';
function selection(query: string, variables: Record<string, unknown>): QuerySelection<Task[]> {
  return { query, variables, decode(data) { if (!Array.isArray(data.tasks)) throw Error('Invalid work selection'); return data.tasks as Task[]; } };
}
const path = (id: string) => `/p/tasks-preview/task/${taskSegment(id)}`;
function TaskRows({ tasks, go, madeHere = false }: { tasks: readonly Task[]; go(path: string): void; madeHere?:boolean }) {
  return <ul>{tasks.map(task => <li key={task.id}><button type="button" onClick={() => go(path(task.id))}>{task.title} · {task.id} · {task.status}{madeHere && ' · Made here'}</button></li>)}</ul>;
}
function MentionedTask({ id, go }: { id: string; go(path: string): void }) {
  const reading = useSelection(useMemo(() => selection(taskQuery, { id }), [id]));
  return reading.status === 'live' ? <TaskRows tasks={reading.data ?? []} go={go} /> : null;
}
function MentionedChange({ id, go }: { id: string; go(path: string): void }) {
  const reading = useSelection(useMemo<QuerySelection<Pick<Change,'id'|'title'|'state'|'checks'|'review'|'waitingOn'|'draft'>[]>>(() => ({ query: changeQuery, variables: { id },
    decode(data) { if (!Array.isArray(data.changes)) throw Error('Invalid change selection'); return data.changes as Pick<Change,'id'|'title'|'state'|'checks'|'review'|'waitingOn'|'draft'>[]; } }), [id]));
  return <ChangeCard id={id} snapshot={{status:reading.status,changes:reading.data ?? []}} open={id => go(`/p/changes-preview/change/${encodeURIComponent(id)}`)} />;
}
export function SharedWork({ conversation, refs, go }: { conversation: string; refs: readonly { ref: string }[]; go(path: string): void }) {
  const [offset, setOffset] = useState(0);
  const reading = useSelection(useMemo(() => ({query:sourceQuery,variables:{conversation,offset},decode(data){if(!Array.isArray(data.tasks)||!Array.isArray(data.conversationMadeChanges))throw Error('Invalid source work');return {tasks:data.tasks as Task[],changes:data.conversationMadeChanges as {id:string}[]};}}), [conversation, offset]));
  const rows = reading.status === 'live' ? reading.data?.tasks ?? [] : [], source = rows.slice(0,50);
  const madeChanges = reading.status === 'live' ? reading.data?.changes ?? [] : [];
  const mentioned = [...new Set(refs.map(row => row.ref))].filter(id => /^t-\d+$/.test(id) && !source.some(task => task.id === id));
  return <><nav aria-label="Conversation work pages"><button type="button" disabled={reading.status !== 'live' || !offset} onClick={() => setOffset(value => Math.max(0,value-50))}>Previous work</button><button type="button" disabled={reading.status !== 'live' || rows.length <= 50 && madeChanges.length <= 50} onClick={() => setOffset(value => value+50)}>Next work</button></nav><TaskRows tasks={source} go={go} madeHere />{mentioned.map(id => <MentionedTask key={id} id={id} go={go} />)}
    {madeChanges.slice(0,50).map(row => <div key={row.id}><p>Made here</p><MentionedChange id={row.id} go={go} /></div>)}
    {[...new Set(refs.filter(row => /^github:[\w.-]+\/[\w.-]+#\d+$/.test(row.ref)).map(row => row.ref))].filter(id=>!madeChanges.some(row=>row.id===id)).map(id => <MentionedChange key={id} id={id} go={go} />)}
    {refs.filter(row => !/^t-\d+$/.test(row.ref) && !/^github:[\w.-]+\/[\w.-]+#\d+$/.test(row.ref)).map((row,n) => <p key={`${row.ref}:${n}`}>{row.ref}</p>)}</>;
}
