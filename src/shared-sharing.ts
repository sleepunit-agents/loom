/** Current shared household facts for the outside permission boundary. */
import { eq, isNull } from 'drizzle-orm';
import { holds, isHouseholdOwner, maySee, rules, type Sharing, type Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { agents, members, memberAgents, projects, projectMembers, projectAgents, conversations } from './core/data/schema.js';
import { builtinServices } from './core/services.js';

/** Removed members are left out, so every rule treats them as nobody; removed agents are left out of `agents`. */
export function sharedSharing(db: DataDatabase): Sharing {
  const ownership = db.select().from(memberAgents).all(), people = db.select().from(projectMembers).all(), bodies = db.select().from(projectAgents).all();
  return {
    members: Object.fromEntries(db.select().from(members).where(isNull(members.removedAt)).all().map(member => [member.id, {
      owner: member.role === 'owner', agents: ownership.filter(row => row.member === member.id).map(row => row.agent),
    }])),
    projects: Object.fromEntries(db.select().from(projects).all().map(project => [project.id, {
      members: people.filter(row => row.project === project.id).map(row => row.member),
      agents: bodies.filter(row => row.project === project.id).map(row => row.agent),
    }])),
    services: builtinServices(db.$client),
    agents: db.select({ id: agents.id }).from(agents).where(isNull(agents.removedAt)).all().map(agent => agent.id),
  };
}
/** Is this viewer a household owner now? The one check for every door that needs an owner. */
export function householdOwner(db: DataDatabase, viewer: Viewer): viewer is Extract<Viewer, { kind: 'member' }> {
  return isHouseholdOwner(viewer, sharedSharing(db));
}
/** Is this viewer a member who is in the household now? The one check for what any member may do for themselves. */
export function currentMember(db: DataDatabase, viewer: Viewer): viewer is Extract<Viewer, { kind: 'member' }> {
  return holds(rules.currentMember, viewer, {}, sharedSharing(db));
}
/** The current household owners, by id. Installed services that write to "the owners" read this list. */
export function householdOwners(db: DataDatabase): string[] {
  return Object.entries(sharedSharing(db).members).filter(([, member]) => member.owner).map(([id]) => id).sort();
}
export function canReadSharedConversation(db: DataDatabase, viewer: Viewer, id: string): boolean {
  const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
  return !!row && maySee(viewer, { type: 'conversation', agent: row.agent, project: row.project ?? undefined,
    member: row.member ?? undefined, direct: row.direct }, sharedSharing(db));
}
