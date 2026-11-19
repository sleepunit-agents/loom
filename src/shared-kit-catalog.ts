import { and, desc, eq, inArray } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { DataDatabase } from './core/data/database.js';
import { agentKitMembers, agentKitOutsidePeople, agentKitProjects, agentKits, kitUses, projectAgents, projectMembers, projectOutsidePeople } from './core/data/schema.js';
import { dataValue } from './core/data/subscriptions.js';
import { directsAgent, isHouseholdOwner, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';

const string = {type:GraphQLString};
const outside = new GraphQLObjectType({name:'KitOutsideAccount',fields:{platform:string,workspace:string,user:string}});
const definition = new GraphQLObjectType({name:'KitDefinition',fields:{kit:string,tools:{type:dataValue}}});
const grant = new GraphQLObjectType({name:'KitGrant',fields:{kit:string,project:string,member:string,outside:{type:outside}}});
const roster = new GraphQLObjectType({name:'KitProjectRoster',fields:{project:string,members:{type:new GraphQLList(GraphQLString)},outside:{type:new GraphQLList(outside)}}});
const use = new GraphQLObjectType({name:'KitUse',fields:{id:string,job:string,conversation:string,personKind:string,person:string,kit:string,tool:string,at:string,outcome:string}});

export function kitCatalogQueries(db:DataDatabase, held:(viewer:Viewer)=>boolean) {
  const reads = new WeakMap<Viewer, Set<string>>();
  const allowed = (viewer:Viewer,agent:string)=>{
    const sharing = sharedSharing(db);
    return sharing.agents?.includes(agent) && !held(viewer) && (isHouseholdOwner(viewer,sharing) || directsAgent(viewer,agent,sharing));
  };
  const catalog = new GraphQLObjectType<string>({name:'AgentKitCatalog',fields:{
    definitions:{type:new GraphQLList(definition),resolve:agent=>db.select().from(agentKits).where(eq(agentKits.agent,agent)).all()},
    grants:{type:new GraphQLList(grant),resolve:agent=>[
      ...db.select().from(agentKitProjects).where(eq(agentKitProjects.agent,agent)).all(),
      ...db.select().from(agentKitMembers).where(eq(agentKitMembers.agent,agent)).all(),
      ...db.select().from(agentKitOutsidePeople).where(eq(agentKitOutsidePeople.agent,agent)).all().map(row=>({kit:row.kit,outside:row})),
    ]},
    projects:{type:new GraphQLList(roster),resolve:agent=>{
      const ids = [...new Set([
        ...db.select({project:agentKitProjects.project}).from(agentKitProjects).where(eq(agentKitProjects.agent,agent)).all(),
        ...db.select({project:projectAgents.project}).from(projectAgents).where(eq(projectAgents.agent,agent)).all(),
      ].map(row=>row.project))].sort();
      const members = db.select().from(projectMembers).where(inArray(projectMembers.project,ids)).all();
      const people = db.select().from(projectOutsidePeople).where(inArray(projectOutsidePeople.project,ids)).all();
      return ids.map(project=>({project,members:members.filter(row=>row.project===project).map(row=>row.member),outside:people.filter(row=>row.project===project)}));
    }},
    uses:{type:new GraphQLList(use),args:{kit:string,person:string,personKind:string,limit:{type:GraphQLInt},offset:{type:GraphQLInt}},
      resolve:(agent,args)=>db.select().from(kitUses).where(and(eq(kitUses.agent,agent),
        args.kit == null ? undefined : eq(kitUses.kit,args.kit),
        args.person == null ? undefined : eq(kitUses.person,args.person),
        args.personKind == null ? undefined : eq(kitUses.personKind,args.personKind),
      )).orderBy(desc(kitUses.at),desc(kitUses.id)).limit(Math.max(0,Math.min(args.limit??100,500))).offset(Math.max(0,args.offset??0)).all()},
  }});
  const fields:GraphQLFieldConfigMap<unknown,{viewer:Viewer}>={kitCatalog:{
    type:catalog,args:{agent:{type:new GraphQLNonNull(GraphQLString)}},resolve(_row,{agent},{viewer}){
      if (!allowed(viewer,agent)) return null;
      let selected=reads.get(viewer);
      if (!selected) { selected=new Set(); reads.set(viewer,selected); }
      selected.add(agent);
      return agent;
    },
  }};
  return {fields,valid:(viewer:Viewer)=>[...(reads.get(viewer)??[])].every(agent=>allowed(viewer,agent))};
}
