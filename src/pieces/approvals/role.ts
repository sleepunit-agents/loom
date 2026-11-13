import type { Operations, Viewer } from '../../core/index.js';
import type { Caller } from './model.js';
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
