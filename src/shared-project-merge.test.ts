/** Merging one project into another: every record that names the first is filed under the second.
 * The tables are read from the schema, so a table added later with a project on it fails here until the
 * merge says what it does with it. */
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq, getTableName, is, sql } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { createDataSchema, type DataDatabase } from './core/data/database.js';
import * as schema from './core/data/schema.js';
import { approvalRulesService } from './apps/approval-rules.js';
import { taskService } from './apps/tasks.js';
import { Conversations } from './core/conversations/index.js';
import { OperationError } from './core/operations/index.js';
import { holds, rules, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { projectLabelled, sharedProjects } from './shared-projects.js';

const { agents, approvals, approvalRules, changes, conversations, inbox, jobs, members, projectAgents, projectMembers, projectRepositories, projects, tasks, taskComments, taskLinks, triggers } = schema;
const at = '2026-11-17T09:00:00.000Z', later = '2026-11-17T10:00:00.000Z';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });

/** Every household table with a column that names a project: one that refers to `projects`, or is called
 * a project. Read from the schema itself, by SQL name. */
function tablesNamingAProject(): Map<string, { table: SQLiteTable; column: string }> {
  const found = new Map<string, { table: SQLiteTable; column: string }>();
  for (const table of new Set(Object.values(schema).filter((value): value is SQLiteTable => is(value, SQLiteTable)))) {
    if (table === projects) continue;
    const config = getTableConfig(table);
    const referring = config.foreignKeys.flatMap(key => { const to = key.reference(); return to.foreignTable === projects ? to.columns.map(column => column.name) : []; });
    const called = config.columns.filter(column => /project/i.test(column.name)).map(column => column.name);
    const columns = [...new Set([...referring, ...called])];
    // A table that named a project in two columns would need this test, and the merge, to say which is meant.
    expect(columns.length, getTableName(table)).toBeLessThanOrEqual(1);
    if (columns.length) found.set(getTableName(table), { table, column: columns[0] });
  }
  return found;
}

function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const db = createDataSchema(client, () => at);
  db.insert(members).values(['owner', 'sam', 'lee', 'kit'].map(id => ({ id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: at }))).run();
  db.insert(agents).values(['art', 'mark'].map(id => ({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble' as const, faceEyes: 'dot' as const }))).run();
  db.insert(projects).values(['pond', 'garden', 'shed'].map(id => ({ id, name: id }))).run();
  // lee and mark are on pond; sam and art are on garden; kit is on both.
  db.insert(projectMembers).values([['pond', 'lee'], ['pond', 'kit'], ['garden', 'sam'], ['garden', 'kit']].map(([project, member]) => ({ project, member }))).run();
  db.insert(projectAgents).values([['pond', 'mark'], ['garden', 'art']].map(([project, agent]) => ({ project, agent }))).run();
  db.insert(projectRepositories).values([{ project: 'pond', repository: 'github:fixture/pond' }, { project: 'garden', repository: 'github:fixture/garden' }]).run();
  return { client, db, service: sharedProjects(db, () => later) };
}
/** One record of every kind that carries a project, each filed under `project`. */
function fileEverything(db: DataDatabase, client: Database.Database, project: string) {
  const service = taskService(db, () => at), mail = new Conversations(db, () => at);
  const task = service.create({ title: 'Clean ' + project, goal: 'Clean', why: 'Green water', owner: { kind: 'agent', id: 'mark' }, project }, { kind: 'member', id: 'lee' });
  const room = mail.open({ agent: 'mark', venue: 'slack', place: project, label: project, project });
  const item = mail.send({ toKind: 'person', to: 'lee', source: 'notice', fromKind: 'agent', fromId: 'mark', words: 'About ' + project, project, agent: 'mark' });
  db.insert(approvals).values({ id: 'card-' + project, kind: 'command', target: project, what: project, why: project, agent: 'mark', project, askedFrom: 'test', actingFor: 'unknown', state: 'pending', minutes: 5, ask: project, ifYes: 'yes', ifNo: 'no', details: project, askedAt: at }).run();
  client.prepare(`INSERT INTO triggers (id,owner_kind,owner,source_kind,lifespan,target_kind,to_kind,"to",project,note,enabled,state,created_at,changed_at) VALUES (?,'member','lee','time','once','inbox','person','lee',?,'note',1,'standing',?,?)`).run('trigger-' + project, project, at, at);
  db.insert(changes).values({ id: `github:fixture/${project}#1`, repository: 'fixture/' + project, number: 1, title: project, body: '', url: '', state: 'open', draft: false, authorLogin: 'login', project, agent: 'mark', branch: 'branch', headCommit: 'a'.repeat(40), baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
  db.insert(jobs).values({ id: 'job-' + project, agent: 'mark', project, conversation: room.id, title: project, brief: '', model: 'test', state: 'done', startedByKind: 'agent', startedBy: 'mark', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: at }).run();
  return { task, room, item };
}
const filedUnder = (db: DataDatabase, table: SQLiteTable, column: string, project: string) =>
  db.get<{ n: number }>(sql`select count(*) as n from ${table} where ${sql.identifier(column)} = ${project}`).n;

it('says what a merge does with every table that names a project, and no table is left out', () => {
  // A new table with a project on it fails here until shared-projects.ts lists it in `projectLabelled`.
  expect([...tablesNamingAProject().keys()].sort()).toEqual(Object.keys(projectLabelled).sort());
  expect(Object.keys(projectLabelled).sort()).toEqual(['agent_kit_projects', 'agent_post_sources', 'approvals', 'changes', 'conversations', 'inbox', 'jobs', 'project_agents', 'project_claim_directions', 'project_members', 'project_outside_people', 'project_repositories', 'tasks', 'triggers']);
});

it('files every record of the merged project under the other, in every table that names a project', () => {
  const f = fixture(), named = tablesNamingAProject();
  // Kit grants and outside identities stay bound to the exact project the owner named.
  named.delete('agent_post_sources'); named.delete('project_claim_directions'); named.delete('agent_kit_projects'); named.delete('project_outside_people');
  const pond = fileEverything(f.db, f.client, 'pond'), garden = fileEverything(f.db, f.client, 'garden');
  // The fixture puts a pond record in every one of the tables, so none is passed over for being empty.
  for (const [name, { table, column }] of named) expect(filedUnder(f.db, table, column, 'pond'), name).toBeGreaterThan(0);
  const before = Object.fromEntries([...named].map(([name, { table, column }]) => [name, filedUnder(f.db, table, column, 'pond') + filedUnder(f.db, table, column, 'garden')]));
  expect(f.service.merge({ from: 'pond', into: 'garden' })).toEqual({ id: 'garden' });
  // The people and agents of a removed project stay on its own lists, as for any removed project; everything else has left it.
  const kept = new Set(['project_members', 'project_agents']);
  for (const [name, { table, column }] of named) {
    expect(filedUnder(f.db, table, column, 'pond'), name).toBe(kept.has(name) ? { project_members: 2, project_agents: 1 }[name] : 0);
    // Nothing is lost or made: every record is still there, under garden. Someone on both lists is on garden once.
    expect(filedUnder(f.db, table, column, 'garden'), name).toBe(kept.has(name) ? { project_members: 3, project_agents: 2 }[name] : before[name]);
  }
  // The people, agents and repositories of pond are garden's too. A repository has one project: it moved.
  expect(f.service.describe('garden')).toEqual({ id: 'garden', name: 'garden', removed: false, retired: false, members: ['kit', 'lee', 'sam'], agents: ['art', 'mark'], repositories: ['github:fixture/garden', 'github:fixture/pond'] });
  expect(f.service.describe('pond')).toEqual({ id: 'pond', name: 'pond', removed: true, retired: false, members: ['kit', 'lee'], agents: ['mark'], repositories: [] });
  expect(f.db.select().from(projectRepositories).where(eq(projectRepositories.project, 'pond')).all()).toEqual([]);
  // pond is kept and marked removed; garden and the project that took no part are as they were.
  expect(f.db.select().from(projects).all()).toEqual([{ id: 'pond', name: 'pond', removedAt: later, retiredAt: null }, { id: 'garden', name: 'garden', removedAt: null, retiredAt: null }, { id: 'shed', name: 'shed', removedAt: null, retiredAt: null }]);
  // The records themselves are the same ones, with nothing about them changed but where they are filed.
  expect(f.db.select().from(tasks).where(eq(tasks.id, pond.task.id)).get()).toEqual({ ...pond.task, project: 'garden' });
  expect(f.db.select().from(conversations).where(eq(conversations.id, pond.room.id)).get()).toEqual({ ...pond.room, project: 'garden' });
  expect(f.db.select().from(inbox).where(eq(inbox.id, pond.item.id)).get()).toEqual({ ...pond.item, project: 'garden' });
  expect(f.db.select().from(tasks).where(eq(tasks.id, garden.task.id)).get()).toEqual(garden.task);
  expect(f.db.select().from(taskComments).all()).toEqual([]);
  // What it means for the people: pond's member reads garden's task, and garden's member reads pond's.
  const sees = (viewer: Viewer, id: string) => holds(rules.task, viewer, f.db.select().from(tasks).where(eq(tasks.id, id)).get()!, sharedSharing(f.db));
  for (const viewer of [{ kind: 'member', id: 'lee' }, { kind: 'member', id: 'sam' }, { kind: 'agent', id: 'art' }, { kind: 'agent', id: 'mark' }] as Viewer[])
    expect([sees(viewer, pond.task.id), sees(viewer, garden.task.id)], viewer.id).toEqual([true, true]);
});

it('keeps the original audience on authored updates when moving a ticket by project merge', () => {
  const f = fixture();
  const {task} = fileEverything(f.db, f.client, 'pond');
  f.db.insert(schema.agentPostSources).values({id:'work-source:original',project:'pond',task:task.id,agent:'mark'}).run();
  f.service.merge({from:'pond',into:'garden'});
  expect(f.db.select().from(schema.agentPostSources).get()?.project).toBe('pond');
  expect(f.db.select().from(tasks).where(eq(tasks.id,task.id)).get()?.project).toBe('garden');
});

it('preserves each project’s original claim directions when their work is merged', () => {
  const f = fixture();
  const directions = schema.projectClaimDirections;
  f.db.insert(directions).values([
    {project:'garden', member:'kit', agent:'art', paused:false, at},
    {project:'pond', member:'kit', agent:'art', paused:true, at:later},
  ]).run();
  const read = () => f.db.select().from(directions).orderBy(directions.seq).all();
  const before = read();
  f.service.merge({from:'pond', into:'garden'});
  expect(read()).toEqual(before);
});

it('makes the whole merge or none of it', () => {
  const f = fixture(), named = tablesNamingAProject();
  fileEverything(f.db, f.client, 'pond');
  const state = () => [...named].map(([name, { table, column }]) => [name, filedUnder(f.db, table, column, 'pond'), filedUnder(f.db, table, column, 'garden')]);
  const before = state();
  // The last step fails: a project's removal is refused by the database.
  f.client.exec("CREATE TRIGGER refuse_removal BEFORE UPDATE OF removed_at ON projects BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect(() => f.service.merge({ from: 'pond', into: 'garden' })).toThrow('fixture failure');
  expect(state()).toEqual(before);
  expect(f.db.select().from(projects).all().map(row => row.removedAt)).toEqual([null, null, null]);
});

it('refuses a project merged into itself, one that is removed or not there, and a repository left with two projects', () => {
  const f = fixture();
  fileEverything(f.db, f.client, 'pond');
  const refused = (input: { from: string; into: string }) => { try { f.service.merge(input); } catch (error) { return error instanceof OperationError ? [error.code, error.message] : error; } return 'merged'; };
  expect(refused({ from: 'pond', into: 'pond' })).toEqual(['invalid', 'A project cannot be merged into itself']);
  expect(refused({ from: 'nowhere', into: 'garden' })).toEqual(['not-found', 'No project has the id nowhere']);
  expect(refused({ from: 'pond', into: 'nowhere' })).toEqual(['not-found', 'No project has the id nowhere']);
  f.db.update(projects).set({ removedAt: at }).where(eq(projects.id, 'shed')).run();
  expect(refused({ from: 'shed', into: 'garden' })).toEqual(['invalid', 'Project shed is removed']);
  expect(refused({ from: 'pond', into: 'shed' })).toEqual(['invalid', 'Project shed is removed']);
  // A repository of pond is also on a third project's list, in another spelling. After the merge it would be garden's and shed's.
  f.db.update(projects).set({ removedAt: null }).where(eq(projects.id, 'shed')).run();
  f.db.insert(projectRepositories).values({ project: 'shed', repository: 'github:Fixture/Pond' }).run();
  expect(refused({ from: 'pond', into: 'garden' })).toEqual(['conflict', 'A repository would belong to two projects']);
  // Nothing was merged by any of them.
  expect(f.db.select().from(tasks).get()).toMatchObject({ project: 'pond' });
  expect(f.db.select().from(projects).all().map(row => row.removedAt)).toEqual([null, null, null]);
  expect(() => f.service.merge({ from: 'pond', into: 'garden', name: 'Garden' } as never)).toThrow();
});

it('does not carry a standing approval rule for the merged project over to the other', () => {
  // A rule's scope names a project in words, not in a column. It is an owner's word about that one project;
  // carried over, it would answer for every card in the project it was merged into.
  const f = fixture(), ruleSettings = approvalRulesService(f.db, () => at);
  ruleSettings.set({ kind: 'command', scope: 'project:pond', person: '', tier: 'do' }, 'owner');
  const answerFor = (project: string) => ruleSettings.resolve({ kind: 'command', target: 'anything', project, actingFor: 'owner' })?.tier;
  expect([answerFor('pond'), answerFor('garden')]).toEqual(['do', undefined]);
  f.service.merge({ from: 'pond', into: 'garden' });
  expect(f.db.select().from(approvalRules).all()).toMatchObject([{ kind: 'command', scope: 'project:pond', tier: 'do' }]);
  // Every card that was pond's is garden's now, and none of them is answered by the rule.
  expect(answerFor('garden')).toBeUndefined();
});

it('leaves links between tasks as they are', () => {
  const f = fixture(), service = taskService(f.db, () => at);
  const parent = service.create({ title: 'Pond', goal: 'Clean', why: 'Green', owner: { kind: 'household' }, project: 'pond', type: 'epic' }, { kind: 'member', id: 'lee' });
  const child = service.create({ title: 'Filter', goal: 'Clean', why: 'Green', owner: { kind: 'household' }, project: 'shed', parent: parent.id }, { kind: 'member', id: 'lee' });
  f.service.merge({ from: 'pond', into: 'garden' });
  expect(f.db.select().from(taskLinks).all()).toEqual([{ task: child.id, dependsOn: parent.id, type: 'parent-child' }]);
  expect([service.get(parent.id).project, service.get(child.id).project]).toEqual(['garden', 'shed']);
});

it('keeps outside identities on their named project and refuses a merge with project kit grants', () => {
  const f=fixture();
  f.client.prepare('INSERT INTO agent_kits(agent,kit,tools) VALUES (?,?,?)').run('art','garden-tools','[]');
  const grant=f.client.prepare('INSERT INTO agent_kit_projects(agent,kit,project) VALUES (?,?,?)');
  for(const project of ['pond','garden']){
    grant.run('art','garden-tools',project);
    expect(()=>f.service.merge({from:'pond',into:'garden'})).toThrow(/withdraw.*kit/i);
    f.client.prepare('DELETE FROM agent_kit_projects WHERE project=?').run(project);
  }
  f.client.prepare('INSERT INTO project_outside_people(project,platform,workspace,user) VALUES (?,?,?,?)').run('pond','slack','W','U');
  f.service.merge({from:'pond',into:'garden'});
  expect(f.client.prepare('SELECT project FROM project_outside_people').all()).toEqual([{project:'pond'}]);
});
