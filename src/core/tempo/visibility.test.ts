import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { graphql } from 'graphql/index.js';
import { sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import { createDataSchema } from '../data/database.js';
import { dataQueries } from '../data/queries.js';
import { tempoVisibility } from './visibility.js';

let client: Database.Database;
let statements: string[];
beforeEach(() => {
  statements = [];
  client = new Database(':memory:', { verbose: s => statements.push(String(s)) });
  createDataSchema(client);
  client.exec(`
    INSERT INTO members (id,role,joined_at) VALUES ('owner','owner','2026-11-14T00:00:00Z'),('sam','member','2026-11-14T00:00:00Z'),('other','member','2026-11-14T00:00:00Z');
    INSERT INTO agents (id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES ('art','','#000000','#ffffff','pebble','dot'),('mark','','#000000','#ffffff','pebble','dot'),('hidden','','#000000','#ffffff','pebble','dot');
    INSERT INTO member_agents (member,agent) VALUES ('sam','art');
    INSERT INTO projects (id,name) VALUES ('pond','Pond'),('private','Private');
    INSERT INTO project_members (project,member) VALUES ('pond','sam');
    INSERT INTO project_agents (project,agent) VALUES ('pond','art'),('pond','mark'),('private','hidden');
    INSERT INTO agent_pauses (agent,since) SELECT id,'2026-11-14T00:00:00Z' FROM agents;
  `);
  const insert = client.prepare(`INSERT INTO triggers
    (id,owner_kind,owner,source_kind,lifespan,target_kind,target,to_kind,"to",project,note,instructions,enabled,state,created_at,changed_at)
    VALUES (?, ?, ?, 'time','once', ?, ?, ?, ?, ?, ?, ?,1,'standing','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')`);
  const rows = [
    ['a-hidden','agent','hidden','inbox',null,'agent','hidden','private'],
    ['b-project','member','other','inbox',null,'person','other','pond'],
    ['c-owned','member','other','inbox',null,'agent','art','private'],
    ['d-person','member','sam','inbox',null,'person','sam',null],
    ['e-authored','agent','art','inbox',null,'agent','hidden',null],
    ['f-global','household',null,'operation','sweep',null,null,null],
    ['g-operation','household',null,'operation','sweep',null,null,'pond'],
  ];
  rows.forEach((row, i) => {
    insert.run(...row, row[0], `words ${row[0]}`);
    client.prepare("INSERT INTO trigger_log (seq,trigger,at,event,note) VALUES (?,?,'2026-11-14T00:00:00Z','set',?)").run(i + 1, row[0], `log ${row[0]}`);
  });
});
afterEach(() => client.close());
const schemaFor = (viewer: Viewer) => dataQueries(client, {
  tables: ['triggers','triggerLog','agentPauses'], visibility: tempoVisibility(viewer),
});
const source = '{ triggers(orderBy:{id:{direction:asc,priority:0}}) { id instructions } triggerLog(orderBy:{seq:{direction:asc,priority:0}}) { trigger note } agentPauses(orderBy:{agent:{direction:asc,priority:0}}) { agent } }';
const shared = ['b-project','c-owned','g-operation'];

it.each([
  [{kind:'member',id:'owner'}, ['a-hidden',...shared.slice(0,2),'d-person','e-authored','f-global','g-operation'], ['art','hidden','mark']],
  [{kind:'member',id:'sam'}, shared, ['art','mark']],
  [{kind:'agent',id:'art'}, shared, ['art','mark']],
  [{kind:'agent',id:'mark'}, ['b-project','g-operation'], ['art','mark']],
  [{kind:'member',id:'other'}, [], []],
  [{kind:'member',id:'absent'}, [], []],
  [{kind:'agent',id:'absent'}, [], []],
  [{kind:'runner',id:'owner'}, [], []],
  [{kind:'service',id:'art'}, [], []],
] as const)('applies project OR recipient-agent visibility for %j', async (viewer, ids, pauses) => {
  const result = await graphql({schema:schemaFor(viewer), source});
  expect(result.errors).toBeUndefined();
  expect(result.data?.triggers).toEqual(ids.map(id => ({id,instructions:`words ${id}`})));
  expect(result.data?.triggerLog).toEqual(ids.map(trigger => ({trigger,note:`log ${trigger}`})));
  expect(result.data?.agentPauses).toEqual(pauses.map(agent => ({agent})));
});

it('filters before root pagination and correlated generated relations', async () => {
  statements.length = 0;
  const result = await graphql({schema:schemaFor({kind:'member',id:'sam'}),source:`{
    triggers(orderBy:{id:{direction:asc,priority:0}},limit:1) { id triggerLogByTrigger { trigger note triggerRow { id } } }
    triggerLog(orderBy:{seq:{direction:asc,priority:0}},limit:1) { trigger triggerRow { id instructions } }
  }`});
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({
    triggers:[{id:'b-project',triggerLogByTrigger:[{trigger:'b-project',note:'log b-project',triggerRow:{id:'b-project'}}]}],
    triggerLog:[{trigger:'b-project',triggerRow:{id:'b-project',instructions:'words b-project'}}],
  });
  const reads=statements.filter(s=>/^select /i.test(s));
  expect(reads).toHaveLength(2);
  expect(reads.every(s=>/where.*exists/is.test(s))).toBe(true);
});

it('rechecks project membership, agent ownership, recipient and owner role in retained schemas', async () => {
  const sam=schemaFor({kind:'member',id:'sam'});
  const art=schemaFor({kind:'agent',id:'art'});
  const owner=schemaFor({kind:'member',id:'owner'});
  client.exec("DELETE FROM project_members; DELETE FROM project_agents; DELETE FROM member_agents; UPDATE members SET role='member' WHERE id='owner'");
  for(const schema of [sam,owner]) {
    const result=await graphql({schema,source});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({triggers:[],triggerLog:[],agentPauses:[]});
  }
  expect((await graphql({schema:art,source})).data?.triggers).toEqual([{id:'c-owned',instructions:'words c-owned'}]);
  client.exec("UPDATE triggers SET \"to\"='hidden' WHERE id='c-owned'");
  const result=await graphql({schema:art,source});
  expect(result.errors).toBeUndefined();
  expect(result.data?.triggers).toEqual([]);
  expect(result.data?.triggerLog).toEqual([]);
});

it('retains owned and self pause access without any project sharing', async () => {
  const sam = schemaFor({kind:'member',id:'sam'});
  const art = schemaFor({kind:'agent',id:'art'});
  client.exec('DELETE FROM project_members; DELETE FROM project_agents');
  for (const schema of [sam, art]) {
    const result = await graphql({schema,source:'{ agentPauses { agent } }'});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({agentPauses:[{agent:'art'}]});
  }
  client.exec('DELETE FROM member_agents');
  expect((await graphql({schema:sam,source:'{ agentPauses { agent } }'})).data).toEqual({agentPauses:[]});
  expect((await graphql({schema:art,source:'{ agentPauses { agent } }'})).data).toEqual({agentPauses:[{agent:'art'}]});
});

it('filters denied children from independently visible project and agent parents', async () => {
  // These fixture parents are intentionally public to isolate the Tempo child
  // predicates. Production project/agent policies remain the root owner's job.
  const schema = dataQueries(client, {
    tables:['projects','agents','triggers','triggerLog','agentPauses'],
    visibility:{...tempoVisibility({kind:'member',id:'sam'}), projects:()=>sql`true`, agents:()=>sql`true`},
  });
  const result = await graphql({schema,source:`{
    projects(where:{id:{eq:"private"}}) {
      id triggersByProject(orderBy:{id:{direction:asc,priority:0}},limit:1) {
        id triggerLogByTrigger { trigger }
      }
    }
    agents(where:{id:{eq:"hidden"}}) { id agentPausesByAgent { agent } }
  }`});
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({
    projects:[{id:'private',triggersByProject:[{id:'c-owned',triggerLogByTrigger:[{trigger:'c-owned'}]}]}],
    agents:[{id:'hidden',agentPausesByAgent:[]}],
  });
});

it('captures identity scalars and cannot bypass denial with aliases or filters', async () => {
  const viewer:Viewer={kind:'member',id:'other'};
  const schema=schemaFor(viewer);
  viewer.id='owner';
  const result=await graphql({schema,source:'{ stolen:triggers(where:{id:{eq:"a-hidden"}},limit:1){id instructions} logs:triggerLog{note} }'});
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({stolen:[],logs:[]});
  expect(schema.getMutationType()).toBeUndefined();
});
