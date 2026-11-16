/** Household changes an agent asks for: a project, a member, an agent's
 * description, the household's own settings, a standing approval rule, or how
 * an agent treats outside people and which tools its body is not given. The agent files a card with
 * the exact before and after. A household owner allows it through Approvals,
 * and only then does loom make the change. The agent never becomes an owner.
 *
 * Unlike the runtime proposals this needs no job: a terminal session with the
 * agent's own token may propose. The owner who allows is the authority. */
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import type {Viewer} from './policy.js';
import type {DataDatabase} from './core/data/database.js';
import {agents,approvals} from './core/data/schema.js';
import type {conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import {householdService,HouseholdError,memberInput,agentInput,settingsInput} from './apps/household.js';
import {projectInput,type sharedProjects} from './shared-projects.js';
import {approvalRuleInput,type approvalRulesService} from './apps/approval-rules.js';
import {agentBodyPolicyInput,readAgentBodyPolicy,saveAgentBodyPolicy} from './shared-agent-body-policy.js';
const operation='household.change';
const kinds={project:projectInput,member:memberInput,agent:agentInput,settings:settingsInput,rule:approvalRuleInput,bodyPolicy:agentBodyPolicyInput};
const one=<K extends keyof typeof kinds,S extends z.ZodRawShape>(change:K,more:S)=>z.object({change:z.literal(change),input:kinds[change],...more}).strict();
const all=<S extends z.ZodRawShape>(more:S)=>z.discriminatedUnion('change',[one('project',more),one('member',more),one('agent',more),one('settings',more),one('rule',more),one('bodyPolicy',more)]);
const proposal=all({}),asked=all({why:z.string().trim().min(1).max(500)});
type Proposal=z.infer<typeof proposal>;
const details=z.object({change:z.enum(['project','member','agent','settings','rule','bodyPolicy']),before:z.json(),after:z.json()}).strict();
const sorted=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0));
// Rule scopes are matched lower-case for merges; name the card the same way the rule is stored.
const ruleScope=(input:{kind:string;scope:string})=>input.kind==='merge'&&!input.scope.startsWith('project:')?input.scope.toLowerCase():input.scope;
const name=(value:Proposal)=>value.change==='settings'?'':value.change==='rule'?[value.input.kind,ruleScope(value.input),value.input.person].join(' ').trim()
 :value.change==='bodyPolicy'?value.input.agent:value.input.id;
const label=(value:Proposal)=>value.change==='settings'?'Household settings':value.change==='rule'?'approval rule '+name(value):value.change==='bodyPolicy'?'how '+name(value)+' treats outside people and tools':value.change+' '+name(value);
const target=(value:Proposal)=>'household:'+(value.change==='settings'?'settings':value.change+':'+name(value));
const summary=(value:Proposal,before:unknown)=>label(value)+': '+JSON.stringify(before)+' → '+JSON.stringify(sorted(value.input));
const cardWords=(value:Proposal)=>({ask:'Change '+label(value)+'?',ifYes:'Make the change shown on this card.',ifNo:'Leave it as it is.'});
export function sharedHouseholdProposals(db:DataDatabase,household:ReturnType<typeof householdService>,projects:ReturnType<typeof sharedProjects>,rules:ReturnType<typeof approvalRulesService>){
 const appliedCards=new Set<string>();
 // What the change would replace, in the same shape as the input, or null when it would be new.
 const before=(value:Proposal):unknown=>{
  if(value.change==='project'){const row=projects.read().projects.find(row=>row.id===value.input.id);return row?sorted({id:row.id,name:row.name,members:[...row.members].sort(),agents:[...row.agents].sort(),repositories:[...row.repositories].sort()}):null;}
  if(value.change==='member'){const row=household.members().find(row=>row.id===value.input.id);return row?sorted({id:row.id,role:row.role,fullOwner:row.fullOwner,agents:row.agents}):null;}
  if(value.change==='agent'){const row=db.select().from(agents).where(eq(agents.id,value.input.id)).get();return row?sorted({id:row.id,about:row.about,markBg:row.markBg,markFg:row.markFg,faceShape:row.faceShape,faceEyes:row.faceEyes}):null;}
  if(value.change==='rule'){const scope=ruleScope(value.input),row=rules.list().find(row=>row.kind===value.input.kind&&row.scope===scope&&row.person===value.input.person);return row?sorted({kind:row.kind,scope:row.scope,person:row.person,tier:row.tier}):null;}
  if(value.change==='bodyPolicy')return db.select({id:agents.id}).from(agents).where(eq(agents.id,value.input.agent)).get()?sorted(readAgentBodyPolicy(db,value.input.agent)):null;
  const current=household.settings() as Record<string,unknown>;
  return sorted(Object.fromEntries(Object.keys(value.input).map(key=>[key,current[key]])));
 };
 const apply=(card:Approval)=>{
  if(card.kind!=='setting'||card.operation!==operation)throw new OperationError('conflict','Wrong household card');
  const kept=details.parse(JSON.parse(card.details)),value=proposal.parse({change:kept.change,input:kept.after});
  const words=cardWords(value);
  if(card.target!==target(value)||card.changeSummary!==summary(value,kept.before)||card.ask!==words.ask||card.ifYes!==words.ifYes||card.ifNo!==words.ifNo)throw new OperationError('denied','Household card changed');
  if(JSON.stringify(before(value))!==JSON.stringify(kept.before))throw new OperationError('conflict','This has changed since the card was filed; ask for a fresh card');
  try{
   if(value.change==='project')projects.save(value.input);
   else if(value.change==='member')household.setMember(value.input);
   else if(value.change==='agent')household.setAgent(value.input);
   else if(value.change==='settings')household.setSettings(value.input);
   // A rule records who set it: the owner who allowed this card.
   else if(value.change==='rule'){if(!card.decidedBy)throw new OperationError('denied','A household owner is required');rules.set(value.input,card.decidedBy);}
   else saveAgentBodyPolicy(db,value.input);
  }catch(error){if(error instanceof HouseholdError)throw new OperationError(error.code,error.message);throw error;}
  appliedCards.add(card.id);
 };
 return{
  operation:[operation,apply] as const,
  // Called after the outer Allow transaction commits, so readers see the change.
  committed(changed:()=>void){const applied=[...appliedCards].some(id=>db.select().from(approvals).where(eq(approvals.id,id)).get()?.state==='used');appliedCards.clear();if(applied)changed();},
  register(operations:Operations,service:ReturnType<typeof approvalService>,current?:ReturnType<typeof conversationBodyScope>){
   const agent=(viewer:Viewer)=>viewer.kind==='agent'&&!!db.select({id:agents.id}).from(agents).where(eq(agents.id,viewer.id)).get();
   operations.register({name:'household.propose',write:true,recheckPolicy:true,doors:['http'],
    input:asked,output:z.object({id:z.string()}).strict(),may:agent,
    run(ctx,raw){
     const value=proposal.parse({change:raw.change,input:raw.input}),was=before(value);
     if(value.change==='bodyPolicy'&&was===null)throw new OperationError('invalid','Unknown agent');
     if(value.change==='rule'&&was===null&&value.input.tier===null)throw new OperationError('invalid','There is no such rule to remove');
     if(JSON.stringify(was)===JSON.stringify(sorted(value.input)))throw new OperationError('invalid','That is how it already is');
     const found=current?.(ctx.viewer);
     // Provenance is set here from the authenticated caller, never taken from input.
     const card=service.request({kind:'setting',operation,target:target(value),details:JSON.stringify({change:value.change,before:was,after:sorted(value.input)}),changeSummary:summary(value,was),
      agent:ctx.viewer.id,member:found?.cv.member??null,project:found?.cv.project??null,conversation:found?.cv.id??null,
      askedFrom:found?.cv.id??'terminal',actingFor:found?.cv.member??'unknown',what:summary(value,was),why:raw.why,...cardWords(value)});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id};
    },
   });
  },
 };
}
