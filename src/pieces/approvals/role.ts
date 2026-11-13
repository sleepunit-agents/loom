import { maySee, type Db, type Sharing, type Operations, type Viewer } from '../../core/index.js';
import { approvalScope, stateOf, type Caller } from './model.js';
import { readApproval } from './store.js';
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
    call(verb: 'request'|'use'|'withdraw'|'rule'|'tell', caller: Caller, input: Record<string,unknown>, id?: string) {
      return operations.call('direct',viewer,`approvals.piece-${verb}`,{...input,caller},id);
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
      if (!approval || !maySee(viewer, approvalScope(approval), sharing())) return;
      return { state: stateOf(approval, now()), kind: approval.kind, target: approval.target };
    },
  };
}

/** Owning target grammar and synchronous application contract for consumers. */
export { vouchOf } from './targets.js';
export type { ApprovalApplication } from './apply.js';
