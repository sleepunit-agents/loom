import {slug} from '../../slug.js';
import {reviewRequest,reviewPlace,reviewRepository,reviewTarget,reviewThread,type ReviewTarget} from './review-place.js';
import {agentRunSettings,changes,conversations,jobs,memberAgents,tasks,threads} from '../data/schema.js';
import {reviewBrief} from './review-brief.js';
import {COMMIT} from '../../apps/merge-target.js';
import {sqlVisibility} from '../../policy-sql.js';
import {linkHandoffTickets} from './handoff-tickets.js';
import {taskVisibility} from '../data/visibility.js';
import {handoffPeersAssigned,handoffTarget} from './handoff-access.js';
import {MESSAGE_WORDS_MAX} from './words.js';
/** A current native body hands a brief to another assigned agent. Labels and
 * parent place come from its live conversation, never from caller claims. */
import {and,desc,eq,getTableColumns,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {OnWord} from '../../policy.js';
import {inbox} from '../data/schema.js';
import {channelTarget} from './channel-target.js';
import {operation,OperationError,type Operations} from '../operations/index.js';
import {bodyOperationDefaults,conversationBodyScope,requireBodyScope,type BodyProof} from './body-scope.js';
import type {CommsMessages} from './messages.js';
import {handoffDeadline,sealHandoff} from './handoff-words.js';
import {threadTitle} from './title.js';
import { commsKeepDays } from '../data/comms-days.js';
/** The most tickets one handoff may be said to be for. */
export const HANDOFF_TICKETS_MAX=20;
const cancelledSchedule='The originating conversation cancelled the scheduled handoff.';
/** Where a note to the agent's own body goes: a conversation it has, or a channel (and thread) it has a rule for. */
const toSelf=z.union([z.object({conversation:z.string().min(1).max(200)}).strict(),
 channelTarget]);
export type HandoffTo=z.infer<typeof toSelf>;
/** The composition's rules for a note from one body of an agent to its body in another conversation
 * (src/shared-place-mail.ts, selfHandoff): who may hand to where, on whose word, and by what chain. */
export interface HandoffToSelf{
 /** Resolve and judge the target for this job; throws an OperationError to refuse. Reads only. */
 target(work:{job:{id:string;agent:string;conversation:string|null};cv:{id:string;agent:string;venue:string;place:string;member:string|null}},to:HandoffTo):{
  conversation?:string;open?:{venue:'discord'|'slack';place:string;label:string};told:string;onWord?:OnWord;chain:string[];startedAt:string};
 /** The person the sending job is working on the word of, if one can be named: a brief to another agent
  * carries it, so the job it starts counts that person as in the room and is never the agent's own work. */
 ownerWork?(work:{job:{id:string;agent:string;conversation:string|null}}):boolean;
 codexAvailability?(agent:string):{available:boolean;reason?:string};
 workRoles?(agent:string,id?:string,frozen?:boolean):readonly {id:string;description:string;revision:string;available:boolean;reason?:string}[];
 word(work:{job:{id:string;agent:string;conversation:string|null}}):OnWord|undefined;
 /** Why this job hands nothing on at all, to its own body elsewhere or to a peer agent, or nothing. */
 hop(work:{job:{id:string;agent:string;conversation:string|null}}):string|undefined;
 /** Told after a new note or brief is written, never of one sent again: for the notice a job that hands many raises. */
 handed(work:{job:{id:string;agent:string;conversation:string|null}}):void;
 /** Told after a note is written, for the notice a long chain raises. */
 sent(note:{chain:string[];startedAt:string;to:string;agent:string}):void;
 /** The commit a frozen review's diff is taken against, read from the forge: with `branch`, the merge base of `head`
  * with that branch; without, `head`'s first parent. Left out, conversation.review is unavailable. */
 reviewBase?(repository:string,head:string,branch?:string):Promise<string>;
 /** Whether the household's forge bindings (the owner-to-credential bindings the changes poll uses) name a
  * credential for this owner on GitHub. A frozen review's copy is fetched with that credential and no other
  * (shared-secret-inputs.ts, `review`), so an owner with none has no review. Left out, none is bound. */
 reviewBinding?(owner:string):boolean;
}
/** The work role conversation.review runs in unless it names another. */
export const REVIEW_ROLE='review';
const COMMIT_SHA=COMMIT;
const reviewInput=z.object({
 role:slug(64).optional().describe('The work role the reviewer runs in; "review" when left out.'),
 clientId:z.string().min(1).max(200),label:threadTitle,
 target:z.union([
  z.object({change:z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,9}$/).refine(value=>reviewRepository(value.split('#')[0]),'Not a repository').describe('A pull request loom follows, as owner/repo#number.')}).strict(),
  z.object({repository:z.string().refine(reviewRepository,'Not a repository').describe('owner/repo on GitHub.'),commit:z.string().regex(COMMIT_SHA).describe('A full 40-character commit id.')}).strict(),
 ]),
 contract:z.string().trim().min(1).max(Math.floor(MESSAGE_WORDS_MAX/2)).describe('What to review against, in your words: the ticket, the spec section or the acceptance criteria. Nothing of your own reasoning about the change.'),
 includeDescription:z.literal(true).optional().describe('Give the reviewer the pull request description too. Left out, it is not given.'),
 tier:z.enum(['medium','high']).optional(),
 tickets:z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
}).strict();
export type ReviewInput=z.infer<typeof reviewInput>;
export function registerConversationHandoff(operations:Operations,service:CommsMessages,proof:BodyProof,privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean,self?:HandoffToSelf){
 const db=service.db,cvs=service.threads.conversations,current=conversationBodyScope(db,proof,privateAssignment),requireCurrent=requireBodyScope(current);
 const common=bodyOperationDefaults(current,value=>service.key.hash(value),'body-handoff');
 type Work=NonNullable<ReturnType<typeof current>>;
 const retryLineage=(job:Work['job'])=>{
  let parent=job;
  const seen=new Set([job.id]);
  while(parent.retryOf){
   const previous=db.select().from(jobs).where(eq(jobs.id,parent.retryOf)).get();
   if(!previous || seen.has(previous.id) || previous.conversation!==job.conversation || previous.agent!==job.agent ||
     previous.project!==job.project || previous.member!==job.member)throw new OperationError('conflict','Invalid coordinator retry history');
   seen.add(previous.id);parent=previous;
  }
  return [...seen];
 };
 const ownerThread=(work:Work)=>{
  const person=self?.word(work);
  if(!work.cv.member || work.cv.venue!=='loom' || person?.kind!=='member' || person.id!==work.cv.member || !self?.ownerWork?.(work))return false;
  const thread=db.select({archivedAt:threads.archivedAt}).from(threads).where(eq(threads.conversation,work.cv.id)).get();
  return !!thread && !thread.archivedAt;
 };
 const peerAllowed=(work:Work,agent:string)=>{
  const cv=work.cv;
  if(agent===cv.agent || !handoffTarget(db,agent))return false;
  if(cv.member!==null && !privateAssignment({member:cv.member,agent,project:cv.project??undefined}))return false;
  return cv.member!==null && cv.project===null || handoffPeersAssigned(db,cv.agent,agent,cv.project);
 };
 operations.register(operation({name:'conversation.handoffOptions',write:false,doors:['http'],
  input:z.object({}).strict().describe('List assigned peers, enabled work roles and current worker availability.'),
  output:z.object({agents:z.array(z.string()),codexAvailable:z.boolean(),codexUnavailableReason:z.string().optional(),roles:z.array(z.object({id:z.string(),description:z.string(),available:z.boolean(),reason:z.string().optional()})).optional()}).strict(),
  may(viewer){const work=current(viewer);return !!work && ownerThread(work);},
  run(ctx){
   const work=requireCurrent(ctx.viewer);
   if(!work.cv.member || !ownerThread(work))throw new OperationError('denied','Private owner conversation required');
   const assigned=db.select({agent:memberAgents.agent}).from(memberAgents).where(eq(memberAgents.member,work.cv.member)).all();
   const agents=assigned.map(row=>row.agent).filter(agent=>peerAllowed(work,agent)).sort();
   const roles=self?.workRoles?.(work.cv.agent).map(({id,description,available,reason})=>({id,description,available,...(reason?{reason}:{})}))??[];
   const codex=self?.codexAvailability?.(work.cv.agent);
   return {agents,...(roles.length?{roles}:{}),codexAvailable:codex?.available===true,...(codex?.reason?{codexUnavailableReason:codex.reason}:{})};
  },
 }));
 const reviewInThread=(work:Work,id:string)=>{
  if(!ownerThread(work))return;
  const child=db.select().from(conversations).where(eq(conversations.id,id)).get();
  if(!child)return;
  const origin=reviewThread(db,child);
  if(origin?.conversation===work.cv.id)return {child,origin};
 };
 const briefFor=(child:typeof conversations.$inferSelect)=>{
  const request=reviewRequest(child)!;
  return db.select({id:inbox.id,state:inbox.state,resolution:inbox.resolution,job:inbox.job}).from(inbox)
   .where(and(eq(inbox.conversation,child.id),eq(inbox.toKind,'agent'),eq(inbox.to,child.agent),eq(inbox.source,'handoff'),
    eq(inbox.sourceId,JSON.stringify([request.parent,request.clientId])))).get();
 };
 operations.register(operation({name:'conversation.handoffStatus',write:false,doors:['http'],
  input:z.object({conversation:z.string().min(1).max(200)}).strict().describe('Check a work role or Codex handoff using the child conversation returned by the original handoff.'),
  output:z.object({jobState:z.enum(jobs.state.enumValues).nullable(),resultDelivered:z.boolean(),notBefore:z.string().optional(),cancelled:z.literal(true).optional()}).strict(),
  may(viewer){const work=current(viewer);return !!work && ownerThread(work);},
  run(ctx,input){
   const work=requireCurrent(ctx.viewer);
   const target=reviewInThread(work,input.conversation);
   if(!target)throw new OperationError('denied','Handoff outside this conversation');
   const {child,origin}=target;
   const latest=db.select({state:jobs.state}).from(jobs).where(eq(jobs.conversation,input.conversation))
    .orderBy(desc(jobs.queuedAt),desc(sql`jobs.rowid`)).limit(1).get();
   const delivery=db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.conversation,work.cv.id),eq(inbox.thread,origin.id),
    eq(inbox.source,'handoff'),eq(inbox.sourceId,'review:'+input.conversation),eq(inbox.toKind,'agent'),eq(inbox.to,work.cv.agent))).limit(1).get();
   const brief=child.handoffNotBefore && !latest ? briefFor(child) : undefined;
   return {jobState:latest?.state??null,resultDelivered:!!delivery,...(child.handoffNotBefore?{notBefore:child.handoffNotBefore}:{}),
    ...(brief?.state==='resolved' && brief.resolution===cancelledSchedule?{cancelled:true as const}:{})};
  },
 }));
 operations.register(operation({...common,name:'conversation.handoffCancel',
  input:z.object({conversation:z.string().min(1).max(200)}).strict().describe('Withdraw a scheduled role or Codex brief before a job is admitted.'),
  output:z.object({cancelled:z.literal(true)}).strict(),
  may(viewer,input){const work=current(viewer);return !!work && !!reviewInThread(work,input.conversation);},
  run(ctx,input){
   const target=reviewInThread(requireCurrent(ctx.viewer),input.conversation);
   if(!target)throw new OperationError('denied','Handoff outside this conversation');
   if(!target.child.handoffNotBefore)throw new OperationError('conflict','This handoff was not scheduled.');
   const brief=briefFor(target.child);
   if(brief?.state==='resolved' && brief.resolution===cancelledSchedule)return {cancelled:true};
   // A failed job can release its waiting mail. The job row still proves it was admitted.
   const admitted=db.select({id:jobs.id}).from(jobs).where(eq(jobs.conversation,input.conversation)).limit(1).get();
   if(admitted || !brief || brief.job!==null || !cvs.resolveItem(brief.id,cancelledSchedule))
    throw new OperationError('conflict','This brief is no longer waiting for a job.');
   ctx.changed('inbox',brief.id);
   return {cancelled:true};
  },
 }));
 operations.register(operation({...common,name:'conversation.handoff',
  // To another agent (`agent`), as a brief in a conversation of its own; or to this agent's own body in
  // another conversation (`to`), as mail there that starts its job like any message.
  input:z.object({notBefore:z.iso.datetime().refine(value=>!/\.\d{4,}Z$/.test(value),'Use at most millisecond precision').transform(value=>new Date(value).toISOString()).optional().describe('Earliest UTC start for a private work role or Codex handoff. Its brief must still be retained then.'),role:slug(64).optional(),harness:z.literal('codex').optional(),agent:z.string().min(1).max(200).optional(),to:toSelf.optional(),clientId:z.string().min(1).max(200),label:threadTitle,words:z.string().trim().min(1).max(MESSAGE_WORDS_MAX),
   tickets:z.array(z.string().min(1).max(200)).min(1).max(HANDOFF_TICKETS_MAX).optional().describe('Ids of the tickets this work is for, when it is for any. Recorded with the session so the ticket can show it; not for a note to your own body (to).')}).strict()
   .refine(value=>[value.agent,value.to,value.harness,value.role].filter(v=>v!==undefined).length===1 && (!value.notBefore || !!(value.role || value.harness)) && (!value.tickets || !value.to)),
  output:z.object({conversation:z.string(),item:z.string()}).strict(),
  may(viewer,input){
   const found=current(viewer);if(!found)return false;
   // To itself: the rule is the composition's and is asked in full when the note is prepared and written.
   if(input.harness || input.role)return ownerThread(found);
   if(input.to)return !!self;
   return !!input.agent && peerAllowed(found,input.agent);
  },
  // A note to itself is sealed with what the receiving body is told about it: where it came from and by what chain.
  async prepare(input,context){
   const work=input.to?current(context.viewer):undefined;
   const resolved=work&&self?self.target(work,input.to!):undefined;
   const agent=input.role?current(context.viewer)?.cv.agent:undefined;
   const role=agent?self?.workRoles?.(agent,input.role)[0]:undefined;
   const words=role?`Assigned work role: ${role.id}\n${role.description}\n\n${input.words}`:input.words;
   const sealed=await sealHandoff(service.key,resolved?`${resolved.told}\n\n${input.words}`:words,service.now(),commsKeepDays(db));
   return resolved?{sealed,resolved}:sealed;},
  run(ctx,input,prepared){
   const {job,cv}=requireCurrent(ctx.viewer);
   const sourceFor=(parent:string)=>JSON.stringify([parent,input.clientId]);
   if(input.to){
    const sourceId=sourceFor(job.id);
    if(!self)throw new OperationError('denied','This program hands no note to an agent\'s own body');
    const before=db.select().from(inbox).where(and(eq(inbox.toKind,'agent'),eq(inbox.to,cv.agent),eq(inbox.source,'handoff'),eq(inbox.sourceId,sourceId))).get();
    if(before?.conversation)return {conversation:before.conversation,item:before.id};
    // Resolved once, when the words were sealed. It is judged again here, and must still be the same: what the
    // receiving body is told and what the row says cannot disagree.
    const {sealed,resolved:how}=prepared as {sealed:string;resolved:ReturnType<HandoffToSelf['target']>},again=self.target({job,cv},input.to);
    if(JSON.stringify([again.conversation,again.open,again.onWord,again.chain])!==JSON.stringify([how.conversation,how.open,how.onWord,how.chain]))throw new OperationError('conflict','The note\'s place or word changed; send it again');
    const target=how.conversation??cvs.open({agent:cv.agent,venue:how.open!.venue,place:how.open!.place,label:how.open!.label}).id;
    const chain=[...how.chain,cv.id];
    const item=cvs.send({conversation:target,toKind:'agent',to:cv.agent,source:'handoff',sourceId,fromKind:'agent',fromId:cv.agent,words:sealed,refs:[cv.id],
     chain:JSON.stringify(chain),chainStartedAt:how.startedAt,...(how.onWord?{onWordKind:how.onWord.kind,onWord:how.onWord.id}:{})});
    cvs.turn({conversation:target,kind:'message',fromKind:'agent',fromId:cv.agent,outcome:'progressed'});
    self.sent({chain,startedAt:how.startedAt,to:target,agent:cv.agent});self.handed({job});
    ctx.changed('conversations',target);ctx.changed('inbox',item.id);ctx.changed('turns',target);
    return {conversation:target,item:item.id};
   }
   const delegated=!!(input.harness || input.role);
   const recipient=delegated?cv.agent:input.agent;
   if(!recipient)throw new OperationError('invalid','A hand-off names an agent or a place');
   // Earlier builds keyed an immediate brief to the attempt that submitted it. Search the whole
   // retry line before creating a child so a lost receipt survives worker failure and upgrades.
   const parents=delegated?retryLineage(job):[job.id];
   const parent=input.notBefore?parents[parents.length-1]:job.id,sourceId=sourceFor(parent);
   const receipts=db.select().from(inbox).where(and(eq(inbox.toKind,'agent'),eq(inbox.to,recipient),
    eq(inbox.source,'handoff'),inArray(inbox.sourceId,parents.map(sourceFor)))).limit(2).all();
   if(receipts.length>1)throw new OperationError('conflict','Multiple handoffs already exist for this request');
   const [existing]=receipts;
   if(existing){
    const target=existing.conversation?cvs.conversation(existing.conversation):undefined;
    const request=target && reviewRequest(target);
    const same=delegated?!!request && existing.sourceId===sourceFor(request.parent) && request.clientId===input.clientId && request.role?.id===input.role && target?.handoffNotBefore===(input.notBefore??null):target?.place===job.id;
    if(!target||target.venue!=='handoff'||!same||target.agent!==recipient||target.project!==cv.project||target.member!==cv.member||target.direct!==cv.direct)throw new OperationError('conflict','Handoff scope changed');
    return {conversation:target.id,item:existing.id};
   }
   // The handoff carries every label that says who may read the words it came from: the project, the member,
   // and whether it was a direct message.
   // The composition's rule for a hand-off of any kind: one hop on anybody else's word.
   const hop=self?.hop({job});if(hop)throw new OperationError('denied',hop);
   // The tickets the work is for are stated by the agent, never read out of its words. Each must be one this
   // body may read now, working for this conversation's member; an unknown or unreadable id refuses the handoff.
   const tickets=[...new Set(input.tickets??[])];
   if(tickets.length){
    const readable=new Set(db.select({id:tasks.id}).from(tasks).where(and(inArray(tasks.id,tickets),taskVisibility(ctx.viewer).tasks!(getTableColumns(tasks)))).all().map(row=>row.id));
    const unknown=tickets.filter(id=>!readable.has(id));
    if(unknown.length)throw new OperationError('invalid','Unknown ticket: '+unknown.join(', '));
   }
   if(input.notBefore){
    const start=Date.parse(input.notBefore),now=service.now();
    if(start<=Date.parse(now) || start>=handoffDeadline({at:now,words:prepared as string},commsKeepDays(db)))
      throw new OperationError('invalid','Choose a future time before the private brief expires');
   }
   if(!input.notBefore && input.harness){
    const codex=self?.codexAvailability?.(recipient);
    if(!codex?.available)throw new OperationError('unavailable',codex?.reason??'No eligible Codex worker with a signed-in account and free capacity is available for this job.');
   }
   const role=input.role?self?.workRoles?.(recipient,input.role)[0]:undefined;
   if(input.role && !role)throw new OperationError('invalid','Unknown work role for this agent');
   if(role && !input.notBefore && !role.available)throw new OperationError('unavailable',role.reason??'No eligible worker is available for this work role');
   const place=delegated?reviewPlace(parent,input.clientId,role):job.id;
   const target=cvs.open({agent:recipient,venue:'handoff',place,label:input.label,project:cv.project,member:cv.member,direct:cv.direct,handoffNotBefore:input.notBefore});
   if(target.handoffNotBefore!==(input.notBefore??null)||target.project!==cv.project||target.member!==cv.member||target.direct!==cv.direct)throw new OperationError('conflict','Handoff scope changed');
   linkHandoffTickets(db,target.id,tickets);
   const word=self?.word({job});
   const item=cvs.send({conversation:target.id,toKind:'agent',to:recipient,source:'handoff',sourceId,fromKind:'agent',fromId:cv.agent,words:prepared as string,...(word?{onWordKind:word.kind,onWord:word.id}:{})});
   cvs.turn({conversation:target.id,kind:'message',fromKind:'agent',fromId:cv.agent,outcome:'progressed'});self?.handed({job});
   ctx.changed('conversations',target.id);ctx.changed('inbox',item.id);ctx.changed('turns',target.id);
   return {conversation:target.id,item:item.id};
  },
 }));
 /** A frozen review (docs/runtime/worker.md, "Frozen reviews"): a handed-off session in a work role, on one exact commit
  * and its diff, which the worker gives the body as a read-only copy, with no credential that can push, and a brief loom
  * writes itself (review-brief.ts). Its answer is relayed like any handoff's, and its verdict filed on the round. */
 /** The one answer for a commit loom will not look at: one in a repository that does not exist, or one the asker has
  * no right to read. They are told apart by nothing, and GitHub is not asked about the second. */
 const unreadable=()=>new OperationError('unavailable','Loom could not read the commit to review against from GitHub.');
 /** The GitHub repository (`owner/name`, lower case) an agent's house is fetched from, when it is one on GitHub. */
 const houseOnGitHub=(agent:string)=>{
  const house=db.select({repository:agentRunSettings.houseRepository}).from(agentRunSettings).where(eq(agentRunSettings.agent,agent)).get()?.repository;
  const found=house && /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(house);
  return found && reviewRepository(found[1]) ? found[1].toLowerCase() : undefined;
 };
 const reviewTargetFor=(viewer:Parameters<typeof current>[0],agent:string,input:ReviewInput)=>{
  const visible=sqlVisibility(viewer,['changes']).changes(getTableColumns(changes));
  if('change' in input.target){
   const [repository,number]=input.target.change.split('#');
   const id='github:'+repository.toLowerCase()+'#'+number;
   const row=db.select().from(changes).where(and(eq(changes.id,id),visible)).get();
   if(!row)throw new OperationError('invalid','Loom does not follow that pull request, or it is not one you may read');
   if(!COMMIT_SHA.test(row.headCommit))throw new OperationError('conflict','The pull request has no head commit loom has read');
   return {repository:row.repository.replace(/^github:/,''),head:row.headCommit,change:row.id,pull:{number:row.number,baseBranch:row.baseBranch},body:row.body};
  }
  const repository=input.target.repository.toLowerCase(),head=input.target.commit,owner=repository.split('/')[0];
  // A commit is reviewed only in a repository the asker may already read: one a pull request it may read is in, the
  // agent's own house, or one whose owner the household's forge bindings name. Anything else is refused as a
  // repository that does not exist is, before GitHub is asked anything (docs/runtime/worker.md, "Frozen reviews").
  const readable=!!db.select({id:changes.id}).from(changes).where(and(eq(changes.repository,repository),visible)).limit(1).get()
   || houseOnGitHub(agent)===repository || self?.reviewBinding?.(owner)===true;
  if(!readable)throw unreadable();
  // The pull request whose head this commit is, when loom follows one the asker may read: the round is filed on it.
  const row=db.select().from(changes).where(and(eq(changes.repository,repository),eq(changes.headCommit,head),visible)).orderBy(desc(changes.updatedAt)).limit(1).get();
  return {repository,head,change:row?.id??null,pull:undefined,body:undefined};
 };
 operations.register(operation({...common,name:'conversation.review',
  input:reviewInput.describe('Hand a pull request or a commit to a reviewer: loom pins the exact commit and its diff, gives the reviewer a read-only copy and no credential that can push, and relays its answer here once its job has ended. Its verdict is filed then, on the pull request\'s round, which only the member of this conversation sees.'),
  output:z.object({conversation:z.string(),item:z.string(),commit:z.string(),base:z.string()}).strict(),
  may(viewer){const found=current(viewer);return !!found && ownerThread(found);},
  async prepare(input,context){
   const work=current(context.viewer);
   if(!work || !ownerThread(work))throw new OperationError('denied','Private owner conversation required');
   if(!self?.reviewBase)throw new OperationError('unavailable','This loom cannot read the forge, so it runs no frozen review.');
   const role=self.workRoles?.(work.cv.agent,input.role??REVIEW_ROLE)[0];
   if(!role)throw new OperationError('invalid','Unknown work role for this agent');
   const found=reviewTargetFor(context.viewer,work.cv.agent,input);
   // Asked before the forge is: a job that may hand nothing on spends no request of GitHub's.
   const hop=self.hop({job:work.job});if(hop)throw new OperationError('denied',hop);
   // The copy is fetched with the credential the forge bindings hold for this owner, and no other: none, no review.
   if(self.reviewBinding?.(found.repository.split('/')[0])!==true)
    throw new OperationError('unavailable','Loom holds no forge credential for this repository\'s owner, so it runs no review of it.');
   let base:string;
   try{base=await self.reviewBase(found.repository,found.head,found.pull?.baseBranch);}
   catch{throw unreadable();}
   if(!COMMIT_SHA.test(base))throw unreadable();
   const target=reviewTarget({repository:found.repository,head:found.head,base,change:found.change,tier:input.tier??'medium'});
   if(!target)throw unreadable();
   const words=reviewBrief({role,target,...(found.pull?{pull:found.pull}:{}),contract:input.contract,
    ...(input.includeDescription && found.body!==undefined?{description:found.body}:{})});
   return {sealed:await sealHandoff(service.key,words,service.now(),commsKeepDays(db)),target,role};
  },
  run(ctx,input,prepared){
   const {job,cv}=requireCurrent(ctx.viewer);
   const {sealed,target,role:asked}=prepared as {sealed:string;target:ReviewTarget;role:{id:string;revision:string}};
   const parents=retryLineage(job),parent=job.id,sourceFor=(id:string)=>JSON.stringify([id,input.clientId]);
   const receipts=db.select().from(inbox).where(and(eq(inbox.toKind,'agent'),eq(inbox.to,cv.agent),
    eq(inbox.source,'handoff'),inArray(inbox.sourceId,parents.map(sourceFor)))).limit(2).all();
   if(receipts.length>1)throw new OperationError('conflict','Multiple handoffs already exist for this request');
   if(receipts[0]){
    const existing=receipts[0],child=existing.conversation?cvs.conversation(existing.conversation):undefined,request=child&&reviewRequest(child);
    if(!child||!request?.target||request.clientId!==input.clientId||request.role?.id!==asked.id||child.agent!==cv.agent||child.project!==cv.project||child.member!==cv.member||child.direct!==cv.direct)
     throw new OperationError('conflict','Handoff scope changed');
    return {conversation:child.id,item:existing.id,commit:request.target.head,base:request.target.base};
   }
   const hop=self?.hop({job});if(hop)throw new OperationError('denied',hop);
   // Judged again inside the write: the role, its revision and the pull request's head as the brief named them.
   const role=self?.workRoles?.(cv.agent,asked.id,true)[0];
   if(!role || role.revision!==asked.revision)throw new OperationError('conflict','The work role changed; ask again');
   if(!role.available)throw new OperationError('unavailable',role.reason??'No worker that gives a frozen review its read-only copy is available for this work role');
   const again=reviewTargetFor(ctx.viewer,cv.agent,input);
   if(again.head!==target.head || again.change!==target.change)throw new OperationError('conflict','The pull request moved while the review was prepared; ask again');
   const tickets=[...new Set(input.tickets??[])];
   if(tickets.length){
    const readable=new Set(db.select({id:tasks.id}).from(tasks).where(and(inArray(tasks.id,tickets),taskVisibility(ctx.viewer).tasks!(getTableColumns(tasks)))).all().map(row=>row.id));
    const unknown=tickets.filter(id=>!readable.has(id));
    if(unknown.length)throw new OperationError('invalid','Unknown ticket: '+unknown.join(', '));
   }
   const child=cvs.open({agent:cv.agent,venue:'handoff',place:reviewPlace(parent,input.clientId,role,target),label:input.label,project:cv.project,member:cv.member,direct:cv.direct});
   if(child.project!==cv.project||child.member!==cv.member||child.direct!==cv.direct||child.handoffNotBefore!==null)throw new OperationError('conflict','Handoff scope changed');
   linkHandoffTickets(db,child.id,tickets);
   const word=self?.word({job});
   const item=cvs.send({conversation:child.id,toKind:'agent',to:cv.agent,source:'handoff',sourceId:sourceFor(parent),fromKind:'agent',fromId:cv.agent,words:sealed,...(word?{onWordKind:word.kind,onWord:word.id}:{})});
   cvs.turn({conversation:child.id,kind:'message',fromKind:'agent',fromId:cv.agent,outcome:'progressed'});self?.handed({job});
   ctx.changed('conversations',child.id);ctx.changed('inbox',item.id);ctx.changed('turns',child.id);
   return {conversation:child.id,item:item.id,commit:target.head,base:target.base};
  },
 }));
}
