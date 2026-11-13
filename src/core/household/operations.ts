import { z } from 'zod';
import { HouseholdAccounts, agentAccountsSchema } from './accounts.js';
import type { Foundation } from '../app.js';
import { operation } from '../operations/index.js';
import { mayAct, maySee, type Viewer } from '../../policy.js';
import { SharingDatabase, projectSchema, projectSlug } from './sharing.js';

/** Explicit installation only until importer and all production callers cut over together. */
export function installHouseholdProjects(app: Foundation, home: string): void {
  const store = new SharingDatabase(app.db, home);
  const owner = (v: Viewer) => mayAct(v, {}, store.sharing(), 'household');
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
