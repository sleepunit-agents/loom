import {parseMergeTarget} from './apps/merge-target.js';
import {requestApprovalWithRules} from './apps/approval-request.js';
/** Work commands for an authenticated current body, never input-selected actors.
 * Prepared settings/dangerous actions stay with their typed proposal producers. */
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {approvals,changes} from './core/data/schema.js';
import {bodyOperationDefaults,requireBodyScope,type conversationBodyScope} from './core/conversations/body-scope.js';
import {operation,OperationError,type Operations} from './core/operations/index.js';
import type {approvalService} from './apps/approvals.js';
import {approvalRuleKind,type approvalRulesService} from './apps/approval-rules.js';
import {lastApprovalAnswer} from './apps/approval-answer.js';
import type {Viewer} from './policy.js';

export function registerSharedWorkBody(operations:Operations,db:DataDatabase,service:ReturnType<typeof approvalService>,rules:ReturnType<typeof approvalRulesService>,current:ReturnType<typeof conversationBodyScope>,hash:(text:string)=>string){
 const requireCurrent=requireBodyScope(current),common={...bodyOperationDefaults(current,hash,'body-work'),inputHash:(input:string,identity:Readonly<{actor:Viewer}>)=>{const bound=current(identity.actor);return hash(JSON.stringify(['body-work',bound?.job.id,bound?.cv.id,bound?.cv.agent,bound?.cv.project,bound?.cv.member,input]));}};
 const boundedText=z.string().trim().min(1).max(2000),target=z.object({kind:approvalRuleKind,target:boundedText}).strict();
 const source=(viewer:Viewer)=>{const {cv}=requireCurrent(viewer);return {agent:cv.agent,conversation:cv.id,askedFrom:cv.id,actingFor:cv.member??'unknown',project:cv.project,member:cv.member};};
 const merge=(viewer:Viewer,kind:string,value:string,open=false)=>{
  if(kind!=='merge')return;
  const context=source(viewer),target=parseMergeTarget(value);
  const row=target&&db.select().from(changes).where(eq(changes.id,target.change)).get();
  if(!row||row.headCommit!==target!.head||row.agent!==context.agent||row.project!==context.project||open&&row.state!=='open')throw new OperationError('conflict','Merge target is not the current conversation change');
  return {change:row,head:target!.head};
 };
 const card=(viewer:Viewer,id:string)=>{
  const context=source(viewer),row=db.select().from(approvals).where(eq(approvals.id,id)).get();
  if(!row||row.agent!==context.agent||row.conversation!==context.conversation||row.project!==context.project||row.member!==context.member)throw new OperationError('denied','Approval does not belong to this body conversation');
  return row;
 };
 const belongs=(viewer:Viewer,id:string,checkHead=false)=>{try{if(!current(viewer))return false;const row=card(viewer,id);if(checkHead)merge(viewer,row.kind,row.target);return true;}catch{return false;}};
 operations.register(operation({...common,name:'approvals.request',
  input:target.extend({kind:z.enum(['merge','command']),what:boundedText,why:boundedText,ask:boundedText,ifYes:boundedText,ifNo:boundedText,minutes:z.number().int().min(1).max(1440).optional(),details:z.string().max(100000).optional()}).strict(),
  output:z.object({id:z.string(),state:z.string()}).strict(),
  may(viewer,input){try{if(!current(viewer))return false;merge(viewer,input.kind,input.target,true);return true;}catch{return false;}},
  run(ctx,input){
   const binding=merge(ctx.viewer,input.kind,input.target,true),context=source(ctx.viewer);
   const row=requestApprovalWithRules(db,service,rules,{...input,...context});
   if(binding&&row.state==='allowed')ctx.changed('changes',binding.change.id);
   ctx.changed('approvals',row.id);return {id:row.id,state:service.get(row.id).state};
  },
 }));
 operations.register(operation({...common,write:false,name:'approvals.rule',input:target,
  output:z.object({tier:z.enum(['ask','tell','do']),scope:z.string().nullable(),person:z.string().nullable()}).strict(),
  run(ctx,input){merge(ctx.viewer,input.kind,input.target,true);const context=source(ctx.viewer),rule=lastApprovalAnswer(db,context.agent,input.kind,input.target)?.event==='deny'?undefined:rules.resolve({...input,project:context.project,actingFor:context.actingFor});return {tier:rule?.tier??'ask',scope:rule?.scope??null,person:rule?.person??null};},
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
