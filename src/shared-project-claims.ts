import { asc, and, eq, getTableColumns, inArray, isNull, max } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import { z } from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {agents, projectClaimDirections, projects} from './core/data/schema.js';
import {projectLifecycle} from './core/data/project-in-use.js';
import {projectClaimDirection} from './core/data/project-claim-direction.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {holds,rules,type Viewer} from './policy.js';
import {sharedSharing} from './shared-sharing.js';

export function projectClaimControls(db:DataDatabase,chatMember:(v:Viewer,project:string)=>string|undefined) {
  function eligible(viewer:Viewer,project:string) {
    const member=viewer.kind==='member' ? viewer.id : viewer.kind==='agent' && viewer.workingFor && chatMember(viewer,project)===viewer.workingFor ? viewer.workingFor : undefined;
    if (!member) return [];
    const record=db.select().from(projects).where(and(eq(projects.id,project),eq(projectLifecycle(getTableColumns(projects)),'active'))).get();
    const sharing=sharedSharing(db), who={kind:'member' as const,id:member};
    if (!record || !holds(rules.project,who,record,sharing)) return [];
    return db.select({id:agents.id}).from(agents).where(isNull(agents.removedAt)).orderBy(asc(agents.id)).all()
      .filter(agent=>(viewer.kind==='member' || viewer.id===agent.id)
        && holds(rules.recipient,who,{toKind:'agent',to:agent.id},sharing)
        && holds(rules.project,{kind:'agent',id:agent.id,workingFor:member},record,sharing))
      .map(agent=>({agent:agent.id,member}));
  }
  const text=new GraphQLNonNull(GraphQLString);
  const state=new GraphQLObjectType({name:'WorkClaimState',fields:{
    agent:{type:text},revision:{type:new GraphQLNonNull(GraphQLInt)},paused:{type:new GraphQLNonNull(GraphQLBoolean)},at:{type:GraphQLString},
  }});
  return {
    fields:{projectClaimStates:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(state))),args:{project:{type:text}},
      resolve:(_row:unknown,{project}:{project:string},{viewer}:{viewer:Viewer})=>{
        const allowed=eligible(viewer,project);
        if (!allowed.length) return [];
        const d=projectClaimDirections;
        const latest=db.select({seq:max(d.seq)}).from(d)
          .where(and(eq(d.project,project),inArray(d.agent,allowed.map(row=>row.agent)))).groupBy(d.agent);
        const states=new Map(db.select().from(d).where(inArray(d.seq,latest)).all().map(row=>[row.agent,row]));
        return allowed.map(({agent})=>{
          const last=states.get(agent);
          return {agent,paused:last?.paused??false,revision:last?.seq??0,at:last?.at};
        });
      }}},
    register(ops:Operations,held:(viewer:Viewer)=>string|undefined) {
      ops.register({name:'work.setProjectClaims',write:true,recheckPolicy:true,refuses:true,
        input:z.object({project:z.string().min(1),agent:z.string().min(1),paused:z.boolean(),expectedRevision:z.number().int().nonnegative()}).strict(),
        output:z.object({revision:z.number().int(),paused:z.boolean()}).strict(),
        may:(viewer,input)=>eligible(viewer,input.project).some(row=>row.agent===input.agent),
        run(ctx,input) {
          const refusal=held(ctx.viewer);
          if (refusal) throw new OperationError('denied',refusal);
          const actor=eligible(ctx.viewer,input.project).find(row=>row.agent===input.agent);
          if (!actor) throw new OperationError('denied','This work direction is unavailable');
          const last=projectClaimDirection(db,input.project,input.agent), revision=last?.seq??0;
          if (revision!==input.expectedRevision) throw new OperationError('conflict','The project direction changed. Read it again.');
          if ((last?.paused??false)===input.paused) return {revision,paused:input.paused};
          const row=db.insert(projectClaimDirections).values({project:input.project,agent:input.agent,member:actor.member,
            at:new Date(ctx.now).toISOString(),paused:input.paused}).returning().get();
          ctx.changed('project-claims',input.project);
          return {revision:row.seq,paused:row.paused};
        },
      });
    },
  };
}
