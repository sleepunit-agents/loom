/** Machine settings requested in private chat become typed inline approvals. */
import {and,asc,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {approvals,boxes,boxAgents,boxFacts} from './core/data/schema.js';
import {bodyOperationDefaults,type conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import {boxSettingsInput,validateBoxSettings,applyBoxSettings,mayChangeBoxSettings} from './shared-box-settings.js';
const operation='runtime.boxSettings';
const details=z.object({owner:z.string(),before:boxSettingsInput,after:boxSettingsInput}).strict();
type Setting=z.infer<typeof boxSettingsInput>;
const canonical=(value:Setting):Setting=>({...value,agents:[...value.agents].sort((a,b)=>a.agent.localeCompare(b.agent,'en')),facts:[...value.facts].sort()});
const target=(box:string)=>'runtime:box-settings:'+box;
const describe=(value:Setting)=>value.name+': '+(value.reportOnly?'reports only':'runs jobs')+', '+(value.alwaysOn?'always on':'on demand')+', '+(value.hostsAny?'any agent':'selected agents')+'; agents: '+(value.agents.map(row=>row.agent+(row.lent?' (lent)':'')).join(', ')||'none')+'; capabilities: '+(value.facts.join(', ')||'none');
const summary=(change:z.infer<typeof details>)=>'Before: '+describe(change.before)+'. After: '+describe(change.after)+'.';
export function sharedBoxProposals(db:DataDatabase){
 const pending=new Set<string>();
 const box=(id:string)=>db.select().from(boxes).where(eq(boxes.id,id)).get();
 const allowed=(member:string,id:string)=>mayChangeBoxSettings(db,{kind:'member',id:member},id);
 const read=(id:string):Setting=>{
  const row=box(id);if(!row||row.revokedAt)throw new OperationError('denied','Available machine required');
  return canonical({box:id,name:row.name,hostsAny:row.hostsAny,reportOnly:row.reportOnly,alwaysOn:row.alwaysOn,
   agents:db.select({agent:boxAgents.agent,lent:boxAgents.lent}).from(boxAgents).where(eq(boxAgents.box,id)).orderBy(asc(boxAgents.agent)).all(),
   facts:db.select({fact:boxFacts.fact}).from(boxFacts).where(and(eq(boxFacts.box,id),eq(boxFacts.fromOwner,true))).orderBy(asc(boxFacts.fact)).all().map(row=>row.fact)});
 };
 const apply=(card:Approval)=>{
  if(card.kind!=='setting'||card.operation!==operation)throw new OperationError('conflict','Wrong machine settings card');
  const change=details.parse(JSON.parse(card.details)),id=change.after.box;
  if(change.before.box!==id||card.target!==target(id)||card.changeSummary!==summary(change)||card.member===null||card.actingFor!==card.member||!allowed(card.member,id))throw new OperationError('denied','Machine settings authority changed');
  if(box(id)?.owner!==change.owner||JSON.stringify(read(id))!==JSON.stringify(change.before))throw new OperationError('conflict','Machine settings changed; ask for a fresh card');
  applyBoxSettings(db,change.after);pending.add(card.id);
 };
 return{
  operation:[operation,apply]as const,
  committed(changed:()=>void){const applied=[...pending].some(id=>db.select().from(approvals).where(eq(approvals.id,id)).get()?.state==='used');pending.clear();if(applied)changed();},
  register(operations:Operations,current:ReturnType<typeof conversationBodyScope>,service:ReturnType<typeof approvalService>,hash:(value:string)=>string){
   operations.register({...bodyOperationDefaults(current,hash,'box-proposal'),name:'runtime.proposeBoxSettings',input:boxSettingsInput,output:z.object({id:z.string()}).strict(),
    may(viewer,value){const found=current(viewer);return !!found?.cv.member&&allowed(found.cv.member,value.box);},
    run(ctx,value){
     const found=current(ctx.viewer);if(!found?.cv.member)throw new OperationError('denied','Private member conversation required');
     validateBoxSettings(db,value);
     const change={owner:box(value.box)!.owner,before:read(value.box),after:canonical(value)};
     if(JSON.stringify(change.before)===JSON.stringify(change.after))throw new OperationError('invalid','Machine settings are unchanged');
     const card=service.request({kind:'setting',operation,target:target(value.box),details:JSON.stringify(change),changeSummary:summary(change),
      agent:found.cv.agent,member:found.cv.member,actingFor:found.cv.member,project:found.cv.project,conversation:found.cv.id,askedFrom:found.cv.id,
      what:summary(change),why:'Requested in this conversation',ask:'Change machine settings for '+value.name+'?',ifYes:'Apply the machine settings shown on this card.',ifNo:'Keep the current machine settings.'});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id};
    },
   });
  },
 };
}
