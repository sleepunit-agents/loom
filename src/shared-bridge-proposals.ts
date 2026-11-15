/** Agent chat prepares configuration; only an owner's exact Allow applies it. */
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {agents,conversations,members,secrets,bridgeConnections,bridgeChannelFilters,bridgeChannels,bridgePeople} from './core/data/schema.js';
import {bodyOperationDefaults,type conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import {mayRunPrivateWork} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import {BridgeSettings,bridgeConfiguration} from './pieces/bridges/settings.js';
const operation='bridges.applyConfiguration';
type Setting=z.infer<typeof bridgeConfiguration>;
type StoredConfiguration=Record<string,unknown>|null;
const details=z.object({before:z.record(z.string(),z.unknown()).nullable(),after:bridgeConfiguration}).strict();
const stable=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const sorted=(values:string[])=>[...new Set(values)].sort();
const canonical=(value:Setting):Setting=>value.action==='connection'?{...value,only:sorted(value.only),ignore:sorted(value.ignore)}:value;
const target=(value:Setting)=>'bridges:configuration:'+stable('id' in value?[value.action,value.id]:'channel' in value?[value.action,value.platform,value.workspace,value.channel]:[value.action,value.platform,value.workspace,value.user]);
export function sharedBridgeProposals(db:DataDatabase,now:()=>string){
 const settings=new BridgeSettings(db,now,write=>write());
 const owner=(id:string)=>db.select().from(members).where(eq(members.id,id)).get()?.role==='owner';
 const connection=(id:string)=>db.select().from(bridgeConnections).where(eq(bridgeConnections.id,id)).get();
 const readConfiguration=(value:Setting):StoredConfiguration=>{
  switch(value.action){
   case 'connection':case 'disconnect':{
    const row=connection(value.id);if(!row)return null;
    const {state:_state,stateAt:_at,...config}=row,filters=db.select().from(bridgeChannelFilters).where(eq(bridgeChannelFilters.connection,value.id)).all();
    return {...config,only:sorted(filters.filter(row=>row.rule==='only').map(row=>row.channel)),ignore:sorted(filters.filter(row=>row.rule==='ignore').map(row=>row.channel))};
   }
   case 'channel':case 'removeChannel':return db.select().from(bridgeChannels).where(and(eq(bridgeChannels.platform,value.platform),eq(bridgeChannels.workspace,value.workspace),eq(bridgeChannels.channel,value.channel))).get()??null;
   case 'person':case 'removePerson':return db.select().from(bridgePeople).where(and(eq(bridgePeople.platform,value.platform),eq(bridgePeople.workspace,value.workspace),eq(bridgePeople.user,value.user))).get()??null;
  }
 };
 const afterState=(value:Setting,before:StoredConfiguration):StoredConfiguration=>{
  if(value.action==='disconnect')return before?{...before,enabled:false}:null;
  if(value.action==='removeChannel'||value.action==='removePerson')return null;
  const {action:_action,...row}=value;return row;
 };
 const validate=(value:Setting,before:StoredConfiguration)=>{
  if(value.action==='connection'){
   if(value.platform==='slack'&&!value.appSecret||value.platform==='discord'&&value.appSecret)throw new OperationError('invalid','Wrong platform credential names');
   if(!db.select().from(agents).where(eq(agents.id,value.agent)).get()||!db.select().from(secrets).where(eq(secrets.name,value.tokenSecret)).get()||(value.appSecret&&!db.select().from(secrets).where(eq(secrets.name,value.appSecret)).get()))throw new OperationError('invalid','Unknown Bridge configuration reference');
   if(before&&(['platform','workspace','botUser','agent'] as const).some(key=>before[key]!==value[key]))throw new OperationError('invalid','Connection identity is fixed');
  }
  if(value.action==='channel'&&!db.select().from(agents).where(eq(agents.id,value.answers)).get())throw new OperationError('invalid','Unknown answering agent');
  if(value.action==='person'&&!db.select().from(members).where(eq(members.id,value.member)).get())throw new OperationError('invalid','Unknown household member');
  if((value.action==='disconnect'||value.action==='removeChannel'||value.action==='removePerson')&&!before)throw new OperationError('invalid','Unknown Bridge configuration');
 };
 const summary=(before:StoredConfiguration,after:Setting)=>'Before: '+stable(before)+'. After: '+stable(afterState(after,before))+'.';
 const apply=(card:Approval)=>{
  if(card.kind!=='setting'||card.operation!==operation)throw new OperationError('conflict','Wrong Bridge configuration card');
  const change=details.parse(JSON.parse(card.details)),conversation=card.conversation?db.select().from(conversations).where(eq(conversations.id,card.conversation)).get():undefined;
  if(!card.member||!owner(card.member)||!card.decidedBy||!owner(card.decidedBy)||card.actingFor!==card.member||card.askedFrom!==card.conversation
   ||!conversation||conversation.member!==card.member||conversation.agent!==card.agent||conversation.project!==card.project
   ||!mayRunPrivateWork({member:card.member,agent:card.agent,project:card.project??undefined},sharedSharing(db)))throw new OperationError('denied','Bridge configuration authority changed');
  if(card.target!==target(change.after)||card.changeSummary!==summary(change.before,change.after)||stable(canonical(change.after))!==stable(change.after))throw new OperationError('conflict','Bridge configuration does not match the card');
  const before=readConfiguration(change.after);
  if(stable(before)!==stable(change.before))throw new OperationError('conflict','Bridge configuration changed; ask for a fresh card');
  validate(change.after,before);
  if(stable(before)===stable(afterState(change.after,before)))throw new OperationError('invalid','Bridge configuration is unchanged');
  settings.change(change.after);
 };
 return {
  operation:[operation,apply]as const,
  register(operations:Operations,current:ReturnType<typeof conversationBodyScope>,service:ReturnType<typeof approvalService>,hash:(value:string)=>string){
   operations.register({...bodyOperationDefaults(current,hash,'bridge-configuration-proposal'),name:'bridges.proposeSettings',input:bridgeConfiguration,output:z.object({id:z.string()}).strict(),
    may(viewer){const found=current(viewer);return !!found?.cv.member&&owner(found.cv.member);},
    run(ctx,input){
     const found=current(ctx.viewer);if(!found?.cv.member||!owner(found.cv.member))throw new OperationError('denied','Private owner conversation required');
     const after=canonical(input),before=readConfiguration(after);validate(after,before);
     if(stable(before)===stable(afterState(after,before)))throw new OperationError('invalid','Bridge configuration is unchanged');
     const changeSummary=summary(before,after);
     const card=service.request({kind:'setting',operation,target:target(after),details:JSON.stringify({before,after}),changeSummary,
      agent:found.cv.agent,member:found.cv.member,actingFor:found.cv.member,project:found.cv.project,conversation:found.cv.id,askedFrom:found.cv.id,
      what:changeSummary,why:'Requested in this conversation',ask:'Change the Bridge configuration shown on this card?',ifYes:'Apply exactly the Bridge configuration shown.',ifNo:'Keep the current Bridge configuration.'});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return {id:card.id};
    },
   });
  },
 };
}
