import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteKnowledgeBackend } from './backends/sqlite-knowledge.js';
import { knowledgeQueryFields } from './pieces/mind/knowledge-query.js';
import { WebSocket } from 'ws';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { nextData } from './next-data.js';
import * as s from './core/data/schema.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const token = 's'.repeat(64), cookie = 'c'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const query = '{ tasks { id title } }';
const selection = { type: 'subscribe', id: 'tasks', payload: {
  query: 'subscription($query: String!) { observe(query: $query) { revision patches { path removed value } } }', variables: { query },
} };
async function setup(fields?: ReturnType<typeof knowledgeQueryFields>['fields']) {
  const client = new Database(':memory:'); clean.push(() => { if (client.open) client.close(); });
  const pending = new Set<symbol>();
  const clock = new FakeClock();
  const schedule = clock.at.bind(clock);
  clock.at = (time, fn) => {
    const id = Symbol(); pending.add(id);
    const cancel = schedule(time, () => { pending.delete(id); fn(); });
    return () => { pending.delete(id); cancel(); };
  };
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  const at = new Date(clock.now()).toISOString();
  client.exec(`INSERT INTO members (id,role,joined_at) VALUES ('sam','member','${at}'),('owner','owner','${at}');
    INSERT INTO projects (id,name) VALUES ('pond','Pond');
    INSERT INTO project_members (project,member) VALUES ('pond','sam');
    INSERT INTO tasks (id,title,project,owner_kind,owner,created_by_kind,created_by,created_at,changed_at)
    VALUES ('pump','Pump','pond','member','owner','member','owner','${at}','${at}');`);
  client.prepare('INSERT INTO tokens (fingerprint,label,kind,member,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(hash(token),'Sam','owner','sam',at,new Date(clock.now()+3600000).toISOString());
  client.prepare('INSERT INTO sessions (id,token,device,via,is_agent,issued_at,seen_at,proved_at) VALUES (?,?,?,?,?,?,?,?)').run(hash(cookie),hash(token),'Browser','token',0,at,at,at);
  const data = nextData(db, clock, req => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`, undefined, fields);
  clean.push(() => data.close());
  async function bind() {
    const http = createServer(); const detach = data.attach(http);
    await new Promise<void>(ok => http.listen(0,'127.0.0.1',ok));
    clean.push(async () => { detach(); await data.close(); await new Promise<void>(ok => http.close(() => ok())); });
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
    return `ws://127.0.0.1:${address.port}/graphql`;
  }
  const url = await bind();
  async function open(address = url, headers: Record<string,string> = { authorization: `Bearer ${token}` }) {
    const ws = new WebSocket(address,'graphql-transport-ws',{headers}); clean.push(() => { ws.terminate(); });
    await once(ws,'open');
    const ack = once(ws,'message'); ws.send(JSON.stringify({type:'connection_init',payload:{viewer:{kind:'member',id:'owner'}}})); await ack;
    return ws;
  }
  const post = (headers: Record<string,string>) => data.http.request('/graphql', {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({query})});
  return {client,db,clock,pending,data,url,bind,open,post};
}
async function read(ws: WebSocket, action: () => void) {
  const received = once(ws,'message'); action(); return JSON.parse(String((await received)[0]));
}
it('uses shared credentials and the same visible selection for HTTP and socket callers', async () => {
  const f = await setup();
  expect(await (await f.post({authorization:`Bearer ${token}`})).json()).toEqual({data:{tasks:[{id:'pump',title:'Pump'}]}});
  expect((await f.post({authorization:hash(token)})).status).toBe(401);
  const ws = await f.open();
  const first = await read(ws, () => ws.send(JSON.stringify(selection)));
  expect(first.payload.data.observe.patches[0].value).toEqual({tasks:[{id:'pump',title:'Pump'}]});
  const changed = await read(ws, () => {
    const result = f.data.writes.run(() => f.client.exec("UPDATE tasks SET title='Fits'"));
    expect(result.notificationErrors).toEqual([]);
  });
  expect(changed.payload.data.observe).toMatchObject({revision:2,patches:[{path:['tasks',0,'title'],value:'Fits'}]});
});
it('refreshes sharing and then closes revoked callers across both bind addresses', async () => {
  const f = await setup(), second = await f.bind();
  const sockets = [await f.open(),await f.open(second)];
  for (const ws of sockets) await read(ws, () => ws.send(JSON.stringify(selection)));
  const messages = sockets.map(ws => once(ws,'message'));
  f.data.writes.run(() => f.client.exec("DELETE FROM project_members WHERE member='sam'"));
  for (const received of messages) expect(JSON.parse(String((await received)[0])).payload.data.observe.patches).toEqual([{path:['tasks',0],removed:true,value:null}]);
  const closed = sockets.map(ws => once(ws,'close'));
  f.data.writes.run(() => f.client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(new Date(f.clock.now()).toISOString(),hash(token)));
  for (const result of closed) expect((await result)[0]).toBe(4403);
  expect((await f.post({authorization:`Bearer ${token}`})).status).toBe(401);
});
it('requires Origin for shared browser sessions and refuses foreign origins or fingerprints', async () => {
  const f = await setup();
  for (const headers of [{cookie:`loom_ui=${cookie}`},{authorization:`Bearer ${token}`,origin:'https://foreign.invalid'},{authorization:`Bearer ${hash(token)}`}]) {
    const ws = new WebSocket(f.url,'graphql-transport-ws',{headers}); ws.on('error',()=>{});
    expect(await new Promise<number>(ok => ws.once('unexpected-response',(_req,res)=>{res.resume();ws.terminate();ok(res.statusCode!);}))).toBe(401);
  }
  const ws = await f.open(f.url,{cookie:`loom_ui=${cookie}`,origin:f.url.replace('ws:','http:').replace('/graphql','')});
  expect((await read(ws,()=>ws.send(JSON.stringify(selection)))).payload.data.observe.revision).toBe(1);
});
it('does not publish rolled-back writes and closes sockets on shutdown', async () => {
  const f = await setup(), ws = await f.open();
  await read(ws,()=>ws.send(JSON.stringify(selection)));
  expect(()=>f.data.writes.run(()=>{f.client.exec("UPDATE tasks SET title='Rolled back'");throw new Error('Rollback');})).toThrow('Rollback');
  expect(await (await f.post({authorization:`Bearer ${token}`})).json()).toEqual({data:{tasks:[{id:'pump',title:'Pump'}]}});
  const update = await read(ws,()=>{f.data.writes.run(()=>f.client.exec("UPDATE tasks SET title='Committed'"));});
  expect(update.payload.data.observe).toMatchObject({revision:2,patches:[{value:'Committed'}]});
  expect(f.pending.size).toBe(1);
  const closed = once(ws,'close'); await f.data.close(); await closed;
  expect(f.pending.size).toBe(0);
  f.client.close();
  f.clock.advance(3600000);
  expect(f.data.close()).toBe(f.data.close());
});

it('mounts all five HTTP projection tables with current visibility on the socket', async () => {
  const f = await setup(), at = new Date(f.clock.now()).toISOString();
  f.client.exec(`INSERT INTO projects (id,name) VALUES ('hidden','Hidden');
    INSERT INTO agents (id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES ('visible','','#000','#fff','pebble','dot'),('hidden','','#000','#fff','pebble','dot');
    INSERT INTO project_agents (project,agent) VALUES ('pond','visible'),('hidden','hidden');
    INSERT INTO tasks (id,title,project,owner_kind,owner,created_by_kind,created_by,created_at,changed_at)
    VALUES ('other','Other','pond','member','owner','member','owner','${at}','${at}'),('private','Private','hidden','member','owner','member','owner','${at}','${at}');
    INSERT INTO task_comments (task,seq,actor_kind,actor,at,text) VALUES ('pump',1,'member','owner','${at}','Visible'),('private',1,'member','owner','${at}','Hidden');
    INSERT INTO task_links (task,depends_on,type) VALUES ('pump','other','blocks'),('pump','private','blocks');`);
  const query = '{ tasks(orderBy:{id:{direction:asc,priority:0}}) { id } taskComments { text } taskLinks { task dependsOn } projects { id } agents { id } }';
  const response = await f.data.http.request('/graphql',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query})});
  const expected = {tasks:[{id:'other'},{id:'pump'}],taskComments:[{text:'Visible'}],taskLinks:[{task:'pump',dependsOn:'other'}],projects:[{id:'pond'}],agents:[{id:'visible'}]};
  expect(await response.json()).toEqual({data:expected});
  const ws = await f.open();
  const result = await read(ws,()=>ws.send(JSON.stringify({...selection,payload:{...selection.payload,variables:{query}}})));
  expect(result.payload.data.observe.patches[0].value).toEqual(expected);
  const message = once(ws,'message');
  f.data.writes.run(()=>f.client.exec("DELETE FROM project_members WHERE member='sam'"));
  const patches = JSON.parse(String((await message)[0])).payload.data.observe.patches;
  for (const table of ['tasks','taskComments','taskLinks','projects','agents']) expect(patches.some((p: {path:string[];removed:boolean})=>p.path[0]===table&&p.removed)).toBe(true);
});

const emptyProjection = (value: Record<string, unknown>) => Object.fromEntries(Object.keys(value).map(key=>[key,[]]));
const workQuery = `{ approvals { id approvalRecordByApproval { note } } approvalRecord { approval }
  approvalNotices { id } approvalRules { scope } changeSync { failed }
  changes { id changeChecksByChange { name } changePeopleByChange { login } changeTasksByChange { task } }
  changeChecks { change } changePeople { change } changeTasks { change task } }`;
async function workSetup() {
  const f = await setup(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(s.members).values({id:'lee',role:'member',joinedAt:at}).run();
  f.db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  f.db.insert(s.memberAgents).values({member:'sam',agent:'art'}).run();
  for (const [id,member] of [['shared',null],['private','lee']] as const) {
    f.db.insert(s.approvals).values({id,kind:'command',target:id,what:id,why:id,agent:'art',project:'pond',member,askedFrom:'test',actingFor:'unknown',state:'pending',minutes:5,ask:id,ifYes:'yes',ifNo:'no',details:id,askedAt:at}).run();
    f.db.insert(s.approvalRecord).values({seq:id==='shared'?1:2,approval:id,agent:'art',at,event:'request',note:id}).run();
  }
  f.db.insert(s.changes).values({id:'change',repository:'house/test',number:1,title:'Shared',body:'',url:'',state:'open',draft:false,authorLogin:'art',project:'pond',agent:'art',branch:'work',headCommit:'a'.repeat(40),baseBranch:'next',checks:'running',review:'required',mergeable:'unknown',waitingOn:'ci',openedAt:at,updatedAt:at}).run();
  f.db.insert(s.changeChecks).values({change:'change',name:'Tests',state:'running'}).run();
  f.db.insert(s.changePeople).values({change:'change',login:'reviewer',role:'reviewer'}).run();
  f.db.insert(s.tasks).values({id:'private-task',title:'Private',ownerKind:'member',owner:'lee',createdByKind:'member',createdBy:'lee',createdAt:at,changedAt:at}).run();
  f.db.insert(s.changeTasks).values(['pump','private-task'].map(task=>({change:'change',task}))).run();
  f.db.insert(s.approvalNotices).values({id:'notice',agent:'art',kind:'command',target:'test',what:'Done',at}).run();
  f.db.insert(s.approvalRules).values({kind:'command',scope:'*',person:'',tier:'ask',setBy:'owner',setAt:at}).run();
  f.db.insert(s.changeSync).values({failed:false}).run();
  const postWork = (source=workQuery, credential=token) => f.data.http.request('/graphql',{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify({query:source})});
  const observeWork = (ws: WebSocket, source=workQuery) => read(ws,()=>ws.send(JSON.stringify({...selection,payload:{...selection.payload,variables:{query:source}}})));
  return {...f,at,postWork,observeWork};
}
it('mounts Work roots and children on the real shared HTTP and socket with identical privacy', async () => {
  const f = await workSetup(), ws = await f.open();
  const http = await (await f.postWork()).json();
  expect(http.errors).toBeUndefined();
  const expected = {approvals:[{id:'shared',approvalRecordByApproval:[{note:'shared'}]}],approvalRecord:[{approval:'shared'}],
    approvalNotices:[{id:'notice'}],approvalRules:[],changeSync:[],changes:[{id:'change',changeChecksByChange:[{name:'Tests'}],changePeopleByChange:[{login:'reviewer'}],changeTasksByChange:[{task:'pump'}]}],
    changeChecks:[{change:'change'}],changePeople:[{change:'change'}],changeTasks:[{change:'change',task:'pump'}]};
  expect(http.data).toEqual(expected);
  expect((await f.observeWork(ws)).payload.data.observe.patches[0].value).toEqual(expected);
  const changed = await read(ws,()=>{ f.data.writes.run(()=>f.client.exec("DELETE FROM project_members WHERE member='sam'; DELETE FROM member_agents WHERE member='sam'")); });
  for (const field of ['approvals','approvalRecord','approvalNotices','changes','changeChecks','changePeople','changeTasks'])
    expect(changed.payload.data.observe.patches).toContainEqual(expect.objectContaining({path:[field,0],removed:true}));
  expect((await (await f.postWork()).json()).data).toEqual(emptyProjection(expected));
});
it('reads owner-private Work only for a current household owner, then withdraws it on demotion', async () => {
  const f = await workSetup(), ownerToken='o'.repeat(64);
  f.db.insert(s.tokens).values({fingerprint:hash(ownerToken),label:'Owner',kind:'owner',member:'owner',createdAt:f.at}).run();
  const ws = await f.open(f.url,{authorization:`Bearer ${ownerToken}`});
  const first = (await f.observeWork(ws)).payload.data.observe.patches[0].value;
  expect(first.approvals.map((row:{id:string})=>row.id).sort()).toEqual(['private','shared']);
  expect(first.approvalRules).toEqual([{scope:'*'}]); expect(first.changeSync).toEqual([{failed:false}]);
  expect(first.changeTasks).toHaveLength(2);
  expect((await (await f.postWork(workQuery,ownerToken)).json()).data).toEqual(first);
  const changed = await read(ws,()=>{f.data.writes.run(()=>f.client.exec("UPDATE members SET role='member' WHERE id='owner'"));});
  for (const field of Object.keys(first)) expect(changed.payload.data.observe.patches.some((p:{path:string[];removed:boolean})=>p.path[0]===field&&p.removed)).toBe(true);
  expect((await (await f.postWork(workQuery,ownerToken)).json()).data).toEqual(emptyProjection(first));
});
it('keeps credential and operation plumbing outside both Work schemas', async () => {
  const f = await workSetup(), ws = await f.open();
  for (const field of ['tokens','sessions','signinLinks','passkeys','notificationDevices','operationResults']) {
    const query=`{ ${field} { __typename } }`;
    expect((await (await f.postWork(query)).json()).errors).toBeDefined();
    const result = await f.observeWork(ws,query);
    expect(result.payload.errors).toBeDefined();
    expect(result.payload.data?.observe).toBeUndefined();
  }
});

it('gives an agent its shared Work without disclosing member-private approvals and closes on token revocation', async () => {
  const f = await workSetup(), agentToken='a'.repeat(64);
  f.db.insert(s.tokens).values({fingerprint:hash(agentToken),label:'Art body',kind:'agent',agent:'art',createdAt:f.at}).run();
  f.db.insert(s.projectAgents).values({project:'pond',agent:'art'}).run();
  const ws = await f.open(f.url,{authorization:`Bearer ${agentToken}`});
  const first = (await f.observeWork(ws)).payload.data.observe.patches[0].value;
  expect(first.approvals.map((row:{id:string})=>row.id)).toEqual(['shared']);
  expect(first.approvalRecord).toEqual([{approval:'shared'}]);
  expect(first.changeTasks).toEqual([{change:'change',task:'pump'}]);
  expect(first.approvalRules).toEqual([]); expect(first.changeSync).toEqual([]);
  expect((await (await f.postWork(workQuery,agentToken)).json()).data).toEqual(first);
  const closed = once(ws,'close');
  f.data.writes.run(()=>f.client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(f.at,hash(agentToken)));
  expect((await closed)[0]).toBe(4403);
  expect((await f.postWork(workQuery,agentToken)).status).toBe(401);
});

it('keeps project and agent-owner Work grants independent on retained root reads', async () => {
  const f = await workSetup(), ws = await f.open();
  await f.observeWork(ws);
  // Keep project membership while deleting agent ownership. Shared work must
  // remain visible, including current HTTP reads, without a reconnect.
  const projectUpdate = await read(ws,()=>{f.data.writes.run(()=>f.client.exec("DELETE FROM member_agents WHERE member='sam'"));});
  expect(projectUpdate.payload.data.observe.patches).toContainEqual(expect.objectContaining({path:['approvalNotices',0],removed:true}));
  const project = (await (await f.postWork()).json()).data;
  expect(project.approvals.map((row:{id:string})=>row.id)).toEqual(['shared']);
  expect(project.changes.map((row:{id:string})=>row.id)).toEqual(['change']);
  // Switch to agent ownership alone in one committed update. Work is still
  // visible, but project-only task links disappear from the retained watch.
  const agent = await read(ws,()=>{f.data.writes.run(()=>{
    f.client.exec("INSERT INTO member_agents(member,agent) VALUES ('sam','art'); DELETE FROM project_members WHERE member='sam'");
  });});
  expect(agent.payload.data.observe.patches).toContainEqual(expect.objectContaining({path:['changeTasks',0],removed:true}));
  const owned = (await (await f.postWork()).json()).data;
  expect(owned.approvals.map((row:{id:string})=>row.id)).toEqual(['shared']);
  expect(owned.changes.map((row:{id:string})=>row.id)).toEqual(['change']);
  expect(owned.changeTasks).toEqual([]);
  const withdrawn = await read(ws,()=>{f.data.writes.run(()=>f.client.exec("DELETE FROM member_agents WHERE member='sam'"));});
  expect(withdrawn.payload.data.observe.patches).toContainEqual(expect.objectContaining({path:['changes',0],removed:true}));
});

it('serves real Memory and Work through the same HTTP and socket caller, including demotion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'root-memory-work-'));
  clean.push(() => rmSync(home, { recursive: true, force: true }));
  const knowledge = new SqliteKnowledgeBackend({ dbPath: join(home, 'knowledge.db') });
  clean.push(() => knowledge.close());
  await knowledge.writePage({ slug: 'pump', title: 'Fictional pump', domain: 'pond', body: 'Fictional hose instructions.' });
  const sharing = { members: { sam: { owner: true, agents: [] } }, projects: {}, services: {} };
  const reader = knowledgeQueryFields({ path: join(home, 'knowledge.db'), sharing: () => sharing, now: () => 0 });
  clean.push(reader.close);
  const f = await setup(reader.fields);
  f.client.exec("UPDATE members SET role='owner' WHERE id='sam'");
  const mixed = '{ tasks { id } approvals { id } memoryKnowledgePage(slug:"pump") { title body } }';
  const post = async () => (await f.data.http.request('/graphql', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ query: mixed }) })).json();
  const expected = { tasks: [{ id: 'pump' }], approvals: [], memoryKnowledgePage: {
    title: 'Fictional pump', body: 'Fictional hose instructions.',
  } };
  expect(await post()).toEqual({ data: expected });
  const ws = await f.open();
  const first = await read(ws, () => ws.send(JSON.stringify({ ...selection, payload: {
    ...selection.payload, variables: { query: mixed },
  } })));
  expect(first.payload.data.observe.patches[0].value).toEqual(expected);
  const changed = await read(ws, () => f.data.writes.run(() => {
    sharing.members.sam.owner = false;
    f.client.exec("UPDATE members SET role='member' WHERE id='sam'");
  }));
  expect(changed.payload.data.observe.patches).toContainEqual({ path: ['memoryKnowledgePage'], value: null, removed: false });
  expect(await post()).toEqual({ data: { ...expected, memoryKnowledgePage: null } });
  const closed = once(ws, 'close');
  f.data.writes.run(() => f.client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(new Date(f.clock.now()).toISOString(), hash(token)));
  expect((await closed)[0]).toBe(4403);
});

it('ships the Tempo selection through the generated door and withdraws it after project revocation', async () => {
  const f = await setup();
  const at = new Date(f.clock.now()).toISOString();
  f.db.insert(s.triggers).values({ id:'tempo-pond',ownerKind:'household',sourceKind:'answer',watches:'approval:example',lifespan:'once',
    targetKind:'inbox',toKind:'person',to:'owner',project:'pond',note:'Wait for answer',enabled:true,state:'standing',createdAt:at,changedAt:at }).run();
  f.db.insert(s.triggerLog).values({seq:1,trigger:'tempo-pond',at,event:'set',note:''}).run();
  const { tempoQuery } = await import('../web/src/pieces/tempo/query.js');
  const request = () => f.data.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({query:tempoQuery})});
  const first = await (await request()).json();
  expect(first.errors).toBeUndefined();
  expect(first.data.triggers).toMatchObject([{id:'tempo-pond',note:'Wait for answer'}]);
  expect(first.data.triggerLog).toMatchObject([{trigger:'tempo-pond',event:'set'}]);
  const socket = await f.open();
  const initial = await read(socket,()=>socket.send(JSON.stringify({...selection,payload:{...selection.payload,variables:{query:tempoQuery}}})));
  expect(initial.payload.data.observe.patches[0].value).toEqual(first.data);
  const withdrawn = await read(socket,()=>{f.data.writes.run(()=>f.client.exec("DELETE FROM project_members WHERE member='sam'"));});
  expect(withdrawn.payload.data.observe.patches).toEqual(expect.arrayContaining([
    {path:['triggers',0],removed:true,value:null}, {path:['triggerLog',0],removed:true,value:null},
  ]));
  const removed = await (await request()).json();
  expect(removed.errors).toBeUndefined();
  expect(removed.data).toEqual({triggers:[],triggerLog:[],agentPauses:[],tempoTimezone:'UTC'});
});
it('projects only the household timezone for Tempo and publishes changes through the same selection',async()=>{
 const f=await setup();
 f.db.insert(s.household).values({timezone:'America/Chicago',backupTarget:'PRIVATE TARGET'}).run();
 const {tempoQuery}=await import('../web/src/pieces/tempo/query.js');
 const socket=await f.open();
 const first=await read(socket,()=>socket.send(JSON.stringify({...selection,payload:{...selection.payload,variables:{query:tempoQuery}}})));
 expect(first.payload.data.observe.patches[0].value.tempoTimezone).toBe('America/Chicago');
 expect(JSON.stringify(first)).not.toContain('PRIVATE TARGET');
 const settings=await f.data.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({query:'{ household { backupTarget } }'})});
 expect((await settings.json()).errors[0].message).toContain('Cannot query field');
 const changed=await read(socket,()=>{f.data.writes.run(()=>f.db.update(s.household).set({timezone:'Europe/London'}).run());});
 expect(changed.payload.data.observe.patches).toContainEqual({path:['tempoTimezone'],removed:false,value:'Europe/London'});
});
