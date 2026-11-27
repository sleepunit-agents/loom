/** The `approvals` brick: the list of approval requests, as the desktop's Approvals lists them.
 *
 * It is read with the desktop's own selection (web/src/data/work-query.ts, approvalsQuery) and its rows are chosen
 * and ordered by the desktop's own rule (pieces/approval-view/model.ts, rows): those still waiting, oldest first,
 * or those no longer waiting, newest first. What is said of each request is decided where the desktop decides it
 * (pieces/approval-view/answering.ts, approvalReading): a household change is said by its plain title and its
 * reason, never by the words stored with it. Nothing here answers a request: each row's chip places the
 * `approval` brick, which does. */
import { useDataQuery } from '../data/graphql';
import { approvalSnapshot, approvalsQuery, type ApprovalsResult } from '../data/work-query';
import { approvalReading } from '../pieces/approval-view/answering';
import { rows, type Approval as Row } from '../pieces/approval-view/model';
import { displayName } from '../kit/words';
import { fullTime } from '../kit/time';
import { Chip, Loading, Unavailable, useOwnFlag, type Params, type Raise } from './brick-kit';
import type { Form } from './layout';

const name = (id: string) => displayName(id);
const few = 4;

export function Approvals({ params, form, raise }: { params: Params; form: Form; raise: Raise }) {
  const answered = params.state === 'answered';
  const read = useDataQuery<ApprovalsResult>(approvalsQuery, undefined, { keep: true });
  const snapshot = approvalSnapshot(read, '');
  const live = snapshot.status === 'live';
  const pending = live ? snapshot.approvals.filter((a) => a.state === 'pending').length : undefined;
  useOwnFlag(pending, raise, (was, count) => (count > was ? 'New approval' : null));
  if (snapshot.status === 'loading') return <Loading />;
  if (!live || pending === undefined) return <Unavailable what="list of approvals" />;
  const settled = snapshot.approvals.length - pending;
  if (form === 'compact') return <p className="board-brief">{pending} pending · {settled} answered</p>;

  const shown = rows(snapshot, answered ? 'history' : 'pending', '');
  const lead = <p className="board-lead">{answered ? `${settled} answered` : `${pending} pending`}</p>;
  const empty = <p className="text-muted-foreground">{answered ? 'No answered approvals.' : 'No approvals are waiting.'}</p>;
  const reading = (a: Row) => approvalReading(a, snapshot.record, name);
  const chip = (a: Row) => <Chip place={{ brick: 'approval', params: { approval: a.id } }}>{reading(a).title}</Chip>;
  if (form === 'side') return (
    <>
      {lead}
      {shown.slice(0, few).map((a) => <div className="board-line" key={a.id}>{chip(a)}<span className="text-muted-foreground">{name(a.agent)} · {a.state}</span></div>)}
      {shown.length > few && <p className="board-line text-muted-foreground">and {shown.length - few} more</p>}
      {!shown.length && empty}
    </>
  );
  return (
    <>
      {lead}
      {shown.length ? (
        <ol className="board-notes">
          {shown.map((a) => {
            const r = reading(a);
            return (
              <li key={a.id}>
                <div className="board-line">
                  {chip(a)}
                  <span className="board-state">{a.state}</span>
                  <span>{r.kind}</span>
                  <Chip place={{ brick: 'agent', params: { agent: a.agent } }}>{a.agent}</Chip>
                  {r.showStored && a.project && <Chip place={{ brick: 'project', params: { project: a.project } }}>{a.project}</Chip>}
                  <span className="text-muted-foreground">{fullTime(a.askedAt)}</span>
                </div>
                <dl>
                  <div><dt>Why</dt><dd>{a.why}</dd></div>
                  {r.allows && <div><dt>Allows</dt><dd>{r.allows}</dd></div>}
                  {answered && r.showStored && r.answered && <div><dt>Answer</dt><dd>{r.answered}</dd></div>}
                </dl>
              </li>
            );
          })}
        </ol>
      ) : empty}
    </>
  );
}
