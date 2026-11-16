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
import {and,asc,eq,isNull} from 'drizzle-orm';
import {lastApprovalAnswer} from './apps/approval-answer.js';
import {z} from 'zod';
import type {Viewer} from './policy.js';
import type {DataDatabase} from './core/data/database.js';
import {agents,agentAccounts,agentBoxes,agentHousePorts,agentModels,agentRunSettings,approvals,boxAgents,boxFacts,members,secrets,tokens,boxes,sessions} from './core/data/schema.js';
import {boxSettingsInput,applyBoxSettings} from './shared-box-settings.js';
import {agentRunSettingsInput,applyAgentRunSettings} from './shared-agent-run-settings.js';
import {agentModelsInput,applyAgentModels} from './shared-agent-models.js';
import type {ModelRole} from './runtime/placement.js';
import {household as householdRow,secretRules,secretRuleAgents} from './core/data/schema.js';
import {secretRuleInput,type SecretRequests} from './pieces/secrets/requests.js';
import {houseSecretsInput,setHouseSecrets,readHouseSecrets} from './shared-secret-commands.js';
import {bridgeConfiguration,type BridgeSettings} from './pieces/bridges/settings.js';
import {measuringValues} from './core/measuring/change.js';
import type {MeasuringSettings} from './core/measuring/index.js';
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
 // Secrets: a standing answer for one secret, the household's default, and what an agent's house is handed at start.
 secretRule:secretRuleInput,secretDefault:z.object({answer:z.enum(['ask','auto','never'])}).strict(),houseSecrets:houseSecretsInput,
 // A Discord or Slack connection, who answers in a channel, and which member an outside user is.
 bridge:bridgeConfiguration,
 // Tempo's three timings for one person or agent, and whether loom measures itself.
 tempoTimings:z.object({who:z.object({kind:z.enum(['person','agent']),id:z.string().min(1).max(200)}).strict(),settleSeconds:z.number().int().min(0).max(86400).optional(),dimDays:z.number().int().min(1).max(3650).optional(),muteDays:z.number().int().min(1).max(3650).optional()}).strict()
  .refine(value=>value.settleSeconds!==undefined||value.dimDays!==undefined||value.muteDays!==undefined,'Name at least one timing'),
 measuring:measuringValues,
 // Dangerous, not a setting: it cannot be put back. Named by label because an agent cannot read fingerprints.
 // How things run: a machine's settings, how an agent runs, the models it may use, and its outside accounts.
 boxSettings:boxSettingsInput,runSettings:agentRunSettingsInput,models:agentModelsInput,
 agentAccounts:z.object({agent:z.string().min(1).max(200),github:z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)).max(100).transform(values=>[...new Set(values.map(value=>value.toLowerCase()))].sort())}).strict(),
 // The order people or agents are listed in: every one of them, once.
 order:z.object({of:z.enum(['members','agents']),ids:z.array(z.string().min(1).max(100)).min(1).max(1000)}).strict(),
 // What a secret is for. Its value is never on a card.
 secretDescription:z.object({secret:z.string().min(1).max(200),description:z.string().max(4000)}).strict(),
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
// A standing rule that answers dangerous cards without asking is itself dangerous to set.
const dangerousRule={verb:'Set',done:'answered without asking',yes:'Dangerous actions this rule covers will happen without a card being answered. Removing the rule later does not undo them.',no:'Each dangerous action keeps asking.'} as const;
const dangerOf=(value:{change:string;input?:unknown})=>value.change in danger?danger[value.change as keyof typeof danger]
 :value.change==='rule'&&(value.input as {kind?:string;tier?:string|null}|undefined)?.kind==='dangerous'&&['tell','do'].includes((value.input as {tier?:string|null}).tier??'')?dangerousRule:undefined;
const one=<K extends keyof typeof kinds,S extends z.ZodRawShape>(change:K,more:S)=>z.object({change:z.literal(change),input:kinds[change],...more}).strict();
const all=<S extends z.ZodRawShape>(more:S)=>z.discriminatedUnion('change',[one('project',more),one('member',more),one('agent',more),one('settings',more),one('rule',more),one('bodyPolicy',more),one('secretRule',more),one('secretDefault',more),one('houseSecrets',more),one('bridge',more),one('tempoTimings',more),one('measuring',more),one('boxSettings',more),one('runSettings',more),one('models',more),one('agentAccounts',more),one('order',more),one('secretDescription',more),one('tokenRevoke',more),one('boxRevoke',more),one('browserSignOut',more)]);
const proposal=all({}),asked=all({why:z.string().trim().min(1).max(500)});
type Proposal=z.infer<typeof proposal>;
const details=z.object({change:z.enum(['project','member','agent','settings','rule','bodyPolicy','secretRule','secretDefault','houseSecrets','bridge','tempoTimings','measuring','boxSettings','runSettings','models','agentAccounts','order','secretDescription','tokenRevoke','boxRevoke','browserSignOut']),before:z.json(),after:z.json()}).strict();
const sorted=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0));
// Rule scopes are matched lower-case for merges; name the card the same way the rule is stored.
const ruleScope=(input:{kind:string;scope:string})=>input.kind==='merge'&&!input.scope.startsWith('project:')?input.scope.toLowerCase():input.scope;
const name=(value:Proposal)=>value.change==='settings'?'':value.change==='rule'?[value.input.kind,ruleScope(value.input),value.input.person].join(' ').trim()
 :value.change==='bodyPolicy'?value.input.agent:value.change==='order'?value.input.of:value.change==='secretRule'||value.change==='secretDescription'?value.input.secret:value.change==='secretDefault'||value.change==='measuring'?'':value.change==='houseSecrets'?value.input.agent
 :value.change==='bridge'?[value.input.action,...('id' in value.input?[value.input.id]:'channel' in value.input?[value.input.platform,value.input.workspace,value.input.channel]:[value.input.platform,value.input.workspace,value.input.user])].join(' ')
 :value.change==='tempoTimings'?value.input.who.kind+' '+value.input.who.id
 :value.change==='boxSettings'?value.input.box:value.change==='runSettings'||value.change==='models'||value.change==='agentAccounts'?value.input.agent
 :value.change==='tokenRevoke'?value.input.label:value.change==='boxRevoke'?value.input.name:value.change==='browserSignOut'?value.input.device+' of '+value.input.member:value.input.id;
const label=(value:Proposal)=>value.change==='order'?'the order of '+name(value):value.change==='secretDescription'?'what secret '+name(value)+' is for':value.change==='secretRule'?'who may use secret '+name(value):value.change==='secretDefault'?'the default answer for secrets':value.change==='houseSecrets'?'secrets handed to '+name(value)+' at start'
 :value.change==='bridge'?'bridge '+name(value):value.change==='tempoTimings'?'Tempo timings for '+name(value):value.change==='measuring'?'Measuring'
 :value.change==='boxSettings'?'settings of machine '+value.input.name:value.change==='runSettings'?'how '+name(value)+' runs':value.change==='models'?'models for '+name(value):value.change==='agentAccounts'?'outside accounts of '+name(value)
 :value.change==='tokenRevoke'?'token '+name(value):value.change==='boxRevoke'?'machine '+name(value):value.change==='browserSignOut'?'browser '+name(value):value.change==='settings'?'Household settings':value.change==='rule'?'approval rule '+name(value):value.change==='bodyPolicy'?'how '+name(value)+' treats outside people and tools':value.change+' '+name(value);
const target=(value:Proposal)=>'household:'+(name(value)===''?value.change:value.change+':'+name(value));
const summary=(value:Proposal,before:unknown)=>dangerOf(value)?dangerOf(value)!.verb+' '+label(value)+': '+JSON.stringify(before)+' → '+dangerOf(value)!.done
 :label(value)+': '+JSON.stringify(before)+' → '+JSON.stringify(sorted(value.input));
const cardWords=(value:Proposal)=>dangerOf(value)?{ask:dangerOf(value)!.verb+' '+label(value)+'?',ifYes:dangerOf(value)!.yes,ifNo:dangerOf(value)!.no}
 :{ask:'Change '+label(value)+'?',ifYes:'Make the change shown on this card.',ifNo:'Leave it as it is.'};
const kindOf=(value:Proposal)=>dangerOf(value)?'dangerous' as const:'setting' as const;
export function sharedHouseholdProposals(db:DataDatabase,household:ReturnType<typeof householdService>,projects:ReturnType<typeof sharedProjects>,rules:ReturnType<typeof approvalRulesService>,revokeToken:(fingerprint:string)=>unknown,now:()=>string,
 runtime:{roles():readonly ModelRole[];setAccounts(input:{agent:string;github:string[]}):unknown},
 parts:{secrets:Pick<SecretRequests,'setRule'>;bridges:Pick<BridgeSettings,'read'|'change'>;
  tempo():{timings(who:{kind:'person'|'agent';id:string}):{settleSeconds:number;dimDays:number;muteDays:number};setTimings(who:{kind:'person'|'agent';id:string},patch:{settleSeconds?:number;dimDays?:number;muteDays?:number}):unknown};
  measuring:{read():MeasuringSettings;write(after:MeasuringSettings):void;changed():void}}){
 const listed=(of:'members'|'agents')=>(of==='members'?db.select({id:members.id}).from(members).orderBy(asc(members.position),asc(members.id)):db.select({id:agents.id}).from(agents).orderBy(asc(agents.position),asc(agents.id))).all().map(row=>row.id);
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
  if(value.change==='order')return sorted({of:value.input.of,ids:listed(value.input.of)});
  if(value.change==='secretDescription'){const row=db.select().from(secrets).where(eq(secrets.name,value.input.secret)).get();return row?sorted({secret:row.name,description:row.description}):null;}
  if(value.change==='bodyPolicy')return db.select({id:agents.id}).from(agents).where(eq(agents.id,value.input.agent)).get()?sorted(readAgentBodyPolicy(db,value.input.agent)):null;
  if(value.change==='secretRule'){
   const row=db.select().from(secretRules).where(eq(secretRules.secret,value.input.secret)).get();if(!row)return null;
   return sorted({secret:row.secret,answer:row.answer,minutes:row.minutes,agents:db.select({agent:secretRuleAgents.agent,when:secretRuleAgents.when}).from(secretRuleAgents).where(eq(secretRuleAgents.secret,row.secret)).orderBy(asc(secretRuleAgents.agent),asc(secretRuleAgents.when)).all()});
  }
  if(value.change==='secretDefault')return {answer:db.select().from(householdRow).get()?.secretsDefault??'ask'};
  if(value.change==='houseSecrets')return db.select({id:agents.id}).from(agents).where(eq(agents.id,value.input.agent)).get()?sorted(readHouseSecrets(db,value.input.agent)):null;
  if(value.change==='bridge'){const row=parts.bridges.read(value.input);return row?sorted(row):null;}
  if(value.change==='tempoTimings'){const now=parts.tempo().timings(value.input.who) as Record<string,number>;return sorted({who:value.input.who,...Object.fromEntries(Object.keys(value.input).filter(key=>key!=='who').map(key=>[key,now[key]]))});}
  if(value.change==='measuring')return sorted({...parts.measuring.read()});
  if(value.change==='boxSettings'){
   const row=db.select().from(boxes).where(and(eq(boxes.id,value.input.box),isNull(boxes.revokedAt))).get();if(!row)return null;
   return sorted({box:row.id,name:row.name,hostsAny:row.hostsAny,reportOnly:row.reportOnly,alwaysOn:row.alwaysOn,
    agents:db.select({agent:boxAgents.agent,lent:boxAgents.lent}).from(boxAgents).where(eq(boxAgents.box,row.id)).orderBy(asc(boxAgents.agent)).all(),
    facts:db.select({fact:boxFacts.fact}).from(boxFacts).where(and(eq(boxFacts.box,row.id),eq(boxFacts.fromOwner,true))).orderBy(asc(boxFacts.fact)).all().map(entry=>entry.fact)});
  }
  if(value.change==='runSettings'){
   const row=db.select().from(agentRunSettings).where(eq(agentRunSettings.agent,value.input.agent)).get();if(!row)return null;
   return sorted({agent:row.agent,houseRepository:row.houseRepository,houseFile:row.houseFile,houseBranch:row.houseBranch,nestedContainers:row.nestedContainers,gpu:row.gpu,
    boxes:db.select().from(agentBoxes).where(eq(agentBoxes.agent,row.agent)).orderBy(asc(agentBoxes.position)).all().map(entry=>entry.box),
    ports:db.select({address:agentHousePorts.address,port:agentHousePorts.port}).from(agentHousePorts).where(eq(agentHousePorts.agent,row.agent)).orderBy(asc(agentHousePorts.address),asc(agentHousePorts.port)).all()});
  }
  if(value.change==='models')return sorted({agent:value.input.agent,models:db.select().from(agentModels).where(eq(agentModels.agent,value.input.agent)).orderBy(asc(agentModels.position)).all().map(row=>row.model)});
  if(value.change==='agentAccounts')return sorted({agent:value.input.agent,github:db.select().from(agentAccounts).where(eq(agentAccounts.agent,value.input.agent)).all().map(row=>row.login.toLowerCase()).sort()});
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
   else if(value.change==='secretRule')parts.secrets.setRule(value.input);
   else if(value.change==='secretDefault')db.insert(householdRow).values({secretsDefault:value.input.answer}).onConflictDoUpdate({target:householdRow.singleton,set:{secretsDefault:value.input.answer}}).run();
   else if(value.change==='houseSecrets')setHouseSecrets(db,value.input);
   else if(value.change==='bridge')parts.bridges.change(value.input);
   else if(value.change==='tempoTimings'){const {who,...patch}=value.input;parts.tempo().setTimings(who,patch);}
   else if(value.change==='measuring'){parts.measuring.write(value.input);parts.measuring.changed();}
   else if(value.change==='boxSettings')applyBoxSettings(db,value.input);
   // Run settings are checked as the owner who allowed the card: which machines that person may offer the agent.
   else if(value.change==='runSettings')applyAgentRunSettings(db,{kind:'member',id:by},value.input);
   else if(value.change==='models')applyAgentModels(db,value.input,runtime.roles());
   else if(value.change==='agentAccounts')runtime.setAccounts(value.input);
   else if(value.change==='order'){
    const table=value.input.of==='members'?members:agents,have=listed(value.input.of);
    if(new Set(value.input.ids).size!==value.input.ids.length||have.length!==value.input.ids.length||have.some(id=>!value.input.ids.includes(id)))throw new OperationError('invalid','Name every one of the '+value.input.of+' exactly once');
    value.input.ids.forEach((id,position)=>db.update(table).set({position}).where(eq(table.id,id)).run());
   }
   else if(value.change==='secretDescription'){if(!db.update(secrets).set({description:value.input.description,changedAt:now(),changedBy:by}).where(eq(secrets.name,value.input.secret)).run().changes)throw new OperationError('not-found','No secret has that name');}
   else if(value.change==='tokenRevoke')revokeToken(liveToken(value.input.label)!.fingerprint);
   else if(value.change==='boxRevoke')db.update(boxes).set({revokedAt:now()}).where(eq(boxes.id,liveBox(value.input.name)!.id)).run();
   else for(const row of browsers(value.input))endBrowser(db,row.id);
  }catch(error){
   if(error instanceof HouseholdError)throw new OperationError(error.code,error.message);
   // The services underneath refuse in plain words meant for the caller; storage errors carry a code and stay hidden.
   if(error instanceof Error&&!(error instanceof OperationError)&&!('code' in error)&&error.message.length>0&&error.message.length<=200)throw new OperationError('invalid',error.message);
   throw error;
  }
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

 /** File the card. Installed code may call this directly; from outside it is household.propose. */
 const file=(service:Pick<ReturnType<typeof approvalService>,'request'|'allow'>,agent:string,raw:{change:string;input:unknown;why:string},where?:{conversation:string;member:string|null;project:string|null})=>{
  const value=proposal.parse({change:raw.change,input:raw.input}),was=before(value);
  if(value.change==='bodyPolicy'&&was===null)throw new OperationError('invalid','Unknown agent');
  if(value.change==='boxSettings'&&was===null)throw new OperationError('not-found','No live machine has that id');
  if(value.change in danger&&was===null)throw new OperationError('not-found',value.change==='tokenRevoke'?'No live token has that label':value.change==='boxRevoke'?'No live machine has that name':'No such signed-in browser');
  if(value.change==='rule'&&was===null&&value.input.tier===null)throw new OperationError('invalid','There is no such rule to remove');
  if(JSON.stringify(was)===JSON.stringify(sorted(value.input)))throw new OperationError('invalid','That is how it already is');
  if(db.select({id:approvals.id}).from(approvals).where(and(eq(approvals.operation,operation),eq(approvals.target,target(value)),eq(approvals.state,'pending'))).get())throw new OperationError('conflict','A card for this is already waiting for an answer');
  rehearse(value);
  const card=service.request({kind:kindOf(value),operation,target:target(value),details:JSON.stringify({change:value.change,before:was,after:sorted(value.input)}),changeSummary:summary(value,was),
   agent,member:where?.member??null,project:where?.project??null,conversation:where?.conversation??null,
   askedFrom:where?.conversation??'terminal',actingFor:where?.member??'unknown',what:summary(value,was),why:raw.why,...cardWords(value)});
  // Standing rules answer these cards as they answer merges and commands: for the person the agent is
  // acting for, on a matching target, unless the last answer to this same thing was a deny. A card with no
  // known person behind it always asks. A card that changes a rule always asks: a rule cannot widen the rules.
  if(value.change==='rule')return card;
  const rule=lastApprovalAnswer(db,card.agent,card.kind,card.target)?.event==='deny'?undefined:rules.resolve({kind:card.kind,target:card.target,project:card.project,actingFor:card.actingFor});
  if(!rule||rule.tier==='ask')return card;
  return service.allow(card.id,rule.setBy,`Standing ${rule.tier} rule ${rule.scope} for ${rule.person||'household owner'}, set by ${rule.setBy}`);
 };
 return{
  operation:[operation,apply] as const,
  file,
  // Called after the outer Allow transaction commits, so readers see the change.
  committed(changed:()=>void){const applied=[...appliedCards].some(id=>db.select().from(approvals).where(eq(approvals.id,id)).get()?.state==='used');appliedCards.clear();if(applied)changed();},
  register(operations:Operations,service:ReturnType<typeof approvalService>,current?:ReturnType<typeof conversationBodyScope>){
   const agent=(viewer:Viewer)=>viewer.kind==='agent'&&!!db.select({id:agents.id}).from(agents).where(eq(agents.id,viewer.id)).get();
   operations.register({name:'household.propose',write:true,recheckPolicy:true,doors:['http'],
    input:asked,output:z.object({id:z.string(),state:z.string()}).strict(),may:agent,
    run(ctx,raw){
     const found=current?.(ctx.viewer);
     // Provenance is set here from the authenticated caller, never taken from input.
     const card=file(service,ctx.viewer.id,raw,found?{conversation:found.cv.id,member:found.cv.member,project:found.cv.project}:undefined);
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id,state:card.state};
    },
   });
  },
 };
}
