/** Whole shared listener on fictional declared files and current shared facts. */
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {WebSocket} from 'ws';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,tokens,agents,household,memberAgents} from './core/data/schema.js';
import {hasTouchedListener,touchSocketPath} from './core/touched/index.js';
import {serveShared} from './shared-serve.js';
import {prepareSharedMemorySources} from './shared-memory.js';
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
 const app=await serveShared({db:f.db,clock:f.clock,memory:{sources:f.sources},originAllowed:req=>{try{return new URL(String(req.headers.origin)).host===req.headers.host;}catch{return false;}},reportError:e=>errors.push(e)});cleanup.push(()=>app.close());
 expect(hasTouchedListener(f.sources.commons.directory)).toBe(true);expect(hasTouchedListener(f.sources.agents[0].directory)).toBe(true);
 const request=(path:string,body?:unknown,headers:Record<string,string>={authorization:'Bearer '+raw})=>fetch(app.url+path,{method:'POST',redirect:'manual',headers:{'content-type':'application/json',origin:app.url,...headers},...(body?{body:JSON.stringify(body)}:{})});
 const minted=await request('/api/signin/link',{input:{}});expect(minted.status).toBe(200);
 const login=await request((await minted.json()).value.path);expect(login.status).toBe(303);
 const cookie=login.headers.get('set-cookie')!.split(';',1)[0],headers={cookie};
 const query='{ memoryKnowledge { pages { slug title fresh } } memoryPerson(id:"fiction:friend") { name } memoryProject(id:"fiction:pond") { name } memoryActivity { entries { title } } }';
 const read=async()=>{const response=await request('/graphql',{query},headers);expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 expect(await read()).toMatchObject({memoryKnowledge:{pages:[]},memoryPerson:null,memoryProject:null,memoryActivity:{entries:[]}});
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{cookie,origin:app.url}});cleanup.push(()=>ws.terminate());await once(ws,'open');
 expect((await waitMessage(ws,()=>ws.send(JSON.stringify({type:'connection_init'})))).type).toBe('connection_ack');
 const first=await waitMessage(ws,()=>ws.send(JSON.stringify({type:'subscribe',id:'memory',payload:{query:'subscription($query:String!){ observe(query:$query){ revision patches { path removed value } } }',variables:{query}}})));
 expect(first.payload.data.observe.patches[0].value).toEqual(await read());
 const added=await waitMessage(ws,async()=>{const result=await request('/api/mind/knowledgeAdd',{id:'add',input:{title:'Fictional pump',domain:'fiction',body:'Fictional pump words',source:''}},headers);expect(result.status).toBe(200);});
 expect(JSON.stringify(added)).toContain('Fictional pump');
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
 const f=fixture();await prepareSharedMemorySources({sources:f.sources});
 mkdirSync(join(f.sources.agents[0].directory,'.loom-live'),{recursive:true});
 const occupied=createServer();await new Promise<void>(ok=>occupied.listen(touchSocketPath(f.sources.agents[0].directory),ok));
 cleanup.push(()=>new Promise<void>(ok=>occupied.close(()=>ok())));
 const scheduled=vi.spyOn(f.clock,'at');
 await expect(serveShared({db:f.db,clock:f.clock,memory:{sources:f.sources},originAllowed:()=>true,reportError:()=>{}})).rejects.toThrow();
 expect(hasTouchedListener(f.sources.commons.directory)).toBe(false);expect(occupied.listening).toBe(true);
 const calls=scheduled.mock.calls.length;f.clock.advance(86400000);expect(scheduled).toHaveBeenCalledTimes(calls);expect(f.tables()).toEqual(f.before);
});
