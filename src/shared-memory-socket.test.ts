import { expect, it, vi } from 'vitest';
import * as socketModule from './core/data/socket.js';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { serveShared } from './shared-serve.js';
import { FakeClock } from './core/index.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, tokens, sessions, tasks, conversationPeople, conversations, household } from './core/data/schema.js';
import { Conversations } from './core/conversations/index.js';
import { KnowledgePages } from '../test/fixtures/knowledge-pages.js';
import { PeopleStore } from './backends/people.js';
import { ProjectsStore } from './backends/projects.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credentials = {owner:'a'.repeat(64), peer:'b'.repeat(64), short:'c'.repeat(64)};
const cookie = 'd'.repeat(64);
const query = '{ tasks { id title } memoryKnowledgePage(slug:"pump") { title body history { body } } memoryPerson(id:"fiction:friend") { name conversations { available rows { title } } } memoryProjects { id name } memoryActivity { entries { title } } }';
type Message = {type: string; id?: string; payload?: {data?: Record<string, unknown>; errors?: unknown[]}};
async function message(ws: WebSocket, action: () => unknown): Promise<Message> {
  const pending = once(ws, 'message'); await action(); return JSON.parse(String((await pending)[0]));
}
const observe = (ws: WebSocket) => message(ws, () => ws.send(JSON.stringify({id:'live',type:'subscribe',payload:{
  query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }', variables:{query},
}})));
async function setup(now=Date.parse('2026-11-14T18:00:00Z')) {
  const home = mkdtempSync(join(tmpdir(),'memory-socket-next-'));
  const clock = new FakeClock(now), at = new Date(clock.now()).toISOString();
  const client = new Database(join(home,'loom.db')), db = createDataSchema(client);
  db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'peer',role:'member',joinedAt:at}]).run();
  db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  for (const [name,raw] of Object.entries(credentials)) db.insert(tokens).values({fingerprint:hash(raw),label:name,kind:'owner',member:name === 'short'?'owner':name,createdAt:at,expiresAt:name === 'short'?new Date(clock.now()+1000).toISOString():undefined}).run();
  db.insert(sessions).values({id:hash(cookie),token:hash(credentials.owner),device:'Fictional browser',via:'token',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
  db.insert(tasks).values({id:'work',title:'Fictional task',ownerKind:'household',createdByKind:'member',createdBy:'owner',createdAt:at,changedAt:at}).run();
  const conversations = new Conversations(db,()=>new Date(clock.now()).toISOString());
  const thread = conversations.open({agent:'fiction',venue:'loom',place:'Fictional terminal',label:'Fictional conversation'});
  db.insert(conversationPeople).values({conversation:thread.id,whoKind:'person',who:'friend'}).run();
  db.insert(household).values({defaultAgent:'fiction',timezone:'UTC'}).run();
  mkdirSync(join(home,'commons'),{recursive:true}); mkdirSync(join(home,'agents/fiction'),{recursive:true});
  const knowledge = new KnowledgePages({dbPath:join(home,'commons/knowledge.db')});
  await knowledge.writePage({slug:'pump',title:'Earlier pump',domain:'pond',body:'Earlier fictional words'});
  await knowledge.writePage({slug:'pump',title:'Fictional pump',domain:'pond',body:'Fictional hose'});
  const people = new PeopleStore({dbPath:join(home,'agents/fiction/memories.db'),actor:'fiction'});
  people.write({slug:'friend',name:'Fictional Friend'}); people.close();
  const projects = new ProjectsStore({dbPath:join(home,'agents/fiction/memories.db')});
  projects.write({slug:'pond',name:'Fictional pond'}); projects.close();
  const commons=join(home,'commons'),directory=join(home,'agents/fiction');
  const loom=await serveShared({db,clock,memory:{checkingAgent:'fiction',sources:{commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:[{agent:'fiction',directory,memories:join(directory,'memories.db')}]}},originAllowed:req=>!req.headers.origin||req.headers.origin===`http://${req.headers.host}`,reportError:error=>{throw error;}});
  const sockets: WebSocket[] = [];
  const open = async (who: keyof typeof credentials | null = 'owner', headers: Record<string,string> = {}, base = loom.url) => {
    const ws = new WebSocket(base.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{...(who ? {authorization:'Bearer '+credentials[who]} : {}),...headers}});sockets.push(ws);
    await once(ws,'open');
    expect(await message(ws,()=>ws.send(JSON.stringify({type:'connection_init',payload:{viewer:{kind:'member',id:'owner'}}})))).toEqual({type:'connection_ack'});
    return ws;
  };
  return {home,loom,clock,knowledge,open,db,async close(){for(const ws of sockets)ws.terminate();await loom.close();knowledge.close();client.close();rmSync(home,{recursive:true,force:true});}};
}

it('mounts the same generated and four Memory projections on HTTP, ordinary socket reads and live selections',async()=>{
  const f=await setup();
  try {
    const response=await fetch(f.loom.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credentials.owner,'content-type':'application/json'},body:JSON.stringify({query})});
    const expected=await response.json(); expect(expected.errors).toBeUndefined();
    expect(expected.data).toMatchObject({tasks:[{id:'work',title:'Fictional task'}],memoryKnowledgePage:{title:'Fictional pump',body:'Fictional hose',history:[{body:'Earlier fictional words'}]},memoryPerson:{name:'Fictional Friend',conversations:{available:true,rows:[{title:'Fictional conversation'}]}},memoryProjects:[{id:'fiction:pond',name:'Fictional pond'}],memoryActivity:{entries:[{title:'Fictional conversation'}]}});
    const ws=await f.open();
    const ordinary = new Promise<Message[]>(ok => {
      const frames: Message[] = [];
      const receive = (raw: import('ws').RawData) => {const frame = JSON.parse(String(raw));frames.push(frame);if(frame.type === 'complete' || frame.type === 'error'){ws.off('message',receive);ok(frames);}};
      ws.on('message',receive);
    });
    ws.send(JSON.stringify({id:'read',type:'subscribe',payload:{query}}));
    expect(await ordinary).toEqual([{id:'read',type:'next',payload:expected},{id:'read',type:'complete'}]);
    const live=await f.open('owner',{},f.loom.url);
    expect(await observe(live)).toMatchObject({type:'next',payload:{data:{observe:{revision:1,patches:[{path:[],removed:false,value:expected.data}]}}}});
    f.loom.operations.register({name:'fiction.renameTask',input:z.object({title:z.string()}),output:z.null(),write:true,may:()=>true,
      run(ctx,input){ctx.db.prepare('UPDATE tasks SET title=? WHERE id=?').run(input.title,'work');ctx.changed('task','work');return null;}});
    const committed=await message(live,()=>expect(f.loom.operations.call('direct',{kind:'member',id:'owner'},'fiction.renameTask',{title:'Changed by a committed operation'},'fiction-rename')).toEqual({ok:true,value:null}));
    expect(committed).toMatchObject({payload:{data:{observe:{patches:[{path:['tasks',0,'title'],removed:false,value:'Changed by a committed operation'}]}}}});
    await f.knowledge.writePage({slug:'pump',title:'Changed fictional pump',domain:'pond',body:'Changed fictional hose'});
    const changed=await message(live,()=>f.loom.changed());
    expect(JSON.stringify(changed)).toContain('Changed fictional pump');
    expect(JSON.stringify(changed)).toContain('Changed fictional hose');
  } finally {await f.close();}
});

it('refreshes all four file projections when the program is told their files changed',async()=>{
  const f=await setup();
  const path=join(f.home,'agents/fiction/memories.db');
  const writer=new Database(path);
  writer.exec("CREATE TABLE memories(ref TEXT,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)");
  try {
    const ws=await f.open();await observe(ws);
    const changedKnowledge=await message(ws,async()=>{await f.knowledge.writePage({slug:'pump',title:'Touched pump',domain:'pond',body:'Touched hose'});f.loom.changed();});
    expect(changedKnowledge).toMatchObject({payload:{data:{observe:{patches:expect.arrayContaining([
      {path:['memoryKnowledgePage','title'],removed:false,value:'Touched pump'},
      {path:['memoryKnowledgePage','body'],removed:false,value:'Touched hose'},
    ])}}}});
    const people=new PeopleStore({dbPath:path,actor:'fiction'});
    try {
      const changedPerson=await message(ws,()=>{people.write({slug:'friend',name:'Touched Friend'});f.loom.changed();});
      expect(changedPerson).toMatchObject({payload:{data:{observe:{patches:[{path:['memoryPerson','name'],removed:false,value:'Touched Friend'}]}}}});
    } finally {people.close();}
    const projects=new ProjectsStore({dbPath:path});
    try {
      const changedProject=await message(ws,()=>{projects.write({slug:'pond',name:'Touched pond'});f.loom.changed();});
      expect(changedProject).toMatchObject({payload:{data:{observe:{patches:[{path:['memoryProjects',0,'name'],removed:false,value:'Touched pond'}]}}}});
    } finally {projects.close();}
    const changedEpisode=await message(ws,()=>{
      writer.prepare('INSERT INTO memories VALUES(?,?,?,?,NULL,?,NULL,?,0)').run('touched-story','Touched episode','Fictional committed story',new Date(f.clock.now()).toISOString(),'{"where":"terminal"}','episode');
      f.loom.changed();
    });
    expect(JSON.stringify(changedEpisode)).toContain('Touched episode');
    const response=await fetch(f.loom.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credentials.owner,'content-type':'application/json'},body:JSON.stringify({query})});
    const current=await response.json();expect(current.errors).toBeUndefined();
    expect(current.data).toMatchObject({memoryKnowledgePage:{title:'Touched pump',body:'Touched hose'},memoryPerson:{name:'Touched Friend'},memoryProjects:[{name:'Touched pond'}],memoryActivity:{entries:expect.arrayContaining([expect.objectContaining({title:'Touched episode'})])}});
    const archivedPeople=new PeopleStore({dbPath:path,actor:'fiction'});
    try {
      const archived=await message(ws,()=>{archivedPeople.archive({slug:'friend',reason:'Fictional archive',actor:'fiction'});f.loom.changed();});
      expect(archived).toMatchObject({payload:{data:{observe:{patches:[{path:['memoryPerson'],removed:false,value:null}]}}}});
    } finally {archivedPeople.close();}
    const archivedProjects=new ProjectsStore({dbPath:path});
    try {
      const archived=await message(ws,()=>{archivedProjects.archive({slug:'pond',reason:'Fictional archive',actor:'fiction'});f.loom.changed();});
      expect(archived).toMatchObject({payload:{data:{observe:{patches:[{path:['memoryProjects',0],removed:true,value:null}]}}}});
    } finally {archivedProjects.close();}
    const archivedEpisode=await message(ws,()=>{
      writer.prepare('UPDATE memories SET archived=1 WHERE ref=?').run('touched-story');
      f.loom.changed();
    });
    expect(JSON.stringify(archivedEpisode)).toContain('memoryActivity');
    const after=await fetch(f.loom.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credentials.owner,'content-type':'application/json'},body:JSON.stringify({query})});
    expect((await after.json()).data).toMatchObject({memoryPerson:null,memoryProjects:[],memoryActivity:{entries:[{title:'Fictional conversation'}]}});
  } finally {writer.close();await f.close();}
});

it('keeps simultaneous owner and peer selections separate and removes words after access changes',async()=>{
  const f=await setup();
  try {
    const owner=await f.open(),peer=await f.open('peer');
    expect(JSON.stringify(await observe(owner))).toContain('Fictional hose');
    const denied=await observe(peer); expect(JSON.stringify(denied)).not.toContain('Fictional');
    expect(denied).toMatchObject({payload:{data:{observe:{patches:[{value:{tasks:[],memoryKnowledgePage:null,memoryPerson:null,memoryProjects:[],memoryActivity:null}}]}}}});
    f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();
    const stripped=await message(owner,()=>f.loom.changed());
    expect(JSON.stringify(stripped)).not.toContain('Fictional');
    expect(stripped).toMatchObject({payload:{data:{observe:{patches:expect.arrayContaining([{path:['memoryKnowledgePage'],removed:false,value:null},{path:['memoryPerson'],removed:false,value:null},{path:['memoryActivity'],removed:false,value:null}])}}}});
    const closed=once(owner,'close');f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.fingerprint,hash(credentials.owner))).run();
    f.loom.changed(); expect((await closed)[0]).toBe(4403);
    const expiry=await f.open('short'),expired=once(expiry,'close');f.clock.advance(1000);expect((await expired)[0]).toBe(4403);
  } finally {await f.close();}
});

it('refuses unauthenticated and cross-origin upgrades and closes sockets at shutdown',async()=>{
  const f=await setup();
  try {
    for(const headers of [{},{authorization:'Bearer '+credentials.owner,origin:'https://evil.invalid'},{cookie:'loom_ui='+cookie}]) {
      const ws=new WebSocket(f.loom.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers});ws.on('error',()=>{});
      const status=await new Promise<number>(ok=>ws.once('unexpected-response',(_req,res)=>{res.resume();ws.terminate();ok(res.statusCode!);}));expect(status).toBe(401);
    }
    const ws=await f.open(null,{cookie:'loom_ui='+cookie,origin:f.loom.url});
    expect(JSON.stringify(await observe(ws))).toContain('Fictional hose');
    const closed=once(ws,'close');await f.loom.close();await closed;
  } finally {await f.close();}
});


it('disposes the socket, pending selection and change observer on listener shutdown',async()=>{
  const factory = vi.spyOn(socketModule,'dataSocket');
  const f=await setup();
  const options=factory.mock.calls[0][0],socket=factory.mock.results[0].value as ReturnType<typeof socketModule.dataSocket>;
  const dispose=vi.spyOn(socket,'close'),watch=vi.spyOn(options.live,'watch'),changed=vi.spyOn(options.live,'changed');
  try {
    const ws=await f.open();await observe(ws);
    const selection=watch.mock.results[0].value as ReturnType<typeof options.live.watch>;
    await f.loom.close();
    expect(dispose).toHaveBeenCalledOnce();
    expect(await selection.next()).toEqual({done:true,value:undefined});
    expect(()=>options.live.watch({schema:options.schema({kind:'member',id:'owner'}),query:'{ tasks { id } }',valid:()=>true})).toThrow('Live data access ended');
    changed.mockClear(); f.loom.changed();
    expect(changed).not.toHaveBeenCalled();
  } finally {await f.close();vi.restoreAllMocks();}
});

it('refreshes Knowledge at exact clock boundaries without writes and cancels its owned deadline',async()=>{
  const f=await setup();
  const writer=new Database(join(f.home,'commons/knowledge.db'));
  try {
    const now=f.clock.now(),day=86400_000;
    for(const [slug,age] of [['recent',7],['aging',20],['due',30]] as const){
      await f.knowledge.writePage({slug,title:slug,domain:'fiction',body:'Fictional fact'});
      writer.prepare('UPDATE pages SET verified_at=? WHERE slug=?').run(new Date(now-age*day+1000).toISOString(),slug);
    }
    // A change arms the one shared deadline before the subscriptions.
    const scheduled=vi.spyOn(f.clock,'at');
    f.loom.changed();
    await vi.waitFor(()=>expect(scheduled).toHaveBeenCalledWith(now+1000,expect.any(Function)));
    scheduled.mockRestore();
    const selection='{ memoryKnowledge { pages { slug fresh recent } } memoryKnowledgePage(slug:"due") { fresh } }';
    const subscribe=(ws:WebSocket)=>message(ws,()=>ws.send(JSON.stringify({id:'time',type:'subscribe',payload:{
      query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query:selection},
    }})));
    const first=await f.open(),second=await f.open('owner',{},f.loom.url);
    const initial=await subscribe(first);await subscribe(second);
    expect(JSON.stringify(initial)).toContain('"fresh":"aging"');
    expect(JSON.stringify(initial)).toContain('"recent":true');
    const observed:Message[]=[];first.on('message',raw=>observed.push(JSON.parse(String(raw))));
    f.clock.advance(999);await Promise.resolve();expect(observed).toEqual([]);
    const pending=message(second,()=>f.clock.advance(1));
    const changed=await pending;
    expect(changed).toMatchObject({payload:{data:{observe:{revision:2,patches:expect.arrayContaining([
      {path:['memoryKnowledgePage','fresh'],removed:false,value:'due'},
      expect.objectContaining({path:expect.arrayContaining(['recent']),value:null}),
      expect.objectContaining({path:expect.arrayContaining(['fresh']),value:'aging'}),
    ])}}}});
    await vi.waitFor(()=>expect(observed).toHaveLength(1));
    expect(observed[0]).toEqual(changed);
    const response=await fetch(f.loom.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credentials.owner,'content-type':'application/json'},body:JSON.stringify({query:selection})});
    expect(await response.json()).toMatchObject({data:{memoryKnowledge:{pages:expect.arrayContaining([
      {slug:'recent',fresh:'fresh',recent:null},{slug:'aging',fresh:'aging',recent:null},{slug:'due',fresh:'due',recent:null},
    ])},memoryKnowledgePage:{fresh:'due'}}});
    // Shutdown owns the timer too, rather than leaving a read of a closed store.
    const at=vi.spyOn(f.clock,'at');await f.loom.close();at.mockClear();
    f.clock.advance(day);expect(at).not.toHaveBeenCalled();at.mockRestore();
  } finally {writer.close();await f.close();}
},20000);

it('refreshes Activity expiry and household midnight on the shared GraphQL clock',async()=>{
  const midnight=Date.parse('2026-11-15T00:00:00Z');
  const f=await setup(midnight-2000);
  const writer=new Database(join(f.home,'agents/fiction/memories.db'));
  writer.exec('CREATE TABLE memories(ref TEXT,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');
  try {
    const put=writer.prepare("INSERT INTO memories VALUES(?,?,?, ?,NULL,'{\"where\":\"terminal\"}',?,'episode',0)");
    put.run('expiry','Expires soon','Fictional expiry',new Date(f.clock.now()).toISOString(),new Date(midnight-1000).toISOString());
    put.run('rolling','Leaves recent','Fictional earlier day','2026-11-12T18:00:00Z',null);
    const scheduled=vi.spyOn(f.clock,'at');f.loom.changed();
    await vi.waitFor(()=>expect(scheduled).toHaveBeenCalledWith(midnight-1000,expect.any(Function)));scheduled.mockRestore();
    const selection='{ memoryActivity { days entries { id title } } memoryActivityEntry(id:"e~fiction~expiry") { title } }';
    const subscribe=(ws:WebSocket)=>message(ws,()=>ws.send(JSON.stringify({id:'activity-time',type:'subscribe',payload:{
      query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query:selection},
    }})));
    const a=await f.open(),b=await f.open('owner',{},f.loom.url);
    const initial=await subscribe(a);await subscribe(b);
    expect(JSON.stringify(initial)).toContain('Expires soon');expect(JSON.stringify(initial)).toContain('Leaves recent');
    const frames:Message[]=[];a.on('message',raw=>frames.push(JSON.parse(String(raw))));
    f.clock.advance(999);await Promise.resolve();expect(frames).toEqual([]);
    const expired=await message(b,()=>f.clock.advance(1));
    expect(expired).toMatchObject({payload:{data:{observe:{patches:expect.arrayContaining([{path:['memoryActivityEntry'],removed:false,value:null}])}}}});
    await vi.waitFor(()=>expect(frames).toHaveLength(1));expect(frames[0]).toEqual(expired);
    const rolled=await message(b,()=>f.clock.advance(1000));
    expect(rolled).toMatchObject({payload:{data:{observe:{patches:expect.arrayContaining([{path:['memoryActivity','days',0],removed:false,value:'2026-11-15'}])}}}});
    await vi.waitFor(()=>expect(frames).toHaveLength(2));expect(frames[1]).toEqual(rolled);
    const response=await fetch(f.loom.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credentials.owner,'content-type':'application/json'},body:JSON.stringify({query:selection})});
    const current=await response.json();expect(current.errors).toBeUndefined();expect(current.data.memoryActivityEntry).toBeNull();
    expect(current.data.memoryActivity.days).toEqual(['2026-11-15','2026-11-14','2026-11-13']);
    expect(JSON.stringify(current)).not.toContain('Leaves recent');expect(JSON.stringify(current)).not.toContain('Expires soon');
  } finally {writer.close();await f.close();}
},20000);

it('refreshes People contact staleness and evidence expiry on the shared GraphQL clock',async()=>{
 const f=await setup(),path=join(f.home,'agents/fiction/memories.db'),writer=new Database(path);
 writer.exec('CREATE TABLE memories(ref TEXT,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');
 try{
  const now=f.clock.now(),people=new PeopleStore({dbPath:path,actor:'fiction'});
  people.write({slug:'friend',where:{email:{value:'fiction@example.invalid',verified_at:new Date(now-14*86400000+1000).toISOString()}}});people.close();
  writer.prepare("INSERT INTO memories VALUES('evidence','Fictional evidence','Private fictional words',?,NULL,'{\"person\":\"friend\"}',?,'user',0)").run(new Date(now).toISOString(),new Date(now+2000).toISOString());
  const scheduled=vi.spyOn(f.clock,'at');f.loom.changed();
  await vi.waitFor(()=>expect(scheduled).toHaveBeenCalledWith(now+1001,expect.any(Function)));scheduled.mockRestore();
  const selection='{ memoryPerson(id:"fiction:friend") { fields { key state } evidence { title content } newer } }';
  const subscribe=(ws:WebSocket)=>message(ws,()=>ws.send(JSON.stringify({id:'person-time',type:'subscribe',payload:{query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query:selection}}})));
  const a=await f.open(),b=await f.open('owner',{},f.loom.url);
  const initial=await subscribe(a);await subscribe(b);expect(JSON.stringify(initial)).toContain('"state":"fresh"');expect(JSON.stringify(initial)).toContain('Private fictional words');
  const frames:Message[]=[];a.on('message',raw=>frames.push(JSON.parse(String(raw))));
  f.clock.advance(1000);await Promise.resolve();expect(frames).toEqual([]);
  const stale=await message(b,()=>f.clock.advance(1));
  expect(stale).toMatchObject({payload:{data:{observe:{patches:[{path:['memoryPerson','fields',0,'state'],removed:false,value:'stale'}]}}}});
  await vi.waitFor(()=>expect(frames).toHaveLength(1));expect(frames[0]).toEqual(stale);
  const expired=await message(b,()=>f.clock.advance(999));
  expect(expired).toMatchObject({payload:{data:{observe:{patches:expect.arrayContaining([{path:['memoryPerson','evidence',0],removed:true,value:null},{path:['memoryPerson','newer'],removed:false,value:0}])}}}});
  await vi.waitFor(()=>expect(frames).toHaveLength(2));expect(frames[1]).toEqual(expired);
  const response=await fetch(f.loom.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credentials.owner,'content-type':'application/json'},body:JSON.stringify({query:selection})});
  expect(await response.json()).toMatchObject({data:{memoryPerson:{fields:[{key:'email',state:'stale'}],evidence:[],newer:0}}});
 }finally{writer.close();await f.close();}
},20000);

it('arms Projects deadlines from the initial query and refreshes age, expiry and spark without writes',async()=>{
 const f=await setup(),path=join(f.home,'agents/fiction/memories.db'),writer=new Database(path);
 writer.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,ref TEXT,category TEXT,title TEXT,content TEXT,created TEXT,updated TEXT,project TEXT,archived INTEGER,expires_at TEXT)');
 try{
  const now=f.clock.now(),day=86400000,projects=new ProjectsStore({dbPath:path});
  projects.write({slug:'pond',where:{hose:{value:'25mm',verified_at:new Date(now-14*day+1000).toISOString()}}});projects.close();
  const put=writer.prepare("INSERT INTO memories(ref,category,title,content,created,updated,project,archived,expires_at) VALUES(?,'project',?,'Fictional content',?,NULL,'pond',0,?)");
  put.run('expiry','Expires soon',new Date(now).toISOString(),new Date(now+2000).toISOString());
  put.run('rolling','Rolling memory',new Date(now-day+3000).toISOString(),null);
  const selection='{ memoryProject(id:"fiction:pond") { fields { state } spark sections { key total } } memoryProjectMemory(id:"fiction:expiry") { title } }';
  const subscribe=(ws:WebSocket)=>message(ws,()=>ws.send(JSON.stringify({id:'project-time',type:'subscribe',payload:{query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query:selection}}})));
  const a=await f.open(),b=await f.open('owner',{},f.loom.url),scheduled=vi.spyOn(f.clock,'at');
  const initial=await subscribe(a);await subscribe(b);expect(JSON.stringify(initial)).toContain('checked 13 days ago');expect(JSON.stringify(initial)).toContain('Expires soon');
  await vi.waitFor(()=>expect(scheduled).toHaveBeenCalledWith(now+1000,expect.any(Function)));scheduled.mockRestore();
  const frames:Message[]=[];a.on('message',raw=>frames.push(JSON.parse(String(raw))));
  f.clock.advance(999);await Promise.resolve();expect(frames).toEqual([]);
  const step=async(ms:number,n:number)=>{const frame=await message(b,()=>f.clock.advance(ms));await vi.waitFor(()=>expect(frames).toHaveLength(n));expect(frames[n-1]).toEqual(frame);return frame;};
  expect(JSON.stringify(await step(1,1))).toContain('checked 14 days ago');
  expect(JSON.stringify(await step(1,2))).toContain('stale for 14 days');
  expect(await step(999,3)).toMatchObject({payload:{data:{observe:{patches:expect.arrayContaining([{path:['memoryProjectMemory'],removed:false,value:null}])}}}});
  const rolled=await step(1000,4);expect(JSON.stringify(rolled)).toContain('spark');
  const response=await fetch(f.loom.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credentials.owner,'content-type':'application/json'},body:JSON.stringify({query:selection})});
  expect(await response.json()).toMatchObject({data:{memoryProject:{fields:[{state:'stale for 14 days'}],spark:[0,0,0,0,0,1,0],sections:expect.arrayContaining([{key:'memories',total:1}])},memoryProjectMemory:null}});
  const at=vi.spyOn(f.clock,'at');await f.loom.close();at.mockClear();f.clock.advance(day);await Promise.resolve();expect(at).not.toHaveBeenCalled();at.mockRestore();
 }finally{writer.close();await f.close();}
},20000);

it('refreshes Activity when future shared conversations enter the inclusive detail and exclusive list windows',async()=>{
 const f=await setup();
 try{
  const now=f.clock.now(),thread=f.db.select().from(conversations).get()!;
  f.loom.operations.register({name:'fiction.futureConversation',write:true,input:z.object({}),output:z.null(),may:()=>true,run(ctx){ctx.db.prepare('UPDATE conversations SET last_at=? WHERE id=?').run(new Date(now+61000).toISOString(),thread.id);ctx.changed('conversation',thread.id);return null;}});
  expect(f.loom.operations.call('direct',{kind:'member',id:'owner'},'fiction.futureConversation',{},'future-conversation')).toEqual({ok:true,value:null});
  const selection=`{ memoryActivity { entries { title } } memoryActivityEntry(id:"c~fiction~${thread.id}") { title } }`;
  const ws=await f.open(),subscribe=()=>ws.send(JSON.stringify({id:'future-time',type:'subscribe',payload:{query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query:selection}}}));
  expect(await message(ws,subscribe)).toMatchObject({payload:{data:{observe:{patches:[{value:{memoryActivity:{entries:[]},memoryActivityEntry:null}}]}}}});
  const frames:Message[]=[];ws.on('message',raw=>frames.push(JSON.parse(String(raw))));f.clock.advance(999);await Promise.resolve();expect(frames).toEqual([]);
  expect(await message(ws,()=>f.clock.advance(1))).toMatchObject({payload:{data:{observe:{patches:[{path:['memoryActivityEntry'],removed:false,value:{title:'Fictional conversation'}}]}}}});
  expect(await message(ws,()=>f.clock.advance(1))).toMatchObject({payload:{data:{observe:{patches:[{path:['memoryActivity','entries',0],removed:false,value:{title:'Fictional conversation'}}]}}}});
 }finally{await f.close();}
},20000);

it('projects existing Memory capabilities on GraphQL and updates them after a committed demotion',async()=>{
 const f=await setup();
 const selection='{ memoryKnowledgeAccess { allowed canAdd canVerify canRecheck } memoryPeopleAccess { allowed directory canAdd agents } memoryProjectsAccess { allowed agents } memoryActivityAccess { allowed agents owner timezone today windows expires } }';
 const http=async(who:'owner'|'peer')=>{const response=await fetch(f.loom.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credentials[who],'content-type':'application/json'},body:JSON.stringify({query:selection})});expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 try{
  const expected=await http('owner');expect(expected).toMatchObject({memoryKnowledgeAccess:{allowed:true,canAdd:true},memoryPeopleAccess:{allowed:true,directory:true,agents:['fiction']},memoryProjectsAccess:{allowed:true,agents:['fiction']},memoryActivityAccess:{allowed:true,agents:['fiction'],today:'2026-11-14'}});
  const peer=await http('peer');for(const value of Object.values(peer) as Array<{allowed:boolean}>)expect(value.allowed).toBe(false);
  const ws=await f.open();expect(await message(ws,()=>ws.send(JSON.stringify({id:'capabilities',type:'subscribe',payload:{query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query:selection}}})))).toMatchObject({payload:{data:{observe:{patches:[{value:expected}]}}}});
  f.loom.operations.register({name:'fiction.demoteCapabilities',write:true,input:z.object({}),output:z.null(),may:()=>true,run(ctx){ctx.db.prepare("UPDATE members SET role='member' WHERE id='owner'").run();ctx.changed('core.access','owner');return null;}});
  const changed=await message(ws,()=>expect(f.loom.operations.call('direct',{kind:'member',id:'owner'},'fiction.demoteCapabilities',{},'demote-capabilities')).toEqual({ok:true,value:null}));
  expect(changed).toMatchObject({payload:{data:{observe:{patches:expect.arrayContaining(['memoryKnowledgeAccess','memoryPeopleAccess','memoryProjectsAccess','memoryActivityAccess'].map(field=>({path:[field,'allowed'],removed:false,value:false})))}}}});
  const after=await http('owner');for(const value of Object.values(after) as Array<{allowed:boolean}>)expect(value.allowed).toBe(false);
 }finally{await f.close();}
},20000);
