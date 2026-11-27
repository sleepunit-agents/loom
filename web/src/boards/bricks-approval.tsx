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
import { fullTime } from '../kit/time';
import { Chip, Loading, Unavailable, words, type Act, type Params } from './brick-kit';
import type { Form } from './layout';

const name = (id: string) => displayName(id);
/** A change the program can check, as the desktop's card draws it: the same list, in the same order
 * (web/src/data/work-views.tsx, renderChange). */
const changeWords = (a: Row): ChangeWords | null => (a.operation === 'household.change' ? null : tempoChangeWords(a) ?? measuringChangeWords(a));
const Values = ({ rows }: { rows: readonly ChangeRow[] }) => <dl>{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;

/** Allow and Deny, drawn from the shared steps. Keyed by the reading it answers (answerKey): a request read again
 * in a new version starts over. */
function Answer({ approval, actions }: { approval: Row; actions?: ApprovalActions }) {
  const answer = useAnswering(approval, actions, { askStanding: true }), busy = answer.busy;
  const caution = cautionWords(approval), always = answer.always;
  return (
    <>
      {!answer.allowed && caution && <p role="note" className="board-line">{caution}</p>}
      {answer.open && (
        <>
          <details className="board-line">
            <summary>Add a reason for denying</summary>
            <textarea className="board-input" aria-label="Reason for the requesting agent" value={answer.reason} maxLength={reasonLimit} disabled={busy} onChange={(e) => answer.setReason(e.target.value)} />
          </details>
          {answer.confirming && <p className="board-line">{secondYesWords}</p>}
          <div className="board-line" role="group" aria-label="Answer approval">
            {answer.confirming
              ? <>
                  <button type="button" className="board-action" disabled={busy} onClick={answer.confirm}>Yes, allow it</button>
                  <button type="button" className="board-action" disabled={busy} onClick={answer.cancel}>Cancel</button>
                </>
              : <button type="button" className="board-action" disabled={busy} onClick={answer.allow}>Allow</button>}
            {always && !always.asking && <button type="button" className="board-action" disabled={busy} onClick={always.ask}>{always.label}…</button>}
            <button type="button" className="board-action" disabled={busy} onClick={answer.deny}>Deny</button>
          </div>
          {always?.asking && (
            <div className="board-line" role="group" aria-label="Standing answer">
              <p>{always.label}? {standingWords}</p>
              <button type="button" className="board-action" disabled={busy} onClick={always.run}>Yes, always allow</button>
              <button type="button" className="board-action" disabled={busy} onClick={always.cancel}>Cancel</button>
            </div>
          )}
        </>
      )}
      {busy && <p role="status" className="text-muted-foreground">Saving answer…</p>}
      {answer.error && <p role="alert" className="text-destructive">{answer.error}</p>}
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
  return (
    <>
      <p className="board-lead">{r.title}</p>
      {r.ask && <p>{r.ask}</p>}
      <div className="board-line">
        <span className="board-state">{a.state}</span>
        <span>{r.kind}</span>
        {r.showStored && <Chip place={{ brick: 'agent', params: { agent: a.agent } }}>{a.agent}</Chip>}
        {r.showStored && a.project && <Chip place={{ brick: 'project', params: { project: a.project } }}>{a.project}</Chip>}
        {r.showStored && whom && <span className="text-muted-foreground">{whom}</span>}
      </div>
      <dl style={{ marginTop: '.8rem' }}>
        <div><dt>Why</dt><dd>{a.why}</dd></div>
        {r.card?.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd className={fact.small ? 'font-mono' : undefined}>{fact.value}</dd></div>)}
        {r.showStored && <div><dt>If you allow</dt><dd>{r.ifYes}</dd></div>}
        {r.showStored && <div><dt>If you deny</dt><dd>{r.ifNo}</dd></div>}
        {r.storedSummary && <div><dt>Exactly what will change</dt><dd>{r.storedSummary}</dd></div>}
        {r.allows && <div><dt>Exactly what this allows</dt><dd>{r.allows}</dd></div>}
        {r.fullCommand && <div><dt>Full command</dt><dd><pre className="board-tail">{r.fullCommand}</pre></dd></div>}
        {r.details && <div><dt>Details</dt><dd><pre className="board-tail">{r.details}</pre></dd></div>}
        {r.exact && <div><dt>Exact request</dt><dd><pre className="board-tail">{r.exact}</pre></dd></div>}
      </dl>
      {change && (
        <section aria-label={change.label}>
          <p className="board-line">{change.heading}</p>
          <p className="board-line text-muted-foreground">Before</p><Values rows={change.before} />
          <p className="board-line text-muted-foreground">After</p><Values rows={change.after} />
          <p className="board-line">{change.note}</p>
        </section>
      )}
      <Answer key={answerKey(a)} approval={a} actions={actions} />
      {r.showStored && (r.answered || a.expiresAt) && (
        <dl style={{ marginTop: '.8rem' }}>
          {r.answered && <div><dt>Answer</dt><dd>{r.answered}</dd></div>}
          {a.expiresAt && <div><dt>Allowance ends</dt><dd>{fullTime(a.expiresAt)}</dd></div>}
        </dl>
      )}
      {form === 'primary' && r.showStored && r.record.length > 0 && (
        <dl style={{ marginTop: '.8rem' }}>
          <div><dt>History</dt><dd>{r.record.map((row) => <span key={row.seq} className="block">{recordWord(row, name)} · {fullTime(row.at)}</span>)}</dd></div>
        </dl>
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
  if (form === 'compact') return <p className="board-brief"><span className="board-state">{a.state}</span> {approvalTitle(a)}</p>;
  return <Card key={id} stored={a} record={read.data?.approvalRecord ?? []} form={form} act={act} />;
}
