/** The `backlog` brick: a project's open tickets that are in no lane, in the order the desktop's backlog lists
 * them (pieces/tasks/shared-view.tsx: priority, then the hand-kept position, then id; a ticket shelved with a
 * retired project is not open work). A ticket is in a lane when the project's board has it (`projectBoardTickets`,
 * the read the `lanes` brick draws). The big form sets a ticket's priority with the desktop's Set priority action:
 * tasks.command `edit` with the priority alone. The board is told `priority` and which one. */
import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { Loading, Unavailable, ticketChip, words, type Act, type Params } from './bricks';
import { Pick, priorityChoices, priorityWord, useTaskCommand } from './bricks-work';
import type { Form } from './layout';

type Row = { id: string; title: string; status: string; priority: number; isShelved: boolean };
export const backlogQuery = `query BrickBacklog($project:String!){
  project:projectsSingle(where:{id:{eq:$project}}){id name}
  open:tasks(where:{project:{eq:$project},status:{ne:closed}},orderBy:{priority:{direction:asc,priority:2},position:{direction:asc,priority:1},id:{direction:asc,priority:0}}){id title status priority isShelved}
}`;
export const backlogLanedQuery = 'query BrickBacklogLaned($project:String!){projectBoardTickets(project:$project,offset:0,limit:100){id}}';
/** The tickets of `open` that no lane holds. */
export const inBacklog = (open: readonly Row[], laned: readonly { id: string }[]) => {
  const held = new Set(laned.map((t) => t.id));
  return open.filter((t) => t.status === 'open' && !t.isShelved && !held.has(t.id));
};

export function Backlog({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const project = words(params.project);
  const read = useDataQuery<{ project: { id: string; name: string } | null; open: Row[] }>(backlogQuery, { project }, { keep: true });
  const lanes = useDataQuery<{ projectBoardTickets: { id: string }[] }>(backlogLanedQuery, { project }, { keep: true });
  const { busy, error, run } = useTaskCommand(act);
  const [setting, setSetting] = useState<string>();
  if (read.status === 'loading' || lanes.status === 'loading') return <Loading />;
  if (read.status !== 'live' || lanes.status !== 'live' || !read.data?.project) return <Unavailable what="project" />;
  const rows = inBacklog(read.data.open ?? [], lanes.data?.projectBoardTickets ?? []);
  const count = `${rows.length || 'No'} ticket${rows.length === 1 ? '' : 's'} in the backlog`;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  if (!rows.length) return <p className="text-muted-foreground">No tickets in the backlog.</p>;
  const big = form === 'primary', shown = rows.slice(0, big ? 30 : 6);
  const set = async (id: string, priority: number) => { if (await run('priority', { action: 'edit', id, input: { priority } }, { priority: String(priority) })) setSetting(undefined); };
  return (
    <>
      <p>{count}.</p>
      <ul className="board-notes">
        {shown.map((t) => (
          <li key={t.id}>
            <span className="board-line" style={{ marginTop: 0 }}>
              {ticketChip(t.id)}<span>{t.title}</span><span className="board-state">{priorityWord(t.priority)}</span>
              {big && setting !== t.id && <button type="button" className="board-action" aria-label={`Set priority of ${t.id}`} onClick={() => setSetting(t.id)}>Priority…</button>}
            </span>
            {big && setting === t.id && <>
              <Pick<number> label="Priority" value={t.priority} options={priorityChoices} disabled={busy} onChange={(priority) => void set(t.id, priority)} />
              <button type="button" className="board-action" onClick={() => setSetting(undefined)}>Cancel</button>
            </>}
          </li>
        ))}
      </ul>
      {rows.length > shown.length && <p className="text-muted-foreground">and {rows.length - shown.length} more</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}
