import {registerConversationHandoff} from './handoff.js';
import { registerConversationBodyOutput } from './body-output.js';
import { ConversationHistory } from './history.js';
import { ConversationMail } from './mail.js';
import { sameMailScope } from './body-input.js';
import { conversationBodyScope, requireBodyScope, bodyOperationDefaults, type BodyProof } from './body-scope.js';
/** Reports from the currently authenticated job body. Public Viewer labels,
 * input-selected jobs and ordinary agent tokens never establish this proof. */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { operation, OperationError, type Operations } from '../operations/index.js';
import { turns } from '../data/schema.js';
import type { CommsMessages } from './messages.js';
export type BodyQuestionAuthority=(viewer:Viewer,scope:Readonly<{id:string;agent:string;member:string|null;project:string|null}>,question:Readonly<{to:string;waitsOnKind?:'task'|'approval';waitsOnId?:string}>)=>boolean;
export function registerConversationBodyOperations(operations:Operations, service:CommsMessages, proof:BodyProof, privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean,questionAllowed:BodyQuestionAuthority): void {
 if(operations.db!==service.db.$client)throw Error('Body reports need the shared connection');
 registerConversationBodyOutput(operations,service,proof,privateAssignment);
 registerConversationHandoff(operations,service,proof,privateAssignment);
 const conversationsService=service.threads.conversations,db=service.db;
 const current=conversationBodyScope(db,proof,privateAssignment);
 const requireCurrent=requireBodyScope(current);
 const common=bodyOperationDefaults(current,words=>service.key.hash(words),'body-conversation');
 operations.register(operation({...common,name:'conversation.turn',
  input:z.object({kind:z.enum(['reply','action','wake','note','refused']),model:z.string().min(1).max(200).optional(),outcome:z.enum(['answered','progressed','deferred','failed','none']).optional(),latencyMs:z.number().int().nonnegative().optional()}).strict(),
  output:z.object({saved:z.literal(true),conversation:z.string(),seq:z.number().int()}).strict(),
  run(ctx,input){const {job,cv}=requireCurrent(ctx.viewer);const turn=conversationsService.turn({conversation:cv.id,fromKind:'agent',fromId:cv.agent,run:job.id,...input});ctx.changed('turns',`${cv.id}:${turn.seq}`);ctx.changed('conversations',cv.id);return {saved:true as const,conversation:cv.id,seq:turn.seq};},
 }));
 const findingLine=z.string().trim().min(1).max(400).refine(text=>[...text].length<=200,'Use at most 200 characters').refine(text=>!/[\p{C}\u2028\u2029]/u.test(text),'Use printable characters on one line');
 operations.register(operation({...common,name:'conversation.finding',
  input:z.object({turnSeq:z.number().int().positive(),measure:findingLine,score:z.number().int().min(1).max(5),text:findingLine}).strict(),
  output:z.object({saved:z.literal(true),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict(),
  run(ctx,input){
   const {cv}=requireCurrent(ctx.viewer);
   const target=db.select({seq:turns.seq}).from(turns).where(and(eq(turns.conversation,cv.id),eq(turns.seq,input.turnSeq),eq(turns.fromKind,'agent'),eq(turns.fromId,cv.agent))).get();
   if(!target)throw new OperationError('not-found','Agent turn not found in current conversation');
   const day=service.now().slice(0,10);new ConversationHistory(db,service.now).finding({...input,conversation:cv.id,day});ctx.changed('findings',cv.id);return {saved:true as const,day};
  },
 }));
 // Two reports about mail this job took. `accept`: the body has it, so its sender sees it delivered; nothing
 // is settled. `confirm`: the mail is dealt with (its answer is recorded, or it needs none) and is done.
 const heldMail=(viewer:Viewer,items:readonly string[])=>{const found=current(viewer);return !!found&&items.every(id=>{try{const item=conversationsService.item(id);return item.conversation===found.cv.id&&item.toKind==='agent'&&item.to===found.cv.agent&&item.job===found.job.id&&['taken','done'].includes(item.state)&&sameMailScope(item,found.cv);}catch{return false;}});};
 const mailReport={input:z.object({items:z.array(z.string().min(1)).min(1).max(100)}).strict(),output:z.object({saved:z.literal(true)}).strict(),may:(viewer:Viewer,input:{items:string[]})=>heldMail(viewer,input.items)};
 operations.register(operation({...common,...mailReport,name:'conversation.accept',
  run(ctx,input){const {job,cv}=requireCurrent(ctx.viewer),mail=new ConversationMail(service);for(const id of input.items)mail.accept(cv.id,job.id,id);ctx.changed('messages',cv.id);return {saved:true as const};},
 }));
 operations.register(operation({...common,...mailReport,name:'conversation.confirm',
  run(ctx,input){const {job,cv}=requireCurrent(ctx.viewer),mail=new ConversationMail(service);for(const id of input.items){mail.confirm(cv.id,job.id,id);ctx.changed('inbox',id);}ctx.changed('messages',cv.id);return {saved:true as const};},
 }));
 const question=z.object({to:z.string().min(1),answers:z.enum(['yes-no','words']),words:z.string().min(1).max(100_000),why:z.string().max(100_000).optional(),ifYes:z.string().max(100_000).optional(),ifNo:z.string().max(100_000).optional(),link:z.string().max(2000).optional(),waitsOnKind:z.enum(['approval','task']).optional(),waitsOnId:z.string().min(1).optional(),refs:z.array(z.string().min(1)).max(100).optional()}).strict().refine(q=>!!q.waitsOnKind===!!q.waitsOnId,'Use both wait-on kind and id');
 operations.register(operation({...common,name:'conversation.digest',
  input:z.object({summary:z.string().max(600),ifAbsent:z.boolean().optional(),items:z.array(z.object({kind:z.enum(['decision','ask','task','project']),text:z.string().min(1).max(2000)}).strict()).max(100).optional(),question:question.optional()}).strict(),
  output:z.object({saved:z.literal(true),digest:z.string(),revision:z.number().int(),item:z.string().nullable()}).strict(),
  may(viewer,input){const found=current(viewer);return !!found&&(!input.question||(!found.cv.member||input.question.to===found.cv.member)&&questionAllowed?.(viewer,found.cv,input.question)===true);},
  async prepare(input,ctx){const {job,cv}=requireCurrent(ctx.viewer);return service.prepareDigest({conversation:cv.id,run:job.id,...input});},
  run(ctx,_input,prepared){const {cv}=requireCurrent(ctx.viewer);const digest=(prepared as Awaited<ReturnType<CommsMessages['prepareDigest']>>)();ctx.changed('digests',digest.id);if(digest.inboxItem)ctx.changed('inbox',digest.inboxItem);ctx.changed('conversations',cv.id);return {saved:true as const,digest:digest.id,revision:digest.revision,item:digest.inboxItem};},
 }));
}
