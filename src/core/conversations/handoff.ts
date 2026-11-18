import {handoffPeersAssigned,handoffTarget} from './handoff-access.js';
import {MESSAGE_WORDS_MAX} from './words.js';
/** A current native body hands a brief to another assigned agent. Labels and
 * parent place come from its live conversation, never from caller claims. */
import {and,eq} from 'drizzle-orm';
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
 word(work:{job:{id:string;agent:string;conversation:string|null}}):OnWord|undefined;
 /** Why this job hands nothing on at all, to its own body elsewhere or to a peer agent, or nothing. */
 hop(work:{job:{id:string;agent:string;conversation:string|null}}):string|undefined;
 /** Why this job may hand no further note, or nothing: asked as a new note is about to be written, never of one sent again. */
 full(work:{job:{id:string;agent:string;conversation:string|null}}):string|undefined;
 /** Told after a note is written, for the notice a long chain raises. */
 sent(note:{chain:string[];startedAt:string;to:string;agent:string}):void;
}
export function registerConversationHandoff(operations:Operations,service:CommsMessages,proof:BodyProof,privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean,self?:HandoffToSelf){
 const db=service.db,cvs=service.threads.conversations,current=conversationBodyScope(db,proof,privateAssignment),requireCurrent=requireBodyScope(current);
 const common=bodyOperationDefaults(current,value=>service.key.hash(value),'body-handoff');
 operations.register(operation({...common,name:'conversation.handoff',
  // To another agent (`agent`), as a brief in a conversation of its own; or to this agent's own body in
  // another conversation (`to`), as mail there that starts its job like any message.
  input:z.object({agent:z.string().min(1).max(200).optional(),to:toSelf.optional(),clientId:z.string().min(1).max(200),label:threadTitle,words:z.string().trim().min(1).max(MESSAGE_WORDS_MAX)}).strict()
   .refine(value=>(value.agent===undefined)!==(value.to===undefined)),
  output:z.object({conversation:z.string(),item:z.string()}).strict(),
  may(viewer,input){
   const found=current(viewer);if(!found)return false;
   // To itself: the rule is the composition's and is asked in full when the note is prepared and written.
   if(input.to)return !!self;
   if(!input.agent||input.agent===found.cv.agent||!handoffTarget(db,input.agent))return false;
   if(found.cv.member!==null&&!privateAssignment({member:found.cv.member,agent:input.agent,project:found.cv.project??undefined}))return false;
   return found.cv.member!==null&&found.cv.project===null||handoffPeersAssigned(db,found.cv.agent,input.agent,found.cv.project);
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
    const full=self.full({job});if(full)throw new OperationError('conflict',full);
    // Resolved once, when the words were sealed. It is judged again here, and must still be the same: what the
    // receiving body is told and what the row says cannot disagree.
    const {sealed,resolved:how}=prepared as {sealed:string;resolved:ReturnType<HandoffToSelf['target']>},again=self.target({job,cv},input.to);
    if(JSON.stringify([again.conversation,again.open,again.onWord,again.chain])!==JSON.stringify([how.conversation,how.open,how.onWord,how.chain]))throw new OperationError('conflict','The note\'s place or word changed; send it again');
    const target=how.conversation??cvs.open({agent:cv.agent,venue:how.open!.venue,place:how.open!.place,label:how.open!.label}).id;
    const chain=[...how.chain,cv.id];
    const item=cvs.send({conversation:target,toKind:'agent',to:cv.agent,source:'handoff',sourceId,fromKind:'agent',fromId:cv.agent,words:sealed,refs:[cv.id],
     chain:JSON.stringify(chain),chainStartedAt:how.startedAt,...(how.onWord?{onWordKind:how.onWord.kind,onWord:how.onWord.id}:{})});
    cvs.turn({conversation:target,kind:'message',fromKind:'agent',fromId:cv.agent,outcome:'progressed'});
    self.sent({chain,startedAt:how.startedAt,to:target,agent:cv.agent});
    ctx.changed('conversations',target);ctx.changed('inbox',item.id);ctx.changed('turns',target);
    return {conversation:target,item:item.id};
   }
   if(!input.agent)throw new OperationError('invalid','A hand-off names an agent or a place');
   const existing=db.select().from(inbox).where(and(eq(inbox.toKind,'agent'),eq(inbox.to,input.agent),eq(inbox.source,'handoff'),eq(inbox.sourceId,sourceId))).get();
   if(existing){
    const target=existing.conversation?cvs.conversation(existing.conversation):undefined;
    if(!target||target.venue!=='handoff'||target.place!==job.id||target.agent!==input.agent||target.project!==cv.project||target.member!==cv.member||target.direct!==cv.direct)throw new OperationError('conflict','Handoff scope changed');
    return {conversation:target.id,item:existing.id};
   }
   // The handoff carries every label that says who may read the words it came from: the project, the member,
   // and whether it was a direct message.
   // The composition's rules for a hand-off of any kind: one hop on anybody else's word, and the flood guard.
   const hop=self?.hop({job});if(hop)throw new OperationError('denied',hop);
   const full=self?.full({job});if(full)throw new OperationError('conflict',full);
   const target=cvs.open({agent:input.agent,venue:'handoff',place:job.id,label:input.label,project:cv.project,member:cv.member,direct:cv.direct});
   if(target.project!==cv.project||target.member!==cv.member||target.direct!==cv.direct)throw new OperationError('conflict','Handoff scope changed');
   const word=self?.word({job});
   const item=cvs.send({conversation:target.id,toKind:'agent',to:input.agent,source:'handoff',sourceId,fromKind:'agent',fromId:cv.agent,words:prepared as string,...(word?{onWordKind:word.kind,onWord:word.id}:{})});
   cvs.turn({conversation:target.id,kind:'message',fromKind:'agent',fromId:cv.agent,outcome:'progressed'});
   ctx.changed('conversations',target.id);ctx.changed('inbox',item.id);ctx.changed('turns',target.id);
   return {conversation:target.id,item:item.id};
  },
 }));
}
