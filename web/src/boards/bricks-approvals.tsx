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
import { Chip, Fact, Facts, Few, Lead, Loading, More, Note, Row as Line, Rows, State, Time, Unavailable, useOwnFlag, type Params, type Raise, type Tone } from './brick-kit';
import type { Form } from './layout';

const name = (id: string) => displayName(id);
const few = 4;
const tone = (state: string): Tone => (state === 'pending' ? 'waiting' : state === 'allowed' || state === 'used' ? 'good' : state === 'denied' ? 'bad' : 'muted');

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
  const lead = <Lead>{answered ? `${settled} answered` : `${pending} pending`}</Lead>;
  const empty = <Note>{answered ? 'No answered approvals.' : 'No approvals are waiting.'}</Note>;
  const reading = (a: Row) => approvalReading(a, snapshot.record, name);
  const place = (a: Row) => ({ brick: 'approval', params: { approval: a.id } });
  if (form === 'side') return (
    <>
      {lead}
      {shown.length > 0 && <Few of={shown} first={few}>{(some, hidden) => <><Rows>{some.map((a) => <Line key={a.id} place={place(a)} title={reading(a).title} meta={<>{name(a.agent)} · {a.state}</>} />)}</Rows><More n={hidden} /></>}</Few>}
      {!shown.length && empty}
    </>
  );
  return (
    <>
      {lead}
      {shown.length ? (
        <Rows>
          {shown.map((a) => {
            const r = reading(a);
            return (
              <Line key={a.id} place={place(a)} title={r.title} end={<><State tone={tone(a.state)}>{a.state}</State><Time at={a.askedAt} /></>}>
                <div className="board-meta">
                  <span>{r.kind}</span>
                  <Chip place={{ brick: 'agent', params: { agent: a.agent } }}>{a.agent}</Chip>
                  {r.showStored && a.project && <Chip place={{ brick: 'project', params: { project: a.project } }}>{a.project}</Chip>}
                </div>
                <Facts>
                  <Fact label="Why">{a.why}</Fact>
                  {r.allows && <Fact label="Allows">{r.allows}</Fact>}
                  {answered && r.showStored && r.answered && <Fact label="Answer">{r.answered}</Fact>}
                </Facts>
              </Line>
            );
          })}
        </Rows>
      ) : empty}
    </>
  );
}
