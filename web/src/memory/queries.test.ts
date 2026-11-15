import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { memoryClient, memoryQueries, MemoryReadError, type MemoryFetch } from './queries';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createFoundation } from '../../../src/core/app.js';
import { createDataSchema } from '../../../src/core/data/database.js';
import { dataHttp } from '../../../src/core/data/http.js';
import { agents, members, tasks, conversationPeople } from '../../../src/core/data/schema.js';
import { FakeClock, type Sharing } from '../../../src/core/index.js';
import { Conversations } from '../../../src/core/conversations/index.js';
import { SqliteKnowledgeBackend } from '../../../src/backends/sqlite-knowledge.js';
import { PeopleStore } from '../../../src/backends/people.js';
import { ProjectsStore } from '../../../src/backends/projects.js';
import { installMindProjects } from '../../../src/pieces/mind/projects.js';
import { mindRole } from '../../../src/pieces/mind/role.js';
import { installMindActivity } from '../../../src/pieces/mind/activity.js';
import { sharedActivityConversations } from '../../../src/pieces/mind/activity-conversations.js';
import { memoryQueryFields } from '../../../src/transport/memory-queries.js';
async function memoryHttpFixture(cleanup: Array<() => unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'memory-door-')); cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const now = Date.parse('2026-11-14T18:00:00Z'), clock = new FakeClock(now), app = createFoundation({home, clock}); cleanup.push(() => app.close());
  const client = new Database(':memory:'); cleanup.push(() => client.close()); const db = createDataSchema(client);
  db.insert(members).values(['owner','peer'].map(id => ({id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: new Date(now).toISOString()}))).run();
  db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(tasks).values({id:'work',title:'Fictional task',ownerKind:'household',createdByKind:'member',createdBy:'owner',createdAt:new Date(now).toISOString(),changedAt:new Date(now).toISOString()}).run();
  const knowledge = new SqliteKnowledgeBackend({dbPath:join(home,'knowledge.db')}); cleanup.push(() => knowledge.close());
  await knowledge.writePage({slug:'pump',title:'Fictional pump',domain:'pond',body:'The fictional pump takes a hose.'});
  const people = new PeopleStore({dbPath:join(home,'memories.db'),actor:'fiction'}); cleanup.push(() => people.close());
  people.write({slug:'friend',name:'Fictional Friend'});
  const projects = new ProjectsStore({dbPath:join(home,'memories.db')}); cleanup.push(() => projects.close());
  projects.write({slug:'pond',name:'Fictional pond'});
  const sharing: Sharing = {members:{owner:{owner:true,agents:[]},peer:{owner:false,agents:[]}},projects:{team:{members:['peer'],agents:['fiction']}},services:{}};
  const source = {agent:'fiction',directory:home,memories:join(home,'memories.db')};
  const projectReader = installMindProjects(app.operations,app.live,{agents:[source],sharing:()=>sharing}); cleanup.push(projectReader.close);
  const conversationHref = (id:string) => `/p/comms-preview/conversation/${encodeURIComponent(id)}`;
  const conversations = new Conversations(db, () => new Date(clock.now()).toISOString());
  const thread = conversations.open({agent:'fiction',venue:'loom',place:'Fictional terminal',label:'Fictional conversation'});
  db.insert(conversationPeople).values({conversation:thread.id,whoKind:'person',who:'friend'}).run();
  const activity = installMindActivity(app.operations,app.live,{agents:[source],sharing:()=>sharing,conversations:sharedActivityConversations(db,{sharing:()=>sharing,conversationHref})}); cleanup.push(activity.close);
  const queries = memoryQueryFields(db,{sources:{commons:{directory:home,knowledge:join(home,'knowledge.db'),people:join(home,'absent.db')},agents:[source]},sharing:()=>sharing,now:()=>clock.now(),mind:mindRole(app.operations),activity,conversationHref,projectHref:(_agent,slug)=>`/project/${slug}`}); cleanup.push(queries.close);
  let valid = true, admitted = false;
  const http = dataHttp(db, request => {
    admitted = true;
    const id = request.headers.get('authorization');
    return id === 'owner' || id === 'peer' ? {viewer:{kind:'member',id},valid:()=>valid} : undefined;
  }, undefined, queries.fields);
  const read = (query:string, token='owner', extra={}) => http.request('http://loom/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:token},body:JSON.stringify({query,...extra})});
  return {http,read,sharing,thread,knowledge,people,projects,clock,home,client,admitted:()=>admitted,end:()=>{valid=false;}};
}

const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const f = await memoryHttpFixture(cleanup);
  let caller = 'owner';
  const requests: Array<{url:string;init:RequestInit}> = [];
  const fetcher: MemoryFetch = async (url,init) => {
    requests.push({url,init});
    return f.http.request('http://loom'+url,{...init,headers:{...init.headers,authorization:caller}});
  };
  return {...f,requests,client:memoryClient(fetcher),caller(id:string) { caller=id; }};
}
it('executes every browser selection against the real generated HTTP schema and existing file readers', async () => {
  const f = await fixture(), c = f.client;
  expect(await c.read(memoryQueries.knowledge())).toMatchObject({total:1,checkDays:30,recentDays:7,pages:[{slug:'pump',title:'Fictional pump'}]});
  const page = await c.read(memoryQueries.page('pump'));
  expect(page).toMatchObject({slug:'pump',body:'The fictional pump takes a hose.',sources:[],citedBy:[]});
  expect(page).not.toHaveProperty('checked');
  expect(await c.read(memoryQueries.people())).toMatchObject([{id:'fiction:friend',card:{where:{},how:{},may:[]}}]);
  expect(await c.read(memoryQueries.person('fiction:friend'))).toMatchObject({synthesizedAt:null,conversations:{available:true,rows:[{id:f.thread.id,title:'Fictional conversation',href:`/p/comms-preview/conversation/${f.thread.id}`}]}});
  expect(await c.read(memoryQueries.projects())).toMatchObject([{id:'fiction:pond',name:'Fictional pond',card:{where:{}}}]);
  expect(await c.read(memoryQueries.project('fiction:pond'))).toMatchObject({id:'fiction:pond',sections:expect.arrayContaining([expect.objectContaining({key:'memories',available:false,counts:{}})])});
  expect(await c.read(memoryQueries.projectMemory('fiction:missing'))).toBeNull();
  const activity = await c.read(memoryQueries.activity());
  expect(activity).toMatchObject({conversations:'available',entries:[{id:`c~fiction~${f.thread.id}`,title:'Fictional conversation'}]});
  expect(await c.read(memoryQueries.activity(activity!.to))).toEqual({...activity,id:activity!.to});
  expect(await c.read(memoryQueries.activityEntry(`c~fiction~${f.thread.id}`))).toMatchObject({title:'Fictional conversation',asked:[],decided:[],more:[],tasks:[],prs:[],links:[{label:'Conversation',href:`/p/comms-preview/conversation/${f.thread.id}`}]});
  for (const {url,init} of f.requests) {
    expect(url).toBe('/graphql');
    expect(init).toMatchObject({method:'POST',cache:'no-store',credentials:'same-origin',headers:{'content-type':'application/json'}});
    expect(JSON.parse(String(init.body))).not.toHaveProperty('viewer');
  }
});

it('keeps typed card values, provenance, canonical ids and project counts usable by screens', async () => {
  const f = await fixture();
  f.people.write({slug:'friend',name:'Fictional Friend',where:{email:{value:'fiction@example.invalid',label:'Work',source:'Fictional source',verified_at:'2026-11-13T18:00:00Z',stale_after_days:30}},how:{empty:'',zero:0,no:false,tags:['one','two']},may:[{text:'A recorded statement',source:'Fictional conversation'}]});
  f.projects.write({slug:'pond',name:'Fictional pond',summary:'Summary',goal:'Keep fictional fish well',where:{hose:{value:'25 mm',source:'Fictional source',verified_at:'2026-11-13T18:00:00Z',stale_after_days:30}},links:{aliases:['on-pond'],repos:['fiction/repo'],notes:['fiction/note'],epic:'t-fiction',venues:['fiction']}});
  const database = new Database(join(f.home,'memories.db')); cleanup.push(() => database.close());
  database.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,ref TEXT,category TEXT,title TEXT,content TEXT,created TEXT,updated TEXT,project TEXT,metadata TEXT,archived INTEGER,expires_at TEXT,salience REAL)');
  const story = 'Full fictional story '.repeat(40), deadline = f.clock.now()+1000;
  database.prepare('INSERT INTO memories VALUES(1,?,?,?,?,?,NULL,?,?,0,?,1)').run('story','project','Fictional story',story,'2026-11-14T17:00:00Z','pond','{}',new Date(deadline).toISOString());
  const person = await f.client.read(memoryQueries.person('fiction:friend'));
  expect(person?.card).toMatchObject({where:{email:{value:'fiction@example.invalid',label:'Work',source:'Fictional source',verified_at:'2026-11-13T18:00:00Z',stale_after_days:30}},how:{empty:'',zero:0,no:false,tags:['one','two']},may:[{text:'A recorded statement',source:'Fictional conversation'}]});
  expect(person?.history).toEqual([expect.objectContaining({card:expect.objectContaining({name:'Fictional Friend',where:{},how:{}})})]);
  await f.knowledge.writePage({slug:'pump',title:'Changed fictional pump',domain:'pond',body:'A later fictional fact.'});
  expect(await f.client.read(memoryQueries.page('pump'))).toMatchObject({body:'A later fictional fact.',history:[expect.objectContaining({body:'The fictional pump takes a hose.'})]});
  const project = await f.client.read(memoryQueries.project('fiction:on-pond'));
  expect(project).toMatchObject({id:'fiction:pond',card:{summary:'Summary',goal:'Keep fictional fish well',where:{hose:{value:'25 mm',source:'Fictional source'}},links:{aliases:['on-pond'],repos:['fiction/repo'],notes:['fiction/note'],epic:'t-fiction',venues:['fiction']}},sections:expect.arrayContaining([expect.objectContaining({key:'memories',total:1,counts:{project:1}})])});
  expect(JSON.stringify(project)).not.toContain(story);
  expect(await f.client.read(memoryQueries.projectMemory('fiction:story'))).toMatchObject({content:story,expires:deadline});
  f.clock.advance(1000);
  expect(await f.client.read(memoryQueries.projectMemory('fiction:story'))).toBeNull();
  f.projects.write({slug:'pond',name:'Changed fictional pond'});
  expect(await f.client.read(memoryQueries.project('fiction:pond'))).toMatchObject({name:'Changed fictional pond'});
});

it('does not retain or reuse owner words after caller changes, demotion, missing ids or session end', async () => {
  const f = await fixture();
  expect(await f.client.read(memoryQueries.person('fiction:friend'))).toHaveProperty('name','Fictional Friend');
  f.caller('peer');
  expect(await f.client.read(memoryQueries.person('fiction:friend'))).toBeNull();
  expect(await f.client.read(memoryQueries.people())).toEqual([]);
  expect(await f.client.read(memoryQueries.projects())).toEqual([]);
  expect(await f.client.read(memoryQueries.knowledge())).toBeNull();
  expect(await f.client.read(memoryQueries.activity())).toBeNull();
  f.caller('owner'); f.sharing.members.owner.owner=false;
  expect(await f.client.read(memoryQueries.person('fiction:friend'))).toBeNull();
  f.sharing.members.owner.owner=true;
  expect(await f.client.read(memoryQueries.person('fiction:absent'))).toBeNull();
  expect(await f.client.read(memoryQueries.page('absent'))).toBeNull();
  expect(await f.client.read(memoryQueries.activityEntry('invalid'))).toBeNull();
  f.end();
  await expect(f.client.read(memoryQueries.person('fiction:friend'))).rejects.toMatchObject({code:'denied'});
});

it('uses variables for exact ids including quotes, unicode and GraphQL-looking text', async () => {
  const f = await fixture(), id = 'fiction:missing") { memoryPeople { name } } # 雨';
  expect(await f.client.read(memoryQueries.person(id))).toBeNull();
  const wire = JSON.parse(String(f.requests.at(-1)!.init.body));
  expect(wire.variables).toEqual({id}); expect(wire.query).not.toContain(id);
  expect(await f.client.read(memoryQueries.page('missing"} # 雨'))).toBeNull();
});

it('discards partial data and sanitizes HTTP, GraphQL, decode and network failures', async () => {
  const responses = [
    Response.json({data:{memoryPeople:[{name:'Private'}]},errors:[{message:'PRIVATE SQL'}]}),
    Response.json({data:{}}), Response.json({data:{memoryPeople:[{}]}}),
    new Response('PRIVATE PATH',{status:500}), new Response('not JSON'),
    Response.json({errors:[{message:'PRIVATE'}]},{status:403}),
  ];
  for (const response of responses) {
    const error = await memoryClient(async () => response).read(memoryQueries.people()).catch(e => e);
    expect(error).toBeInstanceOf(MemoryReadError);
    expect(error.message).not.toMatch(/PRIVATE|SQL|JSON|undefined/);
  }
  await expect(memoryClient(async () => { throw Error('PRIVATE URL'); }).read(memoryQueries.people())).rejects.toThrow('Memory could not load');
});

it('lets a caller abort an obsolete read, including while a response body is being consumed', async () => {
  const controller = new AbortController(), reason = new Error('Selection changed');
  let received: AbortSignal | null | undefined;
  const client = memoryClient(async (_url,init) => {
    received=init.signal;
    return {ok:true,status:200,json:async () => {controller.abort(reason);return {data:{memoryPeople:[]}};}} as Response;
  });
  await expect(client.read(memoryQueries.people(),controller.signal)).rejects.toBe(reason);
  expect(received).toBe(controller.signal);
});
