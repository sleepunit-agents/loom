import { readSharing } from './core/data/sharing.js';
import { projectRefusal, projectStateRefusal } from './core/data/project-in-use.js';
import { repoId } from './pieces/changes/model.js';
import { reprojectChanges } from './apps/changes.js';
import { refileTasks } from './apps/tasks.js';
import { refileApprovals } from './apps/approvals.js';
import { refileConversations, refileInbox } from './core/conversations/index.js';
import { refileTriggers } from './core/tempo/triggers.js';
import { refileJobs } from './runtime/jobs.js';
/** Project sharing is plain household metadata, checked only at the outside door. */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { GraphQLObjectType, GraphQLString, GraphQLList, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { projects, projectMembers, projectAgents, projectRepositories, members, agents } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { householdOwner } from './shared-sharing.js';
import { householdId, projectId } from './slug.js';
const id=projectId,list=z.array(householdId).max(1000).transform(values=>[...new Set(values)].sort());
export const projectInput=z.object({id,name:z.string().trim().min(1).max(200),members:list,agents:list,repositories:z.array(z.string().regex(/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).max(1000).transform(values=>[...new Set(values.map(repoId))].sort())}).strict();
/** Merging one project into another: `from` is emptied into `into` and removed. */
export const projectMergeInput=z.object({from:id,into:id}).strict();
/** Every household table that names a project, by its SQL name, and what a merge does with the rows that
 * name the project being merged away. Listed in the order the merge works. shared-project-merge.test.ts
 * reads the tables from the schema and fails when one of them is not here, so a table that gains a project
 * cannot be passed over.
 *
 * A record is filed under the other project by the module that owns its table. The people and agents of
 * the merged project are added to the other's and stay on its own lists, as for any removed project: they
 * grant nothing while it is removed. A repository has one project, so it moves; a pull request then takes
 * its project from its repository, as it always does.
 *
 * One label is not in a column and is not carried over: a standing approval rule whose scope is
 * `project:<id>` (`approval_rules.scope`). It is an owner's word about one project, and carried over it
 * would answer for every card of the project merged into. It stays, and answers nothing more. */
export const projectLabelled:Readonly<Record<string,(db:DataDatabase,from:string,into:string)=>void>>={
 tasks:refileTasks,
 conversations:refileConversations,
 inbox:refileInbox,
 approvals:refileApprovals,
 triggers:refileTriggers,
 jobs:refileJobs,
 project_members(db,from,into){
  const rows=db.select().from(projectMembers).where(eq(projectMembers.project,from)).all();
  if(rows.length)db.insert(projectMembers).values(rows.map(row=>({project:into,member:row.member}))).onConflictDoNothing().run();
 },
 project_agents(db,from,into){
  const rows=db.select().from(projectAgents).where(eq(projectAgents.project,from)).all();
  if(rows.length)db.insert(projectAgents).values(rows.map(row=>({project:into,agent:row.agent}))).onConflictDoNothing().run();
 },
 project_repositories(db,from,into){
  const rows=db.select().from(projectRepositories).where(eq(projectRepositories.project,from)).all();
  db.delete(projectRepositories).where(eq(projectRepositories.project,from)).run();
  if(rows.length)db.insert(projectRepositories).values(rows.map(row=>({project:into,repository:row.repository}))).onConflictDoNothing().run();
 },
 // After the repositories have moved: each pull request is filed under its repository's project.
 changes(db){reprojectChanges(db);},
};
/** A project retired, or revived. */
export const projectStateInput=z.object({project:id}).strict();
/** One agent let onto one project. */
export const projectJoinInput=z.object({project:id,agent:householdId}).strict();
/** The one refusal for an agent that is on the project already, in the words both doors use. */
export const alreadyOnProject=(value:{project:string;agent:string})=>new OperationError('invalid',value.agent+' is already on project '+value.project);
export function sharedProjects(db:DataDatabase,now:()=>string=()=>new Date().toISOString()){
 const validate=(value:z.infer<typeof projectInput>)=>{
  for(const member of value.members)if(!db.select().from(members).where(eq(members.id,member)).get())throw new OperationError('invalid','Choose existing members');
  for(const agent of value.agents)if(!db.select().from(agents).where(eq(agents.id,agent)).get())throw new OperationError('invalid','Choose existing agents');
  for(const repository of value.repositories){const bound=db.select().from(projectRepositories).all().find(row=>repoId(row.repository)===repository);if(bound&&bound.project!==value.id)throw new OperationError('conflict','Repository already belongs to another project');}
 };
 return {
  save(raw:z.input<typeof projectInput>){const value=projectInput.parse(raw);return db.transaction(()=>{
   validate(value);db.insert(projects).values({id:value.id,name:value.name}).onConflictDoUpdate({target:projects.id,set:{name:value.name}}).run();
   db.delete(projectMembers).where(eq(projectMembers.project,value.id)).run();db.delete(projectAgents).where(eq(projectAgents.project,value.id)).run();db.delete(projectRepositories).where(eq(projectRepositories.project,value.id)).run();
   if(value.members.length)db.insert(projectMembers).values(value.members.map(member=>({project:value.id,member}))).run();
   if(value.agents.length)db.insert(projectAgents).values(value.agents.map(agent=>({project:value.id,agent}))).run();
   if(value.repositories.length)db.insert(projectRepositories).values(value.repositories.map(repository=>({project:value.id,repository}))).run();
   reprojectChanges(db);
   return{id:value.id};
  });},
  read(){return readSharing(db);},
  /** One project as it stands, removed or not, or null when there is none: what a merge card is sealed on. */
  describe(project:string){
   const row=db.select().from(projects).where(eq(projects.id,project)).get();if(!row)return null;
   return{id:row.id,name:row.name,removed:!!row.removedAt,retired:!!row.retiredAt,
    members:db.select().from(projectMembers).where(eq(projectMembers.project,project)).all().map(link=>link.member).sort(),
    agents:db.select().from(projectAgents).where(eq(projectAgents.project,project)).all().map(link=>link.agent).sort(),
    repositories:db.select().from(projectRepositories).where(eq(projectRepositories.project,project)).all().map(link=>link.repository).sort()};
  },
  /** Why this project cannot be retired, or revived, as it stands; nothing when it can. A removed project is
   * neither: it is restored first. */
  stateRefusal(raw:z.input<typeof projectStateInput>,retire:boolean):OperationError|undefined{
   const value=projectStateInput.parse(raw),refused=projectStateRefusal(db,value.project,retire);
   return refused&&new OperationError(refused.code,refused.message);
  },
  /** Retire a project, or revive it. One column of the project's own row changes and nothing else: no task,
   * member, agent, repository or record is touched. What a retired project means for its tasks is derived
   * from that column wherever work is picked (core/data/project-in-use.ts). Reversible either way. */
  setRetired(raw:z.input<typeof projectStateInput>,retire:boolean){const value=projectStateInput.parse(raw);return db.transaction(()=>{
   const refused=this.stateRefusal(value,retire);if(refused)throw refused;
   db.update(projects).set({retiredAt:retire?now():null}).where(eq(projects.id,value.project)).run();
   return{id:value.project};
  });},
  /** Why this agent cannot be added to this project as things stand, or nothing when it can. */
  joinRefusal(raw:z.input<typeof projectJoinInput>):OperationError|undefined{
   const value=projectJoinInput.parse(raw);
   const unusable=projectRefusal(db,value.project,'stand'),agent=db.select().from(agents).where(eq(agents.id,value.agent)).get();
   if(unusable)return new OperationError(unusable.code,unusable.message);
   if(!agent)return new OperationError('not-found','No agent has the id '+value.agent);
   if(agent.removedAt)return new OperationError('invalid','Agent '+value.agent+' is removed');
   if(db.select().from(projectAgents).where(and(eq(projectAgents.project,value.project),eq(projectAgents.agent,value.agent))).get())return alreadyOnProject(value);
   return undefined;
  },
  /** Add one agent to one project. Nothing else about the project changes: not its name, its people, its
   * other agents or its repositories. Who may do this is decided at the outside door. */
  join(raw:z.input<typeof projectJoinInput>){const value=projectJoinInput.parse(raw);return db.transaction(()=>{
   const refused=this.joinRefusal(value);if(refused)throw refused;
   db.insert(projectAgents).values({project:value.project,agent:value.agent}).run();
   return{id:value.project};
  });},
  /** Why these two projects cannot be merged as they stand, or nothing when they can. */
  mergeRefusal(raw:z.input<typeof projectMergeInput>):OperationError|undefined{
   const value=projectMergeInput.parse(raw);
   if(value.from===value.into)return new OperationError('invalid','A project cannot be merged into itself');
   // What is merged away may be retired: that is how a shelved project's work is taken up. What it is merged
   // into takes new records, so it must be in use.
   for(const [project,to] of [[value.from,'stand'],[value.into,'enter']] as const){const unusable=projectRefusal(db,project,to);if(unusable)return new OperationError(unusable.code,unusable.message);}
   // A repository has one project. After the merge every repository of either is the other's alone, unless a
   // third project also lists it.
   const bound=db.select().from(projectRepositories).all(),merged=[value.from,value.into];
   const theirs=new Set(bound.filter(row=>merged.includes(row.project)).map(row=>repoId(row.repository)));
   if(bound.some(row=>!merged.includes(row.project)&&theirs.has(repoId(row.repository))))return new OperationError('conflict','A repository would belong to two projects');
   return undefined;
  },
  /** Merge `from` into `into`, in one write: every record that names `from` is filed under `into`
   * (`projectLabelled`), and `from` is marked removed. Its row is kept, as any removed project's is. A merge
   * is not undone by restoring `from`: that puts back an empty project. Who may do this is decided at the
   * outside door (a household owner, through a household change card). */
  merge(raw:z.input<typeof projectMergeInput>){const value=projectMergeInput.parse(raw);return db.transaction(()=>{
   const refused=this.mergeRefusal(value);if(refused)throw refused;
   for(const refile of Object.values(projectLabelled))refile(db,value.from,value.into);
   db.update(projects).set({removedAt:now()}).where(eq(projects.id,value.from)).run();
   return{id:value.into};
  });},
 };
}
export function sharedProjectQueries(db:DataDatabase){
 const ownerReads=new WeakSet<Viewer>();
 const strings=new GraphQLList(GraphQLString),project=new GraphQLObjectType({name:'SharingProject',fields:{id:{type:GraphQLString},name:{type:GraphQLString},members:{type:strings},agents:{type:strings},repositories:{type:strings}}});
 const sharing=new GraphQLObjectType({name:'HouseholdSharing',fields:{members:{type:strings},agents:{type:strings},projects:{type:new GraphQLList(project)}}});
 const service=sharedProjects(db);
 const fields:GraphQLFieldConfigMap<unknown,{viewer:Viewer}>={householdSharing:{type:sharing,resolve(_row,_args,{viewer}){if(!householdOwner(db,viewer))return null;ownerReads.add(viewer);return service.read();}}};
 return{fields,valid:(viewer:Viewer)=>!ownerReads.has(viewer)||householdOwner(db,viewer)};
}
