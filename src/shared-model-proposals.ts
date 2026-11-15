/** Model preference changes requested in chat use the existing inline Approvals
 * transaction. A body files a typed proposal; it never becomes a member. */
import {asc,eq} from 'drizzle-orm';
import {z} from 'zod';
import {mayAct} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import type {DataDatabase} from './core/data/database.js';
import {agentModels,approvals,conversations} from './core/data/schema.js';
import {bodyOperationDefaults,type conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import type {ModelRole} from './runtime/placement.js';
import {agentModelList,agentModelsInput,validateAgentModels,applyAgentModels} from './shared-agent-models.js';
// Short local schema names describe one small boundary; arrays compare by exact ordered JSON.
const operation='runtime.agentModels';
const details=z.object({agent:agentModelsInput.shape.agent,before:agentModelList,after:agentModelsInput.shape.models}).strict();
const target=(agent:string)=>'runtime:agent-models:'+agent;
const summary=(value:z.infer<typeof details>)=>'Models for '+value.agent+': '+JSON.stringify(value.before)+' → '+JSON.stringify(value.after);
const cardWords=(value:z.infer<typeof details>)=>({what:summary(value),why:'Requested in this conversation',ask:'Change models for '+value.agent+'?',ifYes:'Apply the model order shown on this card.',ifNo:'Keep the current models.'});
// SQLite is the application's trusted state. This checks typed/card consistency,
// not an attacker replacing the entire database and its membership/credential rows.
export function sharedModelProposals(db:DataDatabase,roles:()=>readonly ModelRole[]){
 const appliedCards=new Set<string>();
 const read=(agent:string)=>db.select().from(agentModels).where(eq(agentModels.agent,agent)).orderBy(asc(agentModels.position)).all().map(row=>row.model);
 const allowed=(member:string,agent:string)=>mayAct({kind:'member',id:member},{type:'runtime.agent-models',agent},sharedSharing(db),'agent-setup');
  // Keep this static handler specific to model settings; no arbitrary operation delegation.
 const apply=(card:Approval)=>{
  if(card.kind!=='setting'||card.operation!==operation)throw new OperationError('conflict','Wrong model settings card');
  const value=details.parse(JSON.parse(card.details));
  const source=card.conversation?db.select().from(conversations).where(eq(conversations.id,card.conversation)).get():undefined;
  if(!source||source.agent!==card.agent||source.member!==card.member||source.project!==card.project||card.askedFrom!==source.id||(['what','why','ask','ifYes','ifNo']as const).some(key=>card[key]!==cardWords(value)[key]))throw new OperationError('denied','Model settings card changed');
  if(card.target!==target(value.agent)||card.changeSummary!==summary(value)||card.member===null||card.actingFor!==card.member||!allowed(card.member,value.agent))throw new OperationError('denied','Model settings authority changed');
  if(JSON.stringify(read(value.agent))!==JSON.stringify(value.before))throw new OperationError('conflict','Model settings changed; ask for a fresh card');
  applyAgentModels(db,{agent:value.agent,models:value.after},roles());
  appliedCards.add(card.id);
 };
 return{
  operation:[operation,apply] as const,
  // DataWrites invokes this only after the outer receipt/Allow transaction commits.
  committed(changed:()=>void){const applied=[...appliedCards].some(id=>db.select().from(approvals).where(eq(approvals.id,id)).get()?.state==='used');appliedCards.clear();if(applied)changed();},
  register(operations:Operations,current:ReturnType<typeof conversationBodyScope>,service:ReturnType<typeof approvalService>,hash:(value:string)=>string){
   operations.register({...bodyOperationDefaults(current,hash,'model-proposal'),name:'runtime.proposeAgentModels',input:agentModelsInput,output:z.object({id:z.string()}).strict(),
    may(viewer,value){const found=current(viewer);return !!found?.cv.member&&allowed(found.cv.member,value.agent);},
    run(ctx,value){
     const found=current(ctx.viewer);if(!found?.cv.member)throw new OperationError('denied','Private member conversation required');
     validateAgentModels(value.models,roles());const change={agent:value.agent,before:read(value.agent),after:value.models};
     if(JSON.stringify(change.before)===JSON.stringify(change.after))throw new OperationError('invalid','Model settings are unchanged');
     // Explicit provenance stays at this boundary and is never accepted from input.
     const card=service.request({kind:'setting',operation,target:target(value.agent),details:JSON.stringify(change),changeSummary:summary(change),
      agent:found.cv.agent,member:found.cv.member,actingFor:found.cv.member,project:found.cv.project,conversation:found.cv.id,askedFrom:found.cv.id,
      ...cardWords(change)});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id};
    },
   });
  },
 };
}
