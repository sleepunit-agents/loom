import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { memoryQueries, type MemorySelection } from './queries';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createDataSchema } from '../../../src/core/data/database.js';
import { dataHttp } from '../../../src/core/data/http.js';
import { agents, members, tasks, conversationPeople } from '../../../src/core/data/schema.js';
import { FakeClock, type Sharing } from '../../../src/core/index.js';
import { Conversations } from '../../../src/core/conversations/index.js';
import { KnowledgePages } from '../../../test/fixtures/knowledge-pages.js';
import { PeopleStore } from '../../../src/backends/people.js';
import { ProjectsStore } from '../../../src/backends/projects.js';
import { createProjectsReader } from '../../../src/pieces/mind/projects.js';
import { createActivityReader } from '../../../src/pieces/mind/activity.js';
import { sharedActivityConversations } from '../../../src/pieces/mind/activity-conversations.js';
import { memoryQueryFields } from '../../../src/transport/memory-queries.js';
async function memoryHttpFixture(cleanup: Array<() => unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'memory-door-')); cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const now = Date.parse('2026-11-14T18:00:00Z'), clock = new FakeClock(now);
  const client = new Database(':memory:'); cleanup.push(() => client.close()); const db = createDataSchema(client);
  db.insert(members).values(['owner','peer'].map(id => ({id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: new Date(now).toISOString()}))).run();
  db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(tasks).values({id:'work',title:'Fictional task',ownerKind:'household',createdByKind:'member',createdBy:'owner',createdAt:new Date(now).toISOString(),changedAt:new Date(now).toISOString()}).run();
  const knowledge = new KnowledgePages({dbPath:join(home,'knowledge.db')}); cleanup.push(() => knowledge.close());
  await knowledge.writePage({slug:'pump',title:'Fictional pump',domain:'pond',body:'The fictional pump takes a hose.'});
  const people = new PeopleStore({dbPath:join(home,'memories.db'),actor:'fiction'}); cleanup.push(() => people.close());
  people.write({slug:'friend',name:'Fictional Friend'});
  const projects = new ProjectsStore({dbPath:join(home,'memories.db')}); cleanup.push(() => projects.close());
  projects.write({slug:'pond',name:'Fictional pond'});
  const sharing: Sharing = {members:{owner:{owner:true,agents:[]},peer:{owner:false,agents:[]}},projects:{team:{members:['peer'],agents:['fiction']}},services:{}};
  const source = {agent:'fiction',directory:home,memories:join(home,'memories.db')};
  const projectReader = createProjectsReader(clock,{agents:[source],sharing:()=>sharing}); cleanup.push(projectReader.close);
  const conversationHref = (id:string) => `/p/comms-preview/conversation/${encodeURIComponent(id)}`;
  const conversations = new Conversations(db, () => new Date(clock.now()).toISOString());
  const thread = conversations.open({agent:'fiction',venue:'loom',place:'Fictional terminal',label:'Fictional conversation'});
  db.insert(conversationPeople).values({conversation:thread.id,whoKind:'person',who:'friend'}).run();
  const activity = createActivityReader(clock,{agents:[source],sharing:()=>sharing,timezone:'America/Chicago',conversations:sharedActivityConversations(db,{sharing:()=>sharing,conversationHref})}); cleanup.push(activity.close);
  const queries = memoryQueryFields(db,{sources:{commons:{directory:home,knowledge:join(home,'knowledge.db'),people:join(home,'absent.db')},agents:[source]},sharing:()=>sharing,now:()=>clock.now(),projects:projectReader,activity,conversationHref,projectHref:(_agent,slug)=>`/project/${slug}`}); cleanup.push(queries.close);
  let valid = true, admitted = false;
  const http = dataHttp(db, request => {
    admitted = true;
    const id = request.headers.get('authorization');
    return id === 'owner' || id === 'peer' ? {viewer:{kind:'member',id},valid:()=>valid} : undefined;
  }, undefined, queries.fields, {}, undefined, () => clock.now());
  const read = (query:string, token='owner', extra={}) => http.request('http://loom/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:token},body:JSON.stringify({query,...extra})});
  return {http,read,sharing,thread,knowledge,people,projects,clock,home,client,admitted:()=>admitted,end:()=>{valid=false;}};
}

const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const f = await memoryHttpFixture(cleanup);
  let caller = 'owner';
  const requests: Array<{query:string;variables:Record<string,string>}> = [];
  // Exercise documents/decoders through the actual HTTP schema without keeping
  // a second production transport alongside the canonical live browser client.
  const client={async read<T>(selection:MemorySelection<T>):Promise<T>{
    requests.push({query:selection.query,variables:selection.variables});
    const response=await f.read(selection.query,caller,{variables:selection.variables});
    expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();
    return selection.decode(result.data);
  }};
  return {...f,requests,client,caller(id:string) { caller=id; }};
}
it('executes every browser selection against the real generated HTTP schema and existing file readers', async () => {
  const f = await fixture(), c = f.client;
  expect(await c.read(memoryQueries.knowledgeAccess())).toEqual({allowed:true,canAdd:true,canVerify:true,canRecheck:true});
  expect(await c.read(memoryQueries.peopleAccess())).toEqual({allowed:true,directory:true,canAdd:true,agents:['fiction']});
  expect(await c.read(memoryQueries.projectsAccess())).toEqual({allowed:true,agents:['fiction']});
  expect(await c.read(memoryQueries.activityAccess())).toMatchObject({allowed:true,agents:['fiction'],today:'2026-11-14',windows:expect.any(Array),expires:expect.any(Number)});
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
  for(const request of f.requests)expect(request).not.toHaveProperty('viewer');
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
  expect((await f.read(memoryQueries.person('fiction:friend').query,'owner',{variables:{id:'fiction:friend'}})).status).toBe(401);
});

it('uses variables for exact ids including quotes, unicode and GraphQL-looking text', async () => {
  const f = await fixture(), id = 'fiction:missing") { memoryPeople { name } } # 雨';
  expect(await f.client.read(memoryQueries.person(id))).toBeNull();
  const wire = f.requests.at(-1)!;
  expect(wire.variables).toEqual({id}); expect(wire.query).not.toContain(id);
  expect(await f.client.read(memoryQueries.page('missing"} # 雨'))).toBeNull();
});
