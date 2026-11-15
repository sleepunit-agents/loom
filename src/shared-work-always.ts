/** One owner intent grants a standing project rule and answers this exact head.
 * The agent still performs any forge action through its own current checks. */
import {eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {approvals,changes,members,approvalRecord} from './core/data/schema.js';
import {type Operations,OperationError} from './core/operations/index.js';
import type {approvalService} from './apps/approvals.js';
import type {approvalRulesService} from './apps/approval-rules.js';
import {changeAnswers} from './apps/changes-answers.js';
import {workAnswersAllowed} from './shared-work-access.js';
import type {WorkAnswerAuthority} from './shared-work-commands.js';
const id=z.string().trim().min(1);
const inputSchema=z.object({approval:id,change:id,head:z.string().regex(/^[a-f0-9]{40}$/),project:id,person:z.string().max(100)}).strict();
type Input=z.infer<typeof inputSchema>;
export function registerSharedWorkAlways(operations:Operations,db:DataDatabase,service:ReturnType<typeof approvalService>,rules:ReturnType<typeof approvalRulesService>,authority?:WorkAnswerAuthority){
 const request=(id:string)=>db.select().from(approvals).where(eq(approvals.id,id)).get();
 const change=(id:string)=>db.select().from(changes).where(eq(changes.id,id)).get();
 const answers=changeAnswers(db,service);
 const binding=(input:Input)=>{
  const card=request(input.approval),row=change(input.change);
  if(!card||!row||card.kind!=='merge'||card.operation!==null||!row.agent||card.agent!==row.agent
   ||card.target!==`${row.id}@${input.head}`||row.headCommit!==input.head||card.project!==input.project||row.project!==input.project
   ||!card.actingFor||['unknown','?'].includes(card.actingFor))throw new OperationError('conflict','The merge request changed. Open it again.');
  const principal=db.select().from(members).where(eq(members.id,card.actingFor)).get();
  if(!principal||(principal.role==='owner'?'':principal.id)!==input.person)throw new OperationError('conflict','The person for this request changed. Open it again.');
  return {card,row};
 };
 operations.register({name:'approvals.always',write:true,recheckPolicy:true,input:inputSchema,output:z.object({id}).strict(),
  may(viewer,input){
   if(!workAnswersAllowed(db,viewer))return false;
   const card=request(input.approval),row=change(input.change);
   return !!card&&!!row&&(!authority||authority.approval(viewer,card)===true)&&(!authority||authority.change(viewer,row,card)===true);
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
   const seq=db.select({n:sql<number>`coalesce(max(${approvalRecord.seq}),0)+1`}).from(approvalRecord).get()!.n;
   db.insert(approvalRecord).values({seq,at:new Date(ctx.now).toISOString(),event:'grant',approval:card.id,agent:card.agent,note:`Standing merge rule for ${input.project}${input.person?` for ${input.person}`:''}`}).run();
   ctx.changed('approvals',card.id);ctx.changed('changes',input.change);ctx.changed('approval_rules',JSON.stringify(key));
   return {id:card.id};
  },
 });
}
