/** A window authorizes its own saved filing, never impersonates its body.
 * The immutable Caller is passed unchanged to Clock's existing recovery role.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, mayAct, mayCreate, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { localOwner } from '../approvals/role.js';
import { filedLocal } from './local-filing.js';
import { saveLocalReceipt } from './local-receipt.js';
import { clockLocalRecovery, clockLocalStanding } from './role.js';

export function installLocalWindow(operations: Operations, sharing: () => Sharing) {
  const input = z.object({
    approval: z.string().regex(/^a-[0-9a-f]{8}$/),
    mode: z.enum(['in','at']), when: z.string().min(1).max(100_000), standing: z.boolean().optional(),
  }).strict();
  const permitted = (viewer: Viewer, i: z.infer<typeof input>) => {
    const filing = filedLocal(operations.db, i.approval), s = sharing();
    if (!filing || viewer.kind !== 'member' || filing.caller.member !== viewer.id || !localOwner(filing.caller, s)) return false;
    const {agent} = filing.caller.who, {project, member} = filing.caller;
    const scope = {agent, project, member}, publicScope = {agent, project};
    const clock = {kind:'service' as const,id:'clock'}, body = {kind:'agent' as const,id:agent};
    return mayCreate(viewer, {type:'wake',...scope}, s) && mayAct(viewer, scope, s, 'give-work')
      && mayCreate(body, {type:'wake',...publicScope}, s) && mayCreate(body, {type:'approval',...publicScope}, s)
      && mayAct(clock, {type:'clock'}, s, 'act', i.standing ? 'clock.localStandingSchedule' : 'clock.localSchedule')
      && mayAct(clock, {type:'approval',...publicScope}, s, 'act', i.standing ? 'approvals.piece-standing-local' : 'approvals.piece-use-local');
  };
  operations.register(operation({
    name:'clock.scheduleLocalFromWindow', input, output:z.object({id:z.string(),due:z.number()}),
    write:true, windowOnly:true, doors:['socket'], recheckPolicy:true, may:permitted,
    run(ctx,i) {
      const filing = filedLocal(operations.db,i.approval)!;
      const role = i.standing ? clockLocalStanding(operations) : clockLocalRecovery(operations);
      const {standing:_,...timing} = i;
      const result = role.schedule(filing.caller,timing,randomUUID());
      if (!result.ok) throw new OperationError(result.code,result.message);
      const {id,due} = result.value as {id:string;due:number};
      saveLocalReceipt(ctx,{id,due});
      return {id,due};
    },
  }));
}
