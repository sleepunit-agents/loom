import type { Operations, Viewer } from '../../core/index.js';
import type { Caller } from './model.js';
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
