/** Agent-facing metadata and handoff commands. Only the root's authenticated
 * body proof supplies agent/job; neither is accepted from command input. */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { jobs, secretRequests, secretUses } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { secretName, requestReason } from './pieces/secrets/input.js';
import type { SecretRequests } from './pieces/secrets/requests.js';
import type { SecretDelivery } from './pieces/secrets/delivery.js';
const requestState=z.object({id:z.string(),state:z.enum(['pending','allowed','denied','cancelled','revoked'])}).strict();
const request=z.object({id:z.uuid(),secret:secretName,why:requestReason,minutes:z.number().int().min(1).max(525600),scope:z.enum(['agent','job']).default('job')}).strict();
const handoff=z.object({id:z.string(),state:z.enum(['started','released','failed'])}).strict();
const use=z.object({id:z.uuid(),secret:secretName}).strict();
export function registerSharedSecretAgentCommands(operations:Operations,db:DataDatabase,requests:SecretRequests,
 delivery:SecretDelivery|undefined,body:(viewer:Viewer)=>Readonly<{agent:string;job:string}>|undefined){
 const target=(viewer:Viewer)=>{
  const bound=body(viewer);if(!bound||viewer.kind!=='agent'||bound.agent!==viewer.id)return;
  const job=db.select({id:jobs.id,agent:jobs.agent,conversation:jobs.conversation}).from(jobs).where(eq(jobs.id,bound.job)).get();
  return job?.agent===bound.agent?job:undefined;
 };
 operations.register({name:'secrets.request',input:request,output:requestState,write:true,recheckPolicy:true,
  inputHash:(canonical,{actor})=>{const job=target(actor);return createHash('sha256').update('loom-shared-secret-request-receipt-v1\0').update(JSON.stringify([job?.id??null,job?.conversation??null,canonical])).digest('hex');},
  may:(viewer,input)=>viewer.kind==='agent'&&(input.scope==='agent'||!!target(viewer)),
  run(ctx,input){
   const job=target(ctx.viewer);if(ctx.viewer.kind!=='agent'||(input.scope==='job'&&!job))throw new OperationError('denied','A current agent or body is required');
   try{const row=requests.request({id:input.id,secret:input.secret,why:input.why,minutes:input.minutes,agent:ctx.viewer.id,
    job:input.scope==='job'?job!.id:undefined,conversation:job?.conversation??undefined});
    ctx.changed('secret-request',row.id);return {id:row.id,state:row.state};
   }catch{throw new OperationError('invalid','Secret request could not complete');}
  },
 });
 operations.register({name:'secrets.requestStatus',input:z.object({id:z.string().min(1).max(200)}).strict(),output:requestState,
  may:(viewer,input)=>viewer.kind==='agent'&&db.select({agent:secretRequests.agent}).from(secretRequests).where(eq(secretRequests.id,input.id)).get()?.agent===viewer.id,
  run(_ctx,input){const row=db.select({id:secretRequests.id,state:secretRequests.state}).from(secretRequests).where(eq(secretRequests.id,input.id)).get();if(!row)throw new OperationError('not-found','Secret request not found');return row;},
 });
 if(!delivery)return;
 operations.register({name:'secrets.useStatus',input:z.object({id:z.string().min(1).max(200)}).strict(),output:handoff,
  may:(viewer,input)=>{const job=target(viewer),row=db.select({agent:secretUses.agent,job:secretUses.job}).from(secretUses).where(eq(secretUses.id,input.id)).get();return !!job&&row?.job===job.id&&row.agent===job.agent;},
  run(_ctx,input){const row=db.select({id:secretUses.id,state:secretUses.state}).from(secretUses).where(eq(secretUses.id,input.id)).get();if(!row)throw new OperationError('not-found','Secret handoff not found');return row;},
 });
 operations.register({name:'secrets.use',input:use,output:handoff,write:true,recheckPolicy:true,
  inputHash:(canonical,{actor})=>createHash('sha256').update('loom-shared-secret-use-receipt-v1\0').update(JSON.stringify([target(actor)?.id??null,canonical])).digest('hex'),
  may:viewer=>!!target(viewer),
  async prepare(input,{viewer}){
   const job=target(viewer);if(!job)throw new OperationError('denied','A current body is required');
   const attempt='use-'+createHash('sha256').update('loom-shared-secret-use-v1\0').update(JSON.stringify([job.agent,job.id,input.id])).digest('hex');
   try{return await delivery.handTo(input.secret,job.id,attempt);}catch{throw new OperationError('unavailable','Secret handoff not confirmed');}
  },
  run(ctx,_input,prepared){
   if(!target(ctx.viewer))throw new OperationError('denied','A current body is required');
   const result=handoff.safeParse(prepared);
   if(!result.success)throw new OperationError('unavailable','Secret handoff not confirmed');
   ctx.changed('secret-use',result.data.id);return result.data;
  },
 });
}
