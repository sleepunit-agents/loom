import {reviewPlace,reviewThread} from './review-place.js';
import {conversations,jobs,memberAgents,threads} from '../data/schema.js';
import {handoffPeersAssigned,handoffTarget} from './handoff-access.js';
import {MESSAGE_WORDS_MAX} from './words.js';
/** A current native body hands a brief to another assigned agent. Labels and
 * parent place come from its live conversation, never from caller claims. */
import {and,desc,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {OnWord} from '../../policy.js';
import {inbox} from '../data/schema.js';
import {channelTarget} from './channel-target.js';
import {operation,OperationError,type Operations} from '../operations/index.js';
import {bodyOperationDefaults,conversationBodyScope,requireBodyScope,type BodyProof} from './body-scope.js';
import type {CommsMessages} from './messages.js';
import {sealHandoff} from './handoff-words.js';
import {threadTitle} from './title.js';
import { commsKeepDays } from '../data/comms-days.js';
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
 codexAvailable?(agent:string):boolean;
 word(work:{job:{id:string;agent:string;conversation:string|null}}):OnWord|undefined;
 /** Why this job hands nothing on at all, to its own body elsewhere or to a peer agent, or nothing. */
 hop(work:{job:{id:string;agent:string;conversation:string|null}}):string|undefined;
 /** Told after a new note or brief is written, never of one sent again: for the notice a job that hands many raises. */
 handed(work:{job:{id:string;agent:string;conversation:string|null}}):void;
 /** Told after a note is written, for the notice a long chain raises. */
 sent(note:{chain:string[];startedAt:string;to:string;agent:string}):void;
}
export function registerConversationHandoff(operations:Operations,service:CommsMessages,proof:BodyProof,privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean,self?:HandoffToSelf){
 const db=service.db,cvs=service.threads.conversations,current=conversationBodyScope(db,proof,privateAssignment),requireCurrent=requireBodyScope(current);
 const common=bodyOperationDefaults(current,value=>service.key.hash(value),'body-handoff');
 type Work=NonNullable<ReturnType<typeof current>>;
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
  input:z.object({}).strict().describe('List peer agents assigned to this private conversation and whether a Codex worker can take a new brief now.'),
  output:z.object({agents:z.array(z.string()),codexAvailable:z.boolean()}).strict(),
  may(viewer){const work=current(viewer);return !!work && ownerThread(work);},
  run(ctx){
   const work=requireCurrent(ctx.viewer);
   if(!work.cv.member || !ownerThread(work))throw new OperationError('denied','Private owner conversation required');
   const assigned=db.select({agent:memberAgents.agent}).from(memberAgents).where(eq(memberAgents.member,work.cv.member)).all();
   const agents=assigned.map(row=>row.agent).filter(agent=>peerAllowed(work,agent)).sort();
   return {agents,codexAvailable:self?.codexAvailable?.(work.cv.agent)===true};
  },
 }));
 operations.register(operation({name:'conversation.handoffStatus',write:false,doors:['http'],
  input:z.object({conversation:z.string().min(1).max(200)}).strict().describe('Check a Codex handoff using the child conversation returned by the original handoff.'),
  output:z.object({jobState:z.enum(jobs.state.enumValues).nullable(),resultDelivered:z.boolean()}).strict(),
  may(viewer){const work=current(viewer);return !!work && ownerThread(work);},
  run(ctx,input){
   const work=requireCurrent(ctx.viewer);
   const child=db.select().from(conversations).where(eq(conversations.id,input.conversation)).get();
   const origin=child && reviewThread(db,child);
   if(!ownerThread(work) || !origin || origin.conversation!==work.cv.id)throw new OperationError('denied','Handoff outside this conversation');
   const latest=db.select({state:jobs.state}).from(jobs).where(eq(jobs.conversation,input.conversation))
    .orderBy(desc(jobs.queuedAt),desc(sql`jobs.rowid`)).limit(1).get();
   const delivery=db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.conversation,work.cv.id),eq(inbox.thread,origin.id),
    eq(inbox.source,'handoff'),eq(inbox.sourceId,'review:'+input.conversation),eq(inbox.toKind,'agent'),eq(inbox.to,work.cv.agent))).limit(1).get();
   return {jobState:latest?.state??null,resultDelivered:!!delivery};
  },
 }));
 operations.register(operation({...common,name:'conversation.handoff',
  // To another agent (`agent`), as a brief in a conversation of its own; or to this agent's own body in
  // another conversation (`to`), as mail there that starts its job like any message.
  input:z.object({harness:z.literal('codex').optional(),agent:z.string().min(1).max(200).optional(),to:toSelf.optional(),clientId:z.string().min(1).max(200),label:threadTitle,words:z.string().trim().min(1).max(MESSAGE_WORDS_MAX)}).strict()
   .refine(value=>[value.agent,value.to,value.harness].filter(v=>v!==undefined).length===1),
  output:z.object({conversation:z.string(),item:z.string()}).strict(),
  may(viewer,input){
   const found=current(viewer);if(!found)return false;
   // To itself: the rule is the composition's and is asked in full when the note is prepared and written.
   if(input.harness)return ownerThread(found);
   if(input.to)return !!self;
   return !!input.agent && peerAllowed(found,input.agent);
  },
  // A note to itself is sealed with what the receiving body is told about it: where it came from and by what chain.
  async prepare(input,context){
   const work=input.to?current(context.viewer):undefined;
   const resolved=work&&self?self.target(work,input.to!):undefined;
   const sealed=await sealHandoff(service.key,resolved?`${resolved.told}\n\n${input.words}`:input.words,service.now(),commsKeepDays(db));
   return resolved?{sealed,resolved}:sealed;},
  run(ctx,input,prepared){
   const {job,cv}=requireCurrent(ctx.viewer),sourceId=JSON.stringify([job.id,input.clientId]);
   if(input.to){
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
   const recipient=input.harness?cv.agent:input.agent;
   const place=input.harness?reviewPlace(job.id,input.clientId):job.id;
   if(!recipient)throw new OperationError('invalid','A hand-off names an agent or a place');
   const existing=db.select().from(inbox).where(and(eq(inbox.toKind,'agent'),eq(inbox.to,recipient),eq(inbox.source,'handoff'),eq(inbox.sourceId,sourceId))).get();
   if(existing){
    const target=existing.conversation?cvs.conversation(existing.conversation):undefined;
    if(!target||target.venue!=='handoff'||target.place!==place||target.agent!==recipient||target.project!==cv.project||target.member!==cv.member||target.direct!==cv.direct)throw new OperationError('conflict','Handoff scope changed');
    return {conversation:target.id,item:existing.id};
   }
   // The handoff carries every label that says who may read the words it came from: the project, the member,
   // and whether it was a direct message.
   // The composition's rule for a hand-off of any kind: one hop on anybody else's word.
   const hop=self?.hop({job});if(hop)throw new OperationError('denied',hop);
   if(input.harness && !self?.codexAvailable?.(recipient))throw new OperationError('unavailable','No eligible Codex worker with a signed-in account and free capacity is available for this job.');
   const target=cvs.open({agent:recipient,venue:'handoff',place,label:input.label,project:cv.project,member:cv.member,direct:cv.direct});
   if(target.project!==cv.project||target.member!==cv.member||target.direct!==cv.direct)throw new OperationError('conflict','Handoff scope changed');
   const word=self?.word({job});
   const item=cvs.send({conversation:target.id,toKind:'agent',to:recipient,source:'handoff',sourceId,fromKind:'agent',fromId:cv.agent,words:prepared as string,...(word?{onWordKind:word.kind,onWord:word.id}:{})});
   cvs.turn({conversation:target.id,kind:'message',fromKind:'agent',fromId:cv.agent,outcome:'progressed'});self?.handed({job});
   ctx.changed('conversations',target.id);ctx.changed('inbox',item.id);ctx.changed('turns',target.id);
   return {conversation:target.id,item:item.id};
  },
 }));
}
