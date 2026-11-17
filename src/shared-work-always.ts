/** One owner intent grants a standing project rule and answers this exact head.
 * The agent still performs any forge action through its own current checks. */
import {COMMIT,mergeTargetFor} from './apps/merge-target.js';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {approvals,changes} from './core/data/schema.js';
import {type Operations,OperationError} from './core/operations/index.js';
import type {approvalService} from './apps/approvals.js';
import type {approvalRulesService} from './apps/approval-rules.js';
import {changeAnswers} from './apps/changes-answers.js';
import {workAnswersAllowed} from './shared-work-access.js';
const id=z.string().trim().min(1);
const inputSchema=z.object({approval:id,change:id,head:z.string().regex(COMMIT),project:id,person:z.string().max(100)}).strict();
type Input=z.infer<typeof inputSchema>;
export function registerSharedWorkAlways(operations:Operations,db:DataDatabase,service:ReturnType<typeof approvalService>,rules:ReturnType<typeof approvalRulesService>){
 const request=(id:string)=>db.select().from(approvals).where(eq(approvals.id,id)).get();
 const change=(id:string)=>db.select().from(changes).where(eq(changes.id,id)).get();
 const answers=changeAnswers(db,service);
 const binding=(input:Input)=>{
  const card=request(input.approval),row=change(input.change);
  if(!card||!row||card.kind!=='merge'||card.operation!==null||!row.agent||card.agent!==row.agent
   ||card.target!==mergeTargetFor(row.id,input.head)||row.headCommit!==input.head||card.project!==input.project||row.project!==input.project
   ||!card.actingFor||['unknown','?'].includes(card.actingFor))throw new OperationError('conflict','The merge request changed. Open it again.');
  if(rules.personFor(card.actingFor)!==input.person)throw new OperationError('conflict','The person for this request changed. Open it again.');
  return {card,row};
 };
 operations.register({name:'approvals.always',write:true,recheckPolicy:true,input:inputSchema,output:z.object({id}).strict(),
  may(viewer,input){
   // A current household owner, for a card and a change that still exist. run() checks that they match.
   return workAnswersAllowed(db,viewer)&&!!request(input.approval)&&!!change(input.change);
  },
  validateReplay(_viewer,input){binding(input);},
  run(ctx,input){
   if(ctx.viewer.kind!=='member')throw new OperationError('denied','A household owner is required');
   const {card}=binding(input);
   const key=rules.set({kind:'merge',scope:`project:${input.project}`,person:input.person,tier:'do'},ctx.viewer.id);
   try{answers.answer({change:input.change,head:input.head,approval:input.approval,member:ctx.viewer.id,allow:true});}
   catch(error){
    if(error instanceof Error&&['Change is no longer open','Change head has changed','Approval does not match this change','Approval is already answered','Approval cannot be denied now'].includes(error.message))throw new OperationError('conflict','The merge request changed. Open it again.');
    throw error;
   }
   service.recordGrant(card.id,`Standing merge rule for ${input.project}${input.person?` for ${input.person}`:''}`);
   ctx.changed('approvals',card.id);ctx.changed('changes',input.change);ctx.changed('approval_rules',JSON.stringify(key));
   return {id:card.id};
  },
 });
}
