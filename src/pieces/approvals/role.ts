import { maySee, mayAct, type Db, type Sharing, type Operations, type Viewer } from '../../core/index.js';
import { approvalScope, stateOf, type Caller } from './model.js';
import { load, readApproval } from './store.js';
/** Owner UI composition keeps the authenticated viewer; no body Caller is minted. */
export function ownerApprovalsRole(operations: Operations) {
  return {
    rule: (viewer: Viewer, agent: string, target: string) => operations.call('direct', viewer, 'approvals.rule', {kind:'merge', for:agent, targets:[target]}),
    grant: (viewer: Viewer, input: {agent:string; target:string; deny:boolean; person?:string}, id:string) => operations.call('direct', viewer, 'approvals.grant', {kind:'merge', for:input.agent, target:input.target, deny:input.deny, ...(input.person ? {person:input.person} : {})}, id),
    projectRule: (viewer: Viewer, project:string, id:string) => operations.call('direct', viewer, 'approvals.set-rule', {kind:'merge',scope:`project:${project}`,tier:'do'}, id),
  };
}
/** Services receive only these direct operations in central Sharing. A body cannot supply a caller override. */
export function approvalsRole(operations: Operations, service: string) {
  const viewer: Viewer = {kind:'service',id:service};
  return {
    /** Clock passes an authenticated Caller and its immutable private filing.
     * Check never consumes; use participates in the caller's foundation transaction.
     */
    localStanding(caller: Caller, input: Omit<import('./local-standing.js').LocalStandingInput,'caller'>, id: string) {
      return operations.call('direct',viewer,input.mode==='check'?'approvals.piece-standing-local-check':'approvals.piece-standing-local',{...input,caller},id);
    },
    call(verb: 'request'|'use'|'use-local'|'withdraw'|'rule'|'tell', caller: Caller, input: Record<string,unknown>, id?: string) {
      return operations.call('direct',viewer,`approvals.piece-${verb}`,{...input,caller},id);
    },
    groupVouch(caller: Caller, candidates: unknown, id: string) {
      return operations.call('direct',viewer,'approvals.piece-group-vouch',{caller,candidates},id);
    },
    standing(caller: Caller, input: Record<string,unknown>, id: string) {
      return operations.call('direct',viewer,'approvals.standing',{...input,caller},id);
    },
  };
}

/** Read-only answer seam. It retains the original viewer and never spends a receipt. */
export function approvalAnswers(db: Db, sharing: () => Sharing, now: () => number) {
  return {
    check(id: string, viewer: Viewer) {
      const approval = readApproval(db, id);
      if (!approval) return;
      const scope = approvalScope(approval), access = sharing();
      if (!maySee(viewer, scope, access) || viewer.kind === 'service' && !mayAct(viewer, scope, access, 'act', 'approvals.check')) return;
      return { state: stateOf(approval, now()), kind: approval.kind, target: approval.target };
    },
  };
}

/** Owning target grammar and synchronous application contract for consumers. */
export { vouchOf } from './targets.js';
export { isApplyingOwnerAnswer } from './apply.js';
export type { ApprovalApplication } from './apply.js';

export { vouchDetails, type VouchWords } from './vouch-details.js';

/** Trusted consumer validation and provenance contract. */
export { callerSchema } from './validation.js';
export type { Caller } from './model.js';

export { serviceOf } from './model.js';

export { localOwner, sameLocalCaller } from './local-authority.js';
/** Trusted owning application seam. Returns original cards before request can
 * enrich them, so a consumer can bind its durable snapshot to the exact card.
 * This is not a registry read and confers no transport access.
 */
export function owningApprovalCards(db: Db, kind: string, target: string, agent: string) {
  return load(db).approvals.filter(a => a.kind === kind && a.target === target && a.who.agent === agent).map(a => structuredClone(a));
}
export type { Approval } from './model.js';
