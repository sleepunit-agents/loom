import { useMemo, useState } from 'react';
import { useSelection, type QuerySelection } from '../../data/graphql/selection';
import { ChangeCard } from '../change-view';
import type { Change } from '../change-view/model';
import { taskSegment } from '../tasks/route';
type Task = { id: string; title: string; status: string;isShelved?:boolean;sourceKind?:string;sourceId?:string };
import { sourceQuery, taskQuery, changeQuery } from './work-query';
function selection(query: string, variables: Record<string, unknown>): QuerySelection<Task[]> {
  return { query, variables, decode(data) { if (!Array.isArray(data.tasks)) throw Error('Invalid work selection'); return data.tasks as Task[]; } };
}
const path = (id: string) => `/p/tasks-preview/task/${taskSegment(id)}`;
function TaskRows({ tasks, go, madeHere = false, conversation }: { tasks: readonly Task[]; go(path: string): void; madeHere?:boolean;conversation?:string }) {
  return <ul>{tasks.map(task => <li key={task.id}><button type="button" onClick={() => go(path(task.id))}>{task.title} · {task.id} · {task.isShelved ? 'shelved' : task.status}{(madeHere || task.sourceKind==='conversation' && task.sourceId===conversation) && ' · Made here'}</button></li>)}</ul>;
}
function MentionedTask({ id, go, conversation }: { id: string; go(path: string): void;conversation:string }) {
  const reading = useSelection(useMemo(() => selection(taskQuery, { id }), [id]));
  return reading.status === 'live' ? <TaskRows tasks={reading.data ?? []} go={go} conversation={conversation} /> : null;
}
function MentionedChange({ id, go, conversation }: { id: string; go(path: string): void;conversation:string }) {
  const reading = useSelection(useMemo<QuerySelection<{changes:Pick<Change,'id'|'title'|'state'|'checks'|'review'|'waitingOn'|'draft'>[];made:{id:string}[]}>>(() => ({ query: changeQuery, variables: { id,conversation },
    decode(data) { if (!Array.isArray(data.changes)||!Array.isArray(data.conversationMadeChanges)) throw Error('Invalid change selection'); return {changes:data.changes as Pick<Change,'id'|'title'|'state'|'checks'|'review'|'waitingOn'|'draft'>[],made:data.conversationMadeChanges as {id:string}[]}; } }), [id,conversation]));
  return <div aria-label={`Conversation change ${id}`}>{reading.status==='live' && reading.data?.made.some(row=>row.id===id) && <p>Made here</p>}<ChangeCard id={id} snapshot={{status:reading.status,changes:reading.data?.changes ?? []}} open={id => go(`/p/changes-preview/change/${encodeURIComponent(id)}`)} /></div>;
}
export function SharedWork({ conversation, refs, go }: { conversation: string; refs: readonly { ref: string }[]; go(path: string): void }) {
  const [offset, setOffset] = useState(0);
  const reading = useSelection(useMemo(() => ({query:sourceQuery,variables:{conversation,offset},decode(data){if(!Array.isArray(data.tasks)||!Array.isArray(data.conversationMadeChanges))throw Error('Invalid source work');return {tasks:data.tasks as Task[],changes:data.conversationMadeChanges as {id:string}[]};}}), [conversation, offset]));
  const rows = reading.status === 'live' ? reading.data?.tasks ?? [] : [], source = rows.slice(0,50);
  const madeChanges = reading.status === 'live' ? reading.data?.changes ?? [] : [];
  const mentioned = [...new Set(refs.map(row => row.ref))].filter(id => /^t-\d+$/.test(id) && !source.some(task => task.id === id));
  const displayedChanges=[...new Set([...madeChanges.slice(0,50).map(row=>row.id),...refs.filter(row=>/^github:[\w.-]+\/[\w.-]+#\d+$/.test(row.ref)).map(row=>row.ref)])];
  return <><nav aria-label="Conversation work pages"><button type="button" disabled={reading.status !== 'live' || !offset} onClick={() => setOffset(value => Math.max(0,value-50))}>Previous work</button><button type="button" disabled={reading.status !== 'live' || rows.length <= 50 && madeChanges.length <= 50} onClick={() => setOffset(value => value+50)}>Next work</button></nav><TaskRows tasks={source} go={go} madeHere />{mentioned.map(id => <MentionedTask key={id} id={id} go={go} conversation={conversation} />)}
    {displayedChanges.map(id=><MentionedChange key={id} id={id} go={go} conversation={conversation} />)}
    {refs.filter(row => !/^t-\d+$/.test(row.ref) && !/^github:[\w.-]+\/[\w.-]+#\d+$/.test(row.ref)).map((row,n) => <p key={`${row.ref}:${n}`}>{row.ref}</p>)}</>;
}
