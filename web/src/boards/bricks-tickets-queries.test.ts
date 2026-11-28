/** The `tickets` brick's selections (./bricks-tickets.tsx) run against the schema loom generates from its tables, under
 * the real tasks and projects rules (core/data/visibility.ts): every field, filter and order they name exists, each
 * state holds what the desktop's folder of that name holds, a search narrows it, and nobody reads a ticket the tasks
 * rule would not show them. */
import { beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
// The root's graphql, the one the generated schema is built with (web/ has its own copy).
import { graphql } from '../../../node_modules/graphql/index.js';
import { createDataSchema } from '../../../src/core/data/database.js';
import { dataQueries } from '../../../src/core/data/queries.js';
import { taskVisibility } from '../../../src/core/data/visibility.js';
import * as s from '../../../src/core/data/schema.js';
import type { Viewer } from '../../../src/policy.js';
import { ticketsRead, ticketsRetiredQuery, type TicketRow } from './bricks-tickets';

let client: Database.Database;
const at = '2026-11-14T00:00:00.000Z';
const tables = ['tasks', 'taskComments', 'taskLinks', 'projectMembers', 'projects', 'agents'] as const;
beforeEach(() => {
  client = new Database(':memory:');
  const db = createDataSchema(client, () => at);
  db.insert(s.members).values(['owner', 'sam', 'lee'].map((id) => ({ id, role: id === 'owner' ? ('owner' as const) : ('member' as const), joinedAt: at }))).run();
  db.insert(s.agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(s.projects).values([{ id: 'garden', name: 'Garden' }, { id: 'pond', name: 'Pond', retiredAt: at }, { id: 'secret', name: 'Secret' }, { id: 'vault', name: 'Vault', retiredAt: at }] as (typeof s.projects.$inferInsert)[]).run();
  db.insert(s.projectMembers).values([{ project: 'garden', member: 'sam' }, { project: 'pond', member: 'sam' }]).run();
  const task = (id: string, title: string, project: string | null, status: 'open' | 'in_progress' | 'closed', more: Partial<typeof s.tasks.$inferInsert> = {}) =>
    db.insert(s.tasks).values({ id, title, project, status, ownerKind: project ? 'household' : 'member', owner: project ? null : 'sam', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at, ...more }).run();
  task('t-1', 'Fix the gate latch', 'garden', 'open', { priority: 1, goal: 'Keep the hens in' });
  task('t-2', 'Dig the north bed', 'garden', 'in_progress', { assigneeKind: 'member', assignee: 'sam', changedAt: '2026-11-15T00:00:00.000Z' });
  task('t-3', 'Blocked by the gate', 'garden', 'open', { priority: 0 });
  task('t-4', 'Old pump plan', 'pond', 'open');
  task('t-5', 'Pump half fitted', 'pond', 'in_progress', { assigneeKind: 'agent', assignee: 'art' });
  task('t-6', 'Sow beans', 'garden', 'closed', { closeReason: 'done' });
  task('t-7', 'My own errand', null, 'in_progress', { assigneeKind: 'member', assignee: 'sam' });
  task('t-8', 'Secret plan', 'secret', 'in_progress');
  task('t-9', 'Vault plan', 'vault', 'open');
  task('t-10', 'Lee alone', null, 'open', { owner: 'lee' });
  db.insert(s.taskLinks).values({ task: 't-3', dependsOn: 't-1', type: 'blocks' }).run();
});

async function read(viewer: Viewer, source: string, variableValues: Record<string, unknown> = {}) {
  const schema = dataQueries(client, { tables, visibility: taskVisibility(viewer) });
  const result = await graphql({ schema, source, variableValues });
  expect(result.errors).toBeUndefined();
  return result.data as Record<string, any>;
}
/** What a state lists for a viewer, as the brick asks: the retired projects first, then the list. */
async function listed(viewer: Viewer, state: 'ready' | 'in-progress' | 'shelved' | 'all', search = '', limit = 31) {
  const retired = ((await read(viewer, ticketsRetiredQuery)).retired as { id: string; lifecycle: string }[]).filter((p) => p.lifecycle === 'retired').map((p) => p.id);
  const asked = ticketsRead(state, retired, search);
  if (!asked) return null;
  return ((await read(viewer, asked.query, { where: asked.where, limit })).rows as TicketRow[]);
}
const ids = (rows: TicketRow[] | null) => rows?.map((r) => r.id);
const sam: Viewer = { kind: 'member', id: 'sam' }, owner: Viewer = { kind: 'member', id: 'owner' }, lee: Viewer = { kind: 'member', id: 'lee' };

it('lists each state as the desktop folder of that name holds it, for a member, in the desktop order', async () => {
  // Ready: open, unblocked, not shelved (t-4 is in retired pond, t-3 is blocked).
  expect(ids(await listed(sam, 'ready'))).toEqual(['t-1']);
  // In progress, not shelved: t-5 is in retired pond; t-7 is in no project and is still listed.
  expect(ids(await listed(sam, 'in-progress'))).toEqual(['t-2', 't-7']);
  // Shelved: open work of a retired project the member may read.
  expect(ids(await listed(sam, 'shelved'))).toEqual(['t-4', 't-5']);
  // All: closed ones included, latest change first.
  const all = await listed(sam, 'all');
  expect(ids(all)?.[0]).toBe('t-2');
  expect(ids(all)?.sort()).toEqual(['t-1', 't-2', 't-3', 't-4', 't-5', 't-6', 't-7']);
  expect(all?.find((r) => r.id === 't-2')).toMatchObject({ title: 'Dig the north bed', project: 'garden', projectRow: { name: 'Garden' }, assigneeKind: 'member', assignee: 'sam', status: 'in_progress', isShelved: false });
  expect(all?.find((r) => r.id === 't-4')).toMatchObject({ isShelved: true, isReady: false });
  expect(all?.find((r) => r.id === 't-1')).toMatchObject({ isReady: true, isShelved: false });
});

it('shows nobody a ticket the tasks rule hides: a household owner reads every project, another member only their own', async () => {
  expect(ids(await listed(owner, 'shelved'))).toEqual(['t-4', 't-5', 't-9']);
  expect(ids(await listed(owner, 'in-progress'))?.sort()).toEqual(['t-2', 't-7', 't-8']);
  expect(ids(await listed(lee, 'all'))).toEqual(['t-10']);
  // No retired project lee may read: nothing is shelved, and the list is not asked for at all.
  expect(await listed(lee, 'shelved')).toBeNull();
  expect(ids(await listed(lee, 'in-progress'))).toEqual([]);
});

it('narrows a state by a search over id, title, goal, why, description, project and who has it, ignoring case', async () => {
  expect(ids(await listed(sam, 'all', 'GATE'))?.sort()).toEqual(['t-1', 't-3']);
  expect(ids(await listed(sam, 'all', 'gate latch'))).toEqual(['t-1']);
  expect(ids(await listed(sam, 'ready', 'pump'))).toEqual([]);
  expect(ids(await listed(sam, 'shelved', 'pump'))).toEqual(['t-4', 't-5']);
  expect(ids(await listed(sam, 'in-progress', 'sam'))).toEqual(['t-2', 't-7']);
  expect(ids(await listed(sam, 'all', 't-6'))).toEqual(['t-6']);
  expect(ids(await listed(sam, 'all', 'pond'))?.sort()).toEqual(['t-4', 't-5']);
  expect(ids(await listed(sam, 'all', 'hens'))).toEqual(['t-1']);
  // A project searched for within In progress keeps out the shelved: t-5 is in progress in retired pond.
  expect(ids(await listed(sam, 'in-progress', 'pond'))).toEqual([]);
  expect(ids(await listed(sam, 'in-progress', 'garden'))).toEqual(['t-2']);
  // Searching never reaches past the rule.
  expect(ids(await listed(sam, 'all', 'secret'))).toEqual([]);
});

it('asks for one more than it shows, so it knows there is more, and no more than that', async () => {
  expect(await listed(sam, 'all', '', 3)).toHaveLength(3);
});
