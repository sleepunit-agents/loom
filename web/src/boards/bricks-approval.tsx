/** The `approval` brick: one approval request, READ-ONLY. It is read with the selection the desktop's card in a
 * conversation uses (web/src/data/work-query.ts, inlineApprovalQuery) and said in the desktop's words
 * (pieces/approval-view/model.ts).
 *
 * It has no control that answers, on purpose. Allowing a request lets an agent act, and the desktop's card
 * (pieces/approval-view, composed in web/src/data/work-views.tsx) answers behind safeguards this page does not
 * have: only a member loom says may answer is offered the buttons; a household change is shown as the program
 * reads it now and allowed only with that reading's version; a dangerous action takes a second yes; a refusal is
 * said in the program's own words. Until those are shared with this page as one piece of code, the answer stays
 * there. Nothing in this file calls an operation. */
import { useDataQuery } from '../data/graphql';
import { inlineApprovalQuery, type ApprovalsResult } from '../data/work-query';
import { approvalTitle, kindWord, quotedDecision } from '../pieces/approval-view/model';
import { displayName } from '../kit/words';
import { Chip, Loading, Unavailable, words, type Params } from './bricks';
import type { Form } from './layout';

/** The question is said under the title only when it says more than the title, as on the desktop. */
const same = (text: string) => text.trim().replace(/[?.!\s]+$/, '').toLowerCase();

export function Approval({ params, form }: { params: Params; form: Form }) {
  const id = words(params.approval);
  const read = useDataQuery<Pick<ApprovalsResult, 'approvals' | 'approvalRecord'>>(inlineApprovalQuery, { id }, { keep: true });
  const a = read.data?.approvals.find((row) => row.id === id);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !a) return <Unavailable what="approval" />;
  // A household change's stored words are the program's own record of it. The desktop shows an owner the change as
  // the program reads it now, and shows nothing stored without that reading. This page has no such reading, so it
  // shows the title, the reason and the state.
  const household = a.operation === 'household.change';
  const title = approvalTitle(a), kind = kindWord[a.kind] ?? a.kind;
  if (form === 'compact') return <p className="board-brief"><span className="board-state">{a.state}</span> {title}</p>;
  const decision = (read.data?.approvalRecord ?? []).filter((r) => r.approval === a.id && (r.event === 'allow' || r.event === 'deny')).sort((x, y) => x.seq - y.seq).at(-1);
  return (
    <>
      <p className="board-lead">{title}</p>
      {!household && a.ask && same(a.ask) !== same(a.what) && <p>{a.ask}</p>}
      <div className="board-line">
        <span className="board-state">{a.state}</span>
        <span>{kind}</span>
        {!household && <Chip place={{ brick: 'agent', params: { agent: a.agent } }}>{a.agent}</Chip>}
        {!household && a.project && <Chip place={{ brick: 'project', params: { project: a.project } }}>{a.project}</Chip>}
        {!household && a.member && <span className="text-muted-foreground">for {displayName(a.member)}</span>}
      </div>
      <dl style={{ marginTop: '.8rem' }}>
        <div><dt>Why</dt><dd>{a.why}</dd></div>
        {!household && <div><dt>If you allow</dt><dd>{a.ifYes}</dd></div>}
        {!household && <div><dt>If you deny</dt><dd>{a.ifNo}</dd></div>}
        {!household && a.changeSummary && <div><dt>Exactly what will change</dt><dd>{a.changeSummary}</dd></div>}
        {!household && <div><dt>Exactly what this allows</dt><dd>{kind}: {a.target}</dd></div>}
        {!household && a.details && <div><dt>Details</dt><dd><pre className="board-tail">{a.details}</pre></dd></div>}
        {!household && a.decidedBy && <div><dt>Answer</dt><dd>{quotedDecision(decision) ?? `Answered by ${displayName(a.decidedBy)}`}</dd></div>}
      </dl>
      {a.state === 'pending' && <p className="board-line text-muted-foreground">It is answered in Approvals on the desktop, not here.</p>}
    </>
  );
}
