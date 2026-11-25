/** Retiring a project: it and everything under it stay, readable by who could read them before, and its
 * unfinished tasks are shelved. Shelved is derived from the project; no task row changes at retire or revive. */
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, inbox, memberAgents, members, projectAgents, projectMembers, projectRepositories, projects, taskComments, taskLinks, tasks } from './core/data/schema.js';
import { projectRefusal, taskShelved } from './core/data/project-in-use.js';
import { InboxQueries } from './core/conversations/inbox-query.js';
import { talkVisibility } from './core/data/conversation-visibility.js';
import { workSweepParts } from './core/tempo/work-sweep.js';
import { householdService } from './apps/household.js';
import { taskService } from './apps/tasks.js';
import type { TaskCommand } from './apps/task-command.js';
import { OperationError } from './core/operations/index.js';
import { taskGroups } from './pieces/mind/projects-tasks.js';
import { holds, rules, tableRules, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { sharedProjects } from './shared-projects.js';
import { taskCommandAllowed } from './shared-task-access.js';

const at = '2026-11-18T09:00:00.000Z', later = '2026-11-18T10:00:00.000Z';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
const sam = { kind: 'member', id: 'sam' } as const, art = { kind: 'agent', id: 'art' } as const;
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const db = createDataSchema(client, () => at);
  db.insert(members).values(['owner', 'sam', 'lee'].map(id => ({ id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: at }))).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'sam', agent: 'art' }).run();
  db.insert(projects).values(['phasecraft', 'pond', 'shut'].map(id => ({ id, name: id, removedAt: id === 'shut' ? at : null }))).run();
  db.insert(projectMembers).values([['phasecraft', 'sam'], ['phasecraft', 'lee'], ['pond', 'sam']].map(([project, member]) => ({ project, member }))).run();
  db.insert(projectAgents).values([['phasecraft', 'art'], ['pond', 'art']].map(([project, agent]) => ({ project, agent }))).run();
  db.insert(projectRepositories).values({ project: 'phasecraft', repository: 'github:fixture/phasecraft' }).run();
  const service = taskService(db, () => at), projectsService = sharedProjects(db, () => later);
  const make = (title: string, project: string | null = 'phasecraft') => service.create({ title, goal: 'Done', why: 'Needed', owner: art, project }, sam);
  const everything = () => [projectMembers, projectAgents, projectRepositories, tasks, taskComments, taskLinks, inbox].map(table => db.select().from(table).all());
  return { client, db, service, projects: projectsService, make, everything };
}
const refused = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof OperationError ? [error.code, error.message] : (error as Error).message; } return 'done'; };

it('retires and revives a project by one column of its own row, and changes nothing else', () => {
  const f = fixture();
  const open = f.make('Open'), held = f.make('Held'), asked = f.make('Asked'), done = f.make('Done');
  f.service.claim(held.id, art); f.service.close(done.id, 'Finished');
  f.service.ask(asked.id, { to: sam, ask: 'Spend?', ifYes: 'Buy', ifNo: 'Wait' }, art);
  f.service.link(open.id, held.id, 'parent-child');
  const before = f.everything();
  const viewers: Viewer[] = [sam, { kind: 'member', id: 'lee' }, art, { kind: 'agent', id: 'art', workingFor: 'lee' }, { kind: 'member', id: 'owner' }, { kind: 'member', id: 'ghost' }, { kind: 'agent', id: 'nobody' }];
  const readers = () => viewers.map(viewer => [holds(rules.task, viewer, f.db.select().from(tasks).where(eq(tasks.id, open.id)).get()!, sharedSharing(f.db)), holds(tableRules.projects, viewer, { id: 'phasecraft' }, sharedSharing(f.db))]);
  const readBefore = readers();
  expect(readBefore.map(row => row[0])).toEqual([true, true, true, true, true, false, false]);
  expect(f.projects.setRetired({ project: 'phasecraft' }, true)).toEqual({ id: 'phasecraft' });
  // Who reads the task and the project is exactly who did, for every one of these viewers.
  expect(readers()).toEqual(readBefore);
  expect(f.db.select().from(projects).all()).toEqual([{ id: 'phasecraft', name: 'phasecraft', goal: null, removedAt: null, retiredAt: later }, { id: 'pond', name: 'pond', goal: null, removedAt: null, retiredAt: null }, { id: 'shut', name: 'shut', goal: null, removedAt: at, retiredAt: null }]);
  // No task, comment, link, question, member, agent or repository is touched: not deleted, closed or rewritten.
  expect(f.everything()).toEqual(before);
  expect(f.projects.describe('phasecraft')).toMatchObject({ retired: true, removed: false, members: ['lee', 'sam'], agents: ['art'], repositories: ['github:fixture/phasecraft'] });
  // Who reads it is as it was: its members and agents still do, and nobody else does now.
  const reads = (viewer: Viewer) => holds(rules.task, viewer, f.db.select().from(tasks).where(eq(tasks.id, open.id)).get()!, sharedSharing(f.db));
  expect([reads(sam), reads({ kind: 'member', id: 'lee' }), reads(art), reads({ kind: 'member', id: 'owner' }), reads({ kind: 'member', id: 'ghost' })]).toEqual([true, true, true, true, false]);
  expect(holds(tableRules.projects, sam, { id: 'phasecraft' }, sharedSharing(f.db))).toBe(true);
  // Revived: the column is empty again, and still nothing else has changed. The claim, the question and the link are as they were.
  f.projects.setRetired({ project: 'phasecraft' }, false);
  expect(f.db.select().from(projects).where(eq(projects.id, 'phasecraft')).get()).toEqual({ id: 'phasecraft', name: 'phasecraft', goal: null, removedAt: null, retiredAt: null });
  expect(f.everything()).toEqual(before);
  expect(f.service.get(held.id)).toMatchObject({ status: 'in_progress', assignee: 'art' });
  expect(f.service.get(asked.id)).toMatchObject({ ask: 'Spend?', assignee: 'sam' });
});

it('refuses to retire what is missing, removed or already retired, and to revive what is not retired', () => {
  const f = fixture(), household = householdService(f.db, () => later);
  expect(refused(() => f.projects.setRetired({ project: 'nowhere' }, true))).toEqual(['not-found', 'No project has the id nowhere']);
  expect(refused(() => f.projects.setRetired({ project: 'shut' }, true))).toEqual(['invalid', 'Project shut is removed']);
  expect(refused(() => f.projects.setRetired({ project: 'pond' }, false))).toEqual(['invalid', 'Project pond is not retired']);
  f.projects.setRetired({ project: 'pond' }, true);
  expect(refused(() => f.projects.setRetired({ project: 'pond' }, true))).toEqual(['invalid', 'Project pond is already retired']);
  // A retired project can be removed, and stays retired in the record. Removed, it is neither retired again nor revived.
  household.setRemoved('project', 'pond', true);
  expect(f.db.select().from(projects).where(eq(projects.id, 'pond')).get()).toMatchObject({ retiredAt: later, removedAt: later });
  expect(refused(() => f.projects.setRetired({ project: 'pond' }, false))).toEqual(['invalid', 'Project pond is removed']);
  household.setRemoved('project', 'pond', false);
  expect(f.projects.describe('pond')).toMatchObject({ retired: true, removed: false });
  expect(f.projects.setRetired({ project: 'pond' }, false)).toEqual({ id: 'pond' });
});

it('shelves a retired project’s unfinished tasks: not ready, not claimed, not open work, and back exactly on revive', () => {
  const f = fixture(), sweep = workSweepParts(f.db, new FakeClock(Date.parse(at)))[0];
  const open = f.make('Open'), held = f.make('Held'), done = f.make('Done'), elsewhere = f.make('Elsewhere', 'pond'), own = f.make('Own', null);
  f.service.claim(held.id, art); f.service.close(done.id, 'Finished');
  const shelved = () => f.db.select({ id: tasks.id }).from(tasks).where(taskShelved(tasks)).all().map(row => row.id);
  const ready = () => f.service.ready().map(task => task.id), openWork = () => { const found = sweep.open(art) as { count: number; items: { id: string }[] }; return [found.count, found.items.map(item => item.id)]; };
  const before = [ready(), openWork()];
  expect(before).toEqual([[open.id, elsewhere.id, own.id], [4, [open.id, held.id, elsewhere.id, own.id]]]);
  expect(shelved()).toEqual([]);
  f.projects.setRetired({ project: 'phasecraft' }, true);
  // Shelved: the unfinished ones of that project, the claimed one included. Not the closed one, nor any other project's.
  expect(shelved()).toEqual([open.id, held.id]);
  expect([ready(), openWork()]).toEqual([[elsewhere.id, own.id], [2, [elsewhere.id, own.id]]]);
  expect(() => f.service.claim(open.id, art)).toThrow('Project phasecraft is retired: its tasks are shelved until it is revived');
  // The stored state is untouched, so a shelved task still reads as what it was, and can still be read, edited and commented on.
  expect([f.service.get(open.id).status, f.service.get(held.id).status]).toEqual(['open', 'in_progress']);
  f.service.comment(open.id, 'Parked with the project', sam);
  expect(f.service.edit(open.id, { priority: 1 }).priority).toBe(1);
  f.service.edit(open.id, { priority: 2 });
  f.projects.setRetired({ project: 'phasecraft' }, false);
  expect(shelved()).toEqual([]);
  expect([ready(), openWork()]).toEqual(before);
  expect(f.service.claim(open.id, art)).toMatchObject({ status: 'in_progress' });
});

it('takes no new task into a retired project, by creating, moving or merging; tasks may leave it', () => {
  const f = fixture(), inside = f.make('Inside'), outside = f.make('Outside', 'pond');
  f.projects.setRetired({ project: 'phasecraft' }, true);
  const words = 'Project phasecraft is retired: nothing new is filed under it until it is revived';
  expect(projectRefusal(f.db, 'phasecraft')).toEqual({ code: 'invalid', message: words });
  expect(projectRefusal(f.db, 'phasecraft', 'stand')).toBeUndefined();
  // The trusted service refuses, and nothing is kept.
  expect(() => f.make('New')).toThrow(words);
  expect(() => f.service.moveToProject([outside.id], 'phasecraft', sam)).toThrow(words);
  expect(() => f.service.edit(outside.id, { project: 'phasecraft' }, sam)).toThrow(words);
  expect(f.db.select().from(tasks).all().map(row => [row.id, row.project])).toEqual([[inside.id, 'phasecraft'], [outside.id, 'pond']]);
  // The door refuses the same, to a household owner too; an edit of a task that stays, and a move out, are allowed.
  const allowed = (command: TaskCommand, viewer: Viewer = sam) => taskCommandAllowed(f.db, viewer, command, () => false);
  for (const viewer of [sam, { kind: 'member', id: 'owner' }] as Viewer[]) {
    expect(allowed({ action: 'create', input: { title: 'New', goal: 'Done', why: 'Needed', owner: art, project: 'phasecraft' } }, viewer)).toBe(false);
    expect(allowed({ action: 'moveToProject', ids: [outside.id], project: 'phasecraft' }, viewer)).toBe(false);
    expect(allowed({ action: 'edit', id: outside.id, input: { project: 'phasecraft' } }, viewer)).toBe(false);
    expect(allowed({ action: 'edit', id: inside.id, input: { title: 'Renamed' } }, viewer)).toBe(true);
    expect(allowed({ action: 'comment', id: inside.id, text: 'Still here' }, viewer)).toBe(true);
    expect(allowed({ action: 'moveToProject', ids: [inside.id], project: 'pond' }, viewer)).toBe(true);
  }
  // Rescued: moved out, it is work again where it went.
  expect(f.service.moveToProject([inside.id], 'pond', sam)).toEqual([inside.id]);
  expect(f.service.ready().map(task => task.id)).toEqual([inside.id, outside.id]);
  // A merge into a retired project is refused; a merge from one is allowed, and its tasks are work in the other.
  expect(refused(() => f.projects.merge({ from: 'pond', into: 'phasecraft' }))).toEqual(['invalid', words]);
  f.projects.setRetired({ project: 'phasecraft' }, false);
  const parked = f.make('Parked');
  f.projects.setRetired({ project: 'phasecraft' }, true);
  expect(f.service.ready().map(task => task.id)).not.toContain(parked.id);
  expect(f.projects.merge({ from: 'phasecraft', into: 'pond' })).toEqual({ id: 'pond' });
  expect(f.service.get(parked.id).project).toBe('pond');
  expect(f.service.ready().map(task => task.id)).toContain(parked.id);
  // The merged-away project is removed, and stays marked retired in the record.
  expect(f.db.select().from(projects).where(eq(projects.id, 'phasecraft')).get()).toMatchObject({ retiredAt: later, removedAt: later });
});

it('lists a shelved task under its project as shelved, never as waiting, ready or in progress', () => {
  const task = (id: string, patch: object = {}) => ({ id, title: id, status: 'open', priority: 2, createdAt: at, comments: [], project: 'phasecraft', ...patch });
  const q = { names: ['phasecraft'], since: at, card: { links: {} } } as unknown as Parameters<typeof taskGroups>[3];
  const groups = taskGroups([task('t-1', { shelved: true, assignee: 'sam' }), task('t-2', { shelved: true, status: 'in_progress' }), task('t-3')], [], new Set(['t-3']), q, new Set(['sam']));
  expect(groups.map(group => [group.title, group.waiting ?? false, group.items.map(item => [item.ref, item.status, item.waiting ?? false])])).toEqual([
    ['Ready', false, [['t-3', 'outside the tree', false]]], ['Shelved', false, [['t-1', 'shelved', false], ['t-2', 'shelved', false]]]]);
});

it('reads shelved as exactly 0 or 1 for every task, so it can be negated in a filter', () => {
  const f = fixture();
  f.make('Open'); f.make('Bare', null); f.service.close(f.make('Done').id, 'Finished');
  f.projects.setRetired({ project: 'phasecraft' }, true);
  expect(f.db.all<{ shelved: number }>(sql`select ${taskShelved(tasks)} as shelved from ${tasks} order by ${tasks.id}`).map(row => row.shelved)).toEqual([1, 0, 0]);
});

it('keeps a question about a shelved task readable and out of what needs its person, until the project is revived', () => {
  const f = fixture();
  const asked = f.make('Asked'), other = f.make('Other', 'pond');
  for (const task of [asked, other]) f.service.ask(task.id, { to: sam, ask: 'Spend on ' + task.title + '?', ifYes: 'Buy', ifNo: 'Wait' }, art);
  const key = { seal: async (text: string) => Buffer.from(text), hash: (text: string) => text, open: async (bytes: Uint8Array) => Buffer.from(bytes).toString() };
  const mail = new InboxQueries(f.db, key, (viewer, row) => talkVisibility(viewer).inbox(row), () => at);
  const read = () => ({ folders: f.db.transaction(() => mail.folders(sam)), needs: mail.list(sam, { folder: 'needs' }).map(item => item.waitsOnId).sort(), all: mail.list(sam, { folder: 'all' }).map(item => item.waitsOnId).sort() });
  const before = read();
  expect(before).toMatchObject({ folders: { needs: 2, all: 2, agents: [{ id: 'art', count: 2, needs: 2 }] }, needs: [asked.id, other.id], all: [asked.id, other.id] });
  const stored = f.db.select().from(inbox).all();
  f.projects.setRetired({ project: 'phasecraft' }, true);
  // Still sam's mail, still readable, and not one of the things that need sam. The other project's question still is.
  expect(read()).toMatchObject({ folders: { needs: 1, all: 2, agents: [{ id: 'art', count: 2, needs: 1 }] }, needs: [other.id], all: [asked.id, other.id] });
  expect(f.db.select().from(inbox).all()).toEqual(stored);
  f.projects.setRetired({ project: 'phasecraft' }, false);
  expect(read()).toEqual(before);
});
