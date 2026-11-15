/** Current shared household facts for the outside permission boundary. */
import { eq } from 'drizzle-orm';
import { maySee, type Sharing, type Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { members, memberAgents, projects, projectMembers, projectAgents, conversations } from './core/data/schema.js';
import { builtinServices } from './core/services.js';

export function sharedSharing(db: DataDatabase): Sharing {
  const ownership = db.select().from(memberAgents).all(), people = db.select().from(projectMembers).all(), bodies = db.select().from(projectAgents).all();
  return {
    members: Object.fromEntries(db.select().from(members).all().map(member => [member.id, {
      owner: member.role === 'owner', agents: ownership.filter(row => row.member === member.id).map(row => row.agent),
    }])),
    projects: Object.fromEntries(db.select().from(projects).all().map(project => [project.id, {
      members: people.filter(row => row.project === project.id).map(row => row.member),
      agents: bodies.filter(row => row.project === project.id).map(row => row.agent),
    }])),
    services: builtinServices(db.$client),
  };
}
export function canReadSharedConversation(db: DataDatabase, viewer: Viewer, id: string): boolean {
  const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
  return !!row && maySee(viewer, { type: 'conversation', agent: row.agent, project: row.project ?? undefined,
    member: row.member ?? undefined }, sharedSharing(db));
}
