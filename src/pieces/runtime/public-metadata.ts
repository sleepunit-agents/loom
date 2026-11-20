/** Public Clock body metadata is projected through Attention's own operations.
 * Runtime ids and native transport ids remain opaque; only Attention derives cv ids.
 * Private Comms and service work deliberately have no path through this adapter.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, type Viewer } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import { attentionConversationId as conversationId, attentionDigestInput as digestInput } from '../attention/role.js';
import type { RuntimeRecords } from './records.js';
import { runtimeStore } from './store.js';
import type { PublicInputs } from './public-inputs.js';
import { hearJob } from './heartbeat.js';
const printable=(max:number)=>z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/);
export function installPublicMetadata(app:Foundation,bound:(viewer:Viewer)=>RuntimeRecords['job']|undefined, inbox:PublicInputs) {
 const {operations,db}=app,store=runtimeStore(db);
 const destination=(viewer:Viewer)=>{
  const job=bound(viewer);
  if(!job||job.state!=='running'||job.member!==undefined||job.service!==undefined||!job.conversation)return;
  const binding=store.read('binding',job.conversation);
  if(!binding||binding.venue!=='wake'||binding.job!==job.id||binding.agent!==job.agent
   ||binding.member!==undefined||binding.project!==job.project)return;
  // Namespace the place by the immutable Runtime conversation, not a reusable
  // lane label. A replacement lane cannot inherit another conversation's asks.
  return {job,venue:'runtime-clock',place:binding.id};
 };
 // Registry retry keys are shared by agent, not by body credential. Bind the
 // fingerprint to the original destination so another valid body/claim/scope
 // cannot replay its predecessor's metadata receipt with the same typed input.
 const inputHash=(input:string,{actor}:{actor:Viewer})=>{
  const d=destination(actor),j=d?.job,b=j?.conversation?store.read('binding',j.conversation):undefined;
  return createHash('sha256').update(JSON.stringify({input,destination:j&&{
   job:j.id,agent:j.agent,project:j.project,conversation:j.conversation,runner:j.runner,box:j.box,
   claimedAt:j.claimedAt,made:j.made,binding:b&&{id:b.id,agent:b.agent,member:b.member,project:b.project,venue:b.venue,place:b.place,job:b.job}
  }})).digest('hex');
 };
 const unwrap=(result:ReturnType<typeof operations.call>)=>{
  if(!result.ok)throw new OperationError(result.code,result.message);
  return result.value;
 };
 operations.register(operation({name:'runtime.recordTurn',doors:['http','direct'],write:true,recheckPolicy:true,inputHash,
  input:z.object({kind:z.enum(['reply','action','note']),outcome:z.enum(['answered','progressed','deferred','failed','none']),model:printable(120).optional(),harness:printable(120).optional()}).strict(),output:z.unknown(),
  may:v=>!!destination(v),run(ctx,input){
   const d=destination(ctx.viewer);if(!d)throw new OperationError('denied','Public Clock body binding ended');
   const result=unwrap(operations.call('direct',ctx.viewer,'attention.recordTurn',{agent:d.job.agent,project:d.job.project,
    turn:{...input,venue:d.venue,place:d.place,at:new Date(ctx.now).toISOString(),from:{kind:'agent',id:d.job.agent},run:d.job.id}},`runtime-turn:${ctx.receipt!.id}`));
   inbox.conversation(ctx, d.job);
   hearJob(db,d.job.id,ctx.now);return result;
  },
 }));
 operations.register(operation({name:'runtime.writeDigest',doors:['http','direct'],write:true,recheckPolicy:true,inputHash,
  input:digestInput.pick({digest:true}),output:z.unknown(),may:v=>!!destination(v),run(ctx,input){
   const d=destination(ctx.viewer);if(!d)throw new OperationError('denied','Public Clock body binding ended');
   if(input.digest.needs_owner?.waits_on)throw new OperationError('unavailable','Managed decisions remain owned by their source');
   const result=unwrap(operations.call('direct',ctx.viewer,'attention.writeDigest',{
    conversation:conversationId(d.job.agent,d.venue,d.place),run:d.job.id,digest:input.digest},`runtime-digest:${ctx.receipt!.id}`));
   inbox.question(ctx, d.job, result);
   hearJob(db,d.job.id,ctx.now);return result;
  },
 }));
}
