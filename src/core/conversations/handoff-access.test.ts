import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { agents, members, memberAgents, projects, projectAgents } from '../data/schema.js';
import { handoffPeersAssigned, handoffTarget } from './handoff-access.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const at = '2026-11-16T12:00:00.000Z', db = createDataSchema(client, () => at);
  for (const id of ['alice', 'gone']) db.insert(members).values({ id, role: 'member', joinedAt: at }).run();
  for (const id of ['art', 'mark', 'kit']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(projects).values({ id: 'pond', name: 'pond' }).run();
  return { db, at };
}

it('lets agents hand work to each other outside a project only through a member who has both now', () => {
  const f = fixture();
  for (const agent of ['art', 'mark']) f.db.insert(memberAgents).values({ member: 'gone', agent }).run();
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  expect(handoffPeersAssigned(f.db, 'art', 'mark', null)).toBe(true);
  // A removed member is nobody: the agents they left on their list are not thereby each other's peers.
  f.db.update(members).set({ removedAt: f.at }).where(eq(members.id, 'gone')).run();
  expect(handoffPeersAssigned(f.db, 'art', 'mark', null)).toBe(false);
  f.db.insert(memberAgents).values({ member: 'alice', agent: 'mark' }).run();
  expect(handoffPeersAssigned(f.db, 'art', 'mark', null)).toBe(true);
  expect(handoffPeersAssigned(f.db, 'art', 'kit', null)).toBe(false);
});
it('lets agents of one project hand work to each other, and never to or from a removed agent', () => {
  const f = fixture();
  for (const agent of ['art', 'mark']) f.db.insert(projectAgents).values({ project: 'pond', agent }).run();
  expect(handoffPeersAssigned(f.db, 'art', 'mark', 'pond')).toBe(true);
  expect(handoffPeersAssigned(f.db, 'art', 'kit', 'pond')).toBe(false);
  expect(handoffPeersAssigned(f.db, 'art', 'mark', 'missing')).toBe(false);
  expect(handoffTarget(f.db, 'mark')).toBe(true);
  f.db.update(agents).set({ removedAt: f.at }).where(eq(agents.id, 'mark')).run();
  expect(handoffPeersAssigned(f.db, 'art', 'mark', 'pond')).toBe(false);
  expect(handoffPeersAssigned(f.db, 'mark', 'art', 'pond')).toBe(false);
  expect(handoffTarget(f.db, 'mark')).toBe(false);
  expect(handoffTarget(f.db, 'nobody')).toBe(false);
});
