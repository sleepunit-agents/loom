import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { projectRefusal, projectState } from './core/data/project-in-use.js';
import { agents, agentPeople, bridgeConnections, projectMembers, agentKits, agentKitMembers, agentKitProjects, agentKitOutsidePeople, bridgePeople, members, projectOutsidePeople } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import { outsidePersonKey } from './pieces/bridges/keys.js';
import { hasControlCharacter } from './core/line-name.js';
import { kitTools } from './runtime/kit-manifest.js';
import { OUTSIDE_PEOPLE_MAX, outsideTier } from './shared-agent-body-policy.js';
import { householdId, projectId } from './slug.js';

const addressPart = z.string().min(1).max(200).refine(s => s.trim() === s && !hasControlCharacter(s));
const outside = z.object({platform:z.enum(bridgeConnections.platform.enumValues),workspace:addressPart,user:addressPart}).strict();
const kit = {agent:householdId,kit:householdId};
const recipient = z.union([z.object({member:householdId}).strict(), z.object({project:projectId}).strict(), outside]);
export const kitChanges = {
  kit:z.object({...kit,tools:kitTools.nullable()}).strict(),
  kitGrant:z.object({...kit,to:recipient,grant:z.boolean()}).strict(),
  colleague:outside.extend({agent:householdId,platform:z.literal('slack'),tier:outsideTier,project:projectId.optional()}).strict(),
  projectOutsidePerson:outside.extend({project:projectId,on:z.boolean()}).strict(),
};
type Change = {[K in keyof typeof kitChanges]: {change:K,input:z.infer<(typeof kitChanges)[K]>}}[keyof typeof kitChanges];

export function kitChange(value:{change:string}): value is Change { return Object.hasOwn(kitChanges,value.change); }
export function kitCardName(value:Change):string {
  if (value.change === 'colleague') {
    const {agent,platform,workspace,user}=value.input;
    return JSON.stringify([agent,platform,workspace,user]);
  }
  if (value.change === 'projectOutsidePerson') {
    const {project,platform,workspace,user}=value.input;
    return JSON.stringify([project,platform,workspace,user]);
  }
  const {agent,kit}=value.input;
  return value.change === 'kit' ? agent+'/'+kit : agent+'/'+kit+' '+JSON.stringify(value.input.to);
}
export function kitQuestion(value:Change):string {
  if(value.change==='colleague'){
    const {agent,tier,user,workspace,project}=value.input;
    return 'Set Slack user '+user+' in '+workspace+' to tier '+tier+' with '+agent+(project?' and include them on the '+project+' kit roster':'');
  }
  if(value.change==='kit')return (value.input.tools===null?'Remove':'Define')+' kit '+value.input.kit+' for '+value.input.agent;
  if(value.change==='projectOutsidePerson'){
    const {on,platform,workspace,user,project}=value.input;
    return (on?'Add ':'Remove ')+platform+' user '+user+' in '+workspace+(on?' on ':' from ')+'project '+project;
  }
  const {agent,kit,to,grant}=value.input;
  const who='project' in to?'project '+to.project:'member' in to?'member '+to.member:to.platform+' user '+to.user+' in '+to.workspace;
  return (grant?'Grant ':'Withdraw ')+agent+' kit '+kit+(grant?' to ':' from ')+who;
}
function live(db:DataDatabase,table:typeof agents|typeof members,id:string) {
  const row=db.select({removedAt:table.removedAt}).from(table).where(eq(table.id,id)).get();
  return !!row && row.removedAt===null;
}
function link(db:DataDatabase,p:z.infer<typeof outside>) {
  return db.select({member:bridgePeople.member}).from(bridgePeople).where(and(eq(bridgePeople.platform,p.platform),
    eq(bridgePeople.workspace,p.workspace),eq(bridgePeople.user,p.user))).get()?.member??null;
}
/** Shown in the owner-only proposal preview and sealed so a roster card cannot acquire new powers while it waits. */
export function projectKitDefinitions(db:DataDatabase,project:string){
  return db.select({agent:agentKits.agent,kit:agentKits.kit,tools:agentKits.tools}).from(agentKitProjects)
    .innerJoin(agentKits,and(eq(agentKits.agent,agentKitProjects.agent),eq(agentKits.kit,agentKitProjects.kit)))
    .where(eq(agentKitProjects.project,project)).orderBy(asc(agentKits.agent),asc(agentKits.kit)).all();
}
function knownOutside(db:DataDatabase,p:z.infer<typeof outside>,agent?:string){
  const identity=eq(agentPeople.person,outsidePersonKey(p.platform,p.workspace,p.user));
  return !!db.select({agent:agentPeople.agent}).from(agentPeople).innerJoin(agents,eq(agents.id,agentPeople.agent))
    .where(and(identity,agent===undefined?undefined:eq(agentPeople.agent,agent),isNull(agents.removedAt))).get();
}
function rosterWhere(p:z.infer<typeof outside>,project:string) {
  const t=projectOutsidePeople;
  return and(eq(t.project,project),eq(t.platform,p.platform),eq(t.workspace,p.workspace),eq(t.user,p.user));
}
/** An older grant can survive the removal of an outside tier. Admitting that identity again
 * makes its grants available again, even when the new card names no project. Seal the
 * definitions and show those effects alongside the explicitly requested roster. */
function returningKits(db:DataDatabase,agent:string,p:z.infer<typeof outside>) {
  const definition={kit:agentKits.kit,tools:agentKits.tools};
  const direct=db.select(definition).from(agentKitOutsidePeople)
    .innerJoin(agentKits,and(eq(agentKits.agent,agentKitOutsidePeople.agent),eq(agentKits.kit,agentKitOutsidePeople.kit)))
    .where(and(eq(agentKitOutsidePeople.agent,agent),eq(agentKitOutsidePeople.platform,p.platform),
      eq(agentKitOutsidePeople.workspace,p.workspace),eq(agentKitOutsidePeople.user,p.user)))
    .orderBy(asc(agentKits.kit)).all();
  const inherited=db.select({...definition,project:projectOutsidePeople.project}).from(projectOutsidePeople)
    .innerJoin(agentKitProjects,eq(agentKitProjects.project,projectOutsidePeople.project))
    .innerJoin(agentKits,and(eq(agentKits.agent,agentKitProjects.agent),eq(agentKits.kit,agentKitProjects.kit)))
    .where(and(eq(agentKits.agent,agent),eq(projectOutsidePeople.platform,p.platform),
      eq(projectOutsidePeople.workspace,p.workspace),eq(projectOutsidePeople.user,p.user)))
    .orderBy(asc(projectOutsidePeople.project),asc(agentKits.kit)).all()
    .filter(row=>!projectRefusal(db,row.project));
  return {direct,inherited};
}
function rows(db:DataDatabase,value:Change) {
  if(value.change==='colleague'){
    const {agent,tier,project,...p}=value.input,person=outsidePersonKey(p.platform,p.workspace,p.user);
    const current=db.select({tier:agentPeople.tier}).from(agentPeople)
      .where(and(eq(agentPeople.agent,agent),eq(agentPeople.person,person))).get();
    const full=!current && db.select({n:count()}).from(agentPeople).where(eq(agentPeople.agent,agent)).get()!.n>=OUTSIDE_PEOPLE_MAX;
    const roster=project?{project:projectState(db,project)??null,grants:projectKitDefinitions(db,project),
      on:!!db.select({project:projectOutsidePeople.project}).from(projectOutsidePeople).where(rosterWhere(p,project)).get()}:{};
    return {state:{agentLive:live(db,agents,agent),linked:link(db,p),tier:current?.tier??null,full,...roster,...(!current?{returning:returningKits(db,agent,p)}:{})},apply(){
      db.insert(agentPeople).values({agent,person,tier}).onConflictDoUpdate({target:[agentPeople.agent,agentPeople.person],set:{tier}}).run();
      if(project)db.insert(projectOutsidePeople).values({project,...p}).onConflictDoNothing().run();
    }};
  }
  if(value.change==='projectOutsidePerson'){
    const {on,...p}=value.input,t=projectOutsidePeople;
    const where=rosterWhere(p,p.project);
    return {state:{project:projectState(db,p.project)??null,grants:projectKitDefinitions(db,p.project),known:knownOutside(db,p),linked:link(db,p),on:!!db.select().from(t).where(where).get()},
      apply(){if(on)db.insert(t).values(p).run();else db.delete(t).where(where).run();}};
  }
  const {agent,kit}=value.input;
  const kitWhere=and(eq(agentKits.agent,agent),eq(agentKits.kit,kit));
  const tools=db.select({tools:agentKits.tools}).from(agentKits).where(kitWhere).get()?.tools??null;
  const current={agentLive:live(db,agents,agent),tools};
  if(value.change==='kit'){
    const next=value.input.tools;
    const projects=db.select({project:agentKitProjects.project}).from(agentKitProjects)
      .where(and(eq(agentKitProjects.agent,agent),eq(agentKitProjects.kit,kit))).orderBy(asc(agentKitProjects.project)).all();
    const members=db.select({member:agentKitMembers.member}).from(agentKitMembers)
      .where(and(eq(agentKitMembers.agent,agent),eq(agentKitMembers.kit,kit))).orderBy(asc(agentKitMembers.member)).all();
    const outside=db.select({platform:agentKitOutsidePeople.platform,workspace:agentKitOutsidePeople.workspace,user:agentKitOutsidePeople.user}).from(agentKitOutsidePeople)
      .where(and(eq(agentKitOutsidePeople.agent,agent),eq(agentKitOutsidePeople.kit,kit)))
      .orderBy(asc(agentKitOutsidePeople.platform),asc(agentKitOutsidePeople.workspace),asc(agentKitOutsidePeople.user)).all();
    return {state:{...current,projects,members,outside},apply(){
      if(next===null)db.delete(agentKits).where(kitWhere).run();
      else db.insert(agentKits).values({agent,kit,tools:next}).onConflictDoUpdate({target:[agentKits.agent,agentKits.kit],set:{tools:next}}).run();
    }};
  }
  const {to,grant}=value.input;
  if('project' in to){
    const t=agentKitProjects,where=and(eq(t.agent,agent),eq(t.kit,kit),eq(t.project,to.project));
    return {state:{...current,project:projectState(db,to.project)??null,
      members:db.select({member:projectMembers.member}).from(projectMembers).where(eq(projectMembers.project,to.project)).orderBy(asc(projectMembers.member)).all(),
      outside:db.select().from(projectOutsidePeople).where(eq(projectOutsidePeople.project,to.project))
        .orderBy(asc(projectOutsidePeople.platform),asc(projectOutsidePeople.workspace),asc(projectOutsidePeople.user)).all(),on:!!db.select().from(t).where(where).get()},
      apply(){if(grant)db.insert(t).values({agent,kit,...to}).run();else db.delete(t).where(where).run();}};
  }
  if('member' in to){
    const t=agentKitMembers,where=and(eq(t.agent,agent),eq(t.kit,kit),eq(t.member,to.member));
    return {state:{...current,memberLive:live(db,members,to.member),on:!!db.select().from(t).where(where).get()},
      apply(){if(grant)db.insert(t).values({agent,kit,...to}).run();else db.delete(t).where(where).run();}};
  }
  const t=agentKitOutsidePeople,where=and(eq(t.agent,agent),eq(t.kit,kit),eq(t.platform,to.platform),eq(t.workspace,to.workspace),eq(t.user,to.user));
  return {state:{...current,known:knownOutside(db,to,agent),linked:link(db,to),on:!!db.select().from(t).where(where).get()},
    apply(){if(grant)db.insert(t).values({agent,kit,...to}).run();else db.delete(t).where(where).run();}};
}
export const kitBefore=(db:DataDatabase,value:Change)=>rows(db,value).state;
/** Read-only preview of the refusals enforced by applyKitChange. */
export type KitRefusal =
  | {cause:'agent'|'project'|'member'|'unplaced'|'no-kit'|'same'|'full'}
  | {cause:'linked';member:string};
export function kitRefusal(value:Change,state:ReturnType<typeof kitBefore>):KitRefusal|undefined {
  const adding=value.change==='colleague'||(value.change==='kit'?value.input.tools!==null:value.change==='kitGrant'?value.input.grant:value.input.on);
  if(adding){
    if('agentLive' in state && !state.agentLive)return {cause:'agent'};
    if('project' in state && (!state.project || state.project.removed || state.project.retired))return {cause:'project'};
    if('memberLive' in state && !state.memberLive)return {cause:'member'};
    if('linked' in state && state.linked)return {cause:'linked',member:state.linked};
    if('known' in state && !state.known)return {cause:'unplaced'};
    if(value.change==='kitGrant' && 'tools' in state && !state.tools)return {cause:'no-kit'};
  }
  if(value.change==='colleague' && 'tier' in state){
    if(state.full)return {cause:'full'};
    return state.tier===value.input.tier && (!value.input.project || state.on)?{cause:'same'}:undefined;
  }
  if(('on' in state && state.on===adding)||(value.change==='kit' && 'tools' in state && JSON.stringify(state.tools)===JSON.stringify(value.input.tools)))
    return {cause:'same'};
  return undefined;
}
export function applyKitChange(db:DataDatabase,value:Change) {
  const {state,apply}=rows(db,value);
  const refusal=kitRefusal(value,state);
  if(refusal){
    const messages={
      agent:'Choose a live agent',project:'Choose a project in use',member:'Choose a live member',
      linked:'This account is linked to a member. Name the member instead.',
      unplaced:'Choose an outside account already known to the agent or household',
      full:'The agent has reached its outside contact limit',
      'no-kit':'No such kit',same:'That is how it already is',
    };
    throw new OperationError(refusal.cause==='same'?'conflict':'invalid',messages[refusal.cause]);
  }
  apply();
}

/** Text shown above the sealed details on the owner's review page. */
export function kitReview(value:Change,before:unknown):string {
  const lines=[kitQuestion(value)+'.'];
  if (value.change==='kit' && value.input.tools) {
    for (const tool of value.input.tools) {
      const argv=tool.args.map(arg=>typeof arg==='string'?JSON.stringify(arg):'{'+arg.parameter+'}').join(' ');
      lines.push('Run '+tool.name+' with program '+JSON.stringify(tool.program)+(argv?' '+argv:'')+'.');
      lines.push('Use '+tool.repository+' at '+tool.commit+', image '+tool.image+'.');
      const secrets=Object.entries(tool.secrets).map(([alias,name])=>name+' as '+alias);
      lines.push(secrets.length?'Give this program '+secrets.join(', ')+'.':'This program receives no kit credentials.');
    }
  }
  if (value.change==='projectOutsidePerson' || value.change==='colleague' && value.input.project) {
    const grants=z.object({grants:z.array(z.object({agent:z.string(),kit:z.string()}))}).parse(before).grants;
    lines.push(grants.length?'Project kits: '+grants.map(({agent,kit})=>agent+'/'+kit).join(', ')+'.':'This project currently grants no kits.');
  }
  return lines.join('\n');
}
