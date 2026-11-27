/** The open tickets someone has, as the `person` and `agent` bricks draw them. */
import { useDataQuery } from '../data/graphql';
import { Loading, Note, Row, Rows, Unavailable, count } from './brick-kit';
import type { Form } from './layout';

export function Assigned({ who, kind, form }: { who: string; kind: 'member' | 'agent'; form?: Form }) {
  const read = useDataQuery<{ rows: { id: string; title: string; status: string }[] }>(
    `query BrickAssigned($ref:String!){rows:tasks(where:{assignee:{eq:$ref},assigneeKind:{eq:${kind}},status:{ne:closed}},orderBy:{changedAt:{direction:desc,priority:0}},limit:6){id title status}}`,
    { ref: who }, { keep: true });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <Unavailable what={kind === 'agent' ? 'agent' : 'person'} />;
  const rows = read.data.rows;
  const said = rows.length === 6 ? 'At least six open tickets' : count(rows.length, 'open ticket');
  if (form === 'compact') return <p className="board-brief">{rows.length ? said : 'No open tickets'}</p>;
  return rows.length ? (
    <>
      <Note>{said}.</Note>
      <Rows>{rows.map((t) => <Row key={t.id} place={{ brick: 'ticket', params: { ticket: t.id } }} title={t.title} meta={<span className="font-mono">{t.id}</span>} />)}</Rows>
    </>
  ) : <Note>No open tickets.</Note>;
}
