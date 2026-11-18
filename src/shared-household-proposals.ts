/** Household changes an agent asks for: a project, retiring or reviving one, being let onto one, a member, an agent's
 * description, the household's own settings, a standing approval rule, or how
 * an agent treats outside people and which tools its body is not given.
 * Four dangerous actions are proposed the same way: revoking a token, revoking
 * a machine, signing out a browser, and merging one project into another.
 * None of them can be put back, and an owner must also confirm each. The agent files a card with the
 * exact change it asks for. A household owner allows it through Approvals,
 * and only then does loom make the change. The agent never becomes an owner.
 *
 * Unlike the runtime proposals this needs no job: a terminal session with the
 * agent's own token may propose. The owner who allows is the authority.
 *
 * Proposing is a write, and it must not be a way to read. An agent may name
 * anything here: a member, a secret rule, a token by its label, a machine.
 * Most of those it may not read (policy.ts). So nothing the asker gets back,
 * and nothing on the card it and others can read, depends on what is there
 * now: the card holds the change asked for and not what it would replace, and
 * filing does not refuse because the thing is missing, already so, or could
 * never be allowed. What the change would replace is worked out for a household
 * owner when they look at the card (household.proposal). Whether it can be
 * made is found out when an owner allows it: the change is made as that owner,
 * and refused to them in the words of the rule it breaks. The card keeps a
 * keyed digest of what was there when it was filed, which says nothing to a
 * reader and lets Allow refuse a card whose ground has moved.
 *
 * One refusal is made at filing, and it tells the asker nothing it may not
 * read: an agent that asks to be let onto a project it is already on is told
 * so, and no card is filed. An agent reads the projects it is on (policy.ts,
 * rule `project`), so that is its own to know. A body working for a member
 * who is not on the project does not read it, so it is not told: its card is
 * filed, and refused to the owner as already so. A project that is removed or
 * not there is still filed like anything else. A household owner, who may
 * file that one change too and reads the whole household, is told at filing
 * everything that stands against it.
 *
 * A standing approval rule may answer a card as it is filed, except the kinds
 * in `alwaysAsks`, which wait for an owner's own answer every time. */
import {openMachineReview,sealMachineReview} from './core/tempo/machine-review.js';
import { SHA256_HEX } from './core/sha256-hex.js';
import {readMachineReport} from './runtime/machines.js';
import {SILENCE_MS} from './runtime/silence.js';
import {logTrigger} from './core/tempo/triggers.js';
import {triggerLog} from './core/data/schema.js';
import {createHash,randomBytes} from 'node:crypto';
import {and,asc,desc,eq,isNull,like} from 'drizzle-orm';
import {lastApprovalAnswer} from './apps/approval-answer.js';
import {z} from 'zod';
import {householdId} from './slug.js';
import {machineMayHost,maySetTrigger,triggerWorksFor,holds,householdChangePrincipal,rules as policyRules,type Viewer} from './policy.js';
import {householdOwner,householdOwners,sharedSharing} from './shared-sharing.js';
import {tokenLive} from './core/data/authentication.js';
import type {DataDatabase} from './core/data/database.js';
import {agents,agentAccounts,agentBoxes,agentHousePorts,agentModels,agentRunSettings,approvals,boxAgents,boxFacts,bridgeConnections,members,projects as projectRows,secrets,tokens,boxes,sessions} from './core/data/schema.js';
import {boxSettingsInput,applyBoxSettings} from './shared-box-settings.js';
import {agentRunSettingsInput,applyAgentRunSettings} from './shared-agent-run-settings.js';
import {agentModelsInput,applyAgentModels} from './shared-agent-models.js';
import type {ModelRole} from './runtime/placement.js';
import {secretRules,secretRuleAgents} from './core/data/schema.js';
import {secretAnswer,secretRuleInput,type SecretRequests} from './pieces/secrets/requests.js';
import {secretDescription} from './pieces/secrets/input.js';
import {describeSecret} from './pieces/secrets/shared-values.js';
import {houseSecretsInput,setHouseSecrets,readHouseSecrets} from './shared-secret-commands.js';
import {bridgeConfiguration,type BridgeSettings} from './pieces/bridges/settings.js';
import {measuringValues} from './core/measuring/change.js';
import {SETTLE_SECONDS_MAX,QUIET_DAYS_MAX} from './core/tempo/volume.js';
import type {MeasuringSettings} from './core/measuring/index.js';
import {endBrowser} from './core/signin/shared-browser.js';
import type {conversationBodyScope} from './core/conversations/body-scope.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {ASKED_FROM_TERMINAL,type approvalService,type Approval} from './apps/approvals.js';
import {householdService,HouseholdError,memberInput,agentInput,settingsInput,removable,GITHUB_LOGIN} from './apps/household.js';
import {householdSettings} from './core/data/household-settings.js';
import {alreadyOnProject,projectInput,projectJoinInput,projectMergeInput,projectStateInput,type sharedProjects} from './shared-projects.js';
import {approvalRuleInput,type approvalRulesService} from './apps/approval-rules.js';
import {agentBodyPolicyInput,readAgentBodyPolicy,saveAgentBodyPolicy} from './shared-agent-body-policy.js';
import {placeScheduleAsk,placeScheduleCard,placeScheduleRefusal,placeScheduleWords,type PlaceScheduleAsk} from './shared-place-triggers.js';
import {triggers as triggerRows} from './core/data/schema.js';
const operation='household.change';
const kinds={project:projectInput,
 triggerMachine:z.object({trigger:z.string().min(1).max(200),machine:z.string().min(1).max(200),reviewed:z.string().regex(SHA256_HEX).optional()}).strict(),
 // One project emptied into another and removed. Its records cannot be told apart again afterwards.
 projectMerge:projectMergeInput,
 // A project set aside whole, and brought back. Either can be undone by the other, so each is a setting.
 projectRetire:projectStateInput,projectRevive:projectStateInput,
 // One agent let onto one project: what an agent asks when it is told to work somewhere it is not.
 projectJoin:projectJoinInput,
 member:memberInput,agent:agentInput,settings:settingsInput,rule:approvalRuleInput,bodyPolicy:agentBodyPolicyInput,
 // Secrets: a standing answer for one secret, the household's default, and what an agent's house is handed at start.
 secretRule:secretRuleInput,secretDefault:z.object({answer:secretAnswer}).strict(),houseSecrets:houseSecretsInput,
 // A Discord or Slack connection, who answers in a channel, and which member an outside user is.
 bridge:bridgeConfiguration,
 // Tempo's three timings for one person or agent, and whether loom measures itself.
 tempoTimings:z.object({who:z.object({kind:z.enum(['person','agent']),id:z.string().min(1).max(200)}).strict(),settleSeconds:z.number().int().min(0).max(SETTLE_SECONDS_MAX).optional(),dimDays:z.number().int().min(1).max(QUIET_DAYS_MAX).optional(),muteDays:z.number().int().min(1).max(QUIET_DAYS_MAX).optional()}).strict()
  .refine(value=>value.settleSeconds!==undefined||value.dimDays!==undefined||value.muteDays!==undefined,'Name at least one timing'),
 measuring:measuringValues,
 // Dangerous, not a setting: it cannot be put back. Named by label because an agent cannot read fingerprints.
 // How things run: a machine's settings, how an agent runs, the models it may use, and its outside accounts.
 boxSettings:boxSettingsInput,runSettings:agentRunSettingsInput,models:agentModelsInput,
 agentAccounts:z.object({agent:z.string().min(1).max(200),github:z.array(z.string().regex(GITHUB_LOGIN)).max(100).transform(values=>[...new Set(values.map(value=>value.toLowerCase()))].sort())}).strict(),
 // The order people or agents are listed in: every one of them, once.
 order:z.object({of:z.enum(['members','agents']),ids:z.array(z.string().min(1).max(100)).min(1).max(1000)}).strict(),
 // Removing keeps the row and its history: a removed person cannot sign in, a removed agent does not run,
 // a removed project or bridge connection is out of use. Restoring puts it back.
 remove:z.object({of:removable,id:z.string().min(1).max(200)}).strict(),
 restore:z.object({of:removable,id:z.string().min(1).max(200)}).strict(),
 // What a secret is for. Its value is never on a card.
 secretDescription:z.object({secret:z.string().min(1).max(200),description:secretDescription}).strict(),
 tokenRevoke:z.object({label:z.string().trim().min(1).max(200)}).strict(),
 // A machine by the name people see; a signed-in browser by whose it is and its description.
 boxRevoke:z.object({name:z.string().trim().min(1).max(200)}).strict(),
 browserSignOut:z.object({member:householdId,device:z.string().trim().min(1).max(200)}).strict(),
 // A repeating schedule in a Discord or Slack conversation, asked for there by somebody who is not one of the agent's
 // owners (shared-place-triggers.ts, ownersFirst). loom files it; nobody proposes it (`filedByLoom`).
 placeSchedule:placeScheduleAsk};
// The dangerous actions: none can be put back. Each card says so, and Approvals asks the owner to confirm.
const danger={
 projectMerge:{verb:'Merge',done:'merged',yes:'Everything filed under the first project is filed under the second, whose people and agents then see all of it. The first project\'s members, agents and repositories join the second, and the first is removed. This cannot be undone: restoring the first puts back an empty project.',no:'Both projects stay as they are.'},
 tokenRevoke:{verb:'Revoke',done:'revoked',yes:'The token stops working at once. This cannot be undone.',no:'The token keeps working.'},
 boxRevoke:{verb:'Revoke',done:'revoked',yes:'The machine can no longer run agents or report. This cannot be undone.',no:'The machine stays.'},
 browserSignOut:{verb:'Sign out',done:'signed out',yes:'That browser is signed out at once and its notifications stop. This cannot be undone.',no:'The browser stays signed in.'},
} as const;
// A standing rule that answers dangerous cards without asking is itself dangerous to set.
const dangerousRule={verb:'Set',done:'answered without asking',yes:'Dangerous actions this rule covers will happen without a card being answered. Removing the rule later does not undo them.',no:'Each dangerous action keeps asking.'} as const;
/** The kinds an owner must also confirm. */
export const dangerousHouseholdChanges=Object.keys(danger) as Array<keyof typeof danger>;
const dangerOf=(value:{change:string;input?:unknown})=>value.change in danger?danger[value.change as keyof typeof danger]
 :value.change==='rule'&&(value.input as {kind?:string;tier?:string|null}|undefined)?.kind==='dangerous'&&['tell','do'].includes((value.input as {tier?:string|null}).tier??'')?dangerousRule:undefined;
const one=<K extends keyof typeof kinds,S extends z.ZodRawShape>(change:K,more:S)=>z.object({change:z.literal(change),input:kinds[change],...more}).strict();
/** Every kind of household change, once: the keys of `kinds`. The card takes its list from there; the command's
 * input and the `propose` tool (src/shared-mcp-named.ts) take theirs from `householdChanges`, which leaves out
 * the kinds loom files itself. */
const everyChange=Object.keys(kinds) as [keyof typeof kinds,...Array<keyof typeof kinds>];
/** The kinds loom files itself and nobody proposes: who asked is on the card, and that is loom's to say and never a
 * caller's. `household.propose` and the `propose` tool do not take them. */
const filedByLoom:ReadonlySet<string>=new Set<keyof typeof kinds>(['placeSchedule']);
export const householdChanges=everyChange.filter(change=>!filedByLoom.has(change)) as [keyof typeof kinds,...Array<keyof typeof kinds>];
type Kind<S extends z.ZodRawShape>={[K in keyof typeof kinds]:ReturnType<typeof one<K,S>>}[keyof typeof kinds];
const all=<S extends z.ZodRawShape>(more:S,changes:readonly (keyof typeof kinds)[]=everyChange)=>z.discriminatedUnion('change',changes.map(change=>one(change,more)) as unknown as [Kind<S>,...Kind<S>[]]);
const proposal=all({}),asked=all({why:z.string().trim().min(1).max(500)},householdChanges);
type Proposal=z.infer<typeof proposal>;
const changeName=z.enum(everyChange);
// What a card keeps: the change asked for, and a keyed digest of what it would replace (see the file header).
const details=z.object({change:changeName,after:z.json(),machineReview:z.string().optional(),previousApproval:z.string().optional(),seal:z.object({nonce:z.string(),digest:z.string()}).strict()}).strict();
// A card from before the digest kept the replaced value itself; those are rewritten once, at start.
const olderDetails=z.object({change:changeName,before:z.json(),after:z.json()}).strict();
const sorted=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0));
// Rule scopes are matched lower-case for merges; name the card the same way the rule is stored.
const ruleScope=(input:{kind:string;scope:string})=>input.kind==='merge'&&!input.scope.startsWith('project:')?input.scope.toLowerCase():input.scope;
const name=(value:Proposal)=>value.change==='triggerMachine'?value.input.trigger:value.change==='settings'?'':value.change==='rule'?[value.input.kind,ruleScope(value.input),value.input.person].join(' ').trim()
 :value.change==='bodyPolicy'?value.input.agent:value.change==='remove'||value.change==='restore'?value.input.of+' '+value.input.id:value.change==='order'?value.input.of:value.change==='secretRule'||value.change==='secretDescription'?value.input.secret:value.change==='secretDefault'||value.change==='measuring'?'':value.change==='houseSecrets'?value.input.agent
 :value.change==='bridge'?[value.input.action,...('id' in value.input?[value.input.id]:'channel' in value.input?[value.input.platform,value.input.workspace,value.input.channel]:[value.input.platform,value.input.workspace,value.input.user])].join(' ')
 :value.change==='tempoTimings'?value.input.who.kind+' '+value.input.who.id
 :value.change==='boxSettings'?value.input.box:value.change==='runSettings'||value.change==='models'||value.change==='agentAccounts'?value.input.agent
 :value.change==='tokenRevoke'?value.input.label:value.change==='boxRevoke'?value.input.name:value.change==='browserSignOut'?value.input.device+' of '+value.input.member
 :value.change==='projectMerge'?value.input.from+' into '+value.input.into:value.change==='projectJoin'?value.input.agent+' onto project '+value.input.project
 :value.change==='projectRetire'||value.change==='projectRevive'?value.input.project:value.change==='placeSchedule'?(value.input.action==='set'?value.input.trigger.id:value.input.id):value.input.id;
const label=(value:Proposal)=>value.change==='triggerMachine'?'machine request for schedule '+value.input.trigger:value.change==='placeSchedule'?'a repeating schedule in conversation '+value.input.conversation:value.change==='remove'||value.change==='restore'?name(value):value.change==='projectMerge'?'project '+name(value):value.change==='order'?'the order of '+name(value):value.change==='secretDescription'?'what secret '+name(value)+' is for':value.change==='secretRule'?'who may use secret '+name(value):value.change==='secretDefault'?'the default answer for secrets':value.change==='houseSecrets'?'secrets handed to '+name(value)+' at start'
 :value.change==='bridge'?'bridge '+name(value):value.change==='tempoTimings'?'Tempo timings for '+name(value):value.change==='measuring'?'Measuring'
 :value.change==='boxSettings'?'settings of machine '+value.input.name:value.change==='runSettings'?'how '+name(value)+' runs'+(value.input.houseFile===''?', in the core house with no Housefile of its own':''):value.change==='models'?'models for '+name(value):value.change==='agentAccounts'?'outside accounts of '+name(value)
 :value.change==='tokenRevoke'?'token '+name(value):value.change==='boxRevoke'?'machine '+name(value):value.change==='browserSignOut'?'browser '+name(value):value.change==='settings'?'Household settings':value.change==='rule'?'approval rule '+name(value):value.change==='bodyPolicy'?'how '+name(value)+' treats outside people and tools':value.change+' '+name(value);
const target=(value:Proposal)=>'household:'+(name(value)===''?value.change:(value.change==='restore'?'remove':value.change)+':'+name(value));
// The card's own words, for everyone who may read it: the change asked for, never what it would replace.
const mergeWords=(value:Proposal)=>'Merge '+label(value)+'. Everything filed under the first is filed under the second, and the first is removed.';
const joinWords=(value:Proposal)=>value.change==='projectJoin'?'Let '+value.input.agent+' work on project '+value.input.project:'';
const stateWords=(value:Proposal)=>value.change==='projectRetire'?'Retire project '+name(value)+'. Everything in it stays and stays readable; its unfinished tasks are shelved until it is revived.'
 :'Revive project '+name(value)+'. Its shelved tasks are work again, as they were.';
const isState=(value:Proposal):value is Extract<Proposal,{change:'projectRetire'|'projectRevive'}>=>value.change==='projectRetire'||value.change==='projectRevive';
const said=(value:Proposal)=>value.change==='placeSchedule'?placeScheduleWords(value.input):isState(value)?stateWords(value):value.change==='projectMerge'?mergeWords(value):value.change==='projectJoin'?joinWords(value)+'. Nothing else about the project changes.':value.change==='remove'?'Remove '+label(value)+'. Its history stays.':value.change==='restore'?'Restore '+label(value):value.change in danger?danger[value.change as keyof typeof danger].verb+' '+label(value)
 :label(value)+': '+JSON.stringify(sorted(value.input));
// The same with what it would replace, for a household owner.
const summary=(value:Proposal,before:unknown)=>value.change==='placeSchedule'?placeScheduleWords(value.input)+(value.input.action==='edit'?' As it stands: '+JSON.stringify(before):''):isState(value)?stateWords(value)+' As it stands: '+JSON.stringify(before):value.change==='projectMerge'?mergeWords(value)+' As they stand: '+JSON.stringify(before):value.change==='projectJoin'?joinWords(value)+'. As it stands: '+JSON.stringify(before):value.change==='remove'?'Remove '+label(value)+'. Its history stays.':value.change==='restore'?'Restore '+label(value):dangerOf(value)?dangerOf(value)!.verb+' '+label(value)+': '+JSON.stringify(before)+' → '+dangerOf(value)!.done
 :label(value)+': '+JSON.stringify(before)+' → '+JSON.stringify(sorted(value.input));
const cardWords=(value:Proposal)=>value.change==='triggerMachine'?{ask:'Review the machine request for schedule '+value.input.trigger+'?',ifYes:'Allow this agent to run these exact instructions as the worker user on the named machine. The current server still refuses execution.',ifNo:'The trigger does not fire.'}:value.change==='placeSchedule'?placeScheduleCard(value.input):dangerOf(value)?{ask:dangerOf(value)!.verb+' '+label(value)+'?',ifYes:dangerOf(value)!.yes,ifNo:dangerOf(value)!.no}
 :value.change==='projectRetire'?{ask:'Retire project '+name(value)+'?',ifYes:'Nothing is deleted or closed, and who reads it does not change. Its unfinished tasks are shelved: not ready, not counted as open work, and none can be claimed; one already held keeps who holds it. No new task is filed under it. Reviving it brings everything back as it was.',ifNo:'It stays in use.'}
 :value.change==='projectRevive'?{ask:'Revive project '+name(value)+'?',ifYes:'Its shelved tasks are work again, each as it was left.',ifNo:'It stays retired.'}
 :value.change==='projectJoin'?{ask:joinWords(value)+'?',ifYes:value.input.agent+' is added to project '+value.input.project+' and sees what is filed under it. Nothing else about the project changes.',ifNo:value.input.agent+' stays off the project.'}
 :value.change==='remove'?{ask:'Remove '+label(value)+'?',ifYes:'It is taken out of use. Its history stays, and it can be restored.',ifNo:'It stays as it is.'}
 :value.change==='restore'?{ask:'Restore '+label(value)+'?',ifYes:'It is put back in use.',ifNo:'It stays removed.'}
 :{ask:'Change '+label(value)+'?',ifYes:'Make the change shown on this card.',ifNo:'Leave it as it is.'};
/** The kinds no standing rule answers: each card waits for a household owner's own answer.
 *  - `rule`: a rule cannot widen the rules.
 *  - `projectJoin`: being on a project lets an agent read what is filed under it. A blanket rule for
 *    settings is not an owner saying this agent may read that project, so it never answers for one. The
 *    card is still a setting: one plain Allow, with nothing more to confirm.
 *  - `projectMerge`: a merge cannot be undone, and it shows each project's people the other's records. A
 *    rule for dangerous actions, set for revocations, is not an owner looking at these two projects: the
 *    owner allows and confirms each merge by hand.
 *  - `placeSchedule`: a repeating schedule somebody who is not an owner asked for in a shared place. The owner
 *    ruled that such a request is asked of an owner; a rule for settings is not an owner reading this
 *    person's words and times. */
export const alwaysAsks:ReadonlySet<string>=new Set<keyof typeof kinds>(['rule','projectJoin','projectMerge','placeSchedule','triggerMachine']);
const kindOf=(value:Proposal)=>dangerOf(value)?'dangerous' as const:'setting' as const;
export function sharedHouseholdProposals(db:DataDatabase,household:ReturnType<typeof householdService>,projects:ReturnType<typeof sharedProjects>,rules:ReturnType<typeof approvalRulesService>,revokeToken:(fingerprint:string)=>unknown,now:()=>string,
 runtime:{roles():readonly ModelRole[];setAccounts(input:{agent:string;github:string[]}):unknown},
 parts:{secrets:Pick<SecretRequests,'setRule'>;machines:{revoke(id:string):void};bridges:Pick<BridgeSettings,'read'|'change'>;
  /** Carry out an allowed `placeSchedule` card: set the trigger, or change it, on the asker's word (shared-tempo.ts). */
  schedule(ask:PlaceScheduleAsk):unknown;
  triggerWords?(trigger:typeof triggerRows.$inferSelect):string;
  tempo():{timings(who:{kind:'person'|'agent';id:string}):{settleSeconds:number;dimDays:number;muteDays:number};setTimings(who:{kind:'person'|'agent';id:string},patch:{settleSeconds?:number;dimDays?:number;muteDays?:number}):unknown};
  measuring:{read():MeasuringSettings;write(after:MeasuringSettings):void;changed():void};
  /** A keyed digest only this program can make or check. */
  digest(words:string):string;
  /** Told, in one line, when existing cards were rewritten at start (below). */
  note?(line:string):void}){
 const listed=(of:'members'|'agents')=>(of==='members'?db.select({id:members.id}).from(members).orderBy(asc(members.position),asc(members.id)):db.select({id:agents.id}).from(agents).orderBy(asc(agents.position),asc(agents.id))).all().map(row=>row.id);
 const liveBox=(name:string)=>db.select().from(boxes).where(and(eq(boxes.name,name),isNull(boxes.revokedAt))).get();
 const browsers=(input:{member:string;device:string})=>db.select({id:sessions.id}).from(sessions).innerJoin(tokens,eq(sessions.token,tokens.fingerprint)).where(and(eq(tokens.member,input.member),eq(sessions.device,input.device))).all();
 const liveToken=(label:string)=>db.select().from(tokens).where(eq(tokens.label,label)).all().find(row=>tokenLive(row,Date.parse(now())));
 const appliedCards=new Set<string>();
 const getTrigger=(id:string)=>db.select().from(triggerRows).where(eq(triggerRows.id,id)).get();
 const canRequestMachine=(viewer:Viewer,id:string)=>{
  const row=getTrigger(id),sharing=sharedSharing(db);
  if(viewer.kind==='agent'&&viewer.workingFor!==undefined)return false;
  if(!row||row.member||row.targetKind!=='inbox'||row.toKind!=='agent'||!row.to||row.conversation||triggerWorksFor(row,sharing))return false;
  const own=row.ownerKind==='agent'&&row.owner===row.to;
  const byOwner=row.ownerKind==='household'||row.ownerKind==='member'&&!!row.owner&&householdOwner(db,{kind:'member',id:row.owner});
  return (own||byOwner)&&maySetTrigger(viewer,row,sharing)&&(viewer.kind==='agent'?viewer.id===row.to:householdOwner(db,viewer));
 };
 const machineReview=(input:{trigger:string;machine:string},resolved?:string)=>{
  const row=getTrigger(input.trigger),box=db.select().from(boxes).where(eq(boxes.id,input.machine)).get();
  let words:string|null=null;
  if(row)try{words=resolved??parts.triggerWords?.(row)??null;}catch{/* An unreadable file must never authorize a firing. */}
  const listed=row?.to&&box?db.select().from(boxAgents).where(and(eq(boxAgents.box,box.id),eq(boxAgents.agent,row.to))).get():undefined;
  const report=box?readMachineReport(db,box.id):undefined;
  const reportAge = Date.parse(now()) - Date.parse(box?.lastSeenAt ?? '');
 const problem=!row||!box||box.revokedAt||box.reportOnly?'The requested trigger or machine is unavailable'
   :!row.to||!machineMayHost(box,listed||undefined,row.to,sharedSharing(db))?'The machine may not host this agent'
   :words===null?'The trigger words are unavailable'
   :!report?.enabled?'The worker has not reported support for machine bodies'
   :!report.agents.includes(row.to)?'The worker does not allow this agent'
   :!Number.isFinite(reportAge)||reportAge<0||reportAge>SILENCE_MS?'The machine is away':null;
  return {row,box,words,report,problem};
 };
 const reviewText=(review:ReturnType<typeof machineReview>)=>[
  review.row?.to,review.box?.name,
  review.report?`Worker user: ${review.report.user} · Starting directory: ${review.report.cwd}`:'Worker user and working directory unreported',
  review.row?.note,[review.row?.days,review.row?.times??review.row?.watches].filter(Boolean).join(' '),
  'A machine body runs as the worker’s own user. It can read the worker credentials, model sign-ins and that user’s SSH keys. On Loom’s machine, running as Loom’s user gives it access to Loom’s database. Approval covers these words. They cannot confine what the process does.',
  review.row?.file,'Trigger words (complete)',review.words??'Trigger words unavailable'].filter(part=>part!=null).join('\n');
 const before=(value:Proposal,review?:ReturnType<typeof machineReview>):unknown=>{
  if(value.change==='triggerMachine'){
   const {row,words,report}=review??machineReview(value.input);
   const generation=db.select({seq:triggerLog.seq}).from(triggerLog).where(and(eq(triggerLog.trigger,value.input.trigger),eq(triggerLog.event,'machine-request'))).orderBy(desc(triggerLog.seq)).limit(1).get()?.seq;
   return {agent:row?.to,machine:row?.machine,prior:row?.machineApproval,generation,words,owner:row?.owner,ownerKind:row?.ownerKind,conversation:row?.conversation,user:report?.user,cwd:report?.cwd};
  }
  if(value.change==='project'){const row=projects.read().projects.find(row=>row.id===value.input.id);return row?sorted({id:row.id,name:row.name,members:[...row.members].sort(),agents:[...row.agents].sort(),repositories:[...row.repositories].sort()}):null;}
  if(value.change==='projectMerge')return sorted({from:projects.describe(value.input.from),into:projects.describe(value.input.into)});
  if(isState(value)){const project=projects.describe(value.input.project);return sorted({project:project&&{id:project.id,removed:project.removed,retired:project.retired}});}
  // A join card is sealed on what it changes and nothing more: that the project and the agent are in use, and
  // whether that agent is on it. Another agent let onto the same project meanwhile does not move its ground.
  if(value.change==='projectJoin'){const project=projects.describe(value.input.project),agent=db.select({id:agents.id,removedAt:agents.removedAt}).from(agents).where(eq(agents.id,value.input.agent)).get();
   return sorted({project:project&&{id:project.id,removed:project.removed},agent:agent?{id:agent.id,removed:!!agent.removedAt}:null,on:!!project?.agents.includes(value.input.agent)});}
  if(value.change==='member'){const row=household.members().find(row=>row.id===value.input.id);return row?sorted({id:row.id,role:row.role,fullOwner:row.fullOwner,agents:row.agents}):null;}
  if(value.change==='agent'){const row=db.select().from(agents).where(eq(agents.id,value.input.id)).get();return row?sorted({id:row.id,about:row.about,markBg:row.markBg,markFg:row.markFg,faceShape:row.faceShape,faceEyes:row.faceEyes}):null;}
  if(value.change==='rule'){const scope=ruleScope(value.input),row=rules.list().find(row=>row.kind===value.input.kind&&row.scope===scope&&row.person===value.input.person);return row?sorted({kind:row.kind,scope:row.scope,person:row.person,tier:row.tier}):null;}
  if(value.change==='remove'||value.change==='restore'){
   const table=value.input.of==='member'?members:value.input.of==='agent'?agents:value.input.of==='project'?projectRows:bridgeConnections;
   const row=db.select({id:table.id,removedAt:table.removedAt}).from(table).where(eq(table.id,value.input.id)).get();
   return row?sorted({of:value.input.of,id:row.id,removed:!!row.removedAt}):null;
  }
  if(value.change==='order')return sorted({of:value.input.of,ids:listed(value.input.of)});
  if(value.change==='secretDescription'){const row=db.select().from(secrets).where(eq(secrets.name,value.input.secret)).get();return row?sorted({secret:row.name,description:row.description}):null;}
  if(value.change==='bodyPolicy')return db.select({id:agents.id}).from(agents).where(eq(agents.id,value.input.agent)).get()?sorted(readAgentBodyPolicy(db,value.input.agent)):null;
  if(value.change==='secretRule'){
   const row=db.select().from(secretRules).where(eq(secretRules.secret,value.input.secret)).get();if(!row)return null;
   return sorted({secret:row.secret,answer:row.answer,minutes:row.minutes,agents:db.select({agent:secretRuleAgents.agent,when:secretRuleAgents.when}).from(secretRuleAgents).where(eq(secretRuleAgents.secret,row.secret)).orderBy(asc(secretRuleAgents.agent),asc(secretRuleAgents.when)).all()});
  }
  if(value.change==='secretDefault')return {answer:householdSettings(db).secretsDefault};
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
  // A new schedule replaces nothing. A change is sealed on what the schedule says now and whose it is.
  if(value.change==='placeSchedule'){const id=value.input.action==='set'?value.input.trigger.id:value.input.id,row=db.select().from(triggerRows).where(eq(triggerRows.id,id)).get();
   return row?sorted({id:row.id,times:row.times,days:row.days,lifespan:row.lifespan,note:row.note,instructions:row.instructions,wantsModel:row.wantsModel,on:row.enabled,askedByKind:row.askedByKind,askedBy:row.askedBy}):null;}
  const current=household.settings() as Record<string,unknown>;
  return sorted(Object.fromEntries(Object.keys(value.input).map(key=>[key,current[key]])));
 };
 const previewMachine=(owner:string,input:{trigger:string;machine:string},review:ReturnType<typeof machineReview>)=>{
  const summary=reviewText(review);
  const value={change:'triggerMachine' as const,input:{trigger:input.trigger,machine:input.machine}};
  return {summary,problem:review.problem,review:parts.digest(JSON.stringify(['owner-machine-preview',owner,value,before(value,review),summary,review.problem]))};
 };
 // Make the change. `by` is the owner on whose word it is made.
 const change=(value:Proposal,by:string)=>{
  try{
   if(value.change==='triggerMachine')throw new Error('Machine approval needs its verified card');
   else if(value.change==='project')projects.save(value.input);
   else if(value.change==='projectMerge')projects.merge(value.input);
   else if(value.change==='projectJoin')projects.join(value.input);
   else if(isState(value))projects.setRetired(value.input,value.change==='projectRetire');
   else if(value.change==='member')household.setMember(value.input);
   else if(value.change==='agent')household.setAgent(value.input);
   else if(value.change==='settings')household.setSettings(value.input);
   // A rule records who set it: the owner who allowed the card.
   else if(value.change==='rule')rules.set(value.input,by);
   else if(value.change==='bodyPolicy')saveAgentBodyPolicy(db,value.input);
   else if(value.change==='secretRule')parts.secrets.setRule(value.input);
   else if(value.change==='secretDefault')household.setSecretsDefault(value.input.answer);
   else if(value.change==='houseSecrets')setHouseSecrets(db,value.input);
   else if(value.change==='bridge')parts.bridges.change(value.input);
   else if(value.change==='tempoTimings'){const {who,...patch}=value.input;parts.tempo().setTimings(who,patch);}
   else if(value.change==='measuring'){parts.measuring.write(value.input);parts.measuring.changed();}
   else if(value.change==='boxSettings')applyBoxSettings(db,value.input);
   // Run settings are checked as the owner who allowed the card: which machines that person may offer the agent.
   else if(value.change==='runSettings')applyAgentRunSettings(db,{kind:'member',id:by},value.input);
   else if(value.change==='models')applyAgentModels(db,value.input,runtime.roles());
   else if(value.change==='agentAccounts')runtime.setAccounts(value.input);
   else if(value.change==='remove'||value.change==='restore')household.setRemoved(value.input.of,value.input.id,value.change==='remove');
   else if(value.change==='order')household.setOrder(value.input.of,value.input.ids);
   else if(value.change==='secretDescription'){if(!describeSecret(db,{...value.input,by,at:now()}))throw new OperationError('not-found','No secret has that name');}
   // apply has already refused a dangerous card whose token or machine is not there (refusal).
   else if(value.change==='placeSchedule')parts.schedule(value.input);
   else if(value.change==='tokenRevoke')revokeToken(liveToken(value.input.label)!.fingerprint);
   else if(value.change==='boxRevoke')parts.machines.revoke(liveBox(value.input.name)!.id);
   else for(const row of browsers(value.input))endBrowser(db,row.id);
  }catch(error){
   if(error instanceof HouseholdError)throw new OperationError(error.code,error.message);
   // The services underneath refuse in plain words meant for the caller; storage errors carry a code and stay hidden.
   if(error instanceof Error&&!(error instanceof OperationError)&&!('code' in error)&&error.message.length>0&&error.message.length<=200)throw new OperationError('invalid',error.message);
   throw error;
  }
 };
 // Why the change cannot be made on what is there now, in the words of the rule it breaks; nothing when it can.
 // These depend on what the asker may not read, so they are an owner's to hear: never the asker's.
 const refusal=(value:Proposal,was:unknown,review?:ReturnType<typeof machineReview>)=>
  value.change==='triggerMachine'?(review?.problem?new OperationError('invalid',review.problem):undefined)
  :value.change==='projectMerge'?projects.mergeRefusal(value.input)
  :value.change==='projectJoin'?projects.joinRefusal(value.input)
  :isState(value)?projects.stateRefusal(value.input,value.change==='projectRetire')
  :value.change==='placeSchedule'?(value.input.action==='set'&&was!==null?new OperationError('conflict','A schedule with that id is already there')
    :value.input.action==='edit'&&was===null?new OperationError('not-found','No such schedule')
    :(reason=>reason?new OperationError('invalid',reason):undefined)(placeScheduleRefusal(db,value.input)))
  :value.change==='bodyPolicy'&&was===null?new OperationError('invalid','Unknown agent')
  :value.change==='boxSettings'&&was===null?new OperationError('not-found','No live machine has that id')
  :value.change in danger&&was===null?new OperationError('not-found',value.change==='tokenRevoke'?'No live token has that label':value.change==='boxRevoke'?'No live machine has that name':'No such signed-in browser')
  :value.change==='rule'&&was===null&&value.input.tier===null?new OperationError('invalid','There is no such rule to remove')
  :JSON.stringify(was)===JSON.stringify(sorted(value.input))?new OperationError('invalid','That is how it already is'):undefined;
 const seal=(value:Proposal,nonce:string,was:unknown)=>parts.digest(JSON.stringify([nonce,target(value),was]));
 const read=(card:Approval)=>{
  if(card.operation!==operation)throw new OperationError('conflict','Wrong household card');
  const kept=details.parse(JSON.parse(card.details)),value=proposal.parse({change:kept.change,input:kept.after});
  if(card.kind!==kindOf(value))throw new OperationError('conflict','Wrong household card');
  return {kept,value};
 };
 // Everything an Allow must find true before the change is made, on what is there now.
 const check=(value:Proposal,kept:z.infer<typeof details>)=>{
  const review=value.change==='triggerMachine'?machineReview(value.input):undefined;
  const was=before(value,review);
  if(seal(value,kept.seal.nonce,was)!==kept.seal.digest)throw new OperationError('conflict','This has changed since the card was filed; ask for a fresh card');
  const refused=refusal(value,was,review);if(refused)throw refused;
  if(review){
   if(!kept.machineReview)throw new OperationError('conflict','The original review is unavailable');
   try{openMachineReview(kept.machineReview,parts.digest,target(value),kept.seal.nonce);}
   catch{throw new OperationError('conflict','The original review is unavailable');}
  }
  return review;
 };
 const apply=(card:Approval)=>{
  const {kept,value}=read(card);
  if(!card.decidedBy)throw new OperationError('conflict','Wrong household card');
  const review=check(value,kept);
  if(value.change==='triggerMachine'){
   if(!review?.row||review.words===null||review.row.machine!==value.input.machine||!canRequestMachine({kind:'member',id:card.decidedBy},review.row.id))
    throw new OperationError('denied','This trigger cannot receive machine approval');
   db.update(triggerRows).set({machineApproval:card.id,machineWords:createHash('sha256').update(review.words).digest('hex'),changedAt:now()}).where(eq(triggerRows.id,review.row.id)).run();
  }else change(value,card.decidedBy);
  appliedCards.add(card.id);
 };
 // Cards filed before the digest kept what they would replace, where the asking agent could read it. Take
 // it off every one of them, once. A card still waiting gets the digest of what it recorded, so its Allow
 // is still refused if that has changed.
 // This rewrites stored rows at start and is not a numbered upgrade step, because a step is SQL and the
 // digest is keyed with a key only the running program holds. So it keeps the three rules such a rewrite
 // has (docs/data-schema.md): it changes nothing the second time (a rewritten card has no `before` and is
 // not selected again), it says how many cards it rewrote, and it is listed in docs/accepted-tradeoffs.md.
 const rewritten=db.transaction(()=>{
  let count=0;
  for(const card of db.select().from(approvals).where(and(eq(approvals.operation,operation),like(approvals.details,'%"before":%'))).all()){
   let older:z.infer<typeof olderDetails>,value:Proposal;
   try{older=olderDetails.parse(JSON.parse(card.details));value=proposal.parse({change:older.change,input:older.after});}catch{continue;}
   const nonce=randomBytes(16).toString('hex');
   db.update(approvals).set({details:JSON.stringify({change:older.change,after:older.after,seal:{nonce,digest:seal(value,nonce,older.before)}}),changeSummary:said(value),what:said(value)}).where(eq(approvals.id,card.id)).run();
   count++;
  }
  return count;
 });
 if(rewritten)parts.note?.(`Household cards: removed the stored earlier value from ${rewritten} card${rewritten===1?'':'s'} filed by an older version`);

 /** File the card. Installed code may call this directly; from outside it is household.propose.
  * Nothing here answers differently for what is in the household now: see the file header. */
 const file=(service:Pick<ReturnType<typeof approvalService>,'request'|'allow'|'withdraw'>,agent:string,raw:{change:string;input:unknown;why:string},where?:{conversation:string;member:string|null;project:string|null},owner?:string,replacement?:{prior:string;words:string})=>db.transaction(()=>{
  const request=proposal.parse({change:raw.change,input:raw.input});
  const proof=request.change==='triggerMachine'?request.input.reviewed:undefined;
  const value=request.change==='triggerMachine'?{change:request.change,input:{trigger:request.input.trigger,machine:request.input.machine}}:request;
  let reviewedWords:string|undefined;
  if(value.change==='triggerMachine'){
   const viewer:Viewer=owner?{kind:'member',id:owner}:{kind:'agent',id:agent,workingFor:where?.member??undefined};
   if(!replacement&&!canRequestMachine(viewer,value.input.trigger))throw new OperationError('denied','This trigger cannot request machine work');
   const machine = db.select().from(boxes).where(eq(boxes.id,value.input.machine)).get();
   if (!machine) throw new OperationError('invalid','The named machine is unavailable');
   if (!replacement && viewer.kind === 'agent') {
    const listed = db.select().from(boxAgents).where(and(eq(boxAgents.box,machine.id),eq(boxAgents.agent,agent))).get();
    const preferred = db.select({box:agentBoxes.box}).from(agentBoxes).where(and(eq(agentBoxes.box,machine.id),eq(agentBoxes.agent,agent))).get();
    if (!listed && !preferred && !machineMayHost(machine, listed, agent, sharedSharing(db))) {
     throw new OperationError('invalid','The named machine is unavailable');
    }
   }
   if(proof){
    if(!owner)throw new OperationError('denied','Only a household owner can answer this review');
    const review=machineReview(value.input);
    if(previewMachine(owner,value.input,review).review!==proof)throw new OperationError('conflict','The machine request changed. Read its current words.');
    if(review.problem||review.words===null)throw new OperationError('invalid',review.problem??'The words are unavailable');
    reviewedWords=review.words;
   }
  }
  // The asker's own waiting card for the same thing; another agent's card is not the asker's to know of.
  const cardTarget=replacement?target(value)+':review:'+parts.digest(JSON.stringify([replacement.prior,replacement.words])):target(value);
  const existing=db.select().from(approvals).where(and(eq(approvals.operation,operation),eq(approvals.agent,agent),eq(approvals.target,cardTarget),
   replacement?undefined:eq(approvals.state,'pending'))).get();
  if(existing){
   if(replacement)return existing;
   if(value.change!=='triggerMachine')throw new OperationError('conflict','A card for this is already waiting for an answer');
   const {kept} = read(existing);
   if (seal(value,kept.seal.nonce,before(value)) === kept.seal.digest) {
    throw new OperationError('conflict','A card for this is already waiting for an answer');
   }
   service.withdraw(existing.id,agent);
  }
  if(!householdOwners(db).length)throw new OperationError('conflict','No household owner can allow this');
  if(value.change==='triggerMachine'&&!replacement){
   db.update(triggerRows).set({machine:value.input.machine,machineWords:null,machineApproval:null,changedAt:now()}).where(eq(triggerRows.id,value.input.trigger)).run();
   logTrigger(db,now(),value.input.trigger,'machine-request',value.input.machine);
  }
  const nonce=randomBytes(16).toString('hex');
  const review=value.change==='triggerMachine'?machineReview(value.input,replacement?.words??reviewedWords):undefined;
  const snapshot=review?{machineReview:sealMachineReview(reviewText(review),parts.digest,target(value),nonce)}:{};
  const card=service.request({kind:kindOf(value),operation,target:cardTarget,details:JSON.stringify({change:value.change,after:sorted(value.input),...(replacement?{previousApproval:replacement.prior}:{}),...snapshot,seal:{nonce,digest:seal(value,nonce,before(value,review))}}),changeSummary:said(value),
   agent,member:where?.member??null,project:where?.project??null,conversation:where?.conversation??null,
   askedFrom:where?.conversation??(owner?'household owner':ASKED_FROM_TERMINAL),actingFor:householdChangePrincipal(where?.member,owner),what:said(value),why:raw.why,...cardWords(value)});
  // Standing rules answer these cards as they answer merges and commands: for the person the agent is
  // acting for, on a matching target, unless the last answer to this same thing was a deny. A card with no
  // known person behind it always asks. Some kinds always ask, whatever rule there is: `alwaysAsks`.
  // The change is then made on the word of the owner who set the rule, with nobody answering now. That is
  // the rule's purpose and is accepted: docs/accepted-tradeoffs.md, "A standing approval rule answers ...".
  if(proof&&owner)return service.allow(card.id,owner);
  if(alwaysAsks.has(value.change))return card;
  const rule=lastApprovalAnswer(db,card.agent,card.kind,card.target)?.event==='deny'?undefined:rules.resolve({kind:card.kind,target:card.target,project:card.project,actingFor:card.actingFor});
  if(!rule||rule.tier==='ask')return card;
  // When the change cannot be made on the rule's word (its owner may not make it, or it cannot be made at
  // all), the rule has answered nothing: the card waits for an owner, who is told why.
  try{return service.allow(card.id,rule.setBy,`Standing ${rule.tier} rule ${rule.scope} for ${rule.person||'household owner'}, set by ${rule.setBy}`);}
  catch(error){if(error instanceof OperationError)return card;throw error;}
 });
 return{
  operation:[operation,apply] as const,
  file,
  reviewChanged(service:Pick<ReturnType<typeof approvalService>,'request'|'allow'|'withdraw'>,trigger:typeof triggerRows.$inferSelect,words:string){
   if(!trigger.to||!trigger.machine||!trigger.machineApproval)throw new Error('No approved machine request');
   const prior=db.select().from(approvals).where(eq(approvals.id,trigger.machineApproval)).get();
   if(!prior||prior.state!=='used'||prior.agent!==trigger.to)throw new Error('No previous machine approval');
   const {value}=read(prior);
   if(value.change!=='triggerMachine'||value.input.trigger!==trigger.id||value.input.machine!==trigger.machine)throw new Error('Wrong previous machine approval');
   file(service,trigger.to,{change:'triggerMachine',input:value.input,why:'The trigger words changed since their last approval'},undefined,undefined,{prior:prior.id,words});
  },
  // Called after the outer Allow transaction commits, so readers see the change.
  committed(changed:()=>void){const applied=[...appliedCards].some(id=>db.select().from(approvals).where(eq(approvals.id,id)).get()?.state==='used');appliedCards.clear();if(applied)changed();},
  /** `held` answers why this caller proposes nothing, in words for the caller: the body of a job on anybody else's
   * word (shared-place-mail.ts, heldRefusal). loom's own card for such a job's repeating schedule is filed by `file`. */
  register(operations:Operations,service:ReturnType<typeof approvalService>,current?:ReturnType<typeof conversationBodyScope>,held:(viewer:Viewer)=>string|undefined=()=>undefined){
   // An agent in the household now may propose for itself. Proposing changes nothing: see the file header.
   // One change may also be asked for by a household owner, and by an agent only about itself: letting an
   // agent onto a project (policy.ts, rule `asksToJoin`).
   const agent=(viewer:Viewer,input:z.infer<typeof asked>)=>input.change==='triggerMachine'?canRequestMachine(viewer,input.input.trigger):input.change==='projectJoin'
    ?holds(policyRules.asksToJoin,viewer,{agent:input.input.agent},sharedSharing(db))
    :holds(policyRules.agentItself,viewer,{agent:viewer.id},sharedSharing(db));
   operations.register({name:'household.machinePreview',doors:['http'],input:kinds.triggerMachine.omit({reviewed:true}),
    output:z.object({summary:z.string(),problem:z.string().nullable(),review:z.string()}).strict(),
    may:(viewer,input)=>householdOwner(db,viewer)&&canRequestMachine(viewer,input.trigger),
    run(ctx,input){return previewMachine(ctx.viewer.id,input,machineReview(input));},
   });
   operations.register({name:'household.propose',write:true,recheckPolicy:true,doors:['http'],
    input:asked,output:z.object({id:z.string(),state:z.string()}).strict(),may:agent,
    run(ctx,raw){
     const heldBy=held(ctx.viewer);if(heldBy)throw new OperationError('denied',heldBy);
     if(raw.change==='projectJoin'){
      // A household owner reads the household, so is told at once what stands against it. An agent is told
      // only what it reads for itself: that it is already on a project it is on. Anything else is filed, and
      // is the owner's to hear, as for every other change (see the file header).
      const refused=ctx.viewer.kind==='member'?projects.joinRefusal(raw.input)
       :holds(policyRules.project,ctx.viewer,{id:raw.input.project},sharedSharing(db))?alreadyOnProject(raw.input):undefined;
      if(refused)throw refused;
     }
     const found=current?.(ctx.viewer);
     // Provenance is set here from the authenticated caller, never taken from input. A card an owner files
     // is about the agent it names, and is recorded as asked by that owner.
     const card=ctx.viewer.kind==='member'&&raw.change==='triggerMachine'?file(service,getTrigger(raw.input.trigger)!.to!,raw,undefined,ctx.viewer.id)
      :ctx.viewer.kind==='member'&&raw.change==='projectJoin'?file(service,raw.input.agent,raw,undefined,ctx.viewer.id)
      :file(service,ctx.viewer.id,raw,found?{conversation:found.cv.id,member:found.cv.member,project:found.cv.project}:undefined);
     if(raw.change==='triggerMachine')ctx.changed('triggers',raw.input.trigger);
     ctx.changed('approvals',card.id);ctx.changed('inbox',card.id);return{id:card.id,state:card.state};
    },
   });
   // What a waiting card would replace, and what already stands against it: it has changed since it was
   // filed, it is already so, or the thing it names is not there. A household owner may read all of that;
   // the card itself carries none of it. Whether the change can be made is not tried here. It is made as
   // the owner who allows it, who is refused in the rule's own words if they may not make it; one owner may
   // be able to make a change another may not, so there is no one owner to try it as beforehand.
   const waiting=(id:string)=>{const card=db.select().from(approvals).where(eq(approvals.id,id)).get();return card?.operation===operation&&card.state==='pending'?card:undefined;};
   operations.register({name:'household.proposal',doors:['http'],input:z.object({id:z.string().min(1).max(200)}).strict(),
    output:z.object({summary:z.string(),problem:z.string().nullable()}).strict(),
    may:(viewer,input)=>householdOwner(db,viewer)&&!!waiting(input.id),
    run(_ctx,input){
     const card=waiting(input.id);if(!card)throw new OperationError('not-found','No such waiting card');
     const {kept,value}=read(card);
     let problem:string|null=null;
     try{check(value,kept);}catch(error){if(!(error instanceof OperationError))throw error;problem=error.message;}
     if(value.change==='triggerMachine'){
      try{
       if(kept.machineReview){
        const current=openMachineReview(kept.machineReview,parts.digest,target(value),kept.seal.nonce);
        if(!kept.previousApproval)return {summary:current,problem};
        const prior=service.get(kept.previousApproval),previous=read(prior);
        if(previous.value.change!=='triggerMachine'||previous.value.input.trigger!==value.input.trigger||previous.value.input.machine!==value.input.machine||!previous.kept.machineReview)throw new Error('Wrong previous approval');
        const original=openMachineReview(previous.kept.machineReview,parts.digest,target(previous.value),previous.kept.seal.nonce);
        return {summary:'Previously approved\n'+original+'\n\nRequested now\n'+current,problem};
       }
      }catch{/* A program without a persistent household key cannot open a snapshot made before restart. */}
      return {summary:'The original machine review is unavailable. Ask for a fresh card.',problem:'This review cannot be opened'};
     }
     return{summary:summary(value,before(value)),problem};
    },
   });
  },
 };
}
