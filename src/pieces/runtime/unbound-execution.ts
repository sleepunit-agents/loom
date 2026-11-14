/** Original input assertion for the opt-in unbound worker. This digest is
 * comparison data, never a bearer capability or permission to run a body. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OperationError, type Db, type Sharing } from '../../core/index.js';
import { currentExecution } from './control.js';
import { bodyPolicyExecutionHeld } from './policy-store.js';
import { meets } from './placement.js';
import { runtimeStore } from './store.js';
export const executionAssertion=z.string().regex(/^[a-f0-9]{64}$/);
export function unboundExecution(db:Db,sharing:Sharing,id:string):string {
 const store=runtimeStore(db),job=store.read('job',id),box=job&&store.read('box',job.box);
 const deny=():never=>{throw new OperationError('denied','Original unbound execution authority ended');};
 if(!job||!box||!['starting','running','waiting'].includes(job.state)||job.claimedAt===undefined||!job.made
   ||job.conversation!==undefined||job.member!==undefined||job.service!==undefined||job.model!==undefined||job.account!==undefined
   ||job.imported||job.principalReset||job.writtenOff||job.startFailed||job.endedAt!==undefined
   ||!currentExecution(store,job,sharing)||bodyPolicyExecutionHeld(db,job.agent))return deny();
 const input=db.prepare('SELECT brief,needs FROM runtime_inputs WHERE job=?').get(id) as {brief:string;needs:string}|undefined;
 if(!input)return deny();
 let needs:string[];
 try {needs=z.array(z.string().min(1).max(200)).max(32).parse(JSON.parse(input.needs));}catch{return deny();}
 if(!needs.every(need=>meets([...box.facts,...box.labels],need)))return deny();
 return createHash('sha256').update(JSON.stringify({id:job.id,agent:job.agent,project:job.project,runner:job.runner,box:job.box,
  house:job.made,claimedAt:job.claimedAt,createdAt:job.createdAt,brief:input.brief,needs,
  model:store.read('settings',job.agent)?.model})).digest('hex');
}
export function assertUnboundExecution(db:Db,sharing:Sharing,id:string,expected:string|undefined):void {
 if(expected!==undefined&&unboundExecution(db,sharing,id)!==expected)
  throw new OperationError('denied','Original unbound execution authority ended');
}
