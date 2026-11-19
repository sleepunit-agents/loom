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
    client.prepare("INSERT INTO trigger_edits (seq,trigger,at,by_kind,\"by\",\"before\") VALUES (?,?,'2026-11-14T00:00:00Z','member','owner',?)").run(i + 1, row[0], `was ${row[0]}`);
  });
});
afterEach(() => client.close());
const schemaFor = (viewer: Viewer) => dataQueries(client, {
  tables: ['triggers','triggerLog','triggerEdits','agentPauses'], visibility: tempoVisibility(viewer),
});
const source = '{ triggers(orderBy:{id:{direction:asc,priority:0}}) { id instructions } triggerLog(orderBy:{seq:{direction:asc,priority:0}}) { trigger note } triggerEdits(orderBy:{seq:{direction:asc,priority:0}}) { trigger before } agentPauses(orderBy:{agent:{direction:asc,priority:0}}) { agent } }';
const shared = ['b-project','c-owned','g-operation'];

it.each([
  [{kind:'member',id:'owner'}, ['a-hidden',...shared.slice(0,2),'d-person','e-authored','f-global','g-operation'], ['art','hidden','mark']],
  // sam also sees the trigger sam set for sam, though it is in no project.
  [{kind:'member',id:'sam'}, ['b-project','c-owned','d-person','g-operation'], ['art','mark']],
  [{kind:'agent',id:'art'}, shared, ['art','mark']],
  [{kind:'agent',id:'mark'}, ['b-project','g-operation'], ['art','mark']],
  // other is on no project and owns no agent, but set two triggers, one of them for other.
  [{kind:'member',id:'other'}, ['b-project','c-owned'], []],
  [{kind:'member',id:'absent'}, [], []],
  [{kind:'agent',id:'absent'}, [], []],
  [{kind:'runner',id:'owner'}, [], []],
  [{kind:'service',id:'art'}, [], []],
] as const)('applies project, recipient-agent and own-trigger visibility for %j', async (viewer, ids, pauses) => {
  const result = await graphql({schema:schemaFor(viewer), source});
  expect(result.errors).toBeUndefined();
  expect(result.data?.triggers).toEqual(ids.map(id => ({id,instructions:`words ${id}`})));
  expect(result.data?.triggerLog).toEqual(ids.map(trigger => ({trigger,note:`log ${trigger}`})));
  expect(result.data?.triggerEdits).toEqual(ids.map(trigger => ({trigger,before:`was ${trigger}`})));
  expect(result.data?.agentPauses).toEqual(pauses.map(agent => ({agent})));
});

it('filters before root pagination and correlated generated relations', async () => {
  client.prepare('UPDATE triggers SET needs=?, prefers=? WHERE id=?').run('["linux"]', '["fast"]', 'b-project');
  statements.length = 0;
  const result = await graphql({schema:schemaFor({kind:'member',id:'sam'}),source:`{
    triggers(orderBy:{id:{direction:asc,priority:0}},limit:1) { id triggerLogByTrigger { trigger note triggerRow { id } } }
    triggerLog(orderBy:{seq:{direction:asc,priority:0}},limit:1) { trigger triggerRow { id instructions needs prefers } }
  }`});
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({
    triggers:[{id:'b-project',triggerLogByTrigger:[{trigger:'b-project',note:'log b-project',triggerRow:{id:'b-project'}}]}],
    triggerLog:[{trigger:'b-project',triggerRow:{id:'b-project',instructions:'words b-project',needs:['linux'],prefers:['fast']}}],
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
    // Losing projects and agents leaves a person only the trigger they set for themselves.
    expect(result.data).toEqual(schema===sam?{triggers:[{id:'d-person',instructions:'words d-person'}],triggerLog:[{trigger:'d-person',note:'log d-person'}],triggerEdits:[{trigger:'d-person',before:'was d-person'}],agentPauses:[]}:{triggers:[],triggerLog:[],triggerEdits:[],agentPauses:[]});
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
  // The schema keeps the identity it was built for: other's own two triggers, never the owner's view.
  expect(result.data).toEqual({stolen:[],logs:[{note:'log b-project'},{note:'log c-owned'}]});
  expect(schema.getMutationType()).toBeUndefined();
});
it('shows recipient-free agent operation triggers to that agent and its owners, with current ownership rechecked',async()=>{
 client.prepare(`INSERT INTO triggers (id,owner_kind,owner,source_kind,lifespan,target_kind,target,note,enabled,state,created_at,changed_at)
  VALUES ('own-operation','agent','art','time','until-stopped','operation','tempo.sweep','Owned operation',1,'standing','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')`).run();
 client.prepare("INSERT INTO trigger_log(seq,trigger,at,event,note) VALUES(8,'own-operation','2026-11-14T00:00:00Z','set','Owned operation')").run();
 for(const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'sam'},{kind:'member',id:'owner'}] as const){
  const result=await graphql({schema:schemaFor(viewer),source});expect(result.errors).toBeUndefined();
  expect((result.data?.triggers as {id:string}[]).map(t=>t.id)).toContain('own-operation');
  expect((result.data?.triggerLog as {trigger:string}[]).map(t=>t.trigger)).toContain('own-operation');
 }
 const retained=schemaFor({kind:'member',id:'sam'});
 client.exec("DELETE FROM member_agents WHERE member='sam'");
 const result=await graphql({schema:retained,source});
 expect((result.data?.triggers as {id:string}[]).map(t=>t.id)).not.toContain('own-operation');
 expect((result.data?.triggerLog as {trigger:string}[]).map(t=>t.trigger)).not.toContain('own-operation');
 for(const viewer of [{kind:'agent',id:'mark'},{kind:'member',id:'other'}] as const){
  const other=await graphql({schema:schemaFor(viewer),source});
  expect((other.data?.triggers as {id:string}[]).map(t=>t.id)).not.toContain('own-operation');
 }
});
it('does not turn authorship of an explicitly addressed operation into agent-owner visibility',async()=>{
 client.prepare(`INSERT INTO triggers(id,owner_kind,owner,source_kind,lifespan,target_kind,target,to_kind,"to",project,note,enabled,state,created_at,changed_at)
  VALUES('explicit-operation','agent','art','time','once','operation','test','agent','hidden','private','Other agent operation',1,'standing','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')`).run();
 client.prepare("INSERT INTO trigger_log(seq,trigger,at,event,note) VALUES(8,'explicit-operation','2026-11-14T00:00:00Z','set','Other agent operation')").run();
 for(const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'sam'}] as const){
  const result=await graphql({schema:schemaFor(viewer),source});expect(result.errors).toBeUndefined();
  expect((result.data?.triggers as {id:string}[]).map(t=>t.id)).not.toContain('explicit-operation');
  expect((result.data?.triggerLog as {trigger:string}[]).map(t=>t.trigger)).not.toContain('explicit-operation');
 }
});

it('keeps program state and configuration out of table projections, including filters and relations', async () => {
  const schema = schemaFor({ kind: 'member', id: 'sam' });
  for (const source of [
    '{ triggers { program } }',
    '{ triggerLog { triggerRow { programState } } }',
    '{ triggers(where:{programState:{eq:"draft"}}) { id } }',
    '{ triggers(where:{OR:[{readStateFrom:{eq:"private"}}]}) { id } }',
    '{ triggers(orderBy:{program:{direction:asc,priority:0}}) { id } }',
  ]) expect((await graphql({ schema, source })).errors?.length).toBeGreaterThan(0);
});
