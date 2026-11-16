/** Household changes an agent asks for: a project, a member, an agent's
 * description, the household's own settings, a standing approval rule, or how
 * an agent treats outside people and which tools its body is not given. One
 * Three dangerous actions are proposed the same way: revoking a token, revoking
 * a machine, and signing out a browser. The agent files a card with
 * the exact before and after. A household owner allows it through Approvals,
 * and only then does loom make the change. The agent never becomes an owner.
 *
 * Unlike the runtime proposals this needs no job: a terminal session with the
 * agent's own token may propose. The owner who allows is the authority. */
import {and,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {Viewer} from './policy.js';
import type {DataDatabase} from './core/data/database.js';
import {agents,approvals,members,tokens,boxes,sessions} from './core/data/schema.js';
import {endBrowser} from './core/signin/shared-browser.js';
import type {conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import type {approvalService,Approval} from './apps/approvals.js';
import {householdService,HouseholdError,memberInput,agentInput,settingsInput} from './apps/household.js';
import {projectInput,type sharedProjects} from './shared-projects.js';
import {approvalRuleInput,type approvalRulesService} from './apps/approval-rules.js';
import {agentBodyPolicyInput,readAgentBodyPolicy,saveAgentBodyPolicy} from './shared-agent-body-policy.js';
const operation='household.change';
const kinds={project:projectInput,member:memberInput,agent:agentInput,settings:settingsInput,rule:approvalRuleInput,bodyPolicy:agentBodyPolicyInput,
 // Dangerous, not a setting: it cannot be put back. Named by label because an agent cannot read fingerprints.
 tokenRevoke:z.object({label:z.string().trim().min(1).max(200)}).strict(),
 // A machine by the name people see; a signed-in browser by whose it is and its description.
 boxRevoke:z.object({name:z.string().trim().min(1).max(200)}).strict(),
 browserSignOut:z.object({member:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),device:z.string().trim().min(1).max(200)}).strict()};
// The dangerous actions: none can be put back. Each card says so, and Approvals asks the owner to confirm.
const danger={
 tokenRevoke:{verb:'Revoke',done:'revoked',yes:'The token stops working at once. This cannot be undone.',no:'The token keeps working.'},
 boxRevoke:{verb:'Revoke',done:'revoked',yes:'The machine can no longer run agents or report. This cannot be undone.',no:'The machine stays.'},
 browserSignOut:{verb:'Sign out',done:'signed out',yes:'That browser is signed out at once and its notifications stop. This cannot be undone.',no:'The browser stays signed in.'},
} as const;
const dangerOf=(value:{change:string})=>value.change in danger?danger[value.change as keyof typeof danger]:undefined;
const one=<K extends keyof typeof kinds,S extends z.ZodRawShape>(change:K,more:S)=>z.object({change:z.literal(change),input:kinds[change],...more}).strict();
const all=<S extends z.ZodRawShape>(more:S)=>z.discriminatedUnion('change',[one('project',more),one('member',more),one('agent',more),one('settings',more),one('rule',more),one('bodyPolicy',more),one('tokenRevoke',more),one('boxRevoke',more),one('browserSignOut',more)]);
const proposal=all({}),asked=all({why:z.string().trim().min(1).max(500)});
type Proposal=z.infer<typeof proposal>;
const details=z.object({change:z.enum(['project','member','agent','settings','rule','bodyPolicy','tokenRevoke','boxRevoke','browserSignOut']),before:z.json(),after:z.json()}).strict();
const sorted=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0));
// Rule scopes are matched lower-case for merges; name the card the same way the rule is stored.
const ruleScope=(input:{kind:string;scope:string})=>input.kind==='merge'&&!input.scope.startsWith('project:')?input.scope.toLowerCase():input.scope;
const name=(value:Proposal)=>value.change==='settings'?'':value.change==='rule'?[value.input.kind,ruleScope(value.input),value.input.person].join(' ').trim()
 :value.change==='bodyPolicy'?value.input.agent:value.change==='tokenRevoke'?value.input.label:value.change==='boxRevoke'?value.input.name:value.change==='browserSignOut'?value.input.device+' of '+value.input.member:value.input.id;
const label=(value:Proposal)=>value.change==='tokenRevoke'?'token '+name(value):value.change==='boxRevoke'?'machine '+name(value):value.change==='browserSignOut'?'browser '+name(value):value.change==='settings'?'Household settings':value.change==='rule'?'approval rule '+name(value):value.change==='bodyPolicy'?'how '+name(value)+' treats outside people and tools':value.change+' '+name(value);
const target=(value:Proposal)=>'household:'+(value.change==='settings'?'settings':value.change+':'+name(value));
const summary=(value:Proposal,before:unknown)=>dangerOf(value)?dangerOf(value)!.verb+' '+label(value)+': '+JSON.stringify(before)+' → '+dangerOf(value)!.done
 :label(value)+': '+JSON.stringify(before)+' → '+JSON.stringify(sorted(value.input));
const cardWords=(value:Proposal)=>dangerOf(value)?{ask:dangerOf(value)!.verb+' '+label(value)+'?',ifYes:dangerOf(value)!.yes,ifNo:dangerOf(value)!.no}
 :{ask:'Change '+label(value)+'?',ifYes:'Make the change shown on this card.',ifNo:'Leave it as it is.'};
const kindOf=(value:Proposal)=>dangerOf(value)?'dangerous' as const:'setting' as const;
export function sharedHouseholdProposals(db:DataDatabase,household:ReturnType<typeof householdService>,projects:ReturnType<typeof sharedProjects>,rules:ReturnType<typeof approvalRulesService>,revokeToken:(fingerprint:string)=>unknown,now:()=>string){
 const liveBox=(name:string)=>db.select().from(boxes).where(and(eq(boxes.name,name),isNull(boxes.revokedAt))).get();
 const browsers=(input:{member:string;device:string})=>db.select({id:sessions.id}).from(sessions).innerJoin(tokens,eq(sessions.token,tokens.fingerprint)).where(and(eq(tokens.member,input.member),eq(sessions.device,input.device))).all();
 const liveToken=(label:string)=>db.select().from(tokens).where(and(eq(tokens.label,label),isNull(tokens.revokedAt))).all().find(row=>!row.expiresAt||row.expiresAt>now());
 const appliedCards=new Set<string>();
 // What the change would replace, in the same shape as the input, or null when it would be new.
 const before=(value:Proposal):unknown=>{
  if(value.change==='project'){const row=projects.read().projects.find(row=>row.id===value.input.id);return row?sorted({id:row.id,name:row.name,members:[...row.members].sort(),agents:[...row.agents].sort(),repositories:[...row.repositories].sort()}):null;}
  if(value.change==='member'){const row=household.members().find(row=>row.id===value.input.id);return row?sorted({id:row.id,role:row.role,fullOwner:row.fullOwner,agents:row.agents}):null;}
  if(value.change==='agent'){const row=db.select().from(agents).where(eq(agents.id,value.input.id)).get();return row?sorted({id:row.id,about:row.about,markBg:row.markBg,markFg:row.markFg,faceShape:row.faceShape,faceEyes:row.faceEyes}):null;}
  if(value.change==='rule'){const scope=ruleScope(value.input),row=rules.list().find(row=>row.kind===value.input.kind&&row.scope===scope&&row.person===value.input.person);return row?sorted({kind:row.kind,scope:row.scope,person:row.person,tier:row.tier}):null;}
  if(value.change==='bodyPolicy')return db.select({id:agents.id}).from(agents).where(eq(agents.id,value.input.agent)).get()?sorted(readAgentBodyPolicy(db,value.input.agent)):null;
  if(value.change==='tokenRevoke'){const row=liveToken(value.input.label);return row?sorted({label:row.label,kind:row.kind,for:row.member??row.agent??row.box}):null;}
  if(value.change==='boxRevoke'){const row=liveBox(value.input.name);return row?sorted({name:row.name,owner:row.owner}):null;}
  if(value.change==='browserSignOut'){const rows=browsers(value.input);return rows.length?sorted({member:value.input.member,device:value.input.device,browsers:rows.length}):null;}
  const current=household.settings() as Record<string,unknown>;
  return sorted(Object.fromEntries(Object.keys(value.input).map(key=>[key,current[key]])));
 };
 // Make the change. `by` is the owner on whose word it is made.
 const change=(value:Proposal,by:string)=>{
  try{
   if(value.change==='project')projects.save(value.input);
   else if(value.change==='member')household.setMember(value.input);
   else if(value.change==='agent')household.setAgent(value.input);
   else if(value.change==='settings')household.setSettings(value.input);
   // A rule records who set it: the owner who allowed the card.
   else if(value.change==='rule')rules.set(value.input,by);
   else if(value.change==='bodyPolicy')saveAgentBodyPolicy(db,value.input);
   else if(value.change==='tokenRevoke')revokeToken(liveToken(value.input.label)!.fingerprint);
   else if(value.change==='boxRevoke')db.update(boxes).set({revokedAt:now()}).where(eq(boxes.id,liveBox(value.input.name)!.id)).run();
   else for(const row of browsers(value.input))endBrowser(db,row.id);
  }catch(error){if(error instanceof HouseholdError)throw new OperationError(error.code,error.message);throw error;}
 };
 // Try the change and undo it, so a card that could never be allowed is refused when it is filed.
 const undone=Symbol('rehearsal');
 const rehearse=(value:Proposal)=>{
  const owner=db.select({id:members.id}).from(members).where(eq(members.role,'owner')).get()?.id;
  if(!owner)throw new OperationError('conflict','No household owner can allow this');
  try{db.transaction(()=>{change(value,owner);throw undone;});}catch(error){if(error!==undone)throw error instanceof OperationError?error:new OperationError('invalid','That change cannot be made');}
 };
 const apply=(card:Approval)=>{
  if(card.operation!==operation)throw new OperationError('conflict','Wrong household card');
  const kept=details.parse(JSON.parse(card.details)),value=proposal.parse({change:kept.change,input:kept.after});
  if(card.kind!==kindOf(value)||!card.decidedBy)throw new OperationError('conflict','Wrong household card');
  if(JSON.stringify(before(value))!==JSON.stringify(kept.before))throw new OperationError('conflict','This has changed since the card was filed; ask for a fresh card');
  change(value,card.decidedBy);
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
     if(dangerOf(value)&&was===null)throw new OperationError('not-found',value.change==='tokenRevoke'?'No live token has that label':value.change==='boxRevoke'?'No live machine has that name':'No such signed-in browser');
     if(value.change==='rule'&&was===null&&value.input.tier===null)throw new OperationError('invalid','There is no such rule to remove');
     if(JSON.stringify(was)===JSON.stringify(sorted(value.input)))throw new OperationError('invalid','That is how it already is');
     if(db.select({id:approvals.id}).from(approvals).where(and(eq(approvals.operation,operation),eq(approvals.target,target(value)),eq(approvals.state,'pending'))).get())throw new OperationError('conflict','A card for this is already waiting for an answer');
     rehearse(value);
     const found=current?.(ctx.viewer);
     // Provenance is set here from the authenticated caller, never taken from input.
     const card=service.request({kind:kindOf(value),operation,target:target(value),details:JSON.stringify({change:value.change,before:was,after:sorted(value.input)}),changeSummary:summary(value,was),
      agent:ctx.viewer.id,member:found?.cv.member??null,project:found?.cv.project??null,conversation:found?.cv.id??null,
      askedFrom:found?.cv.id??'terminal',actingFor:found?.cv.member??'unknown',what:summary(value,was),why:raw.why,...cardWords(value)});
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id};
    },
   });
  },
 };
}
