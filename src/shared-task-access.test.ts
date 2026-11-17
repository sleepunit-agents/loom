import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from './core/data/database.js';
import { members, agents, memberAgents, projects, projectMembers, projectAgents } from './core/data/schema.js';
import { taskService, type NewTask } from './apps/tasks.js';
import type { TaskCommand } from './apps/task-command.js';
import type { Viewer } from './policy.js';
import { taskCommandAllowed } from './shared-task-access.js';
const at = '2026-11-14T20:00:00.000Z';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const db = createDataSchema(client, () => at);
  db.insert(members).values(['owner', 'sam', 'lee'].map(id => ({ id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: at }))).run();
  db.insert(agents).values(['art', 'mark'].map(id => ({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble' as const, faceEyes: 'dot' as const }))).run();
  db.insert(memberAgents).values({ member: 'sam', agent: 'art' }).run();
  db.insert(projects).values(['pond', 'other'].map(id => ({ id, name: id }))).run();
  db.insert(projectMembers).values({ member: 'sam', project: 'pond' }).run();
  db.insert(projectAgents).values({ agent: 'art', project: 'pond' }).run();
  const service = taskService(db, () => at);
  const input: NewTask = { title: 'Pump', goal: 'Works', why: 'Needed', owner: { kind: 'member', id: 'sam' } };
  const make = (patch: Partial<NewTask> = {}) => service.create({ ...input, ...patch }, { kind: 'member', id: 'owner' });
  const allowed = (command: TaskCommand, viewer: Viewer = { kind: 'member', id: 'sam' }, source = false) => taskCommandAllowed(db, viewer, command, (who, id) => source && who.id === viewer.id && id === 'cv-visible');
  return { db, input, make, allowed };
}
it('uses task project precedence, private member ownership and independent agent ownership', () => {
  const f = fixture();
  const own = f.make(), privateOther = f.make({ owner: { kind: 'member', id: 'lee' } });
  const agent = f.make({ owner: { kind: 'agent', id: 'art' } });
  const shared = f.make({ owner: { kind: 'member', id: 'lee' }, project: 'pond' });
  const foreignProject = f.make({ owner: { kind: 'agent', id: 'art' }, project: 'other' });
  for (const action of ['claim', 'unclaim', 'reopen'] as const) {
    expect(f.allowed({ action, id: own.id })).toBe(true);
    expect(f.allowed({ action, id: privateOther.id })).toBe(false);
    expect(f.allowed({ action, id: agent.id })).toBe(true);
    expect(f.allowed({ action, id: shared.id })).toBe(true);
    expect(f.allowed({ action, id: foreignProject.id })).toBe(false);
    expect(f.allowed({ action, id: foreignProject.id }, { kind: 'member', id: 'owner' })).toBe(true);
  }
});
it('reevaluates current project membership, agent ownership and household role', () => {
  const f = fixture(), task = f.make({ owner: { kind: 'agent', id: 'art' } }), project = f.make({ project: 'pond' });
  const command = { action: 'close', id: task.id, reason: 'Done' } as const;
  expect(f.allowed(command)).toBe(true);
  f.db.delete(memberAgents).run(); expect(f.allowed(command)).toBe(false);
  expect(f.allowed({ ...command, id: project.id })).toBe(true);
  f.db.delete(projectMembers).run(); expect(f.allowed({ ...command, id: project.id })).toBe(false);
  expect(f.allowed(command, { kind: 'member', id: 'owner' })).toBe(true);
  f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'owner')).run();
  expect(f.allowed(command, { kind: 'member', id: 'owner' })).toBe(false);
});
it('binds agent scope independently and refuses other outside caller kinds', () => {
  const f = fixture(), own = f.make({ owner: { kind: 'agent', id: 'art' } }), privatePerson = f.make();
  expect(f.allowed({ action: 'comment', id: own.id, text: 'Ready' }, { kind: 'agent', id: 'art' })).toBe(true);
  expect(f.allowed({ action: 'comment', id: privatePerson.id, text: 'Ready' }, { kind: 'agent', id: 'art' })).toBe(false);
  for (const viewer of [{ kind: 'service', id: 'tasks' }, { kind: 'runner', id: 'box' }, { kind: 'member', id: 'missing' }] as Viewer[])
    expect(f.allowed({ action: 'comment', id: own.id, text: 'Ready' }, viewer)).toBe(false);
});
it('checks both dependency ends and proposed project before changing a visible task', () => {
  const f = fixture(), own = f.make(), hidden = f.make({ owner: { kind: 'member', id: 'lee' } }), other = f.make();
  for (const action of ['link', 'unlink'] as const) {
    expect(f.allowed({ action, id: own.id, dependsOn: hidden.id, type: 'blocks' })).toBe(false);
    expect(f.allowed({ action, id: hidden.id, dependsOn: own.id, type: 'parent-child' })).toBe(false);
    expect(f.allowed({ action, id: own.id, dependsOn: other.id, type: 'blocks' })).toBe(true);
  }
  expect(f.allowed({ action: 'edit', id: own.id, input: { project: 'other' } })).toBe(false);
  expect(f.allowed({ action: 'edit', id: own.id, input: { project: 'pond' } })).toBe(true);
  const project = f.make({ owner: { kind: 'member', id: 'lee' }, project: 'pond' });
  expect(f.allowed({ action: 'edit', id: project.id, input: { project: null } })).toBe(false);
});
it('validates create destination, owner existence, parent and current conversation source', () => {
  const f = fixture(), hidden = f.make({ owner: { kind: 'member', id: 'lee' } });
  const create = (input: NewTask) => f.allowed({ action: 'create', input });
  expect(create(f.input)).toBe(true);
  expect(create({ ...f.input, owner: { kind: 'household' } })).toBe(false);
  expect(create({ ...f.input, owner: { kind: 'member', id: 'missing' }, project: 'pond' })).toBe(false);
  expect(create({ ...f.input, owner: { kind: 'agent', id: 'art' } })).toBe(true);
  expect(create({ ...f.input, project: 'other' })).toBe(false);
  expect(create({ ...f.input, parent: hidden.id })).toBe(false);
  const sourced = { action: 'create', input: { ...f.input, source: { kind: 'conversation', id: 'cv-visible' } } } as const;
  expect(f.allowed(sourced)).toBe(false); expect(f.allowed(sourced, { kind: 'member', id: 'sam' }, true)).toBe(true);
  expect(create({ ...f.input, source: { kind: 'unknown', id: 'anything' } })).toBe(false);
});
it('only asks a current member who can reach the task', () => {
  const f = fixture(), task = f.make();
  const command = { action: 'ask', id: task.id, input: { to: { kind: 'member', id: 'lee' }, ask: 'Pump?', ifYes: 'Buy', ifNo: 'Wait' } } as const;
  expect(f.allowed(command)).toBe(false);
  f.db.insert(projectMembers).values({ member: 'lee', project: 'pond' }).run();
  const shared = f.make({ project: 'pond' }); expect(f.allowed({ ...command, id: shared.id })).toBe(true);
  expect(f.allowed({ ...command, input: { ...command.input, to: { kind: 'member', id: 'missing' } } })).toBe(false);
});
it('refuses a new task whose owner has been removed from the household, member or agent', () => {
  const f = fixture();
  const create = (owner: NewTask['owner']) => f.allowed({ action: 'create', input: { ...f.input, owner, project: 'pond' } });
  expect(create({ kind: 'member', id: 'lee' })).toBe(true);
  expect(create({ kind: 'agent', id: 'mark' })).toBe(true);
  f.db.update(members).set({ removedAt: at }).where(eq(members.id, 'lee')).run();
  f.db.update(agents).set({ removedAt: at }).where(eq(agents.id, 'mark')).run();
  // Still rows in their tables; no longer anyone a task can be given to.
  expect(create({ kind: 'member', id: 'lee' })).toBe(false);
  expect(create({ kind: 'agent', id: 'mark' })).toBe(false);
  expect(create({ kind: 'agent', id: 'art' })).toBe(true);
});
it('moves tasks to a project only for someone who acts on each of them and could file work there', () => {
  const f = fixture(), owner: Viewer = { kind: 'member', id: 'owner' }, art: Viewer = { kind: 'agent', id: 'art' };
  const own = f.make(), inPond = f.make({ owner: { kind: 'member', id: 'lee' }, project: 'pond' }), hidden = f.make({ owner: { kind: 'member', id: 'lee' } });
  const agents = f.make({ owner: { kind: 'agent', id: 'art' } });
  const move = (ids: string[], project: string | null, viewer?: Viewer) => f.allowed({ action: 'move', ids, project }, viewer);
  // sam is in pond and not in other.
  expect(move([own.id], 'pond')).toBe(true);
  expect(move([own.id, agents.id, inPond.id], 'pond')).toBe(true);
  expect(move([inPond.id], 'other')).toBe(false);
  expect(move([inPond.id], 'other', owner)).toBe(true);
  // All or nothing: one task the caller cannot act on, or that is not there, refuses the whole move.
  expect(move([own.id, hidden.id], 'pond')).toBe(false);
  expect(move([own.id, 't-999'], 'pond')).toBe(false);
  // Being in the destination is not enough: lee is put in other and still cannot pull sam's task there.
  f.db.insert(projectMembers).values({ member: 'lee', project: 'other' }).run();
  expect(move([own.id], 'other', { kind: 'member', id: 'lee' })).toBe(false);
  expect(move([hidden.id], 'other', { kind: 'member', id: 'lee' })).toBe(true);
  // An agent moves its own work into its project; its body working for someone outside that project does not.
  expect(move([agents.id], 'pond', art)).toBe(true);
  expect(move([agents.id], 'other', art)).toBe(false);
  expect(move([agents.id], 'pond', { kind: 'agent', id: 'art', workingFor: 'sam' })).toBe(true);
  expect(move([agents.id], 'pond', { kind: 'agent', id: 'art', workingFor: 'lee' })).toBe(false);
  // A project that is removed, or was never there, is nobody's destination: not a household owner's either.
  f.db.update(projects).set({ removedAt: at }).where(eq(projects.id, 'other')).run();
  expect(move([inPond.id], 'other', owner)).toBe(false);
  expect(move([inPond.id], 'nowhere', owner)).toBe(false);
  expect(move([inPond.id], 'pond', owner)).toBe(true);
  for (const viewer of [{ kind: 'service', id: 'tasks' }, { kind: 'runner', id: 'box' }, { kind: 'member', id: 'missing' }] as Viewer[]) expect(move([own.id], 'pond', viewer)).toBe(false);
});
it('takes a task out of every project only for its owner or a household owner', () => {
  const f = fixture(), owner: Viewer = { kind: 'member', id: 'owner' };
  const sams = f.make({ project: 'pond' }), lees = f.make({ owner: { kind: 'member', id: 'lee' }, project: 'pond' });
  const arts = f.make({ owner: { kind: 'agent', id: 'art' }, project: 'pond' }), households = f.make({ owner: { kind: 'household' }, project: 'pond' });
  const move = (ids: string[], viewer?: Viewer) => f.allowed({ action: 'move', ids, project: null }, viewer);
  // Out of pond the task is its owner's alone. sam acts on all four and owns one, and has art.
  expect(move([sams.id])).toBe(true);
  expect(move([arts.id])).toBe(true);
  expect(move([arts.id], { kind: 'agent', id: 'art' })).toBe(true);
  expect(move([lees.id])).toBe(false);
  expect(move([households.id])).toBe(false);
  expect(move([sams.id, lees.id])).toBe(false);
  // lee owns one and is not in pond, so cannot act on it there.
  expect(move([lees.id], { kind: 'member', id: 'lee' })).toBe(false);
  expect(move([sams.id, lees.id, arts.id, households.id], owner)).toBe(true);
});
it('still places a task in the hand-kept order under the same action name', () => {
  const f = fixture(), own = f.make(), other = f.make(), hidden = f.make({ owner: { kind: 'member', id: 'lee' } });
  expect(f.allowed({ action: 'move', id: own.id, before: null })).toBe(true);
  expect(f.allowed({ action: 'move', id: own.id, before: other.id })).toBe(true);
  expect(f.allowed({ action: 'move', id: own.id, before: hidden.id })).toBe(false);
  expect(f.allowed({ action: 'move', id: hidden.id, before: null })).toBe(false);
});
