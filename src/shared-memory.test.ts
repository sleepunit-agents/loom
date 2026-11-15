/** Whole shared listener on fictional declared files and current shared facts. */
import {afterEach,expect,it,vi} from 'vitest';
import {memoryCall} from '../web/src/memory/commands.js';
import {GraphQLString} from 'graphql/index.js';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {WebSocket} from 'ws';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,tokens,agents,household,memberAgents,inbox,triggers,projects as projectRows,changes,taskLinks} from './core/data/schema.js';
import {hasTouchedListener,touchSocketPath} from './core/touched/index.js';
import {serveShared} from './shared-serve.js';
import {prepareSharedMemorySources} from './shared-memory.js';
import {SqliteKnowledgeBackend} from './backends/sqlite-knowledge.js';
import {PeopleStore} from './backends/people.js';
import {ProjectsStore} from './backends/projects.js';
const cleanup:Array<()=>unknown>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();});
const raw='a'.repeat(64),fingerprint=createHash('sha256').update(raw).digest('hex');
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'shared-memory-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const client=new Database(':memory:');cleanup.push(()=>client.close());const clock=new FakeClock(Date.parse('2026-11-14T12:00:00Z')),db=createDataSchema(client),at=new Date(clock.now()).toISOString();
 db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();
 db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(household).values({singleton:1,defaultAgent:'fiction',timezone:'America/Chicago'}).run();
 db.insert(tokens).values({fingerprint,label:'Fictional bearer',kind:'owner',member:'owner',createdAt:at}).run();
 const commons=join(home,'commons'),agent=join(home,'agents/fiction'),sources={commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:[{agent:'fiction',directory:agent,memories:join(agent,'memories.db')}]};
 const tables=()=>client.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),before=tables();
 return {home,client,db,clock,sources,tables,before};
}
async function waitMessage(ws:WebSocket,action:()=>unknown){
 const message=once(ws,'message');await action();return JSON.parse(String((await message)[0]));
}
it('signs in on the actual shared listener and converges Memory writes, source touches, grants and revocation',async()=>{
 const f=fixture(),scheduled=vi.spyOn(f.clock,'at'),errors:unknown[]=[];
 expect(existsSync(f.sources.commons.knowledge)).toBe(false);
 const webRoot=join(f.home,'web');mkdirSync(join(webRoot,'assets'),{recursive:true});writeFileSync(join(webRoot,'next.html'),'<html>Fictional Memory app</html>');writeFileSync(join(webRoot,'assets/app.js'),'/* fictional app */');
 const app=await serveShared({db:f.db,clock:f.clock,webRoot,memory:{sources:f.sources,checkingAgent:'fiction'},originAllowed:req=>{try{return new URL(String(req.headers.origin)).host===req.headers.host;}catch{return false;}},reportError:e=>errors.push(e)});cleanup.push(()=>app.close());
 const navigation=await fetch(app.url+'/p/knowledge-preview');expect(navigation.status).toBe(200);expect(await navigation.text()).toBe('<html>Fictional Memory app</html>');
 expect(await (await fetch(app.url+'/app/assets/app.js')).text()).toBe('/* fictional app */');
 const absent=await fetch(app.url+'/api/missing');expect(absent.status).toBe(404);expect(await absent.text()).not.toContain('Fictional Memory app');
 expect(hasTouchedListener(f.sources.commons.directory)).toBe(true);expect(hasTouchedListener(f.sources.agents[0].directory)).toBe(true);
 const request=(path:string,body?:unknown,headers:Record<string,string>={authorization:'Bearer '+raw})=>fetch(app.url+path,{method:'POST',redirect:'manual',headers:{'content-type':'application/json',origin:app.url,...headers},...(body?{body:JSON.stringify(body)}:{})});
 const minted=await request('/api/signin/link',{input:{}});expect(minted.status).toBe(200);
 const login=await request((await minted.json()).value.path,undefined,{authorization:'Bearer '+raw,'user-agent':'Mozilla/5.0 HeadlessChrome/140.0'});expect(login.status).toBe(303);
 const cookie=login.headers.get('set-cookie')!.split(';',1)[0],headers={cookie};
 expect(await (await fetch(app.url+'/auth/session',{headers})).json()).toMatchObject({viewer:{kind:'member',id:'owner'}});
 const query='{ memoryKnowledge { pages { slug title fresh } } memoryPerson(id:"fiction:friend") { name } memoryProject(id:"fiction:pond") { name } memoryActivity { entries { title } } }';
 const read=async()=>{const response=await request('/graphql',{query},headers);expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 expect(await read()).toMatchObject({memoryKnowledge:{pages:[]},memoryPerson:null,memoryProject:null,memoryActivity:{entries:[]}});
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{cookie,origin:app.url,'user-agent':'Mozilla/5.0 HeadlessChrome/140.0'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
 expect((await waitMessage(ws,()=>ws.send(JSON.stringify({type:'connection_init'})))).type).toBe('connection_ack');
 const first=await waitMessage(ws,()=>ws.send(JSON.stringify({type:'subscribe',id:'memory',payload:{query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query}}})));
 expect(first.payload.data.observe.patches[0].value).toEqual(await read());
 const added=await waitMessage(ws,async()=>{const command=memoryCall('mind.knowledgeAdd',{title:'Fictional pump',domain:'fiction',body:'Fictional pump words',source:''},(path,init)=>fetch(app.url+path,{...init,headers:{...init.headers,cookie,origin:app.url}}));expect((await command.result).ok).toBe(true);});
 expect(JSON.stringify(added)).toContain('Fictional pump');
 const retiredRead=await request('/api/mind/knowledgeRead',{input:{slug:'fictional-pump'}},headers);expect(retiredRead.status).toBe(404);
 expect((await fetch(app.url+'/live',{headers})).status).toBe(404);
 const people=new PeopleStore({dbPath:f.sources.agents[0].memories});cleanup.push(()=>people.close());
 const person=await waitMessage(ws,()=>people.write({slug:'friend',name:'Private fictional friend'}));expect(JSON.stringify(person)).toContain('Private fictional friend');
 const projects=new ProjectsStore({dbPath:f.sources.agents[0].memories});cleanup.push(()=>projects.close());
 const project=await waitMessage(ws,()=>projects.write({slug:'pond',name:'Private fictional pond'}));expect(JSON.stringify(project)).toContain('Private fictional pond');
 const activity=await waitMessage(ws,()=>app.writes.run(()=>app.services.conversations.open({agent:'fiction',venue:'wake',place:'fiction',label:'Private fictional session'})));expect(JSON.stringify(activity)).toContain('Private fictional session');
 expect(await read()).toMatchObject({memoryKnowledge:{pages:[{title:'Fictional pump'}]},memoryPerson:{name:'Private fictional friend'},memoryProject:{name:'Private fictional pond'},memoryActivity:{entries:[{title:'Private fictional session'}]}});
 const demoted=await waitMessage(ws,()=>app.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run()));expect(JSON.stringify(demoted)).not.toContain('Private fictional');
 expect(await read()).toEqual({memoryKnowledge:null,memoryPerson:null,memoryProject:null,memoryActivity:null});
 await waitMessage(ws,()=>app.writes.run(()=>f.db.insert(memberAgents).values({member:'owner',agent:'fiction'}).run()));
 expect(await read()).toMatchObject({memoryKnowledge:null,memoryPerson:{name:'Private fictional friend'},memoryProject:{name:'Private fictional pond'},memoryActivity:{entries:[{title:'Private fictional session'}]}});
 const revoked=once(ws,'close');app.writes.run(()=>f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).run());await revoked;
 expect((await request('/graphql',{query},headers)).status).toBe(401);
 expect(f.tables()).toEqual(f.before);await app.close();expect(app.memory.nextDeadline()).toBeUndefined();expect(hasTouchedListener(f.sources.commons.directory)).toBe(false);expect(hasTouchedListener(f.sources.agents[0].directory)).toBe(false);
 const calls=scheduled.mock.calls.length;f.clock.advance(86400000);expect(scheduled).toHaveBeenCalledTimes(calls);expect(errors).toEqual([]);
});
it('releases acquired source sockets and Memory clocks when a later source bind fails',async()=>{
 const f=fixture();await prepareSharedMemorySources({sources:f.sources,checkingAgent:'fiction'});
 mkdirSync(join(f.sources.agents[0].directory,'.loom-live'),{recursive:true});
 const occupied=createServer();await new Promise<void>(ok=>occupied.listen(touchSocketPath(f.sources.agents[0].directory),ok));
 cleanup.push(()=>new Promise<void>(ok=>occupied.close(()=>ok())));
 const scheduled=vi.spyOn(f.clock,'at');
 await expect(serveShared({db:f.db,clock:f.clock,memory:{sources:f.sources,checkingAgent:'fiction'},originAllowed:()=>true,reportError:()=>{}})).rejects.toThrow();
 expect(hasTouchedListener(f.sources.commons.directory)).toBe(false);expect(occupied.listening).toBe(true);
 const calls=scheduled.mock.calls.length;f.clock.advance(86400000);expect(scheduled).toHaveBeenCalledTimes(calls);expect(f.tables()).toEqual(f.before);
});
it('leaves existing declared content files byte-for-byte unchanged during preparation',async()=>{
 const f=fixture(),memory={sources:f.sources,checkingAgent:'fiction'};await prepareSharedMemorySources(memory);
 const knowledge=new SqliteKnowledgeBackend({dbPath:f.sources.commons.knowledge});await knowledge.writePage({slug:'kept',title:'Kept fact',domain:'fiction',body:'Precious fictional words'});knowledge.close();
 const paths=[f.sources.commons.knowledge,f.sources.commons.people,f.sources.agents[0].memories],before=paths.map(path=>readFileSync(path));
 await prepareSharedMemorySources(memory);expect(paths.map(path=>readFileSync(path))).toEqual(before);
});
it('uses the current household timezone for Activity days and metadata after a committed settings change',async()=>{
 const f=fixture(),app=await serveShared({db:f.db,clock:f.clock,memory:{sources:f.sources,checkingAgent:'fiction'},originAllowed:()=>true,reportError:()=>{}});cleanup.push(()=>app.close());
 app.writes.run(()=>app.services.conversations.open({agent:'fiction',venue:'wake',place:'fiction',label:'Fictional session'}));
 const read=async()=>{const response=await app.http.request(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query:'{ memoryActivityAccess { timezone today } memoryActivity { entries { day hour } } }'})});const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 expect(await read()).toMatchObject({memoryActivityAccess:{timezone:'America/Chicago',today:'2026-11-14'},memoryActivity:{entries:[{day:'2026-11-14',hour:6}]}});
 app.writes.run(()=>f.db.update(household).set({timezone:'Pacific/Kiritimati'}).run());
 expect(await read()).toMatchObject({memoryActivityAccess:{timezone:'Pacific/Kiritimati',today:'2026-11-15'},memoryActivity:{entries:[{day:'2026-11-15',hour:2}]}});
});
it('registers Knowledge before the one shared Tempo starts and preserves a stopped daily sweep across restart',async()=>{
 const f=fixture(),memory={sources:f.sources,checkingAgent:'fiction'};await prepareSharedMemorySources(memory);
 const source=new SqliteKnowledgeBackend({dbPath:f.sources.commons.knowledge});await source.writePage({slug:'due-pump',title:'Fictional due pump',domain:'fiction',body:'Due fictional fact',verified_at:'2020-01-01T00:00:00Z'});source.close();
 f.clock.advance(Date.parse('2026-11-14T13:16:59Z')-f.clock.now());
 const options={db:f.db,clock:f.clock,memory,originAllowed:()=>true,reportError:()=>{}};
 const app=await serveShared(options);cleanup.push(()=>app.close());expect(f.db.select().from(inbox).all()).toEqual([]);
 f.clock.advance(1000);expect(f.db.select().from(inbox).all()).toMatchObject([{to:'fiction',source:'notice',words:expect.stringContaining('due-pump')}]);
 const facts=new Database(f.sources.commons.knowledge,{readonly:true});try{expect(facts.prepare('SELECT verified_at FROM pages').get()).toEqual({verified_at:'2020-01-01T00:00:00Z'});}finally{facts.close();}
 app.writes.run(()=>app.services.tempo.triggers.stop('knowledge-sweep:fiction'));await app.close();f.clock.advance(86400000);
 const again=await serveShared(options);cleanup.push(()=>again.close());
 expect(f.db.select().from(triggers).where(eq(triggers.id,'knowledge-sweep:fiction')).get()).toMatchObject({enabled:false,state:'stopped'});
 f.clock.advance(86400000);expect(f.db.select().from(inbox).all()).toHaveLength(1);
});
it('builds project sections from current visible Tasks, Changes and Conversations without legacy roles',async()=>{
 const f=fixture(),at=new Date(f.clock.now()).toISOString();f.db.insert(members).values({id:'other',role:'member',joinedAt:at}).run();
 f.db.insert(agents).values({id:'other-agent',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();f.db.insert(projectRows).values([{id:'pond',name:'Pond'},{id:'hidden',name:'Hidden'}]).run();
 const app=await serveShared({db:f.db,clock:f.clock,memory:{sources:f.sources,checkingAgent:'fiction'},originAllowed:()=>true,reportError:()=>{}});cleanup.push(()=>app.close());
 const cards=new ProjectsStore({dbPath:f.sources.agents[0].memories});cards.write({slug:'pond',name:'Fictional pond',links:{repos:['fiction/repo']}});cards.close();
 app.writes.run(()=>{
  const visible=app.services.tasks.create({title:'Pond visible task',goal:'Fictional goal',why:'Fictional reason',owner:{kind:'agent',id:'fiction'}},{kind:'member',id:'owner'});
  const hidden=app.services.tasks.create({title:'Pond PRIVATE TASK',goal:'Fictional goal',why:'Fictional reason',owner:{kind:'member',id:'other'}},{kind:'member',id:'owner'});
  f.db.insert(taskLinks).values({task:visible.id,dependsOn:hidden.id,type:'blocks'}).run();
  const change={repository:'fiction/repo',number:1,body:'',url:'https://example.invalid/change',state:'open' as const,draft:false,authorLogin:'fiction',branch:'fiction',headCommit:'abc',baseBranch:'next',checks:'failing' as const,review:'required' as const,mergeable:'yes' as const,waitingOn:'ci' as const,openedAt:at,updatedAt:at};
  f.db.insert(changes).values([{...change,id:'visible-change',title:'Visible change',agent:'fiction',project:'pond'},{...change,id:'hidden-change',number:2,title:'PRIVATE CHANGE',agent:'other-agent',project:'hidden'}]).run();
  app.services.conversations.open({agent:'fiction',venue:'wake',place:'public',project:'pond',label:'Visible conversation'});
  app.services.conversations.open({agent:'fiction',venue:'wake',place:'private',project:'pond',member:'other',label:'PRIVATE CONVERSATION'});
 });
 const read=async()=>{const response=await app.http.request(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query:'{ memoryProject(id:"fiction:pond") { changes { open failing running } sections { key available total conversationIds groups { title items { title } } items { title } } } }'})});const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 const owner=await read();expect(JSON.stringify(owner)).toContain('PRIVATE TASK');expect(JSON.stringify(owner)).toContain('PRIVATE CHANGE');expect(JSON.stringify(owner)).toContain('PRIVATE CONVERSATION');
 app.writes.run(()=>{f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();f.db.insert(memberAgents).values({member:'owner',agent:'fiction'}).run();});
 const member=await read(),words=JSON.stringify(member);expect(words).toContain('Pond visible task');expect(words).toContain('Visible change');expect(words).toContain('Visible conversation');expect(words).not.toContain('PRIVATE');
 expect(member.memoryProject.changes).toEqual({open:1,failing:1,running:0});
 const tasks=member.memoryProject.sections.find((section:{key:string})=>section.key==='tasks');expect(tasks.groups.map((group:{title:string})=>group.title)).toEqual(['Blocked or in progress']);
 app.writes.run(()=>{for(let i=0;i<201;i++)app.services.conversations.open({agent:'fiction',venue:'wake',place:'many-'+i,project:'pond',label:'Visible linked conversation '+i});});
 const complete=await read(),conversations=complete.memoryProject.sections.find((section:{key:string})=>section.key==='conversations');
 expect(conversations.total).toBe(202);expect(conversations.conversationIds).toHaveLength(202);expect(conversations.items).toHaveLength(50);
});

it('rejects an unconfigured checking recipient before creating source files',async()=>{
 const f=fixture();
 await expect(serveShared({db:f.db,clock:f.clock,memory:{sources:f.sources,checkingAgent:'absent'},originAllowed:()=>true,reportError:()=>{}})).rejects.toThrow('configured checking agent');
 expect(existsSync(f.sources.commons.knowledge)).toBe(false);expect(existsSync(f.sources.agents[0].memories)).toBe(false);expect(f.tables()).toEqual(f.before);
});
it('refreshes Knowledge and Activity together at the shared root deadline without a write',async()=>{
 const f=fixture(),memory={sources:f.sources,checkingAgent:'fiction'},now=f.clock.now();await prepareSharedMemorySources(memory);
 const knowledge=new SqliteKnowledgeBackend({dbPath:f.sources.commons.knowledge});
 try{for(const slug of ['recent','aging','due'])await knowledge.writePage({slug,title:slug,domain:'fiction',body:'Fictional fact'});}finally{knowledge.close();}
 const facts=new Database(f.sources.commons.knowledge);
 try{for(const [slug,days] of [['recent',7],['aging',20],['due',30]] as const)facts.prepare('UPDATE pages SET verified_at=? WHERE slug=?').run(new Date(now-days*86400000+1000).toISOString(),slug);}finally{facts.close();}
 const episodes=new Database(f.sources.agents[0].memories);
 try{episodes.exec('CREATE TABLE memories(ref TEXT,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');episodes.prepare("INSERT INTO memories VALUES('expiry','Expires soon','Fictional episode',?,NULL,'{}',?,'episode',0)").run(new Date(now).toISOString(),new Date(now+1000).toISOString());}finally{episodes.close();}
 const app=await serveShared({db:f.db,clock:f.clock,memory,originAllowed:()=>true,reportError:()=>{}});cleanup.push(()=>app.close());
 const query='{ memoryKnowledge { pages { slug fresh recent } } memoryKnowledgePage(slug:"due") { fresh } memoryActivity { entries { id title } } memoryActivityEntry(id:"e~fiction~expiry") { title } }';
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw,origin:app.url}});cleanup.push(()=>ws.terminate());await once(ws,'open');
 await waitMessage(ws,()=>ws.send(JSON.stringify({type:'connection_init'})));
 const initial=await waitMessage(ws,()=>ws.send(JSON.stringify({type:'subscribe',id:'clock',payload:{query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query}}})));
 expect(JSON.stringify(initial)).toContain('Expires soon');expect(JSON.stringify(initial)).toContain('"recent":true');
 f.clock.advance(999);
 const changed=await waitMessage(ws,()=>f.clock.advance(1));
 expect(changed).toMatchObject({payload:{data:{observe:{revision:2,patches:expect.arrayContaining([
  {path:['memoryKnowledgePage','fresh'],removed:false,value:'due'},
  expect.objectContaining({path:expect.arrayContaining(['recent']),value:null}),
  expect.objectContaining({path:expect.arrayContaining(['fresh']),value:'aging'}),
  {path:['memoryActivityEntry'],removed:false,value:null},
 ])}}}});
 const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query})});
 expect(await response.json()).toMatchObject({data:{memoryKnowledge:{pages:expect.arrayContaining([{slug:'recent',fresh:'fresh',recent:null},{slug:'aging',fresh:'aging',recent:null},{slug:'due',fresh:'due',recent:null}])},memoryKnowledgePage:{fresh:'due'},memoryActivity:{entries:[]},memoryActivityEntry:null}});
});
it('withdraws a selected private Memory card when sharing changes during a sibling await',async()=>{
 const f=fixture(),memory={sources:f.sources,checkingAgent:'fiction'};await prepareSharedMemorySources(memory);
 const people=new PeopleStore({dbPath:f.sources.agents[0].memories});try{people.write({slug:'friend',name:'PRIVATE selected Memory card'});}finally{people.close();}
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 const app=await serveShared({db:f.db,clock:f.clock,memory,originAllowed:()=>true,reportError:()=>{},fields:{held:{type:GraphQLString,async resolve(){began();await held;return 'public sibling';}}}});cleanup.push(()=>app.close());
 try{
  const pending=fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query:'{ memoryPerson(id:"fiction:friend") { name } held }'})});
  await started;app.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());release();
  const response=await pending,body=await response.text();
  expect(body).not.toContain('PRIVATE selected Memory card');expect(response.status).toBe(503);
 }finally{release();}
});
it('withdraws a selected private episode when its deadline passes during a sibling await without a SQL write',async()=>{
 const f=fixture(),memory={sources:f.sources,checkingAgent:'fiction'};await prepareSharedMemorySources(memory);
 const source=new Database(f.sources.agents[0].memories);
 try{source.exec('CREATE TABLE memories(ref TEXT,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');source.prepare("INSERT INTO memories VALUES('expiry','PRIVATE expiring episode','Fictional private words',?,NULL,'{}',?,'episode',0)").run(new Date(f.clock.now()).toISOString(),new Date(f.clock.now()+1000).toISOString());}finally{source.close();}
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 const app=await serveShared({db:f.db,clock:f.clock,memory,originAllowed:()=>true,reportError:()=>{},fields:{held:{type:GraphQLString,async resolve(){began();await held;return 'public sibling';}}}});cleanup.push(()=>app.close());
 const committed=vi.fn(),stop=app.writes.observe(committed);cleanup.push(stop);
 try{
  const pending=fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query:'{ memoryActivityEntry(id:"e~fiction~expiry") { title } held }'})});
  await started;f.clock.advance(1000);expect(committed).not.toHaveBeenCalled();release();
  const response=await pending,body=await response.text();
  expect(body).not.toContain('PRIVATE expiring episode');expect(response.status).toBe(503);
 }finally{release();}
});
