/** Public writes retain the exact Signin Viewer until Runtime proves its Caller.
 * Only acknowledgements leave this boundary; saved private words stay inside
 * the owning Clock/Approvals transaction.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { localOwner, type Caller } from '../approvals/role.js';
import { clockLocalFiling, clockLocalRecovery, clockLocalStanding } from './role.js';
const text=z.string().min(1).max(100_000);
export function installLocalPublic(operations:Operations,sharing:()=>Sharing,resolve?: (viewer:Viewer)=>Caller|undefined) {
  const caller=(viewer:Viewer,agent:string)=>{
    const c=resolve?.(viewer);
    if(viewer.kind!=='agent' || viewer.id!==agent || c?.who.agent!==agent || !localOwner(c,sharing()))
      throw new OperationError('denied','Local work requires a household owner’s authenticated conversation');
    return c;
  };
  const request=z.object({agent:text,prompt:text,note:z.string().max(100_000)}).strict();
  const recover=z.object({agent:text,approval:z.string().regex(/^a-[0-9a-f]{8}$/),when:text,mode:z.enum(['in','at']),standing:z.boolean().optional(),prompt:text.optional(),note:z.string().max(100_000).optional()}).strict();
  const permitted=(v:Viewer,i:{agent:string})=>{try{caller(v,i.agent);return true;}catch{return false;}};
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
      if(i.standing) {
        const receipt=ctx.receipt!;
        operations.db.prepare('INSERT INTO clock_meta(key,value) VALUES (?,?)').run(
          `local-standing-receipt:${receipt.viewer}:${receipt.id}`,
          JSON.stringify({name:receipt.name,hash:receipt.inputHash,result:{id,due}}));
      }
      return {id,due};
    },
  }));
}
