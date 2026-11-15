/** Chat prepares metadata only. Approvals applies the exact static change. */
import {asc,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {agents,conversations,household,members,secrets,secretRules,secretRuleAgents} from './core/data/schema.js';
import {bodyOperationDefaults,type conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import {mayRunPrivateWork} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import {SecretRequests} from './pieces/secrets/requests.js';
import {secretName,secretAgent} from './pieces/secrets/input.js';
const operation='secrets.settings';
const answer=z.enum(['ask','auto','never']);
const assignment=z.object({agent:secretAgent,when:z.enum(['on_request','at_start'])}).strict();
const rule=z.object({secret:secretName,answer,minutes:z.number().int().min(1).max(525600),agents:z.array(assignment).max(1000)}).strict();
const setting=z.discriminatedUnion('action',[
 z.object({action:z.literal('default'),answer}).strict(),
 rule.extend({action:z.literal('rule')}).strict(),
]);
const ruleState=z.object({action:z.literal('rule'),secret:secretName,rule:rule.nullable()}).strict();
const state=z.union([z.object({action:z.literal('default'),answer}).strict(),ruleState]);
const details=z.object({before:state,after:setting}).strict();
type Setting=z.infer<typeof setting>;
const canonical=(value:Setting):Setting=>value.action==='default'?value:{...value,agents:[...new Map(value.agents.map(row=>[JSON.stringify([row.agent,row.when]),row])).values()].sort((a,b)=>a.agent.localeCompare(b.agent,'en')||a.when.localeCompare(b.when,'en'))};
const resultingState=(value:Setting):z.infer<typeof state>=>{
 if(value.action==='default')return value;
 const {action:_action,...ruleValue}=value;return {action:'rule',secret:value.secret,rule:ruleValue};
};
const target=(value:Setting)=>value.action==='default'?'secrets:default':'secrets:rule:'+value.secret;
const sameState=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const summary=(change:z.infer<typeof details>)=>'Before: '+JSON.stringify(change.before)+'. After: '+JSON.stringify(change.after)+'.';
export function sharedSecretProposals(db:DataDatabase,now:()=>string){
 const owner=(id:string)=>db.select().from(members).where(eq(members.id,id)).get()?.role==='owner';
 const requests=new SecretRequests(db,now);
 const read=(input:Setting):z.infer<typeof state>=>{
  if(input.action==='default')return {action:'default',answer:db.select().from(household).get()?.secretsDefault??'ask'};
  const found=db.select().from(secretRules).where(eq(secretRules.secret,input.secret)).get();
  return found?resultingState(canonical({action:'rule',...found,agents:db.select({agent:secretRuleAgents.agent,when:secretRuleAgents.when}).from(secretRuleAgents).where(eq(secretRuleAgents.secret,input.secret)).orderBy(asc(secretRuleAgents.agent),asc(secretRuleAgents.when)).all()})):{action:'rule',secret:input.secret,rule:null};
 };
 const validate=(value:Setting)=>{
  if(value.action==='default')return;
  if(!db.select().from(secrets).where(eq(secrets.name,value.secret)).get())throw new OperationError('invalid','Unknown secret');
  for(const row of value.agents)if(!db.select().from(agents).where(eq(agents.id,row.agent)).get())throw new OperationError('invalid','Unknown agent');
 };
 const apply=(card:Approval)=>{
  if(card.kind!=='setting'||card.operation!==operation)throw new OperationError('conflict','Wrong Secret settings card');
  const change=details.parse(JSON.parse(card.details));
  const conversation=card.conversation?db.select().from(conversations).where(eq(conversations.id,card.conversation)).get():undefined;
  if(!card.member||!owner(card.member)||!card.decidedBy||!owner(card.decidedBy))
   throw new OperationError('denied','Secret settings authority changed');
  if(card.actingFor!==card.member||card.askedFrom!==card.conversation||!conversation
   ||conversation.member!==card.member||conversation.agent!==card.agent||conversation.project!==card.project
   ||!mayRunPrivateWork({member:card.member,agent:card.agent,project:card.project??undefined},sharedSharing(db)))
   throw new OperationError('denied','Secret settings conversation changed');
  if(card.target!==target(change.after)||card.changeSummary!==summary(change)||!sameState(canonical(change.after),change.after))throw new OperationError('conflict','Secret settings do not match the card');
  validate(change.after);
  if(!sameState(read(change.after),change.before))throw new OperationError('conflict','Secret settings changed; request a fresh card');
  if(change.after.action==='default')db.insert(household).values({secretsDefault:change.after.answer}).onConflictDoUpdate({target:household.singleton,set:{secretsDefault:change.after.answer}}).run();
  else {const {action:_action,...value}=change.after;requests.setRule(value);}
 };
 return {
  operation:[operation,apply]as const,
  register(operations:Operations,current:ReturnType<typeof conversationBodyScope>,service:ReturnType<typeof approvalService>,hash:(value:string)=>string){
   operations.register({...bodyOperationDefaults(current,hash,'secret-setting-proposal'),name:'secrets.proposeSettings',input:setting,output:z.object({id:z.string()}).strict(),
    may(viewer){const found=current(viewer);return !!found?.cv.member&&owner(found.cv.member);},
    run(ctx,value){
     const found=current(ctx.viewer);if(!found?.cv.member||!owner(found.cv.member))throw new OperationError('denied','Private owner conversation required');
     const after=canonical(value);validate(after);const before=read(after);
     if(sameState(before,resultingState(after)))throw new OperationError('invalid','Secret settings are unchanged');
     const change={before,after};
     const card=service.request({kind:'setting',operation,target:target(after),details:JSON.stringify(change),changeSummary:summary(change),
      agent:found.cv.agent,member:found.cv.member,actingFor:found.cv.member,project:found.cv.project,conversation:found.cv.id,askedFrom:found.cv.id,
      what:summary(change),why:'Requested in this conversation',ask:after.action==='default'?'Change the household Secret default?':'Change the Secret rule for '+after.secret+'?',ifYes:'Apply the Secret settings shown on this card.',ifNo:'Keep the current Secret settings.'});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return {id:card.id};
    },
   });
  },
 };
}
