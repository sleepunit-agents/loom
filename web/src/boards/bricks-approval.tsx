/** The `approval` brick: one approval request, read and answered as the desktop reads and answers it.
 *
 * Nothing about the answer is decided in this file. The request is read with the selection the desktop's card in a
 * conversation uses (web/src/data/work-query.ts, inlineApprovalQuery). Who may answer, the commands an answer
 * sends and the owner's reading of a household change come from the desktop's own composition
 * (web/src/data/work-approvals.ts). What is said before an answer, the reviewed version an Allow names, the second
 * yes a dangerous action takes, the reason for denying and the words of a refused answer come from the desktop's
 * own logic (web/src/pieces/approval-view/answering.ts). This file is the markup.
 *
 * The compact form is one line and answers nothing: it reads the request and nothing else. The desktop's standing
 * answer for a merge ("Always for <project>") is offered under the desktop's own rule for it (useStandingAnswer in
 * web/src/data/work-approvals.ts) and, being a standing permission, only as a question first: the press asks, and
 * a second press sends `approvals.always` (the two steps are the shared hook's, with askStanding).
 *
 * The board is told that the member allowed, denied or gave the standing answer, after loom took it, and nothing
 * more: a reason typed here goes to `approvals.answer` and never to `boards.act`. */
import { useDataQuery } from '../data/graphql';
import { inlineApprovalQuery, type ApprovalsResult } from '../data/work-query';
import { ownerApprovalActions, useProposalNow, useStandingAnswer, useViewer, useWorkAccess } from '../data/work-approvals';
import { answerKey, approvalReading, cautionWords, forWhom, reasonLimit, secondYesWords, standingWords, useAnswering, type ApprovalActions, type ChangeRow, type ChangeWords } from '../pieces/approval-view/answering';
import { approvalTitle, recordWord, type Approval as Row, type ApprovalSnapshot } from '../pieces/approval-view/model';
import { tempoChangeWords } from '../pieces/tempo/change';
import { measuringChangeWords } from '../pieces/measuring/change';
import { displayName } from '../kit/words';
import { Action, Actions, Chip, Fact, Facts, Lead, Loading, Note, Problem, Row as Line, Rows, Section, State, Time, Unavailable, words, type Act, type Params, type Tone } from './brick-kit';
import type { Form } from './layout';

const name = (id: string) => displayName(id);
/** A change the program can check, as the desktop's card draws it: the same list, in the same order
 * (web/src/data/work-views.tsx, renderChange). */
const changeWords = (a: Row): ChangeWords | null => (a.operation === 'household.change' ? null : tempoChangeWords(a) ?? measuringChangeWords(a));
const Values = ({ rows }: { rows: readonly ChangeRow[] }) => <Facts>{rows.map((row) => <Fact key={row.label} label={row.label}>{row.value}</Fact>)}</Facts>;
/** An approval's own state words, as tones: it waits on an answer, it was allowed, it was refused, or it is over. */
export const approvalTone = (state: string): Tone => (state === 'pending' ? 'waiting' : state === 'allowed' || state === 'used' ? 'good' : state === 'denied' ? 'bad' : 'muted');

/** Allow and Deny, drawn from the shared steps. Keyed by the reading it answers (answerKey): a request read again
 * in a new version starts over. */
function Answer({ approval, actions }: { approval: Row; actions?: ApprovalActions }) {
  const answer = useAnswering(approval, actions, { askStanding: true }), busy = answer.busy;
  const caution = cautionWords(approval), always = answer.always;
  return (
    <>
      {!answer.allowed && caution && <p role="note" className="board-approval-caution">{caution}</p>}
      {answer.open && (
        <div className="board-form">
          {answer.confirming && <p className="board-approval-caution">{secondYesWords}</p>}
          <Actions label="Answer approval">
            {answer.confirming
              ? <>
                  <Action kind="primary" disabled={busy} onClick={answer.confirm}>Yes, allow it</Action>
                  <Action kind="quiet" disabled={busy} onClick={answer.cancel}>Cancel</Action>
                </>
              : <Action kind="primary" disabled={busy} onClick={answer.allow}>Allow</Action>}
            {always && !always.asking && <Action disabled={busy} onClick={always.ask}>{always.label}…</Action>}
            <Action disabled={busy} onClick={answer.deny}>Deny</Action>
          </Actions>
          {always?.asking && (
            <div className="board-confirm" role="group" aria-label="Standing answer">
              <p>{always.label}? {standingWords}</p>
              <Action kind="primary" disabled={busy} onClick={always.run}>Yes, always allow</Action>
              <Action kind="quiet" disabled={busy} onClick={always.cancel}>Cancel</Action>
            </div>
          )}
          <details className="board-approval-reason">
            <summary>Add a reason for denying</summary>
            <textarea className="board-input" aria-label="Reason for the requesting agent" value={answer.reason} maxLength={reasonLimit} disabled={busy} onChange={(e) => answer.setReason(e.target.value)} />
          </details>
        </div>
      )}
      {busy && <p role="status" className="board-note">Saving answer…</p>}
      <Problem>{answer.error}</Problem>
    </>
  );
}

/** The primary and side forms. Only these ask loom whether the member may answer. */
function Card({ stored, record, form, act }: { stored: Row; record: ApprovalSnapshot['record']; form: Form; act: Act }) {
  const access = useWorkAccess(), owner = access.owner, viewer = useViewer();
  // For an owner, a household change is read as it stands now, and read again when the window is looked at, every
  // minute, and after a refused Allow. The row drawn below is the one that reading produced, version and all.
  const { snapshot, refresh } = useProposalNow({ status: 'live', approvals: [stored], rules: [], notices: [], record, timezone: '' }, stored.id, owner);
  const a = snapshot.approvals[0];
  const commands = ownerApprovalActions(owner, useStandingAnswer(a, access));
  const standing = commands?.always;
  const actions: ApprovalActions | undefined = commands && {
    refreshProposal: refresh,
    ...(standing ? { always: { ...standing, run: async (id: string) => { await standing.run(id); act('always', {}); } } } : {}),
    allow: async (...sent) => { await commands.allow(...sent); act('approve', {}); },
    deny: async (...sent) => { await commands.deny(...sent); act('refuse', {}); },
  };
  const change = changeWords(a);
  const r = approvalReading(a, record, name, { change: !!change });
  const whom = forWhom(a, viewer, name);
  const facts = (
    <>
      <Facts>
        <Fact label="Why">{a.why}</Fact>
        {r.card?.facts.map((fact, index) => <Fact key={index} label={fact.label}><span className={fact.small ? 'font-mono' : undefined}>{fact.value}</span></Fact>)}
        {r.showStored && <Fact label="If you allow">{r.ifYes}</Fact>}
        {r.showStored && <Fact label="If you deny">{r.ifNo}</Fact>}
        {r.storedSummary && <Fact wide label="Exactly what will change">{r.storedSummary}</Fact>}
        {r.allows && <Fact wide label="Exactly what this allows">{r.allows}</Fact>}
        {r.fullCommand && <Fact wide label="Full command"><pre className="board-tail">{r.fullCommand}</pre></Fact>}
        {r.details && <Fact wide label="Details"><pre className="board-tail">{r.details}</pre></Fact>}
        {r.exact && <Fact wide label="Exact request"><pre className="board-tail">{r.exact}</pre></Fact>}
      </Facts>
      {change && (
        <section className="board-approval-change" aria-label={change.label}>
          <p className="board-approval-ask">{change.heading}</p>
          <Section title="Before"><Values rows={change.before} /></Section>
          <Section title="After"><Values rows={change.after} /></Section>
          <Note>{change.note}</Note>
        </section>
      )}
    </>
  );
  const answer = <Answer key={answerKey(a)} approval={a} actions={actions} />;
  return (
    <>
      <Lead>{r.title}</Lead>
      {r.ask && <p className="board-approval-ask">{r.ask}</p>}
      <div className="board-meta">
        <State tone={approvalTone(a.state)}>{a.state}</State>
        <span>{r.kind}</span>
        {r.showStored && <Chip place={{ brick: 'agent', params: { agent: a.agent } }}>{a.agent}</Chip>}
        {r.showStored && a.project && <Chip place={{ brick: 'project', params: { project: a.project } }}>{a.project}</Chip>}
        {r.showStored && whom && <span>{whom}</span>}
      </div>
      {/* Everything it is weighed by comes before the answer, in every form. */}
      {facts}
      {answer}
      {r.showStored && (r.answered || a.expiresAt) && (
        <Facts>
          {r.answered && <Fact label="Answer">{r.answered}</Fact>}
          {a.expiresAt && <Fact label="Allowance ends"><Time at={a.expiresAt} /></Fact>}
        </Facts>
      )}
      {form === 'primary' && r.showStored && r.record.length > 0 && (
        <Section title="History">
          <Rows>{r.record.map((row) => <Line key={row.seq} title={recordWord(row, name)} end={<Time at={row.at} />} />)}</Rows>
        </Section>
      )}
    </>
  );
}

export function Approval({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const id = words(params.approval);
  const read = useDataQuery<Pick<ApprovalsResult, 'approvals' | 'approvalRecord'>>(inlineApprovalQuery, { id }, { keep: true });
  const a = read.data?.approvals.find((row) => row.id === id);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !a) return <Unavailable what="approval" />;
  if (form === 'compact') return <p className="board-brief"><State tone={approvalTone(a.state)}>{a.state}</State> {approvalTitle(a)}</p>;
  return <Card key={id} stored={a} record={read.data?.approvalRecord ?? []} form={form} act={act} />;
}
