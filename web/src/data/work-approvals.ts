/** The approval answer's composition, with no component: who may answer, the commands an answer sends, and the
 * owner's reading of a household change as it stands now. The desktop's Approvals and its cards
 * (./work-views.tsx) and the board's `approval` brick (web/src/boards/bricks-approval.tsx) bind the same three, so
 * neither can offer an answer the other would not. */
import { useEffect, useState } from 'react';
import type { ApprovalActions } from '../pieces/approval-view/answering';
import type { ApprovalSnapshot } from '../pieces/approval-view/model';
import { useDataQuery } from './graphql';
import { alwaysInput, alwaysLabel, sendWorkAlways, type CurrentChange, type MergeRequest, type WorkAlwaysInput, type RulePerson } from './work-always';
import { sendWorkAnswer } from './work-answer';
import { readProposal, type ProposalNow } from './work-proposal';

const ownerQuery = 'query WorkAnswerOwner { workAnswerOwner workChangesRefresh members { id role } }';
/** Whether loom says this member may answer (workAnswerOwner). Anything but a live yes is a no. */
export function useWorkAccess() {
  const snapshot = useDataQuery<{workAnswerOwner:boolean;workChangesRefresh:boolean;members:RulePerson[]}>(ownerQuery);
  return {owner:snapshot.status === 'live' && snapshot.data?.workAnswerOwner === true,
    refresh:snapshot.status === 'live' && snapshot.data?.workChangesRefresh === true,
    members:snapshot.status === 'live' && snapshot.data?.workAnswerOwner === true ? snapshot.data?.members ?? [] : []};
}
/** The commands, for a member who may answer and for nobody else. */
export function ownerApprovalActions(owner: boolean, standing?:WorkAlwaysInput): ApprovalActions | undefined {
  return owner ? {...(standing?{always:{approval:standing.approval,label:alwaysLabel(standing),run:async(id:string)=>{if(id!==standing.approval)throw Error('Approval changed');await sendWorkAlways(standing);}}}:{}),allow:(id,confirm,review)=>sendWorkAnswer({piece:'approvals',id,answer:'allow',...(review?{review}:{}),...(confirm?{confirm:true as const}:{})}),deny:(id,reason)=>sendWorkAnswer({piece:'approvals',id,answer:'deny',reason})} : undefined;
}
const approvalChangeQuery = `query ApprovalChange($id: String!, $head: String!) {
  changes(where: {id: {eq: $id}, headCommit: {eq: $head}}, limit: 1) { id state agent project headCommit }
}`;
/** The standing answer ("Always for <project>") for the open request, or none. It is offered to a member who may
 * answer, for a waiting merge request of an agent's own, whose pull request loom reads as still open at the very
 * commit the request names, in the request's project, for a person of the household (./work-always.ts, alwaysInput).
 * The server binds every field again (approvals.always). */
export function useStandingAnswer(card: MergeRequest | undefined, access: { owner: boolean; members: readonly RulePerson[] }): WorkAlwaysInput | undefined {
  const target = access.owner && card?.kind === 'merge' && card.state === 'pending' && card.operation === null
    ? /^(.+)@([a-f0-9]{40})$/u.exec(card.target) : null;
  const change = useDataQuery<{changes:CurrentChange[]}>(
    approvalChangeQuery, {id: target?.[1] ?? '', head: target?.[2] ?? ''}, {pause: !target});
  return alwaysInput(card, target && change.status === 'live' ? change.data?.changes ?? [] : [], access.members);
}

/** Read the owner preview for the open card and discard results when it closes or changes. */
export function useProposalNow(snapshot: ApprovalSnapshot, id: string | undefined, owner: boolean, blockerOnly = false) {
  const row = owner && snapshot.status === 'live' ? snapshot.approvals.find(row =>
    row.id === id && row.operation === 'household.change') : undefined;
  const opened = row?.id, state = row?.state;
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<{ id: string; state: typeof state; value: ProposalNow }>();
  useEffect(() => {
    if (!opened) {setPreview(undefined);return;}
    let current = true;
    void readProposal(opened).then(value => { if (current) setPreview(value ? { id: opened, state, value } : undefined); });
    return () => { current = false; };
  }, [opened, revision, state]);
  useEffect(() => {
    if (!opened || typeof window === 'undefined') return;
    const refresh = () => setRevision(value => value + 1);
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
      window.clearInterval(interval);
    };
  }, [opened]);
  const held = preview?.id === opened && preview?.state === state ? preview?.value : undefined;
  const refresh = (id: string) => { if (id === opened) setRevision(value => value + 1); };
  return { snapshot: held ? { ...snapshot, approvals: snapshot.approvals.map(row => row.id === opened
    ? { ...row, blocked: held.blocked, ...(!blockerOnly && {card: held.card, review: held.review, exactRequest: held.exact}) } : row) } : snapshot, refresh };
}

/** The signed-in member's id, from the same small reading Comms makes of who is at the desk. It only decides
 * whether a private request says "for you" or the person's name. */
const viewerQuery = 'query WorkViewer { homeComms { member } }';
export function useViewer(): string | undefined {
  const reading = useDataQuery<{ homeComms: { member: string } | null }>(viewerQuery);
  return reading.status === 'live' ? reading.data?.homeComms?.member ?? undefined : undefined;
}
