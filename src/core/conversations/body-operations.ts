/** Reports from the currently authenticated job body. Public Viewer labels,
 * input-selected jobs and ordinary agent tokens never establish this proof. */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { OperationError, operation, type Operations } from '../operations/index.js';
import { conversations, jobs, members, memberAgents } from '../data/schema.js';
import type { CommsMessages } from './messages.js';
type BodyProof = (viewer: Viewer) => Readonly<{job:string;agent:string;box:string}> | undefined;
export function registerConversationBodyOperations(operations:Operations, service:CommsMessages, proof:BodyProof): void {
 if(operations.db!==service.db.$client)throw Error('Body reports need the shared connection');
 const cvs=service.threads.conversations,db=service.db;
 const current=(viewer:Viewer)=>{
  const body=proof(viewer);if(!body)return;
  const job=db.select().from(jobs).where(eq(jobs.id,body.job)).get();
  if(!job?.conversation||job.state!=='running'||job.agent!==body.agent||job.box!==body.box)return;
  const cv=db.select().from(conversations).where(eq(conversations.id,job.conversation)).get();
  if(!cv||cv.job!==job.id||cv.agent!==job.agent||cv.member!==job.member||cv.project!==job.project)return;
  // A private assignment cannot survive the recipient losing the agent.
  if(cv.member&&!db.select({id:memberAgents.member}).from(memberAgents).where(and(eq(memberAgents.member,cv.member),eq(memberAgents.agent,cv.agent))).get()
    &&!db.select({id:members.id}).from(members).where(and(eq(members.id,cv.member),eq(members.role,'owner'))).get())return;
  return {job,cv};
 };
 const requireCurrent=(viewer:Viewer)=>{const found=current(viewer);if(!found)throw new OperationError('denied','Current conversation body required');return found;};
 const common={write:true,recheckPolicy:true,doors:['http'] as ['http'],may:(viewer:Viewer)=>!!current(viewer),inputHash:(input:string, identity:Readonly<{actor:Viewer}>)=>service.key.hash(`body-conversation\0${current(identity.actor)?.job.id ?? 'unbound'}\0${input}`)};
 operations.register(operation({...common,name:'conversation.turn',
  input:z.object({kind:z.enum(['reply','action','wake','note','refused']),model:z.string().min(1).max(200).optional(),outcome:z.enum(['answered','progressed','deferred','failed','none']).optional(),latencyMs:z.number().int().nonnegative().optional()}).strict(),
  output:z.object({saved:z.literal(true),conversation:z.string(),seq:z.number().int()}).strict(),
  run(ctx,input){const {job,cv}=requireCurrent(ctx.viewer);const turn=cvs.turn({conversation:cv.id,fromKind:'agent',fromId:cv.agent,run:job.id,...input});ctx.changed('turns',`${cv.id}:${turn.seq}`);ctx.changed('conversations',cv.id);return {saved:true as const,conversation:cv.id,seq:turn.seq};},
 }));
 const question=z.object({to:z.string().min(1),answers:z.enum(['yes-no','words']),words:z.string().min(1).max(100_000),why:z.string().max(100_000).optional(),ifYes:z.string().max(100_000).optional(),ifNo:z.string().max(100_000).optional(),link:z.string().max(2000).optional(),waitsOnKind:z.enum(['approval','task']).optional(),waitsOnId:z.string().min(1).optional(),refs:z.array(z.string().min(1)).max(100).optional()}).strict();
 operations.register(operation({...common,name:'conversation.digest',
  input:z.object({summary:z.string().max(600),items:z.array(z.object({kind:z.enum(['decision','ask','task','project']),text:z.string().min(1).max(2000)}).strict()).max(100).optional(),question:question.optional()}).strict(),
  output:z.object({saved:z.literal(true),digest:z.string(),revision:z.number().int(),item:z.string().nullable()}).strict(),
  may(viewer,input){const found=current(viewer);return !!found&&(!input.question||(!found.cv.member||input.question.to===found.cv.member)&&!!db.select({id:members.id}).from(members).where(eq(members.id,input.question.to)).get());},
  async prepare(input,ctx){const {job,cv}=requireCurrent(ctx.viewer);return service.prepareDigest({conversation:cv.id,run:job.id,...input});},
  run(ctx,_input,prepared){const {cv}=requireCurrent(ctx.viewer);const digest=(prepared as Awaited<ReturnType<CommsMessages['prepareDigest']>>)();ctx.changed('digests',digest.id);if(digest.inboxItem)ctx.changed('inbox',digest.inboxItem);ctx.changed('conversations',cv.id);return {saved:true as const,digest:digest.id,revision:digest.revision,item:digest.inboxItem};},
 }));
}
