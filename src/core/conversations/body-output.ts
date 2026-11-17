import { threadTitle } from './title.js';
/** Job-body producers for a thread's encrypted output and reported state. */
import { z } from 'zod';
import { and,eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { operation, OperationError, type Operations } from '../operations/index.js';
import { agentStatus, messages,threads,turns } from '../data/schema.js';
import { conversationBodyScope, requireBodyScope, bodyOperationDefaults, type BodyProof } from './body-scope.js';
import type { CommsMessages } from './messages.js';
import { MESSAGE_WORDS_MAX } from './words.js';
import { ConversationMail } from './mail.js';
const privateWork={working:'Working privately',waiting:'Waiting privately',idle:'',offline:''}as const;
export function registerConversationBodyOutput(operations:Operations,service:CommsMessages,proof:BodyProof,privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean):void {
 const db=service.db,current=conversationBodyScope(db,proof,privateAssignment);
 const requireCurrent=requireBodyScope(current);
 const threadFor=(viewer:Viewer)=>{
  const found=requireCurrent(viewer),thread=db.select().from(threads).where(eq(threads.conversation,found.cv.id)).get();
  if(found.cv.venue!=='loom'||!thread)throw new OperationError('not-found','Current conversation has no Comms thread');
  return {...found,thread};
 };
 const common=bodyOperationDefaults(current,words=>service.key.hash(words),'body-output');
 const details={model:z.string().min(1).max(200).optional(),outcome:z.enum(turns.outcome.enumValues).optional(),latencyMs:z.number().int().nonnegative().optional()};
 operations.register(operation({...common,name:'conversation.message',
  input:z.discriminatedUnion('kind',[
   z.object({kind:z.literal('reply'),clientId:z.string().min(1).max(200),words:z.string().min(1).max(MESSAGE_WORDS_MAX),...details}).strict(),
   z.object({kind:z.literal('card'),clientId:z.string().min(1).max(200),words:z.string().min(1).max(MESSAGE_WORDS_MAX),tool:z.string().min(1).max(200),cardState:z.enum(messages.cardState.enumValues),...details}).strict(),
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
  run(ctx,input,prepared){
   const found=threadFor(ctx.viewer),message=(prepared as ()=>{seq:number})();
   // A reply answers the mail this job took: both are saved together (ConversationMail.settle). A card is progress, not an answer.
   if(input.kind==='reply')for(const id of new ConversationMail(service).settle(found.cv.id,found.job.id))ctx.changed('inbox',id);
   ctx.changed('messages',found.thread.id);ctx.changed('turns',found.cv.id);ctx.changed('conversations',found.cv.id);return {saved:true as const,seq:message.seq};},
 }));

 operations.register(operation({...common,name:'conversation.title',
  input:z.object({title:threadTitle}).strict(),output:z.object({saved:z.literal(true),renamed:z.boolean()}).strict(),
  run(ctx,input){const found=threadFor(ctx.viewer),updated=service.threads.rename(found.thread.id,input.title,'agent');ctx.changed('threads',found.thread.id);ctx.changed('conversations',found.cv.id);return {saved:true as const,renamed:updated.title!==found.thread.title};},
 }));
 operations.register(operation({...common,name:'conversation.cardState',
  input:z.object({clientId:z.string().min(1).max(200),cardState:z.enum(messages.cardState.enumValues)}).strict(),output:z.object({saved:z.literal(true),seq:z.number().int()}).strict(),
  run(ctx,input){
   const found=threadFor(ctx.viewer),card=db.select({seq:messages.seq}).from(messages).where(and(eq(messages.thread,found.thread.id),eq(messages.sender,found.cv.agent),eq(messages.run,found.job.id),eq(messages.clientId,found.job.id+':'+input.clientId),eq(messages.kind,'card'))).get();
   if(!card)throw new OperationError('not-found','Current run card not found');
   db.update(messages).set({cardState:input.cardState}).where(and(eq(messages.thread,found.thread.id),eq(messages.seq,card.seq))).run();ctx.changed('messages',found.thread.id);return {saved:true as const,seq:card.seq};
  },
 }));
 operations.register(operation({...common,name:'conversation.status',
  input:z.object({state:z.enum(agentStatus.state.enumValues),work:z.string().max(600).refine(text=>!/[\r\n\v\f\u0085\u2028\u2029]/u.test(text),'Use one line')}).strict(),
  output:z.object({saved:z.literal(true),stopRequested:z.boolean()}).strict(),
  run(ctx,input){
   const found=requireCurrent(ctx.viewer),at=service.now();
   // This row is shared across the agent's owners; private conversation words stay private.
   const work=found.cv.member!==null?privateWork[input.state]:input.work;
   db.insert(agentStatus).values({agent:found.cv.agent,state:input.state,work,changedAt:at}).onConflictDoUpdate({target:agentStatus.agent,set:{state:input.state,work,changedAt:at}}).run();
   const thread=found.cv.venue==='loom'?db.select().from(threads).where(eq(threads.conversation,found.cv.id)).get():undefined;
   let stopRequested=false;
   // Waiting still owns a live body: the thread must keep its Stop control.
   // The body is told of a Stop here and never takes it: Jobs.endIfStopAsked does, when the worker reports the body gone.
   if(thread){service.threads.working(thread.id,input.state==='working'||input.state==='waiting');stopRequested=thread.stopRequested;ctx.changed('threads',thread.id);}
   ctx.changed('agent_status',found.cv.agent);return {saved:true as const,stopRequested};
  },
 }));
}
