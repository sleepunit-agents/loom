import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDataSchema } from '../core/data/database.js';
import { dataHttp } from '../core/data/http.js';
import { agents, members, tasks, conversationPeople } from '../core/data/schema.js';
import { FakeClock, type Sharing } from '../core/index.js';
import { Conversations } from '../core/conversations/index.js';
import { KnowledgePages } from '../../test/fixtures/knowledge-pages.js';
import { PeopleStore } from '../backends/people.js';
import { ProjectsStore } from '../backends/projects.js';
import { createProjectsReader } from '../pieces/mind/projects.js';
import { createActivityReader } from '../pieces/mind/activity.js';
import { sharedActivityConversations } from '../pieces/mind/activity-conversations.js';
import { memoryQueryFields } from './memory-queries.js';
const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
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
  const sharing: Sharing = {members:{owner:{owner:true,agents:[]},peer:{owner:false,agents:[]}},projects:{team:{members:['peer'],agents:['fiction']}}};
  const source = {agent:'fiction',directory:home,memories:join(home,'memories.db')};
  const projectReader = createProjectsReader(clock,{agents:[source],sharing:()=>sharing}); cleanup.push(projectReader.close);
  const conversationHref = (id:string) => `/p/comms-preview/conversation/${encodeURIComponent(id)}`;
  const conversations = new Conversations(db, () => new Date(clock.now()).toISOString());
  const thread = conversations.open({agent:'fiction',venue:'loom',place:'Fictional terminal',label:'Fictional conversation'});
  db.insert(conversationPeople).values({conversation:thread.id,whoKind:'person',who:'friend'}).run();
  const activity = createActivityReader(clock,{agents:[source],sharing:()=>sharing,timezone:'America/Chicago',conversations:sharedActivityConversations(db,{conversationHref})}); cleanup.push(activity.close);
  const queries = memoryQueryFields(db,{sources:{commons:{directory:home,knowledge:join(home,'knowledge.db'),people:join(home,'absent.db')},agents:[source]},sharing:()=>sharing,now:()=>clock.now(),projects:projectReader,activity,conversationHref,projectHref:(_agent,slug)=>`/project/${slug}`}); cleanup.push(queries.close);
  let valid = true, admitted = false;
  const http = dataHttp(db, request => {
    admitted = true;
    const id = request.headers.get('authorization');
    return id === 'owner' || id === 'peer' ? {viewer:{kind:'member',id},valid:()=>valid} : undefined;
  }, undefined, queries.fields, {}, undefined, () => clock.now());
  const read = (query:string, token='owner', extra={}) => http.request('http://loom/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:token},body:JSON.stringify({query,...extra})});
  return {db,http,read,sharing,thread,knowledge,client,admitted:()=>admitted,end:()=>{valid=false;}};
}
const selection = `{ tasks { id } memoryKnowledgePage(slug:"pump") { title body } memoryPerson(id:"fiction:friend") { name conversations { available rows { id title href } } } memoryProjects { id name } memoryActivity { entries { id title } conversations } }`;
it('reads Tasks and all four real Memory projections through the authenticated HTTP door', async () => {
  const f = await fixture();
  const response = await f.read(selection);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json(); expect(body.errors).toBeUndefined();
  expect(body.data).toMatchObject({tasks:[{id:'work'}],memoryKnowledgePage:{title:'Fictional pump',body:'The fictional pump takes a hose.'},memoryPerson:{name:'Fictional Friend',conversations:{available:true,rows:[{id:f.thread.id,title:'Fictional conversation',href:`/p/comms-preview/conversation/${f.thread.id}`}]}},memoryProjects:[{id:'fiction:pond',name:'Fictional pond'}],memoryActivity:{conversations:'available',entries:[{id:`c~fiction~${f.thread.id}`,title:'Fictional conversation'}]}});
  await f.knowledge.writePage({slug:'pump',title:'Changed pump',domain:'pond',body:'Changed in its own file.'});
  expect(await (await f.read('{ memoryKnowledgePage(slug:"pump") { title body } }')).json()).toEqual({data:{memoryKnowledgePage:{title:'Changed pump',body:'Changed in its own file.'}}});
});
it('binds every Memory resolver to the caller, rechecks ownership and rejects caller-supplied identity', async () => {
  const f = await fixture();
  expect((await f.read(selection,'peer',{viewer:{kind:'member',id:'owner'}})).status).toBe(400);
  const [ownerResponse, peerResponse] = await Promise.all([f.read(selection), f.read(selection,'peer')]);
  expect((await ownerResponse.json()).data.memoryPerson.name).toBe('Fictional Friend');
  const peer = await peerResponse.json();
  expect(peer.errors).toBeUndefined();
  expect(peer.data).toMatchObject({tasks:[],memoryKnowledgePage:null,memoryPerson:null,memoryProjects:[],memoryActivity:null});
  f.sharing.members.owner.owner=false; f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();
  const demoted = await (await f.read(selection)).json();
  expect(demoted.data).toMatchObject({memoryKnowledgePage:null,memoryPerson:null,memoryProjects:[],memoryActivity:null});
  expect((await (await f.read('{ memoryPerson(id:"fiction:friend",viewer:"owner") { name } }')).json()).errors[0].message).toContain('Unknown argument');
  expect((await f.read(selection,'nobody')).status).toBe(401);
  f.end(); expect((await f.read(selection)).status).toBe(401);
});
it('withholds Memory words when the authenticated session ends during parsing', async () => {
  const f = await fixture();
  // The request stream yields after admission, before any Memory field executes.
  const bytes = new TextEncoder().encode(JSON.stringify({query:selection}));
  const stream = new ReadableStream<Uint8Array>({pull(controller) {
    expect(f.admitted()).toBe(true); f.end(); controller.enqueue(bytes); controller.close();
  }});
  const response = await f.http.fetch(new Request('http://loom/graphql',{method:'POST',headers:{'content-type':'application/json','content-length':String(bytes.length),authorization:'owner'},body:stream,duplex:'half'} as RequestInit));
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('Fictional');
});
