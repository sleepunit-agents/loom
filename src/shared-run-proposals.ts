/** Run settings requested by a bound private chat body require a typed Allow. */
import {asc,eq} from 'drizzle-orm';
import {z} from 'zod';
import {mayAct} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import type {DataDatabase} from './core/data/database.js';
import {approvals,agentRunSettings,agentBoxes,agentHousePorts} from './core/data/schema.js';
import {bodyOperationDefaults,type conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import {agentRunSettingsInput,validateAgentRunSettings,applyAgentRunSettings} from './shared-agent-run-settings.js';
const operation='runtime.agentRunSettings';
const details=z.object({agent:agentRunSettingsInput.shape.agent,before:agentRunSettingsInput.nullable(),after:agentRunSettingsInput}).strict();
type Setting=z.infer<typeof agentRunSettingsInput>;
const canonical=(value:Setting):Setting=>({...value,ports:[...value.ports].sort((a,b)=>a.address.localeCompare(b.address,'en')||a.port-b.port)});
const target=(agent:string)=>'runtime:agent-run-settings:'+agent;
const describe=(value:Setting|null)=>value===null?'not configured':'house '+value.houseRepository+' at '+value.houseBranch+' ('+value.houseFile+'); preferred machines: '+(value.boxes.join(', ')||'none')+'; containers '+(value.nestedContainers?'allowed':'not allowed')+'; GPU '+(value.gpu?'allowed':'not allowed')+'; ports: '+(value.ports.map(port=>(port.address.includes(':')?'['+port.address+']':port.address)+':'+port.port).join(', ')||'none');
const summary=(change:z.infer<typeof details>)=>'Run settings for '+change.agent+'. Before: '+describe(change.before)+'. After: '+describe(change.after)+'.';
export function sharedRunProposals(db:DataDatabase){
 const pending=new Set<string>();
 const allowed=(member:string,agent:string)=>mayAct({kind:'member',id:member},{type:'runtime.agent-run-settings',agent},sharedSharing(db),'agent-setup');
 const read=(agent:string):Setting|null=>{
  const row=db.select().from(agentRunSettings).where(eq(agentRunSettings.agent,agent)).get();if(!row)return null;
  return canonical({agent,houseRepository:row.houseRepository,houseFile:row.houseFile,houseBranch:row.houseBranch,nestedContainers:row.nestedContainers,gpu:row.gpu,
   boxes:db.select().from(agentBoxes).where(eq(agentBoxes.agent,agent)).orderBy(asc(agentBoxes.position)).all().map(row=>row.box),
   ports:db.select({address:agentHousePorts.address,port:agentHousePorts.port}).from(agentHousePorts).where(eq(agentHousePorts.agent,agent)).all()});
 };
 const apply=(card:Approval)=>{
  if(card.kind!=='setting'||card.operation!==operation)throw new OperationError('conflict','Wrong run settings card');
  const change=details.parse(JSON.parse(card.details));
  if(change.after.agent!==change.agent||change.before&&change.before.agent!==change.agent||card.target!==target(change.agent)||card.changeSummary!==summary(change)||card.member===null||card.actingFor!==card.member||!allowed(card.member,change.agent))throw new OperationError('denied','Run settings authority changed');
  if(JSON.stringify(read(change.agent))!==JSON.stringify(change.before))throw new OperationError('conflict','Run settings changed; ask for a fresh card');
  applyAgentRunSettings(db,{kind:'member',id:card.member},change.after);pending.add(card.id);
 };
 return{
  operation:[operation,apply]as const,
  committed(changed:()=>void){const applied=[...pending].some(id=>db.select().from(approvals).where(eq(approvals.id,id)).get()?.state==='used');pending.clear();if(applied)changed();},
  register(operations:Operations,current:ReturnType<typeof conversationBodyScope>,service:ReturnType<typeof approvalService>,hash:(value:string)=>string){
   operations.register({...bodyOperationDefaults(current,hash,'run-settings-proposal'),name:'runtime.proposeAgentRunSettings',input:agentRunSettingsInput,output:z.object({id:z.string()}).strict(),
    may(viewer,value){const found=current(viewer);return !!found?.cv.member&&allowed(found.cv.member,value.agent);},
    run(ctx,value){
     const found=current(ctx.viewer);if(!found?.cv.member)throw new OperationError('denied','Private member conversation required');
     validateAgentRunSettings(db,{kind:'member',id:found.cv.member},value);
     const change={agent:value.agent,before:read(value.agent),after:canonical(value)};
     if(JSON.stringify(change.before)===JSON.stringify(change.after))throw new OperationError('invalid','Run settings are unchanged');
     const card=service.request({kind:'setting',operation,target:target(value.agent),details:JSON.stringify(change),changeSummary:summary(change),
      agent:found.cv.agent,member:found.cv.member,actingFor:found.cv.member,project:found.cv.project,conversation:found.cv.id,askedFrom:found.cv.id,
      what:summary(change),why:'Requested in this conversation',ask:'Change run settings for '+value.agent+'?',ifYes:'Apply the run settings shown on this card.',ifNo:'Keep the current run settings.'});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id};
    },
   });
  },
 };
}
