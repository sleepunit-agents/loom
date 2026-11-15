/** Run settings requested by a bound private chat body require a typed Allow. */
import {asc,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {approvals,agentRunSettings,agentBoxes,agentHousePorts,conversations} from './core/data/schema.js';
import {bodyOperationDefaults,type conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import {agentRunSettingsInput,validateAgentRunSettings,applyAgentRunSettings,mayChangeAgentRunSettings} from './shared-agent-run-settings.js';
const operation='runtime.agentRunSettings';
const details=z.object({agent:agentRunSettingsInput.shape.agent,before:agentRunSettingsInput.nullable(),after:agentRunSettingsInput}).strict();
type Setting=z.infer<typeof agentRunSettingsInput>;
const canonical=(value:Setting):Setting=>({...value,ports:[...value.ports].sort((a,b)=>a.address.localeCompare(b.address,'en')||a.port-b.port)});
const target=(agent:string)=>'runtime:agent-run-settings:'+agent;
const describe=(value:Setting|null)=>value===null?'not configured':'house '+value.houseRepository+' at '+value.houseBranch+' ('+value.houseFile+'); preferred machines: '+(value.boxes.join(', ')||'none')+'; containers '+(value.nestedContainers?'allowed':'not allowed')+'; GPU '+(value.gpu?'allowed':'not allowed')+'; ports: '+(value.ports.map(port=>(port.address.includes(':')?'['+port.address+']':port.address)+':'+port.port).join(', ')||'none');
const summary=(change:z.infer<typeof details>)=>'Run settings for '+change.agent+'. Before: '+describe(change.before)+'. After: '+describe(change.after)+'.';
const cardWords=(change:z.infer<typeof details>)=>({what:summary(change),why:'Requested in this conversation',ask:'Change run settings for '+change.agent+'?',ifYes:'Apply the run settings shown on this card.',ifNo:'Keep the current run settings.'});
export function sharedRunProposals(db:DataDatabase){
 const appliedCards=new Set<string>();
 const allowed=(member:string,agent:string)=>mayChangeAgentRunSettings(db,{kind:'member',id:member},agent);
 const read=(agent:string):Setting|null=>{
  const row=db.select().from(agentRunSettings).where(eq(agentRunSettings.agent,agent)).get();if(!row)return null;
  return canonical({agent,houseRepository:row.houseRepository,houseFile:row.houseFile,houseBranch:row.houseBranch,nestedContainers:row.nestedContainers,gpu:row.gpu,
   boxes:db.select().from(agentBoxes).where(eq(agentBoxes.agent,agent)).orderBy(asc(agentBoxes.position)).all().map(row=>row.box),
   ports:db.select({address:agentHousePorts.address,port:agentHousePorts.port}).from(agentHousePorts).where(eq(agentHousePorts.agent,agent)).all()});
 };
 // Prepared wording is part of intent; a changed format requires a fresh card.
 // SQLite is trusted state; this validates a typed intent, not a signed database.
 const apply=(card:Approval)=>{
  if(card.kind!=='setting'||card.operation!==operation)throw new OperationError('conflict','Wrong run settings card');
  let stored:unknown;try{stored=JSON.parse(card.details);}catch{throw new OperationError('conflict','Run settings card changed');}
  const parsed=details.safeParse(stored);if(!parsed.success)throw new OperationError('conflict','Run settings card changed');const change=parsed.data;
  const source=card.conversation?db.select().from(conversations).where(eq(conversations.id,card.conversation)).get():undefined;
  if(!source||source.agent!==card.agent||source.member!==card.member||source.project!==card.project||card.askedFrom!==source.id||(['what','why','ask','ifYes','ifNo']as const).some(key=>card[key]!==cardWords(change)[key]))throw new OperationError('denied','Run settings card changed');
  if(change.after.agent!==change.agent||change.before&&change.before.agent!==change.agent||card.target!==target(change.agent)||card.changeSummary!==summary(change)||card.member===null||card.actingFor!==card.member||!allowed(card.member,change.agent))throw new OperationError('denied','Run settings authority changed');
  if(JSON.stringify(read(change.agent))!==JSON.stringify(change.before))throw new OperationError('conflict','Run settings changed; ask for a fresh card');
  applyAgentRunSettings(db,{kind:'member',id:card.member},change.after);appliedCards.add(card.id);
 };
 return{
  operation:[operation,apply]as const,
  committed(changed:()=>void){const applied=[...appliedCards].some(id=>db.select().from(approvals).where(eq(approvals.id,id)).get()?.state==='used');appliedCards.clear();if(applied)changed();},
  register(operations:Operations,current:ReturnType<typeof conversationBodyScope>,service:ReturnType<typeof approvalService>,hash:(value:string)=>string){
   operations.register({...bodyOperationDefaults(current,hash,'run-settings-proposal'),name:'runtime.proposeAgentRunSettings',input:agentRunSettingsInput,output:z.object({id:z.string()}).strict(),
    may(viewer,value){const found=current(viewer);return !!found?.cv.member&&allowed(found.cv.member,value.agent);},
    run(ctx,value){
     const found=current(ctx.viewer);if(!found?.cv.member)throw new OperationError('denied','Private member conversation required');
     // Validate the recorded member's proposed edit; this creates no caller credential.
     validateAgentRunSettings(db,{kind:'member',id:found.cv.member},value);
     const change={agent:value.agent,before:read(value.agent),after:canonical(value)};
     const prepared=details.safeParse(change);
     if(!prepared.success||JSON.stringify(prepared.data.before)!==JSON.stringify(change.before))throw new OperationError('conflict','Current run settings need correction');
     if(JSON.stringify(change.before)===JSON.stringify(change.after))throw new OperationError('invalid','Run settings are unchanged');
     const card=service.request({kind:'setting',operation,target:target(value.agent),details:JSON.stringify(change),changeSummary:summary(change),
      agent:found.cv.agent,member:found.cv.member,actingFor:found.cv.member,project:found.cv.project,conversation:found.cv.id,askedFrom:found.cv.id,
      ...cardWords(change)});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id};
    },
   });
  },
 };
}
