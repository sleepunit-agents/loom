import { registerConversationBodyOutput } from './body-output.js';
import { ConversationMail } from './mail.js';
import { sameMailScope } from './body-input.js';
import { conversationBodyScope, requireBodyScope, bodyOperationDefaults, type BodyProof } from './body-scope.js';
/** Reports from the currently authenticated job body. Public Viewer labels,
 * input-selected jobs and ordinary agent tokens never establish this proof. */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { operation, type Operations } from '../operations/index.js';
import { members } from '../data/schema.js';
import type { CommsMessages } from './messages.js';
export function registerConversationBodyOperations(operations:Operations, service:CommsMessages, proof:BodyProof, privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean): void {
 if(operations.db!==service.db.$client)throw Error('Body reports need the shared connection');
 registerConversationBodyOutput(operations,service,proof,privateAssignment);
 const conversationsService=service.threads.conversations,db=service.db;
 const current=conversationBodyScope(db,proof,privateAssignment);
 const requireCurrent=requireBodyScope(current);
 const common=bodyOperationDefaults(current,words=>service.key.hash(words),'body-conversation');
 operations.register(operation({...common,name:'conversation.turn',
  input:z.object({kind:z.enum(['reply','action','wake','note','refused']),model:z.string().min(1).max(200).optional(),outcome:z.enum(['answered','progressed','deferred','failed','none']).optional(),latencyMs:z.number().int().nonnegative().optional()}).strict(),
  output:z.object({saved:z.literal(true),conversation:z.string(),seq:z.number().int()}).strict(),
  run(ctx,input){const {job,cv}=requireCurrent(ctx.viewer);const turn=conversationsService.turn({conversation:cv.id,fromKind:'agent',fromId:cv.agent,run:job.id,...input});ctx.changed('turns',`${cv.id}:${turn.seq}`);ctx.changed('conversations',cv.id);return {saved:true as const,conversation:cv.id,seq:turn.seq};},
 }));
 operations.register(operation({...common,name:'conversation.confirm',
  input:z.object({items:z.array(z.string().min(1)).min(1).max(100)}).strict(),output:z.object({saved:z.literal(true)}).strict(),
  may(viewer,input){const found=current(viewer);return !!found&&input.items.every(id=>{try{const item=conversationsService.item(id);return item.conversation===found.cv.id&&item.toKind==='agent'&&item.to===found.cv.agent&&item.job===found.job.id&&['taken','done'].includes(item.state)&&sameMailScope(item,found.cv);}catch{return false;}});},
  run(ctx,input){const {job,cv}=requireCurrent(ctx.viewer),mail=new ConversationMail(service);for(const id of input.items){mail.confirm(cv.id,job.id,id);ctx.changed('inbox',id);}ctx.changed('messages',cv.id);return {saved:true as const};},
 }));
 const question=z.object({to:z.string().min(1),answers:z.enum(['yes-no','words']),words:z.string().min(1).max(100_000),why:z.string().max(100_000).optional(),ifYes:z.string().max(100_000).optional(),ifNo:z.string().max(100_000).optional(),link:z.string().max(2000).optional(),waitsOnKind:z.enum(['approval','task']).optional(),waitsOnId:z.string().min(1).optional(),refs:z.array(z.string().min(1)).max(100).optional()}).strict();
 operations.register(operation({...common,name:'conversation.digest',
  input:z.object({summary:z.string().max(600),items:z.array(z.object({kind:z.enum(['decision','ask','task','project']),text:z.string().min(1).max(2000)}).strict()).max(100).optional(),question:question.optional()}).strict(),
  output:z.object({saved:z.literal(true),digest:z.string(),revision:z.number().int(),item:z.string().nullable()}).strict(),
  may(viewer,input){const found=current(viewer);return !!found&&(!input.question||(!found.cv.member||found.cv.venue==='loom')&&(!found.cv.member||input.question.to===found.cv.member)&&!!db.select({id:members.id}).from(members).where(eq(members.id,input.question.to)).get());},
  async prepare(input,ctx){const {job,cv}=requireCurrent(ctx.viewer);return service.prepareDigest({conversation:cv.id,run:job.id,...input});},
  run(ctx,_input,prepared){const {cv}=requireCurrent(ctx.viewer);const digest=(prepared as Awaited<ReturnType<CommsMessages['prepareDigest']>>)();ctx.changed('digests',digest.id);if(digest.inboxItem)ctx.changed('inbox',digest.inboxItem);ctx.changed('conversations',cv.id);return {saved:true as const,digest:digest.id,revision:digest.revision,item:digest.inboxItem};},
 }));
}
