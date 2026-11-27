/** The open tickets someone has, as the `person` and `agent` bricks draw them. */
import { useDataQuery } from '../data/graphql';
import { Loading, Unavailable, ticketChip } from './brick-kit';
import type { Form } from './layout';

export function Assigned({ who, kind, form }: { who: string; kind: 'member' | 'agent'; form?: Form }) {
  const read = useDataQuery<{ rows: { id: string; title: string; status: string }[] }>(
    `query BrickAssigned($ref:String!){rows:tasks(where:{assignee:{eq:$ref},assigneeKind:{eq:${kind}},status:{ne:closed}},orderBy:{changedAt:{direction:desc,priority:0}},limit:6){id title status}}`,
    { ref: who }, { keep: true });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <Unavailable what={kind === 'agent' ? 'agent' : 'person'} />;
  const rows = read.data.rows;
  if (form === 'compact') return <p className="board-brief">{rows.length ? `${rows.length === 6 ? 'At least six' : rows.length} open ticket${rows.length === 1 ? '' : 's'}` : 'No open tickets'}</p>;
  return rows.length ? (
    <>
      <p>{rows.length === 6 ? 'At least six' : rows.length} open ticket{rows.length === 1 ? '' : 's'}.</p>
      <div className="board-line">{rows.map((t) => <span key={t.id} title={t.title}>{ticketChip(t.id)}</span>)}</div>
    </>
  ) : <p className="text-muted-foreground">No open tickets.</p>;
}
