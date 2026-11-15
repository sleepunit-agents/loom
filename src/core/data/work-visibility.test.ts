import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { createDataSchema, type DataDatabase } from './database.js';
import { dataQueries } from './queries.js';
import { workVisibility } from './work-visibility.js';
import { taskVisibility } from './visibility.js';
import type { Viewer } from '../../policy.js';
import * as s from './schema.js';

let client: Database.Database, db: DataDatabase;
const at = '2026-11-14T00:00:00.000Z';
const tables = ['approvals', 'approvalRecord', 'approvalNotices', 'approvalRules', 'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', 'tasks'] as const;
function schema(viewer: Viewer) { return dataQueries(client, { tables, visibility: { ...taskVisibility(viewer), ...workVisibility(viewer) } }); }
async function read(viewer: Viewer, source: string) {
  const result = await graphql({ schema: schema(viewer), source });
  expect(result.errors).toBeUndefined();
  return JSON.parse(JSON.stringify(result.data));
}
beforeEach(() => {
  client = new Database(':memory:'); db = createDataSchema(client, () => at);
  db.insert(s.members).values(['owner', 'sam', 'lee'].map(id => ({ id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: at }))).run();
  db.insert(s.agents).values(['art', 'other'].map(id => ({ id, about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble' as const, faceEyes: 'dot' as const }))).run();
  db.insert(s.memberAgents).values({ member: 'sam', agent: 'art' }).run();
  db.insert(s.projects).values(['pond', 'secret'].map(id => ({ id, name: id }))).run();
  db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run();
  db.insert(s.projectAgents).values({ project: 'pond', agent: 'art' }).run();
  for (const [id, project, agent, member] of [
    ['project', 'pond', 'other', null], ['agent', 'secret', 'art', null],
    ['private', 'pond', 'art', 'lee'], ['mine', 'secret', 'other', 'sam'], ['hidden', 'secret', 'other', null],
  ] as const) {
    db.insert(s.approvals).values({ id, kind: 'command', target: id, what: id, why: id, agent, project, member, askedFrom: 'test', actingFor: 'unknown', state: 'pending', minutes: 5, ask: id, ifYes: 'yes', ifNo: 'no', details: id, askedAt: at }).run();
    db.insert(s.approvalRecord).values({ seq: ['project','agent','private','mine','hidden'].indexOf(id) + 1, approval: id, agent, at, event: 'request', note: id }).run();
  }
  for (const [id, project, agent] of [['project','pond','other'], ['agent','secret','art'], ['hidden','secret','other'], ['unlabelled',null,null]] as const) {
    db.insert(s.changes).values({ id, repository: 'house/test', number: ['project','agent','hidden','unlabelled'].indexOf(id), title: id, body: id, url: '', state: 'open', draft: false, authorLogin: 'login', project, agent, branch: 'branch', headCommit: 'a'.repeat(40), baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
    db.insert(s.changeChecks).values({ change: id, name: id, state: 'running' }).run();
    db.insert(s.changePeople).values({ change: id, login: id, role: 'reviewer' }).run();
  }
  for (const id of ['visible', 'hidden']) db.insert(s.tasks).values({ id, title: id, project: id === 'visible' ? 'pond' : 'secret', ownerKind: 'household', createdByKind: 'agent', createdBy: 'art', createdAt: at, changedAt: at }).run();
  db.insert(s.changeTasks).values([{ change: 'project', task: 'visible' }, { change: 'project', task: 'hidden' }, { change: 'hidden', task: 'visible' }]).run();
  db.insert(s.approvalNotices).values(['art','other'].map(agent => ({ id: agent, agent, kind: 'command', target: 'pond', what: agent, at }))).run();
  db.insert(s.approvalRules).values({ kind: 'command', scope: '*', person: '', tier: 'ask', setBy: 'owner', setAt: at }).run();
  db.insert(s.changeSync).values({ failed: false }).run();
});
afterEach(() => client.close());
const ids = (rows: {id:string}[]) => rows.map(r => r.id).sort();
it('uses project OR agent access but member-private approvals override both, including record roots', async () => {
  const result = await read({kind:'member',id:'sam'}, '{ approvals { id } approvalRecord { approval } changes { id } }');
  expect(ids(result.approvals)).toEqual(['agent','mine','project']);
  expect(result.approvalRecord.map((r:{approval:string})=>r.approval).sort()).toEqual(['agent','mine','project']);
  expect(ids(result.changes)).toEqual(['agent','project']);
  expect(ids((await read({kind:'member',id:'lee'}, '{ approvals { id } }')).approvals)).toEqual(['private']);
  expect(ids((await read({kind:'agent',id:'art'}, '{ approvals { id } }')).approvals)).toEqual(['agent','project']);
  const owner = await read({kind:'member',id:'owner'}, '{ approvals { id } changes { id } }');
  expect(owner.approvals).toHaveLength(5);
  expect(ids(owner.changes)).toEqual(['agent','hidden','project','unlabelled']);
});
it('filters child roots and nested selections, requiring both task-link ends before returning IDs', async () => {
  const result = await read({kind:'member',id:'sam'}, '{ changeChecks { change } changePeople { change } changeTasks { change task } changes { id changeChecksByChange { name } changePeopleByChange { login } changeTasksByChange { task } } }');
  expect(result.changeChecks.map((r:{change:string})=>r.change).sort()).toEqual(['agent','project']);
  expect(result.changePeople.map((r:{change:string})=>r.change).sort()).toEqual(['agent','project']);
  expect(result.changeTasks).toEqual([{change:'project',task:'visible'}]);
  expect(result.changes.find((r:{id:string})=>r.id==='project').changeTasksByChange).toEqual([{task:'visible'}]);
  for (const row of result.changes) {
    expect(row.changeChecksByChange).toEqual([{name:row.id}]);
    expect(row.changePeopleByChange).toEqual([{login:row.id}]);
  }
  const privateResult = await read({kind:'member',id:'sam'}, '{ approvals { id approvalRecordByApproval { note } } }');
  expect(ids(privateResult.approvals)).toEqual(['agent','mine','project']);
  for (const row of privateResult.approvals) expect(row.approvalRecordByApproval).toEqual([{note:row.id}]);
});
it('keeps retained schemas current across project, agent and household owner revocation', async () => {
  const retained = schema({kind:'member',id:'sam'});
  const query = () => graphql({schema:retained,source:'{ approvals { id } changes { id } changeChecks { change } }'});
  db.delete(s.projectMembers).where(eq(s.projectMembers.member,'sam')).run();
  db.delete(s.memberAgents).where(eq(s.memberAgents.member,'sam')).run();
  const result = await query(); expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({approvals:[{id:'mine'}],changes:[],changeChecks:[]});
  const owner = schema({kind:'member',id:'owner'});
  db.update(s.members).set({role:'member'}).where(eq(s.members.id,'owner')).run();
  expect((await graphql({schema:owner,source:'{ approvals { id } approvalRules { scope } changeSync { failed } }'})).data).toEqual({approvals:[],approvalRules:[],changeSync:[]});
});
it('denies unscoped telemetry/configuration to nonowners and denies runner/service/unknown identities', async () => {
  const source = '{ approvals { id } approvalRecord { approval } approvalNotices { id } approvalRules { scope } changes { id } changeChecks { change } changePeople { change } changeTasks { task } changeSync { failed } }';
  for (const viewer of [{kind:'runner',id:'art'}, {kind:'service',id:'art'}, {kind:'member',id:'missing'}, {kind:'agent',id:'missing'}] as const) {
    const result = await read(viewer,source);
    expect(Object.values(result).every(v => Array.isArray(v) && v.length === 0)).toBe(true);
  }
  const sam = await read({kind:'member',id:'sam'}, source);
  expect(sam.approvalNotices).toEqual([{id:'art'}]); expect(sam.approvalRules).toEqual([]); expect(sam.changeSync).toEqual([]);
  const owner = await read({kind:'member',id:'owner'}, source);
  expect(owner.approvalRules).toHaveLength(1); expect(owner.changeSync).toHaveLength(1); expect(owner.changeTasks).toHaveLength(3);
  expect(owner.approvalRecord.map((r:{approval:string})=>r.approval).sort()).toEqual(['agent','hidden','mine','private','project']);
  expect(ids(owner.approvalNotices)).toEqual(['art','other']);
  expect(owner.changeChecks.map((r:{change:string})=>r.change).sort()).toEqual(['agent','hidden','project','unlabelled']);
  expect(owner.changePeople.map((r:{change:string})=>r.change).sort()).toEqual(['agent','hidden','project','unlabelled']);
  expect((await read({kind:'agent',id:'art'}, '{ approvalNotices { id } }')).approvalNotices).toEqual([{id:'art'}]);
});

it('reads own and project-assigned changes for agents, including connected children, and revokes project assignment in retained schemas', async () => {
  const retained = schema({kind:'agent',id:'art'});
  const source = '{ changes { id changeChecksByChange { name } changePeopleByChange { login } changeTasksByChange { task } } changeChecks { change } changePeople { change } changeTasks { change task } }';
  const initial = await graphql({schema:retained,source});
  expect(initial.errors).toBeUndefined();
  const result = JSON.parse(JSON.stringify(initial.data));
  expect(ids(result.changes)).toEqual(['agent','project']);
  for (const row of result.changes) {
    expect(row.changeChecksByChange).toEqual([{name:row.id}]);
    expect(row.changePeopleByChange).toEqual([{login:row.id}]);
    expect(row.changeTasksByChange).toEqual(row.id === 'project' ? [{task:'visible'}] : []);
  }
  expect(result.changeChecks.map((r:{change:string})=>r.change).sort()).toEqual(['agent','project']);
  expect(result.changePeople.map((r:{change:string})=>r.change).sort()).toEqual(['agent','project']);
  expect(result.changeTasks).toEqual([{change:'project',task:'visible'}]);
  db.delete(s.projectAgents).where(eq(s.projectAgents.agent,'art')).run();
  const revoked = await graphql({schema:retained,source});
  expect(revoked.errors).toBeUndefined();
  expect(revoked.data).toEqual({changes:[{id:'agent',changeChecksByChange:[{name:'agent'}],changePeopleByChange:[{login:'agent'}],changeTasksByChange:[]}],changeChecks:[{change:'agent'}],changePeople:[{change:'agent'}],changeTasks:[]});
});

it('revokes only the task endpoint without hiding the still-visible change or its other children', async () => {
  const retained = schema({kind:'member',id:'sam'});
  const source = '{ changeTasks { change task } changes(where:{id:{eq:"project"}}) { id changeTasksByChange { task } changeChecksByChange { name } } }';
  const initial = await graphql({schema:retained,source});
  expect(initial.errors).toBeUndefined();
  expect(initial.data).toEqual({changeTasks:[{change:'project',task:'visible'}],changes:[{id:'project',changeTasksByChange:[{task:'visible'}],changeChecksByChange:[{name:'project'}]}]});
  db.update(s.tasks).set({project:'secret'}).where(eq(s.tasks.id,'visible')).run();
  const revoked = await graphql({schema:retained,source});
  expect(revoked.errors).toBeUndefined();
  expect(revoked.data).toEqual({changeTasks:[],changes:[{id:'project',changeTasksByChange:[],changeChecksByChange:[{name:'project'}]}]});
});
