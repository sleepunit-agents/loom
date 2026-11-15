/** Model preference changes requested in chat use the existing inline Approvals
 * transaction. A body files a typed proposal; it never becomes a member. */
import {asc,eq} from 'drizzle-orm';
import {z} from 'zod';
import {mayAct} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import type {DataDatabase} from './core/data/database.js';
import {agentModels,approvals} from './core/data/schema.js';
import {bodyOperationDefaults,type conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import type {ModelRole} from './runtime/placement.js';
const operation='runtime.agentModels';
const models=z.array(z.string().min(1).max(200)).max(64).refine(values=>new Set(values).size===values.length);
const input=z.object({agent:z.string().min(1).max(200),models:models.refine(values=>values.length>0)}).strict();
const details=z.object({agent:input.shape.agent,before:models,after:input.shape.models}).strict();
const target=(agent:string)=>'runtime:agent-models:'+agent;
const summary=(value:z.infer<typeof details>)=>'Models for '+value.agent+': '+JSON.stringify(value.before)+' → '+JSON.stringify(value.after);
export function sharedModelProposals(db:DataDatabase,roles:()=>readonly ModelRole[]){
 const pending=new Set<string>();
 const read=(agent:string)=>db.select().from(agentModels).where(eq(agentModels.agent,agent)).orderBy(asc(agentModels.position)).all().map(row=>row.model);
 const allowed=(member:string,agent:string)=>mayAct({kind:'member',id:member},{type:'runtime.agent-models',agent},sharedSharing(db),'agent-setup');
 const validate=(values:readonly string[])=>{const configured=new Set(roles().map(role=>role.model));if(values.some(value=>!configured.has(value)))throw new OperationError('invalid','Choose configured models');};
 const apply=(card:Approval)=>{
  if(card.kind!=='setting'||card.operation!==operation)throw new OperationError('conflict','Wrong model settings card');
  const value=details.parse(JSON.parse(card.details));
  if(card.target!==target(value.agent)||card.changeSummary!==summary(value)||card.member===null||card.actingFor!==card.member||!allowed(card.member,value.agent))throw new OperationError('denied','Model settings authority changed');
  validate(value.after);
  if(JSON.stringify(read(value.agent))!==JSON.stringify(value.before))throw new OperationError('conflict','Model settings changed; ask for a fresh card');
  db.delete(agentModels).where(eq(agentModels.agent,value.agent)).run();
  db.insert(agentModels).values(value.after.map((model,position)=>({agent:value.agent,model,position}))).run();
  pending.add(card.id);
 };
 return{
  operation:[operation,apply] as const,
  // DataWrites invokes this only after the outer receipt/Allow transaction commits.
  committed(changed:()=>void){const applied=[...pending].some(id=>db.select().from(approvals).where(eq(approvals.id,id)).get()?.state==='used');pending.clear();if(applied)changed();},
  register(operations:Operations,current:ReturnType<typeof conversationBodyScope>,service:ReturnType<typeof approvalService>,hash:(value:string)=>string){
   operations.register({...bodyOperationDefaults(current,hash,'model-proposal'),name:'runtime.proposeAgentModels',input,output:z.object({id:z.string()}).strict(),
    may(viewer,value){const found=current(viewer);return !!found?.cv.member&&allowed(found.cv.member,value.agent);},
    run(ctx,value){
     const found=current(ctx.viewer);if(!found?.cv.member)throw new OperationError('denied','Private member conversation required');
     validate(value.models);const change={agent:value.agent,before:read(value.agent),after:value.models};
     if(JSON.stringify(change.before)===JSON.stringify(change.after))throw new OperationError('invalid','Model settings are unchanged');
     const card=service.request({kind:'setting',operation,target:target(value.agent),details:JSON.stringify(change),changeSummary:summary(change),
      agent:found.cv.agent,member:found.cv.member,actingFor:found.cv.member,project:found.cv.project,conversation:found.cv.id,askedFrom:found.cv.id,
      what:summary(change),why:'Requested in this conversation',ask:'Change models for '+value.agent+'?',ifYes:'Apply the model order shown on this card.',ifNo:'Keep the current models.'});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id};
    },
   });
  },
 };
}
