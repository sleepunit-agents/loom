import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { projectState } from './core/data/project-in-use.js';
import { agents, agentPeople, projectMembers, agentKits, agentKitMembers, agentKitProjects, agentKitOutsidePeople, bridgePeople, members, projectOutsidePeople } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import { outsidePersonKey } from './pieces/bridges/keys.js';
import { hasControlCharacter } from './core/line-name.js';
import { kitTools } from './runtime/kit-manifest.js';
import { householdId } from './slug.js';

const addressPart = z.string().min(1).max(200).refine(s => s.trim() === s && !hasControlCharacter(s));
const outside = z.object({platform:z.enum(['slack','discord']),workspace:addressPart,user:addressPart}).strict();
const kit = {agent:householdId,kit:householdId};
const recipient = z.union([z.object({member:householdId}).strict(), z.object({project:householdId}).strict(), outside]);
export const kitChanges = {
  kit:z.object({...kit,tools:kitTools.nullable()}).strict(),
  kitGrant:z.object({...kit,to:recipient,grant:z.boolean()}).strict(),
  projectOutsidePerson:outside.extend({project:householdId,on:z.boolean()}).strict(),
};
type Change = {[K in keyof typeof kitChanges]: {change:K,input:z.infer<(typeof kitChanges)[K]>}}[keyof typeof kitChanges];

export function kitChange(value:{change:string}): value is Change { return Object.hasOwn(kitChanges,value.change); }
export function kitCardName(value:Change):string {
  if (value.change === 'projectOutsidePerson') {
    const {project,platform,workspace,user}=value.input;
    return JSON.stringify([project,platform,workspace,user]);
  }
  const {agent,kit}=value.input;
  return value.change === 'kit' ? agent+'/'+kit : agent+'/'+kit+' '+JSON.stringify(value.input.to);
}
export function kitQuestion(value:Change):string {
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
function rows(db:DataDatabase,value:Change) {
  if(value.change==='projectOutsidePerson'){
    const {on,...p}=value.input,t=projectOutsidePeople;
    const where=and(eq(t.project,p.project),eq(t.platform,p.platform),eq(t.workspace,p.workspace),eq(t.user,p.user));
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
export function applyKitChange(db:DataDatabase,value:Change) {
  const {state,apply}=rows(db,value);
  const adding=value.change==='kit'?value.input.tools!==null:value.change==='kitGrant'?value.input.grant:value.input.on;
  if(adding){
    if('agentLive' in state && !state.agentLive)throw new OperationError('invalid','Choose a live agent');
    if('project' in state && (!state.project || state.project.removed || state.project.retired))throw new OperationError('invalid','Choose a project in use');
    if('memberLive' in state && !state.memberLive)throw new OperationError('invalid','Choose a live member');
    if('linked' in state && state.linked)throw new OperationError('invalid','This account is linked to a member. Name the member instead.');
    if('known' in state && !state.known)throw new OperationError('invalid','Choose an outside account already known to the agent or household');
    if(value.change==='kitGrant' && 'tools' in state && !state.tools)throw new OperationError('invalid','No such kit');
  }
  if(('on' in state && state.on===adding)||(value.change==='kit' && 'tools' in state && JSON.stringify(state.tools)===JSON.stringify(value.input.tools)))
    throw new OperationError('conflict','That is how it already is');
  apply();
}
