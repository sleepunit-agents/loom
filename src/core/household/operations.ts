import { z } from 'zod';
import { changeHouseholdMember, memberAgents, memberPerson, memberSchema } from './members.js';
import { AGENT_NAME } from '../../household.js';
import { addHouseholdAgent } from './agents.js';
import { HouseholdAccounts, agentAccountsSchema } from './accounts.js';
import type { Foundation } from '../app.js';
import { operation, OperationError } from '../operations/index.js';
import { mayAct, maySee, type Viewer } from '../../policy.js';
import { SharingDatabase, projectSchema, projectSlug } from './sharing.js';

/** Explicit installation only until importer and all production callers cut over together. */
export function installHouseholdProjects(app: Foundation, home: string): void {
  const store = new SharingDatabase(app.db, home);
  const owner = (v: Viewer) => mayAct(v, {}, store.sharing(), 'household');
  app.operations.register(operation({
    name: 'household.setMember', write: true,
    input: z.object({ person: memberPerson, agents: memberAgents }).strict(),
    output: z.array(memberSchema), may: owner,
    run(ctx, input) {
      const person = app.operations.call('direct', ctx.viewer, 'mind.personRead', { id: `commons:${input.person}` });
      if (!person.ok || !person.value || typeof person.value !== 'object' ||
          !('slug' in person.value) || person.value.slug !== input.person) {
        throw new OperationError('invalid', 'Pick someone from People');
      }
      const members = changeHouseholdMember(app.db, home, input.person, input.agents);
      ctx.changed('household.sharing', 'household'); ctx.changed('core.access', 'household');
      return members;
    },
  }));
  app.operations.register(operation({
    name: 'household.removeMember', write: true,
    input: z.object({ person: memberPerson }).strict(),
    output: z.array(memberSchema), may: owner,
    run(ctx, input) {
      const members = changeHouseholdMember(app.db, home, input.person);
      ctx.changed('household.sharing', 'household'); ctx.changed('core.access', 'household');
      return members;
    },
  }));
  app.operations.register(operation({
    name: 'household.addAgent', write: true,
    input: z.object({ agent: z.string().regex(AGENT_NAME) }).strict(),
    output: z.array(z.string()), may: owner,
    run(ctx, input) {
      const agents = addHouseholdAgent(app.db, home, input.agent);
      ctx.changed('household.sharing', 'household'); ctx.changed('core.access', 'household');
      return agents;
    },
  }));
  app.operations.register(operation({
    name: 'household.setMemberProjects', write: true,
    input: z.object({ person: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), projects: z.array(projectSlug) }).strict(),
    output: z.array(projectSlug), may: owner,
    run(ctx, input) {
      const result = store.setMemberProjects(input.person, input.projects);
      for (const slug of result.changed) ctx.changed('household.project', slug);
      ctx.changed('core.access', 'household');
      return result.projects;
    },
  }));
  app.operations.register(operation({
    name: 'household.setOwnedAgents', write: true,
    input: z.object({ person: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), agents: z.array(z.string().min(1).max(40)) }).strict(),
    output: z.array(z.string()), may: owner,
    run(ctx, input) {
      const agents = store.setOwnedAgents(input.person, input.agents);
      ctx.changed('household.sharing', 'household'); ctx.changed('core.access', 'household');
      return agents;
    },
  }));
  app.operations.register(operation({
    name: 'household.setAgentAccounts', write: true,
    input: z.object({ agent: z.string().min(1).max(200), accounts: agentAccountsSchema }).strict(),
    output: agentAccountsSchema, may: owner,
    run(ctx, input) {
      const accounts = new HouseholdAccounts(app.db, home).set(input.agent, input.accounts);
      ctx.changed('household.sharing', 'household');
      return accounts;
    },
  }));
  app.operations.register(operation({
    name: 'household.createProject', write: true, input: projectSchema, output: projectSchema,
    may: owner,
    run(ctx, input) {
      const p = store.create(input);
      ctx.changed('household.project', p.slug); ctx.changed('core.access', 'household');
      return p;
    },
  }));
  app.operations.register(operation({
    name: 'household.setProjectMembers', write: true,
    input: z.object({ slug: projectSlug, members: projectSchema.shape.members }).strict(), output: projectSchema,
    may: owner,
    run(ctx, input) {
      const p = store.setMembers(input.slug, input.members);
      ctx.changed('household.project', p.slug); ctx.changed('core.access', 'household');
      return p;
    },
  }));
  app.operations.register(operation({
    name: 'household.setProjectAgents', write: true,
    input: z.object({ slug: projectSlug, agents: projectSchema.shape.agents }).strict(), output: projectSchema,
    may: owner,
    run(ctx, input) {
      const p = store.setAgents(input.slug, input.agents);
      ctx.changed('household.project', p.slug); ctx.changed('core.access', 'household');
      return p;
    },
  }));
  app.live.register({
    name: 'household.project',
    ids: () => store.projectIds(),
    read(id, viewer) {
      if (!maySee(viewer, { project: id }, store.sharing())) return;
      const p = store.project(id);
      return p && { ...p, id };
    },
    inScope: () => true,
  });
}
