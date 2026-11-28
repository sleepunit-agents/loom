/** The `catchup` brick's two reads (./bricks-catchup.tsx) and the `trend` brick's backlog history (./bricks-trend.tsx),
 * run against what loom serves: the catch-up's tickets against the schema loom generates from its tables under the
 * real tasks and projects rules (core/data/visibility.ts), and the agents' updates and the backlog history against
 * the server's own fields (`agentPostFields`, `backlogWindowFields`) as the viewer they are resolved for. A member
 * reads only their projects, a household owner reads every project, and a member on no project reads nothing. */
import { createHash } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
// The root's graphql, the one the generated schema is built with (web/ has its own copy).
import { GraphQLObjectType, GraphQLSchema, graphql } from '../../../node_modules/graphql/index.js';
import { eq, getTableColumns } from 'drizzle-orm';
import { createDataSchema, type DataDatabase } from '../../../src/core/data/database.js';
import { dataQueries } from '../../../src/core/data/queries.js';
import { taskVisibility } from '../../../src/core/data/visibility.js';
import { backlogWindowFields } from '../../../src/core/data/backlog-window.js';
import { agentPostFields } from '../../../src/core/conversations/agent-post-query.js';
import { prepareAgentPost } from '../../../src/core/conversations/agent-posts.js';
import type { WordsKey } from '../../../src/core/conversations/words.js';
import { sqlVisibility } from '../../../src/policy-sql.js';
import * as s from '../../../src/core/data/schema.js';
import type { Viewer } from '../../../src/policy.js';
import { catchupFrom, catchupItems, catchupPostsQuery, catchupQuery, type CatchupPost, type CatchupProject } from './bricks-catchup';
import { backlogWindowQuery, type BacklogWindow } from './bricks-trend';

/** Words sealed as themselves: the reads open what they sealed, and the digests are real hashes. */
const key: WordsKey = { seal: async (w) => Buffer.from(w), open: async (b) => Buffer.from(b).toString(), hash: (w) => createHash('sha256').update(w).digest('hex') };
const tables = ['tasks', 'taskComments', 'taskLinks', 'projectMembers', 'projects', 'agents'] as const;
const day = (n: number, hour = 12) => `2026-11-${String(n).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
let client: Database.Database, db: DataDatabase, at = day(1, 0);

beforeEach(async () => {
  client = new Database(':memory:');
  at = day(1, 0);
  db = createDataSchema(client, () => at);
  db.insert(s.members).values(['owner', 'sam', 'lee'].map((id) => ({ id, role: id === 'owner' ? ('owner' as const) : ('member' as const), joinedAt: at }))).run();
  db.insert(s.agents).values({ id: 'fern', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(s.projects).values([{ id: 'garden', name: 'Garden' }, { id: 'pond', name: 'Pond' }] as (typeof s.projects.$inferInsert)[]).run();
  db.insert(s.projectMembers).values({ project: 'garden', member: 'sam' }).run();
  const task = (id: string, title: string, project: string, more: Partial<typeof s.tasks.$inferInsert> = {}) => db.insert(s.tasks).values({
    id, title, project, status: 'open', ownerKind: 'household', owner: null, createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at, ...more }).run();
  // Day 2: the window's start. Two garden tickets and one pond ticket are open.
  at = day(2, 0);
  task('t-1', 'Fix the gate latch', 'garden');
  task('t-2', 'Dig the north bed', 'garden');
  task('t-3', 'Fit the pump', 'pond');
  // Day 20: one garden ticket closes, one is opened; the pond ticket is started.
  at = day(20);
  db.update(s.tasks).set({ status: 'closed', closedAt: at, closeReason: 'done', changedAt: at }).where(eq(s.tasks.id, 't-1')).run();
  task('t-4', 'Sow the beans', 'garden');
  db.update(s.tasks).set({ status: 'in_progress', startedAt: at, changedAt: at }).where(eq(s.tasks.id, 't-3')).run();
  db.insert(s.taskComments).values({ task: 't-4', seq: 1, actorKind: 'member', actor: 'sam', at: day(20, 13), text: 'Broad beans, not runners.' }).run();
  // Agent updates on a garden ticket that did not change and on the pond ticket.
  const post = async (task: string, project: string, words: string, when: string) =>
    (await prepareAgentPost(db, key, `work-source:${task}`, { action: 'open', words }, { project, task, agent: 'fern' }))(when);
  await post('t-2', 'garden', 'Bed marked out; digging tomorrow.', day(20, 15));
  await post('t-3', 'pond', 'Pump arrived.', day(20, 16));
});

const generated = (viewer: Viewer) => dataQueries(client, { tables, visibility: taskVisibility(viewer) });
const served = () => new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: () => ({
  ...agentPostFields(db, key, (viewer) => sqlVisibility(viewer, ['conversations']).conversations(getTableColumns(s.conversations))),
  ...backlogWindowFields(db),
}) }) });
async function read(schema: GraphQLSchema, viewer: Viewer, source: string, variableValues: Record<string, unknown>) {
  const result = await graphql({ schema, source, variableValues, contextValue: { viewer } });
  expect(result.errors).toBeUndefined();
  return result.data as Record<string, any>;
}
const sam: Viewer = { kind: 'member', id: 'sam' }, owner: Viewer = { kind: 'member', id: 'owner' }, lee: Viewer = { kind: 'member', id: 'lee' };
async function catchup(viewer: Viewer, since: string) {
  const projects = (await read(generated(viewer), viewer, catchupQuery, { since })).projects as CatchupProject[];
  const posts = (await read(served(), viewer, catchupPostsQuery, { since })).projectActivityHighlights as CatchupPost[];
  return { projects, posts, items: catchupItems(projects, posts, since) };
}

it('reads the changed tickets and the agents\' updates of every project a member is on, and of no other', async () => {
  const { projects, posts, items } = await catchup(sam, day(19, 0));
  expect(projects.map((p) => p.id)).toEqual(['garden']);
  expect(projects[0].tasksByProject.map((t) => t.id)).toEqual(['t-1', 't-4']);
  expect(projects[0].tasksByProject[1].taskCommentsByTask).toEqual([{ at: day(20, 13), actor: 'sam', text: 'Broad beans, not runners.' }]);
  expect(posts).toEqual([expect.objectContaining({ project: 'garden', task: 't-2', title: 'Dig the north bed', agent: 'fern', words: 'Bed marked out; digging tomorrow.' })]);
  // Put together as the desktop does: the update names a ticket that did not change, the comment says what moved the new
  // one, and a ticket keeps its own change's time (t-1 and t-4 changed together, so they are in id order).
  expect(items.map((g) => [g.project.id, g.items.map((i) => [i.id, i.agent, i.words])])).toEqual([['garden', [
    ['t-2', 'fern', 'Bed marked out; digging tomorrow.'], ['t-1', null, 'Completed'], ['t-4', null, 'sam · Broad beans, not runners.'],
  ]]]);
  // Nothing since a later time.
  const later = await catchup(sam, day(21, 0));
  expect(later.items).toEqual([]);
  expect(later.posts).toEqual([]);
});

it('reads every project for a household owner, and nothing for a member on no project', async () => {
  const all = await catchup(owner, day(19, 0));
  expect(all.items.map((g) => [g.project.id, g.items.map((i) => i.id)])).toEqual([['garden', ['t-2', 't-1', 't-4']], ['pond', ['t-3']]]);
  expect(all.items[1].items[0]).toMatchObject({ agent: 'fern', words: 'Pump arrived.' });
  const none = await catchup(lee, day(19, 0));
  expect(none.projects).toEqual([]);
  expect(none.posts).toEqual([]);
  expect(none.items).toEqual([]);
});

it('asks from the start of the member\'s day, or of two or six days before it', () => {
  const now = new Date(2026, 10, 27, 15, 30).getTime();
  expect(catchupFrom(now, 'today')).toBe(new Date(2026, 10, 27).toISOString());
  expect(catchupFrom(now, '3-days')).toBe(new Date(2026, 10, 25).toISOString());
  expect(catchupFrom(now, '7-days')).toBe(new Date(2026, 10, 21).toISOString());
});

it('reads the trend\'s backlog history for a project the member may read, by group, and refuses one they may not', async () => {
  const window = async (viewer: Viewer, project: string, group: string | null) =>
    (await read(served(), viewer, backlogWindowQuery, { project, since: day(10, 0), until: day(25, 0), group, offset: 0 })).projectBacklogWindow as BacklogWindow | null;
  const counts = (w: BacklogWindow | null) => Object.fromEntries((w?.counts ?? []).map((c) => [c.key, c.total]));
  const garden = await window(sam, 'garden', null);
  expect(garden).toMatchObject({ from: day(10, 0), until: day(25, 0), tickets: [] });
  expect(counts(garden)).toMatchObject({ start: 2, end: 2, originalEverClosed: 1, created: 1, addedOpen: 1 });
  expect((await window(sam, 'garden', 'originalEverClosed'))?.tickets).toEqual([{ id: 't-1', title: 'Fix the gate latch' }]);
  expect((await window(sam, 'garden', 'created'))?.tickets).toEqual([{ id: 't-4', title: 'Sow the beans' }]);
  // A project the member is not on is no answer at all, for a member on another project and for one on none.
  expect(await window(sam, 'pond', null)).toBeNull();
  expect(await window(lee, 'garden', null)).toBeNull();
  expect(counts(await window(owner, 'pond', null))).toMatchObject({ start: 1, end: 1 });
});
