/** Project administration uses canonical rows and current household authority. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { agents, members, projects, projectAgents, projectMembers } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { workAnswersAllowed } from './shared-work-access.js';

const identifiers = z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100)).max(1000)
  .transform(ids => [...new Set(ids)].sort());
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const createInput = z.object({ slug, name: z.string().trim().min(1).max(200), members: identifiers.default([]), agents: identifiers.default([]) }).strict();
const memberInput = z.object({ slug, members: identifiers }).strict();
const agentInput = z.object({ slug, agents: identifiers }).strict();
const result = z.object({ id: z.string() }).strict();
const strings = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString)));
const project = new GraphQLObjectType({ name: 'ProjectSharingProject', fields: {
  id: { type: new GraphQLNonNull(GraphQLString) }, name: { type: new GraphQLNonNull(GraphQLString) },
  members: { type: strings }, agents: { type: strings },
} });
const sharing = new GraphQLObjectType({ name: 'ProjectSharing', fields: {
  members: { type: strings }, agents: { type: strings },
  projects: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(project))) },
} });

export function projectSharingFields(db: DataDatabase) {
  return { projectSharing: { type: sharing,
    resolve: (_source: unknown, _args: unknown, context: { viewer: Viewer }) => {
      const viewer = context.viewer;
      if (viewer.kind !== 'member') return null;
      // Constrain every source selection in SQL, before assembling metadata.
      const owner = sql`exists(select 1 from ${members} where ${members.id} = ${viewer.id} and ${members.role} = 'owner')`;
      if (!db.select({ id: members.id }).from(members).where(and(eq(members.id, viewer.id), owner)).get()) return null;
      return {
        members: db.select({ id: members.id }).from(members).where(owner).orderBy(asc(members.position), asc(members.id)).all().map(row => row.id),
        agents: db.select({ id: agents.id }).from(agents).where(owner).orderBy(asc(agents.position), asc(agents.id)).all().map(row => row.id),
        projects: db.select({ id: projects.id, name: projects.name }).from(projects).where(owner).orderBy(asc(projects.name), asc(projects.id)).all().map(row => ({ ...row,
          members: db.select({ id: projectMembers.member }).from(projectMembers).where(and(owner, eq(projectMembers.project, row.id))).orderBy(asc(projectMembers.member)).all().map(member => member.id),
          agents: db.select({ id: projectAgents.agent }).from(projectAgents).where(and(owner, eq(projectAgents.project, row.id))).orderBy(asc(projectAgents.agent)).all().map(agent => agent.id),
        })),
      };
    },
  } };
}

export function registerProjectSharing(operations: Operations, db: DataDatabase) {
  // Same existing current-household-owner rule as household identity and Work
  // administration; ownership of an agent/project never grants administration.
  const may = (viewer: Viewer) => workAnswersAllowed(db, viewer);
  const requireProject = (id: string) => {
    if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get()) throw new OperationError('invalid', 'Unknown project');
  };
  const validateMembers = (ids: string[]) => {
    for (const id of ids) if (!db.select({ id: members.id }).from(members).where(eq(members.id, id)).get()) throw new OperationError('invalid', 'Unknown member');
  };
  const validateAgents = (ids: string[]) => {
    for (const id of ids) if (!db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).get()) throw new OperationError('invalid', 'Unknown agent');
  };
  operations.register({ name: 'household.createProject', write: true, recheckPolicy: true, input: createInput, output: result, may,
    run(ctx, input) {
      if (db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.slug)).get()) throw new OperationError('conflict', 'Project already exists');
      validateMembers(input.members); validateAgents(input.agents);
      db.insert(projects).values({ id: input.slug, name: input.name }).run();
      for (const member of input.members) db.insert(projectMembers).values({ project: input.slug, member }).run();
      for (const agent of input.agents) db.insert(projectAgents).values({ project: input.slug, agent }).run();
      ctx.changed('core.access', 'household'); return { id: input.slug };
    },
  });
  operations.register({ name: 'household.setProjectMembers', write: true, recheckPolicy: true, input: memberInput, output: result, may,
    run(ctx, input) {
      requireProject(input.slug); validateMembers(input.members);
      db.delete(projectMembers).where(eq(projectMembers.project, input.slug)).run();
      for (const member of input.members) db.insert(projectMembers).values({ project: input.slug, member }).run();
      ctx.changed('core.access', 'household'); return { id: input.slug };
    },
  });
  operations.register({ name: 'household.setProjectAgents', write: true, recheckPolicy: true, input: agentInput, output: result, may,
    run(ctx, input) {
      requireProject(input.slug); validateAgents(input.agents);
      db.delete(projectAgents).where(eq(projectAgents.project, input.slug)).run();
      for (const agent of input.agents) db.insert(projectAgents).values({ project: input.slug, agent }).run();
      ctx.changed('core.access', 'household'); return { id: input.slug };
    },
  });
}
