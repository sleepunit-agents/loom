import { agentPostEdit, prepareAgentPost } from './agent-posts.js';
import { prepareReviewResult } from './review-result.js';
import { prepareJobTrace, TRACE_KINDS } from './job-trace.js';
import { reviewThread } from './review-place.js';
import { threadTitle } from './title.js';
/** Job-body producers for a thread's encrypted output and reported state. */
import { z } from 'zod';
import { and,eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { operation, OperationError, type Operations } from '../operations/index.js';
import { agentStatus, changeReviewRounds, messages,threads,turns } from '../data/schema.js';
import { conversationBodyScope, requireBodyScope, bodyOperationDefaults, type BodyProof } from './body-scope.js';
import type { CommsMessages } from './messages.js';
import { MESSAGE_WORDS_MAX } from './words.js';
import { ConversationMail } from './mail.js';
/** Told, inside the reply's own write, that an agent's reply was stored in a loom thread that is one member's own:
 * a reply and not a progress message, a card, or a handed-off session's result brought to its origin thread (the
 * agent is woken by that one and answers it itself). The composition notifies that member's devices. */
export type Replied=(reply:{member:string;thread:string;seq:number})=>void;
const privateWork={working:'Working privately',waiting:'Waiting privately',idle:'',offline:''}as const;
/** `quiet` names a body whose status report writes nothing to the agent's status row (one on anybody else's word). */
export function registerConversationBodyOutput(operations:Operations,service:CommsMessages,proof:BodyProof,privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean,quiet?:(work:NonNullable<ReturnType<ReturnType<typeof conversationBodyScope>>>)=>boolean,maySendProgress?:(viewer:Viewer)=>boolean,replied?:Replied):void {
 const db=service.db,current=conversationBodyScope(db,proof,privateAssignment);
 const requireCurrent=requireBodyScope(current);
 const threadFor=(viewer:Viewer)=>{
  const found=requireCurrent(viewer),thread=db.select().from(threads).where(eq(threads.conversation,found.cv.id)).get();
  if(found.cv.venue!=='loom'||!thread)throw new OperationError('not-found','Current conversation has no Comms thread');
  return {...found,thread};
 };
 const replyTarget=(viewer:Viewer,kind:string)=>{
  const found=requireCurrent(viewer);
  if(kind==='reply' && found.cv.venue==='handoff'){
   const thread=reviewThread(db,found.cv);
   if(thread)return {...found,thread};
  }
  return threadFor(viewer);
 };
 // A handed-off job has no thread to hold its work steps: they are kept beside its own conversation (job-trace.ts).
 // What the server can check of who may write a step, it checks: the body is the current, authenticated body of a
 // live job whose conversation is this handoff (body-scope.ts), the job is that conversation's own and its result
 // returns to its member's own open thread (prepareJobTrace), and the job does not work on anybody else's word
 // (`quiet`, the composition's answer: a kept session is the record of an owners' body). The body's own gate
 // (runtime/body-program.ts) says the same and is no longer the only one. What is not checked here: that a step's
 // words hold no secret. That filter runs in the body, where the secret values are known; the server never has them.
 const traced=(viewer:Viewer,kind:string)=>{
  if(kind!=='card')return;
  const found=requireCurrent(viewer);
  if(found.cv.venue!=='handoff')return;
  if(quiet?.(found)===true)throw new OperationError('denied','A session on anybody else\'s word keeps no steps');
  return found;
 };
 const common=bodyOperationDefaults(current,words=>service.key.hash(words),'body-output');
 const progressKey=(job:string,id:string)=>JSON.stringify([job,'progress',id]);
 const details={model:z.string().min(1).max(200).optional(),outcome:z.enum(turns.outcome.enumValues).optional(),latencyMs:z.number().int().nonnegative().optional()};
 operations.register(operation({...common,name:'conversation.message',
  input:z.discriminatedUnion('kind',[
   z.object({kind:z.literal('reply'),progressId:z.uuid().optional(),clientId:z.string().min(1).max(200),words:z.string().min(1).max(MESSAGE_WORDS_MAX),...details}).strict(),
   z.object({kind:z.literal('progress'),clientId:z.uuid(),words:z.string().min(1).max(MESSAGE_WORDS_MAX),...details}).strict(),
   // stepKind: what a session's step is (job-trace.ts). Only a handed-off session's trace keeps steps that are not a
   // tool's; a card for a thread is a tool step and nothing else.
   z.object({kind:z.literal('card'),clientId:z.string().min(1).max(200),words:z.string().min(1).max(MESSAGE_WORDS_MAX),tool:z.string().min(1).max(200),cardState:z.enum(messages.cardState.enumValues),stepKind:z.enum(TRACE_KINDS).optional(),...details}).strict(),
  ]),
  output:z.object({saved:z.literal(true),seq:z.number().int()}).strict(),
  may:(viewer,input)=>common.may(viewer)&&(input.kind!=='progress'||maySendProgress?.(viewer)===true),
  async prepare(input,ctx){
   const child=traced(ctx.viewer,input.kind);
   if(child&&input.kind==='card'){
    const save=await prepareJobTrace(service,child.cv,child.job.id,{clientId:input.clientId,words:input.words,tool:input.tool,cardState:input.cardState,kind:input.stepKind});
    return ()=>{
     const live=traced(ctx.viewer,input.kind);
     if(!live||live.job.id!==child.job.id||live.cv.id!==child.cv.id||live.cv.member!==child.cv.member||live.cv.project!==child.cv.project||live.cv.agent!==child.cv.agent||live.cv.place!==child.cv.place)throw new OperationError('denied','Conversation changed');
     return save();
    };
   }
   if(input.kind==='card'&&input.stepKind&&input.stepKind!=='tool')throw new OperationError('invalid','Only a handed-off session keeps steps of words or reasoning; a thread\'s card is a tool step');
   const before=replyTarget(ctx.viewer,input.kind),{kind,clientId,words,model,outcome,latencyMs}=input;
   if(kind==='progress'||kind==='reply'&&input.progressId){
    if(before.cv.venue!=='loom'||kind==='reply'&&clientId!==input.progressId)throw new OperationError('invalid','Invalid progress receipt');
    const row=()=>db.select({seq:messages.seq,words:messages.words}).from(messages).where(and(
     eq(messages.thread,before.thread.id),eq(messages.run,before.job.id),eq(messages.sender,before.cv.agent),
     eq(messages.kind,'reply'),eq(messages.clientId,progressKey(before.job.id,clientId)))).get();
    const saved=row();
    if(!saved){
     const append=await service.prepareSend({thread:before.thread.id,sender:before.cv.agent,kind:'reply',progress:kind==='progress',words,
      clientId:progressKey(before.job.id,clientId),run:before.job.id,turn:{model,outcome,latencyMs}});
     return ()=>{
      const live=threadFor(ctx.viewer);
      if(live.job.id!==before.job.id||live.thread.id!==before.thread.id||live.cv.place!==before.cv.place||
         live.cv.member!==before.cv.member||live.cv.project!==before.cv.project||row())throw new OperationError('conflict','Progress receipt changed during preparation');
      return append();
     };
    }
    if(!saved.words||await service.key.open(saved.words)!==words)throw new OperationError('conflict','Progress message changed');
    return ()=>{
     const live=threadFor(ctx.viewer),again=row();
     if(live.job.id!==before.job.id||live.thread.id!==before.thread.id||live.cv.place!==before.cv.place||
        live.cv.member!==before.cv.member||live.cv.project!==before.cv.project||again?.seq!==saved.seq||
        !again.words?.equals(saved.words!))throw new OperationError('conflict','Progress message changed');
     return {seq:saved.seq};
    };
   }
   const prepared=before.cv.venue==='handoff'?await prepareReviewResult(service,before.cv,before.job.id,words,model):await service.prepareSend({thread:before.thread.id,sender:before.cv.agent,kind,words,clientId:before.job.id+':'+clientId,run:before.job.id,turn:{model,outcome,latencyMs},...(kind==='card'?{tool:input.tool,cardState:input.cardState}:{})});
   return ()=>{
    const live=replyTarget(ctx.viewer,input.kind);
    if(live.job.id!==before.job.id||live.thread.id!==before.thread.id||live.cv.id!==before.cv.id||live.cv.member!==before.cv.member||live.cv.project!==before.cv.project||live.cv.agent!==before.cv.agent||live.cv.place!==before.cv.place)throw new OperationError('denied','Conversation changed');
    return prepared();
   };
  },
  run(ctx,input,prepared){
   const child=traced(ctx.viewer,input.kind);
   if(child){const step=(prepared as ()=>{seq:number})();ctx.changed('job_trace',child.cv.id);return {saved:true as const,seq:step.seq};}
   const found=replyTarget(ctx.viewer,input.kind),message=(prepared as ()=>{seq:number})();
   // A frozen review's reply filed its round (review-result.ts): the pull request's readers are told.
   if(input.kind==='reply'&&found.cv.venue==='handoff'){const round=db.select({change:changeReviewRounds.change}).from(changeReviewRounds).where(eq(changeReviewRounds.job,found.job.id)).get();if(round)ctx.changed('change',round.change);}
   // A reply answers the mail this job took: both are saved together (ConversationMail.settle). A card is progress, not an answer.
   if(input.kind==='reply'&&input.progressId&&!db.select({seq:turns.seq}).from(turns).where(and(
     eq(turns.conversation,found.cv.id),eq(turns.run,found.job.id),eq(turns.kind,'reply'))).get()){
    service.threads.conversations.turn({conversation:found.cv.id,kind:'reply',fromKind:'agent',fromId:found.cv.agent,run:found.job.id,
     model:input.model,outcome:input.outcome,latencyMs:input.latencyMs});
   }
   if(input.kind==='reply')for(const id of new ConversationMail(service).settle(found.cv.id,found.job.id))ctx.changed('inbox',id);
   if(input.kind==='reply'&&found.cv.venue==='loom'&&found.cv.member)replied?.({member:found.cv.member,thread:found.thread.id,seq:message.seq});
   ctx.changed('messages',found.thread.id);ctx.changed('turns',found.cv.id);ctx.changed('conversations',found.cv.id);return {saved:true as const,seq:message.seq};},
 }));

 operations.register(operation({
  ...common, name:'conversation.activityPost', input:agentPostEdit,
  output:z.object({thread:z.string()}).strict(),
  may(viewer) {
    const work=current(viewer);
    return !!work && work.cv.venue==='loom' && !quiet?.(work);
  },
  async prepare(input, {viewer}) {
    const before=threadFor(viewer);
    const save=await prepareAgentPost(db,service.key,before.thread.id,input);
    return () => {
      const live=threadFor(viewer);
      if (live.job.id!==before.job.id || live.thread.id!==before.thread.id || live.cv.member!==before.cv.member ||
          live.cv.agent!==before.cv.agent || live.cv.project!==before.cv.project || live.cv.place!==before.cv.place)
        throw new OperationError('denied','Conversation changed');
      return save(service.now());
    };
  },
  run(ctx,_input,prepared) {
    const thread=(prepared as ()=>string)();
    ctx.changed('threads',threadFor(ctx.viewer).thread.id);
    return {thread};
  },
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
   // The row is the whole agent's. A body the composition calls quiet is answered below, since this report is also how
   // a body hears of a Stop, and writes nothing here: it neither shows its words as the agent's work nor overwrites
   // what another job of the agent reported.
   const silent=quiet?.(found)===true;
   if(!silent)db.insert(agentStatus).values({agent:found.cv.agent,state:input.state,work,changedAt:at}).onConflictDoUpdate({target:agentStatus.agent,set:{state:input.state,work,changedAt:at}}).run();
   const thread=found.cv.venue==='loom'?db.select().from(threads).where(eq(threads.conversation,found.cv.id)).get():undefined;
   let stopRequested=false;
   // Waiting still owns a live body: the thread must keep its Stop control.
   // The body is told of a Stop here and never takes it: Jobs.endIfStopAsked does, when the worker reports the body gone.
   if(thread){service.threads.working(thread.id,input.state==='working'||input.state==='waiting');stopRequested=thread.stopRequested;ctx.changed('threads',thread.id);}
   if(!silent)ctx.changed('agent_status',found.cv.agent);return {saved:true as const,stopRequested};
  },
 }));
}
