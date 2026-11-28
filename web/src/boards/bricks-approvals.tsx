/** The `approvals` brick: the approvals the member may read, as the desktop's Approvals lists them, in one of its
 * four folders: the requests still waiting, the ones answered, the standing rules and the reported steps.
 *
 * Each state reads only what it draws, with the desktop's own fields (web/src/data/work-query.ts) and its own
 * composition of them (approvalSnapshot): `pending` and `answered` the requests and their record; `rules` the
 * standing rules, and of the requests only their ids and states (for the count of pending the brick flags itself
 * by); `notices` the steps agents reported and, because the desktop's Reported steps also lists answers quoted from a
 * conversation and steps reported on a request, the requests and their record too. The rows are chosen, ordered and
 * said where the desktop does it (pieces/approval-view/model.ts and answering.ts): a household change is said by its
 * plain title and its reason, never by the words stored with it. Nothing here answers or changes anything: each
 * request's chip places the `approval` brick, which answers it, and a standing rule is changed by asking the agent. */
import { useDataQuery } from '../data/graphql';
import { approvalFields, approvalSnapshot, recordFields, type ApprovalsResult } from '../data/work-query';
import { approvalReading } from '../pieces/approval-view/answering';
import { kindChoice, kindWord, rows, ruleKey, scopeWord, tierWord, type Approval as Row, type ApprovalSnapshot } from '../pieces/approval-view/model';
import { displayName } from '../kit/words';
import { Chip, count, Fact, Facts, Few, Lead, Loading, More, Note, Row as Line, Rows, State, Time, Unavailable, useOwnFlag, type Params, type Raise, type Tone } from './brick-kit';
import type { Form } from './layout';

const name = (id: string) => displayName(id);
const few = 4;
/** At most this many reported steps are drawn in the big form, newest first; the rest are counted. */
const mostSteps = 50;
const tone = (state: string): Tone => (state === 'pending' ? 'waiting' : state === 'allowed' || state === 'used' ? 'good' : state === 'denied' ? 'bad' : 'muted');
const tierTone = (tier: string): Tone => (tier === 'ask' ? 'waiting' : tier === 'do' ? 'good' : 'neutral');

type State = 'pending' | 'answered' | 'rules' | 'notices';
const ruleFields = 'kind scope person tier setBy setAt';
const noticeFields = 'id agent kind target what at';
/** What each state reads. A state that does not draw the rules or the steps does not ask for them. */
export const approvalsQueries: Record<State, string> = {
  pending: `query BrickApprovals { approvals { ${approvalFields} } approvalRecord { ${recordFields} } }`,
  answered: `query BrickApprovals { approvals { ${approvalFields} } approvalRecord { ${recordFields} } }`,
  rules: `query BrickApprovalRules { approvals { id state } approvalRules { ${ruleFields} } }`,
  notices: `query BrickApprovalNotices { approvals { ${approvalFields} } approvalNotices { ${noticeFields} } approvalRecord { ${recordFields} } }`,
};
const stateOf = (v: unknown): State => (v === 'answered' || v === 'rules' || v === 'notices' ? v : 'pending');

export function Approvals({ params, form, raise }: { params: Params; form: Form; raise: Raise }) {
  const state = stateOf(params.state);
  const read = useDataQuery<Partial<ApprovalsResult>>(approvalsQueries[state], undefined, { keep: true });
  // What a state did not ask for is empty, so the desktop's composition reads as it always has.
  const data = read.status === 'live' && read.data ? { approvals: [], approvalRules: [], approvalNotices: [], approvalRecord: [], ...read.data } as ApprovalsResult : undefined;
  const snapshot = approvalSnapshot({ status: read.status, data }, '');
  const live = snapshot.status === 'live';
  const pending = live ? snapshot.approvals.filter((a) => a.state === 'pending').length : undefined;
  useOwnFlag(pending, raise, (was, n) => (n > was ? 'New approval' : null));
  if (snapshot.status === 'loading') return <Loading />;
  if (!live || pending === undefined) return <Unavailable what="list of approvals" />;
  if (state === 'rules') return <StandingRules snapshot={snapshot} pending={pending} form={form} />;
  if (state === 'notices') return <ReportedSteps snapshot={snapshot} pending={pending} form={form} />;
  const answered = state === 'answered';
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

/** The standing rules, as the desktop's Rules folder lists them: for what (a scope), which kind of request, for whom,
 * and the answer (ask, tell after, just do it). Read only. */
function StandingRules({ snapshot, pending, form }: { snapshot: ApprovalSnapshot; pending: number; form: Form }) {
  const rules = snapshot.rules;
  if (form === 'compact') return <p className="board-brief">{count(rules.length, 'standing rule')} · {pending} pending</p>;
  const meta = (r: ApprovalSnapshot['rules'][number]) => `${kindChoice[r.kind] ?? r.kind}${r.person ? ` · for ${name(r.person)}` : ''}`;
  const line = (r: ApprovalSnapshot['rules'][number], full: boolean) => (
    <Line key={ruleKey(r)} title={scopeWord(r.scope)} meta={full ? <>{meta(r)} · set by {name(r.setBy)} <Time at={r.setAt} /></> : meta(r)}
      end={<State tone={tierTone(r.tier)}>{tierWord[r.tier] ?? r.tier}</State>} />
  );
  return (
    <>
      <Lead>{count(rules.length, 'standing rule')}</Lead>
      {!rules.length ? <Note>No standing rules.</Note>
        : form === 'side' ? <Few of={rules} first={few}>{(some, hidden) => <><Rows label="Standing rules" beside>{some.map((r) => line(r, false))}</Rows><More n={hidden} /></>}</Few>
          : <Rows label="Standing rules" beside>{rules.map((r) => line(r, true))}</Rows>}
      {form === 'primary' && <Note>A standing rule is made, changed or removed by asking the agent.</Note>}
    </>
  );
}

/** The reported steps, as the desktop's Reported steps lists them, newest first: what an agent did under a "tell me
 * after" rule, a step reported on a request, and an answer given in a conversation. */
function ReportedSteps({ snapshot, pending, form }: { snapshot: ApprovalSnapshot; pending: number; form: Form }) {
  const steps = [...snapshot.notices].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  if (form === 'compact') return <p className="board-brief">{count(steps.length, 'reported step')} · {pending} pending</p>;
  const meta = (n: ApprovalSnapshot['notices'][number]) => [name(n.agent), kindWord[n.kind as Row['kind']] ?? n.kind, n.target].filter(Boolean).join(' · ');
  const line = (n: ApprovalSnapshot['notices'][number]) => <Line key={n.id} title={n.what} meta={meta(n)} end={<Time at={n.at} />} />;
  return (
    <>
      <Lead>{count(steps.length, 'reported step')}</Lead>
      {!steps.length ? <Note>No reported steps.</Note>
        : form === 'side' ? <Few of={steps} first={few}>{(some, hidden) => <><Rows label="Reported steps" beside>{some.map(line)}</Rows><More n={hidden} /></>}</Few>
          : <><Rows label="Reported steps" beside>{steps.slice(0, mostSteps).map(line)}</Rows>{steps.length > mostSteps && <Note>and {steps.length - mostSteps} earlier, not shown here</Note>}</>}
    </>
  );
}
