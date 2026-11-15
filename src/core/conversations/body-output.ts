/** Job-body producers for a thread's encrypted output and reported state. */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { operation, OperationError, type Operations } from '../operations/index.js';
import { agentStatus, threads } from '../data/schema.js';
import { conversationBodyScope, requireBodyScope, type BodyProof } from './body-scope.js';
import type { CommsMessages } from './messages.js';
export function registerConversationBodyOutput(operations:Operations,service:CommsMessages,proof:BodyProof,privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean):void {
 const db=service.db,current=conversationBodyScope(db,proof,privateAssignment);
 const requireCurrent=requireBodyScope(current);
 const threadFor=(viewer:Viewer)=>{
  const found=requireCurrent(viewer),thread=db.select().from(threads).where(eq(threads.conversation,found.cv.id)).get();
  if(found.cv.venue!=='loom'||!thread)throw new OperationError('not-found','Current conversation has no Comms thread');
  return {...found,thread};
 };
 const common={write:true,recheckPolicy:true,doors:['http'] as ['http'],may:(viewer:Viewer)=>!!current(viewer),inputHash:(input:string,identity:Readonly<{actor:Viewer}>)=>service.key.hash(`body-output\0${current(identity.actor)?.job.id??'unbound'}\0${input}`)};
 const details={model:z.string().min(1).max(200).optional(),outcome:z.enum(['answered','progressed','deferred','failed','none']).optional(),latencyMs:z.number().int().nonnegative().optional()};
 operations.register(operation({...common,name:'conversation.message',
  input:z.discriminatedUnion('kind',[
   z.object({kind:z.literal('reply'),clientId:z.string().min(1).max(200),words:z.string().min(1).max(100_000),...details}).strict(),
   z.object({kind:z.literal('card'),clientId:z.string().min(1).max(200),words:z.string().min(1).max(100_000),tool:z.string().min(1).max(200),cardState:z.enum(['running','done','failed']),...details}).strict(),
  ]),
  output:z.object({saved:z.literal(true),seq:z.number().int()}).strict(),
  async prepare(input,ctx){
   const before=threadFor(ctx.viewer),{kind,clientId,words,model,outcome,latencyMs}=input;
   const prepared=await service.prepareSend({thread:before.thread.id,sender:before.cv.agent,kind,words,clientId:before.job.id+':'+clientId,run:before.job.id,turn:{model,outcome,latencyMs},...(kind==='card'?{tool:input.tool,cardState:input.cardState}:{})});
   return ()=>{
    const live=threadFor(ctx.viewer);
    if(live.job.id!==before.job.id||live.thread.id!==before.thread.id||live.cv.id!==before.cv.id||live.cv.member!==before.cv.member||live.cv.project!==before.cv.project||live.cv.agent!==before.cv.agent||live.cv.place!==before.cv.place)throw new OperationError('denied','Conversation changed');
    return prepared();
   };
  },
  run(ctx,_input,prepared){const found=threadFor(ctx.viewer),message=(prepared as ()=>{seq:number})();ctx.changed('messages',found.thread.id);ctx.changed('turns',found.cv.id);ctx.changed('conversations',found.cv.id);return {saved:true as const,seq:message.seq};},
 }));
 operations.register(operation({...common,name:'conversation.status',
  input:z.object({state:z.enum(['working','waiting','idle','offline']),work:z.string().max(600).refine(text=>!/[\r\n]/.test(text),'Use one line'),seenStop:z.literal(true).optional()}).strict(),
  output:z.object({saved:z.literal(true),stopRequested:z.boolean()}).strict(),
  run(ctx,input){
   const found=requireCurrent(ctx.viewer),at=service.now();
   db.insert(agentStatus).values({agent:found.cv.agent,state:input.state,work:input.work,changedAt:at}).onConflictDoUpdate({target:agentStatus.agent,set:{state:input.state,work:input.work,changedAt:at}}).run();
   const thread=found.cv.venue==='loom'?db.select().from(threads).where(eq(threads.conversation,found.cv.id)).get():undefined;
   let stopRequested=false;
   if(thread){service.threads.working(thread.id,input.state==='working');stopRequested=thread.stopRequested;if(input.seenStop)service.threads.takeStop(thread.id);ctx.changed('threads',thread.id);}
   ctx.changed('agent_status',found.cv.agent);return {saved:true as const,stopRequested};
  },
 }));
}
