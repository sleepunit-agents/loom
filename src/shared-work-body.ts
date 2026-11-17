import {parseMergeTarget} from './apps/merge-target.js';
import {requestApprovalWithRules} from './apps/approval-request.js';
/** Work commands for an agent's own credential (a current body, or its terminal), never input-selected actors.
 * Prepared settings/dangerous actions stay with their typed proposal producers. */
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {approvals,changes} from './core/data/schema.js';
import {bodyOperationDefaults,requireBodyScope,type conversationBodyScope} from './core/conversations/body-scope.js';
import {operation,OperationError,type Operations} from './core/operations/index.js';
import {ASKED_FROM_TERMINAL,type approvalService} from './apps/approvals.js';
import {approvalRuleKind,approvalTier,type approvalRulesService} from './apps/approval-rules.js';
import {lastApprovalAnswer} from './apps/approval-answer.js';
import {holds,rules as policyRules,workPrincipal,type Viewer} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import {readsRepository} from './apps/changes.js';
import {MESSAGE_WORDS_MAX} from './core/conversations/words.js';

/** Who is asking, taken from the credential and never from input.
 *  - A body in its conversation: the conversation's labels, and its principal (policy.ts, `workPrincipal`).
 *  - The agent's terminal credential, bound to no job: the agent's own work, in no conversation. */
export function registerSharedWorkBody(operations:Operations,db:DataDatabase,service:ReturnType<typeof approvalService>,rules:ReturnType<typeof approvalRulesService>,current:ReturnType<typeof conversationBodyScope>,hash:(text:string)=>string,
 terminal:(viewer:Viewer)=>Readonly<{agent:string}>|undefined){
 // The terminal credential is its agent while the agent is in the household (rule `agentItself`).
 const session=(viewer:Viewer)=>{const own=current(viewer)?undefined:terminal(viewer);return own&&holds(policyRules.agentItself,viewer,{agent:own.agent},sharedSharing(db))?own:undefined;};
 const defaults=bodyOperationDefaults(current,hash,'body-work');
 const common={...defaults,may:(viewer:Viewer)=>!!current(viewer)||!!session(viewer),inputHash:(input:string,identity:Readonly<{actor:Viewer}>)=>{const bound=current(identity.actor);return hash(JSON.stringify(['body-work',bound?.job.id??(session(identity.actor)?'terminal:'+identity.actor.id:undefined),bound?.cv.id,bound?.cv.agent,bound?.cv.project,bound?.cv.member,input]));}};
 const boundedText=z.string().trim().min(1).max(2000),target=z.object({kind:approvalRuleKind,target:boundedText}).strict();
 type Source={own:boolean;agent:string;conversation:string|null;askedFrom:string;actingFor:string;project:string|null;member:string|null};
 const source=(viewer:Viewer):Source=>{
  const bound=current(viewer);
  if(bound){const {cv}=bound;return {own:false,agent:cv.agent,conversation:cv.id,askedFrom:cv.id,actingFor:workPrincipal(cv.agent,cv),project:cv.project,member:cv.member};}
  const own=session(viewer);if(!own)throw new OperationError('denied','An agent\'s own credential is required');
  return {own:true,agent:own.agent,conversation:null,askedFrom:ASKED_FROM_TERMINAL,actingFor:workPrincipal(own.agent,undefined),project:null,member:null};
 };
 // What a merge target is held to, for a rule read, a card filed and a card spent alike.
 // A repository loom reads (apps/changes.ts, `readsRepository`): in a conversation, this agent's change at
 // that head in the conversation's project, as it always was, which keeps a card's project label true; from
 // a terminal, this agent's own change at that head, whose project the card then carries.
 // A repository loom does not read: there is nothing to hold it to but the target's own words, which name
 // one exact commit. It has no project, so a project's rule never answers for it and its card carries none.
 const merge=(context:Source,kind:string,value:string,open=false):{change?:typeof changes.$inferSelect;project:string|null}=>{
  if(kind!=='merge')return {project:context.project};
  const target=parseMergeTarget(value);
  if(target&&!readsRepository(db,target.repository))return {project:null};
  const row=target&&db.select().from(changes).where(eq(changes.id,target.change)).get();
  if(!row||row.headCommit!==target!.head||row.agent!==context.agent||!context.own&&row.project!==context.project||open&&row.state!=='open')
   throw new OperationError('conflict',context.own?'Merge target is not this agent\'s own open change at that commit':'Merge target is not the current conversation change');
  return {change:row,project:context.own?row.project:context.project};
 };
 // The cards a caller may act on: a body, its conversation's; a terminal credential, its own agent's merge
 // and command cards filed from no conversation. Never a household change, and never each other's.
 const card=(viewer:Viewer,id:string)=>{
  const context=source(viewer),row=db.select().from(approvals).where(eq(approvals.id,id)).get();
  const mine=row&&row.agent===context.agent&&row.conversation===context.conversation&&row.member===context.member
   &&(context.own?row.askedFrom===ASKED_FROM_TERMINAL&&row.operation===null&&(row.kind==='merge'||row.kind==='command'):row.project===context.project||row.project===null);
  if(!row||!mine)throw new OperationError('denied',context.own?'Approval is not one this agent filed from a terminal':'Approval does not belong to this body conversation');
  return row;
 };
 const belongs=(viewer:Viewer,id:string,checkHead=false)=>{try{if(!current(viewer)&&!session(viewer))return false;const row=card(viewer,id);if(checkHead)merge(source(viewer),row.kind,row.target);return true;}catch{return false;}};
 operations.register(operation({...common,name:'approvals.request',
  input:target.extend({kind:z.enum(['merge','command']),what:boundedText,why:boundedText,ask:boundedText,ifYes:boundedText,ifNo:boundedText,minutes:z.number().int().min(1).max(1440).optional(),details:z.string().max(MESSAGE_WORDS_MAX).optional()}).strict(),
  output:z.object({id:z.string(),state:z.string()}).strict(),
  may(viewer,input){try{merge(source(viewer),input.kind,input.target,true);return true;}catch{return false;}},
  run(ctx,input){
   const context=source(ctx.viewer),binding=merge(context,input.kind,input.target,true);
   const row=requestApprovalWithRules(db,service,rules,{...input,agent:context.agent,conversation:context.conversation,askedFrom:context.askedFrom,actingFor:context.actingFor,member:context.member,project:binding.project});
   if(binding.change&&row.state==='allowed')ctx.changed('changes',binding.change.id);
   ctx.changed('approvals',row.id);return {id:row.id,state:service.get(row.id).state};
  },
 }));
 operations.register(operation({...common,write:false,name:'approvals.rule',input:target,
  output:z.object({tier:approvalTier,scope:z.string().nullable(),person:z.string().nullable()}).strict(),
  // A read: nothing is filed. A project's rule is read with the project `merge` gives the target. The agent's own work is its account for merges and
  // commands only: a household change with no member behind it always asks (shared-household-proposals.ts).
  run(ctx,input){
   const context=source(ctx.viewer);
   if(context.own&&input.kind!=='merge'&&input.kind!=='command')return {tier:'ask' as const,scope:null,person:null};
   // Held to the same target a card would be: for a repository loom reads, a wrong head, another agent's
   // change or a closed one is refused here as it is at filing, never answered on its words.
   const project=merge(context,input.kind,input.target,true).project;
   const rule=lastApprovalAnswer(db,context.agent,input.kind,input.target)?.event==='deny'?undefined:rules.resolve({...input,project,actingFor:context.actingFor});
   return {tier:rule?.tier??'ask',scope:rule?.scope??null,person:rule?.person??null};
  },
 }));
 operations.register(operation({...common,name:'approvals.report',input:z.object({id:z.string().min(1),what:boundedText}).strict(),output:z.object({id:z.string(),reported:z.literal(true)}).strict(),
  may:(viewer,input)=>belongs(viewer,input.id),
  run(ctx,input){const row=card(ctx.viewer,input.id);service.reportUsed(row.id,row.agent,input.what);ctx.changed('approvals',row.id);return {id:row.id,reported:true as const};},
 }));
 operations.register(operation({...common,name:'approvals.withdraw',input:z.object({id:z.string().min(1)}).strict(),output:z.object({id:z.string(),state:z.literal('withdrawn')}).strict(),
  may:(viewer,input)=>belongs(viewer,input.id),
  run(ctx,input){const row=card(ctx.viewer,input.id);service.withdraw(row.id,row.agent);ctx.changed('approvals',row.id);return {id:row.id,state:'withdrawn' as const};},
 }));
 operations.register(operation({...common,name:'approvals.use',input:target.extend({id:z.string().min(1)}).strict(),output:z.object({id:z.string(),used:z.boolean()}).strict(),
  may:(viewer,input)=>belongs(viewer,input.id,true),
  rejected(viewer,input,failure){if(failure.code==='denied'&&belongs(viewer,input.id)&&!belongs(viewer,input.id,true)){const row=card(viewer,input.id);service.refuseUse(row.id,row.agent,'Cached merge target no longer matches');}},
  run(ctx,input){const row=card(ctx.viewer,input.id),result=service.use(row.id,row.agent,input.kind,input.target);ctx.changed('approvals',row.id);return {id:row.id,used:result.ok};},
 }));
}
