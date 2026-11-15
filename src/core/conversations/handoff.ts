/** A current native body hands a brief to another assigned agent. Labels and
 * parent place come from its live conversation, never from caller claims. */
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {agents,household,inbox,projectAgents} from '../data/schema.js';
import {operation,OperationError,type Operations} from '../operations/index.js';
import {bodyOperationDefaults,conversationBodyScope,requireBodyScope,type BodyProof} from './body-scope.js';
import type {CommsMessages} from './messages.js';
import {sealHandoff} from './handoff-words.js';
import {threadTitle} from './title.js';
export function registerConversationHandoff(operations:Operations,service:CommsMessages,proof:BodyProof,privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean){
 const db=service.db,cvs=service.threads.conversations,current=conversationBodyScope(db,proof,privateAssignment),requireCurrent=requireBodyScope(current);
 const common=bodyOperationDefaults(current,value=>service.key.hash(value),'body-handoff');
 operations.register(operation({...common,name:'conversation.handoff',
  input:z.object({agent:z.string().min(1).max(200),clientId:z.string().min(1).max(200),label:threadTitle,words:z.string().trim().min(1).max(100_000)}).strict(),
  output:z.object({conversation:z.string(),item:z.string()}).strict(),
  may(viewer,input){
   const found=current(viewer);if(!found||input.agent===found.cv.agent||!db.select({id:agents.id}).from(agents).where(eq(agents.id,input.agent)).get())return false;
   if(found.cv.member&&!privateAssignment({member:found.cv.member,agent:input.agent,project:found.cv.project??undefined}))return false;
   return !found.cv.project||[found.cv.agent,input.agent].every(agent=>!!db.select().from(projectAgents).where(and(eq(projectAgents.project,found.cv.project!),eq(projectAgents.agent,agent))).get());
  },
  async prepare(input){return sealHandoff(service.key,input.words,service.now(),db.select({days:household.commsDays}).from(household).get()?.days??14);},
  run(ctx,input,prepared){
   const {job,cv}=requireCurrent(ctx.viewer),sourceId=JSON.stringify([job.id,input.clientId]);
   const existing=db.select().from(inbox).where(and(eq(inbox.toKind,'agent'),eq(inbox.to,input.agent),eq(inbox.source,'handoff'),eq(inbox.sourceId,sourceId))).get();
   if(existing){
    const target=existing.conversation?cvs.conversation(existing.conversation):undefined;
    if(!target||target.venue!=='handoff'||target.place!==job.id||target.agent!==input.agent||target.project!==cv.project||target.member!==cv.member)throw new OperationError('conflict','Handoff scope changed');
    return {conversation:target.id,item:existing.id};
   }
   const target=cvs.open({agent:input.agent,venue:'handoff',place:job.id,label:input.label,project:cv.project,member:cv.member});
   if(target.project!==cv.project||target.member!==cv.member)throw new OperationError('conflict','Handoff scope changed');
   const item=cvs.send({conversation:target.id,toKind:'agent',to:input.agent,source:'handoff',sourceId,fromKind:'agent',fromId:cv.agent,words:prepared as string});
   cvs.turn({conversation:target.id,kind:'message',fromKind:'agent',fromId:cv.agent,outcome:'progressed'});
   ctx.changed('conversations',target.id);ctx.changed('inbox',item.id);ctx.changed('turns',target.id);
   return {conversation:target.id,item:item.id};
  },
 }));
}
