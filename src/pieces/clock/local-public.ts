/** Public writes retain the exact Signin Viewer until Runtime proves its Caller.
 * Only acknowledgements leave this boundary; saved private words stay inside
 * the owning Clock/Approvals transaction.
 */
import { saveLocalReceipt } from './local-receipt.js';
import { filedLocal } from './local-filing.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, type Operations, type Sharing, type Viewer, mayAct, mayCreate } from '../../core/index.js';
import { localOwner, sameLocalCaller, type Caller } from '../approvals/role.js';
import { clockLocalFiling, clockLocalRecovery, clockLocalStanding } from './role.js';
const text=z.string().min(1).max(100_000);
function authenticatedCaller(viewer:Viewer,agent:string,s:Sharing,resolve:((viewer:Viewer)=>Caller|undefined)|undefined) {
 const c=resolve?.(viewer);
 return viewer.kind==='agent' && viewer.id===agent && c?.who.agent===agent && localOwner(c,s)?c:undefined;
}
export function localPublicPolicy(operations:Operations,sharing:()=>Sharing,resolve:((viewer:Viewer)=>Caller|undefined)|undefined,v:Viewer,i:{agent:string;approval?:string;standing?:boolean}) {
 const s=sharing(),c=authenticatedCaller(v,i.agent,s,resolve);
 if(!c)return false;
 const service={kind:'service' as const,id:'clock'},agent={kind:'agent' as const,id:i.agent};
 const scope={agent:i.agent,project:c.project};
 const clockOp=i.approval?(i.standing?'clock.localStandingSchedule':'clock.localSchedule'):'clock.localRequest';
 const approvalOp=i.approval?(i.standing?'approvals.piece-standing-local':'approvals.piece-use-local'):'approvals.piece-request';
 if(!mayCreate(agent,{type:'wake',...scope},s)||!mayCreate(agent,{type:'approval',...scope},s)
   ||!mayAct(service,{type:'clock'},s,'act',clockOp)||!mayAct(service,{type:'approval',...scope},s,'act',approvalOp))return false;
 if(i.approval) {
  const filing=filedLocal(operations.db,i.approval);
  if(!filing||!localOwner(filing.caller,s)||!sameLocalCaller(c,filing.caller))return false;
 }
 return true;
}
export function installLocalPublic(operations:Operations,sharing:()=>Sharing,resolve?: (viewer:Viewer)=>Caller|undefined) {
  const caller=(viewer:Viewer,agent:string)=>{
    const c=authenticatedCaller(viewer,agent,sharing(),resolve);
    if(!c)
      throw new OperationError('denied','Local work requires a household owner’s authenticated conversation');
    return c;
  };
  const request=z.object({agent:text,prompt:text,note:z.string().max(100_000)}).strict();
  const recover=z.object({agent:text,approval:z.string().regex(/^a-[0-9a-f]{8}$/),when:text,mode:z.enum(['in','at']),standing:z.boolean().optional(),prompt:text.optional(),note:z.string().max(100_000).optional()}).strict();
  const permitted=(v:Viewer,i:{agent:string;approval?:string;standing?:boolean})=>localPublicPolicy(operations,sharing,resolve,v,i);
  operations.register(operation({name:'clock.requestLocal',input:request,output:z.object({id:z.string(),state:z.string()}),write:true,recheckPolicy:true,may:(v,i)=>permitted(v,i),
    run(ctx,i){
      const c=caller(ctx.viewer,i.agent),result=clockLocalFiling(operations).request(c,i.prompt,i.note,randomUUID());
      if(!result.ok)throw new OperationError(result.code,result.message);
      const {id,state}=result.value as {id:string;state:string};return {id,state};
    },
  }));
  operations.register(operation({name:'clock.recoverLocal',input:recover,output:z.object({id:z.string(),due:z.number()}),write:true,recheckPolicy:true,may:(v,i)=>permitted(v,i),
    run(ctx,i){
      const c=caller(ctx.viewer,i.agent),role=i.standing?clockLocalStanding(operations):clockLocalRecovery(operations);
      const {agent:_agent,standing:_standing,...input}=i;
      const result=role.schedule(c,input,randomUUID());
      if(!result.ok)throw new OperationError(result.code,result.message);
      const {id,due}=result.value as {id:string;due:number};
      if(i.standing)saveLocalReceipt(ctx,{id,due});
      return {id,due};
    },
  }));
}
