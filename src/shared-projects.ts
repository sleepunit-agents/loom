import { readSharing } from './core/data/sharing.js';
import { repoId } from './pieces/changes/model.js';
import { reprojectChanges } from './apps/changes.js';
/** Project sharing is plain household metadata, checked only at the outside door. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { GraphQLObjectType, GraphQLString, GraphQLList, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { projects, projectMembers, projectAgents, projectRepositories, members, agents } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { sharedTokenOwner } from './core/signin/shared-tokens.js';
const id=z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),list=z.array(id).max(1000).transform(values=>[...new Set(values)].sort());
const input=z.object({id,name:z.string().trim().min(1).max(200),members:list,agents:list,repositories:z.array(z.string().regex(/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).max(1000).transform(values=>[...new Set(values.map(repoId))].sort())}).strict();
export function sharedProjects(db:DataDatabase){
 const validate=(value:z.infer<typeof input>)=>{
  for(const member of value.members)if(!db.select().from(members).where(eq(members.id,member)).get())throw new OperationError('invalid','Choose existing members');
  for(const agent of value.agents)if(!db.select().from(agents).where(eq(agents.id,agent)).get())throw new OperationError('invalid','Choose existing agents');
  for(const repository of value.repositories){const bound=db.select().from(projectRepositories).all().find(row=>repoId(row.repository)===repository);if(bound&&bound.project!==value.id)throw new OperationError('conflict','Repository already belongs to another project');}
 };
 return {
  save(raw:z.input<typeof input>){const value=input.parse(raw);return db.transaction(()=>{
   validate(value);db.insert(projects).values({id:value.id,name:value.name}).onConflictDoUpdate({target:projects.id,set:{name:value.name}}).run();
   db.delete(projectMembers).where(eq(projectMembers.project,value.id)).run();db.delete(projectAgents).where(eq(projectAgents.project,value.id)).run();db.delete(projectRepositories).where(eq(projectRepositories.project,value.id)).run();
   if(value.members.length)db.insert(projectMembers).values(value.members.map(member=>({project:value.id,member}))).run();
   if(value.agents.length)db.insert(projectAgents).values(value.agents.map(agent=>({project:value.id,agent}))).run();
   if(value.repositories.length)db.insert(projectRepositories).values(value.repositories.map(repository=>({project:value.id,repository}))).run();
   reprojectChanges(db);
   return{id:value.id};
  });},
  read(){return readSharing(db);},
 };
}
export function registerSharedProjects(operations:Operations,db:DataDatabase,service:ReturnType<typeof sharedProjects>){
 operations.register({name:'household.setProject',write:true,recheckPolicy:true,input,output:z.object({id:z.string()}).strict(),may:viewer=>sharedTokenOwner(db,viewer),run(ctx,value){const result=service.save(value);ctx.changed('core.access','household');return result;}});
}
export function sharedProjectQueries(db:DataDatabase){
 const ownerReads=new WeakSet<Viewer>();
 const strings=new GraphQLList(GraphQLString),project=new GraphQLObjectType({name:'SharingProject',fields:{id:{type:GraphQLString},name:{type:GraphQLString},members:{type:strings},agents:{type:strings},repositories:{type:strings}}});
 const sharing=new GraphQLObjectType({name:'HouseholdSharing',fields:{members:{type:strings},agents:{type:strings},projects:{type:new GraphQLList(project)}}});
 const service=sharedProjects(db);
 const fields:GraphQLFieldConfigMap<unknown,{viewer:Viewer}>={householdSharing:{type:sharing,resolve(_row,_args,{viewer}){if(!sharedTokenOwner(db,viewer))return null;ownerReads.add(viewer);return service.read();}}};
 return{fields,valid:(viewer:Viewer)=>!ownerReads.has(viewer)||sharedTokenOwner(db,viewer)};
}
