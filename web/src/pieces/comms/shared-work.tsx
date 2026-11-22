import { useMemo, useState } from 'react';
import { useSelection, type QuerySelection } from '../../data/graphql/selection';
import { Chip, Chips, List, Pager, Row } from '../../kit';
import { ChangeCard } from '../change-view';
import { WorkCard, WorkPanel } from '../comms-view/work';
import { inboxRefPath } from '../attention/inbox-query';
import type { Change } from '../change-view/model';
import { taskPath } from '../../../../src/task-route';
type Task = { id: string; title: string; status: string;isShelved?:boolean;sourceKind?:string;sourceId?:string };
import { sourceQuery, taskQuery, changeQuery } from './work-query';
function selection(query: string, variables: Record<string, unknown>): QuerySelection<Task[]> {
  return { query, variables, decode(data) { if (!Array.isArray(data.tasks)) throw Error('Invalid work selection'); return data.tasks as Task[]; } };
}
/** A task's stored state in plain words ("in_progress" is "in progress"). */
const stateWord = (task: Task) => task.isShelved ? 'shelved' : task.status.replace(/_/g, ' ');
function TaskRows({ tasks, go, madeHere = false, conversation }: { tasks: readonly Task[]; go(path: string): void; madeHere?:boolean;conversation?:string }) {
  return <>{tasks.map(task => <Row key={task.id} title={task.title} onClick={() => go(taskPath(task.id))}
    status={`${task.id} · ${stateWord(task)}${madeHere || task.sourceKind==='conversation' && task.sourceId===conversation ? ' · Made here' : ''}`} />)}</>;
}
function MentionedTask({ id, go, conversation }: { id: string; go(path: string): void;conversation:string }) {
  const reading = useSelection(useMemo(() => selection(taskQuery, { id }), [id]));
  return reading.status === 'live' ? <TaskRows tasks={reading.data ?? []} go={go} conversation={conversation} /> : null;
}
function MentionedChange({ id, go, conversation }: { id: string; go(path: string): void;conversation:string }) {
  const reading = useSelection(useMemo<QuerySelection<{changes:Pick<Change,'id'|'title'|'state'|'checks'|'review'|'waitingOn'|'draft'>[];made:{id:string}[]}>>(() => ({ query: changeQuery, variables: { id,conversation },
    decode(data) { if (!Array.isArray(data.changes)||!Array.isArray(data.conversationMadeChanges)) throw Error('Invalid change selection'); return {changes:data.changes as Pick<Change,'id'|'title'|'state'|'checks'|'review'|'waitingOn'|'draft'>[],made:data.conversationMadeChanges as {id:string}[]}; } }), [id,conversation]));
  return <WorkCard label={`Conversation change ${id}`} made={reading.status==='live' && reading.data?.made.some(row=>row.id===id)}><ChangeCard id={id} snapshot={{status:reading.status,changes:reading.data?.changes ?? []}} open={id => go(`/p/changes-preview/change/${encodeURIComponent(id)}`)} /></WorkCard>;
}
export function SharedWork({ conversation, refs, go }: { conversation: string; refs: readonly { ref: string }[]; go(path: string): void }) {
  const [offset, setOffset] = useState(0);
  // Another page keeps the last one's rows and the pager usable until it answers. Mounted per conversation.
  const reading = useSelection(useMemo(() => ({query:sourceQuery,variables:{conversation,offset},decode(data){if(!Array.isArray(data.tasks)||!Array.isArray(data.conversationMadeChanges))throw Error('Invalid source work');return {tasks:data.tasks as Task[],changes:data.conversationMadeChanges as {id:string}[]};}}), [conversation, offset]), { keep: true });
  const rows = reading.status === 'live' ? reading.data?.tasks ?? [] : [], source = rows.slice(0,50);
  const madeChanges = reading.status === 'live' ? reading.data?.changes ?? [] : [];
  const mentioned = [...new Set(refs.map(row => row.ref))].filter(id => /^t-\d+$/.test(id) && !source.some(task => task.id === id));
  const displayedChanges=[...new Set([...madeChanges.slice(0,50).map(row=>row.id),...refs.filter(row=>/^github:[\w.-]+\/[\w.-]+#\d+$/.test(row.ref)).map(row=>row.ref)])];
  // What is neither a task nor a pull request is still named: as a chip, one that opens where the app knows how.
  const others=[...new Set(refs.map(row => row.ref))].filter(ref => !/^t-\d+$/.test(ref) && !/^github:[\w.-]+\/[\w.-]+#\d+$/.test(ref));
  const count=source.length+mentioned.length+displayedChanges.length+others.length, hasNext=rows.length > 50 || madeChanges.length > 50;
  if (!count && !offset && !hasNext) return null;
  return <WorkPanel count={count}>
    {(source.length > 0 || mentioned.length > 0) && <List label="Tasks in this conversation"><TaskRows tasks={source} go={go} madeHere />{mentioned.map(id => <MentionedTask key={id} id={id} go={go} conversation={conversation} />)}</List>}
    <div className="comms-work__rest">
      {displayedChanges.map(id=><MentionedChange key={id} id={id} go={go} conversation={conversation} />)}
      {others.length > 0 && <Chips label="Also mentioned">{others.map(ref => { const to = inboxRefPath(ref); return <Chip key={ref} onClick={to ? () => go(to) : undefined} label={to ? `Open ${ref}` : undefined}>{ref}</Chip>; })}</Chips>}
      <Pager label="Conversation work pages" disabled={reading.status !== 'live'} hasPrevious={offset > 0} hasNext={hasNext} previous={() => setOffset(value => Math.max(0,value-50))} next={() => setOffset(value => value+50)} />
    </div>
  </WorkPanel>;
}
