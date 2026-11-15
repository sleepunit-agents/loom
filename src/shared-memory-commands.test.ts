/** Native command authority, source receipts and the actual shared HTTP/socket door. */
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {getRequestListener} from '@hono/node-server';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
const embed=vi.hoisted(()=>({gate:undefined as undefined|(()=>Promise<void>),calls:0}));
vi.mock('./backends/fastembed.js',()=>({FastEmbedProvider:class{
 readonly dimensions=4;
 async embed(text:string){embed.calls++;await embed.gate?.();const v=['alpha','beta','gamma','delta'].map(word=>text.toLowerCase().includes(word)?1:0);if(!v.some(Boolean))v[3]=1;const size=Math.hypot(...v);return v.map(n=>n/size);}
 async embedBatch(texts:string[]){return Promise.all(texts.map(text=>this.embed(text)));}
}}));
import {bodyFixture,bodyCredentials as raw,credentialHash} from '../test/fixtures/conversation-body.js';
import {prepareSharedMemorySources} from './shared-memory.js';
import {ProjectsStore} from './backends/projects.js';
import * as s from './core/data/schema.js';
const clean:Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{embed.gate=undefined;for(const close of clean.splice(0).reverse())await close();vi.useRealTimers();vi.restoreAllMocks();});
const words='alpha NATIVE_PRIVATE_MEMORY_WORDS',title='PRIVATE_MEMORY_TITLE';
const input={category:'project',title,content:words,project:'pond'};
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'native-memory-fiction-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));
 const common=join(home,'commons'),directory=join(home,'agents/art'),other=join(home,'agents/mark');
 const memory={checkingAgent:'art',sources:{commons:{directory:common,knowledge:join(common,'knowledge.db'),people:join(common,'people.db')},agents:[{agent:'art',directory,memories:join(directory,'memories.db')},{agent:'mark',directory:other,memories:join(other,'memories.db')}]}};
 await prepareSharedMemorySources(memory);const project=new ProjectsStore({dbPath:memory.sources.agents[0].memories});project.write({slug:'pond',name:'Fictional pond'});project.close();
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse('2026-11-14T18:00:00Z'));
 const f=await bodyFixture(clean,{memory});await f.root.ready;
 const server=createServer(getRequestListener(request=>f.root.http.fetch(request))),detach=f.root.attach(server);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
 clean.push(async()=>{detach();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const path=memory.sources.agents[0].memories,source=new Database(path,{fileMustExist:true});clean.push(()=>source.close());
 const call=async(verb:string,value:unknown,id:string,token=raw.body)=>{const response=await fetch(url+'/api/memory/'+verb,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:value,id})});return {status:response.status,result:await response.json()};};
 const query=async(query:string,token=raw.body)=>{const response=await fetch(url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query})});const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 const count=()=>source.prepare("SELECT 1 FROM sqlite_schema WHERE name='memories'").get()? (source.prepare('SELECT count(*) AS n FROM memories').get() as {n:number}).n:0;
 return {...f,home,path,source,url,call,query,count,other:memory.sources.agents[1].memories};
}
async function next(ws:WebSocket,action:()=>unknown){const pending=once(ws,'message');await action();return JSON.parse(String((await pending)[0]));}
function hold(){let entered!:()=>void,release!:()=>void;const began=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve);embed.gate=async()=>{entered();await blocked;};return {began,release};}
it('binds commands to the actual body, publishes committed content, and reads opaque results through current GraphQL authority',async()=>{
 const f=await fixture(),ws=new WebSocket(f.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.body}});clean.push(()=>ws.terminate());await once(ws,'open');
 expect((await next(ws,()=>ws.send(JSON.stringify({type:'connection_init'})))).type).toBe('connection_ack');
 const initial=await next(ws,()=>ws.send(JSON.stringify({type:'subscribe',id:'memory',payload:{query:'subscription($query:String!){observe(query:$query){patches{path value removed}}}',variables:{query:'{memoryProject(id:"art:pond"){sections{key total items{title body}}}}'}}})));
 expect(initial.type).toBe('next');expect(JSON.stringify(initial)).toContain('memories');
 const publication=new Promise<any>(resolve=>{const message=(raw:import('ws').RawData)=>{ws.off('close',closed);resolve(JSON.parse(String(raw)));},closed=(code:number)=>{ws.off('message',message);resolve({closed:code});};ws.once('message',message);ws.once('close',closed);});
 const remembered=await f.call('remember',input,'remember');expect(remembered.status).toBe(200);let changed=await publication;
 if(changed.closed!==undefined){
  // Guarded publication may request a fresh snapshot if a committed write
  // overtook frame serialization. The canonical client reconnects on1012.
  expect(changed.closed).toBe(1012);
  const retry=new WebSocket(f.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.body}});clean.push(()=>retry.terminate());await once(retry,'open');await next(retry,()=>retry.send(JSON.stringify({type:'connection_init'})));
  changed=await next(retry,()=>retry.send(JSON.stringify({type:'subscribe',id:'memory',payload:{query:'subscription($query:String!){observe(query:$query){patches{path value removed}}}',variables:{query:'{memoryProject(id:"art:pond"){sections{key total items{title body}}}}'}}})));
 }
 expect(JSON.stringify(changed)).toContain(words);
 const id=remembered.result.value.ids[0];expect(id).toMatch(/^art:[a-f0-9-]{36}$/);expect(JSON.stringify(remembered)).not.toContain(title);expect(JSON.stringify(remembered)).not.toContain(words);
 expect(await f.query(`{memoryProjectMemory(id:"${id}"){title content}}`)).toEqual({memoryProjectMemory:{title,content:words}});
 const recall=await f.call('recall',{query:'alpha',limit:1},'recall');expect(recall.status).toBe(200);expect(recall.result.value).toMatchObject({ids:[id],matches:[{id}]});expect(JSON.stringify(recall)).not.toContain(words);
 const before=embed.calls;expect(await f.call('recall',{query:'alpha',limit:1},'recall')).toEqual(recall);expect(embed.calls).toBe(before);
 for(const token of [raw.agent,raw.member,raw.runner])expect((await f.call('remember',input,'wrong-'+token[0],token)).status).toBe(403);
 expect((await f.call('remember',{...input,agent:'mark'},'choose-agent')).status).toBe(400);expect((await f.call('remember',{...input,path:f.other},'choose-path')).status).toBe(400);
 expect(f.count()).toBe(1);expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(words))).toBe(false);expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(title))).toBe(false);
});
it('recovers the committed private result after shared receipt failure and reserves the id against unrelated writes',async()=>{
 const f=await fixture();f.db.$client.exec("CREATE TRIGGER fail_memory_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('remember',input,'recover')).status).toBe(503);expect(f.count()).toBe(1);const before=embed.calls;
 let writes=0;f.root.operations.register({name:'fixture.write',write:true,input:z.object({}).strict(),output:z.null(),may:()=>true,run(){writes++;return null;}});
 const unrelated=await fetch(f.url+'/api/fixture/write',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{},id:'recover'})});expect(unrelated.status).toBe(409);expect(writes).toBe(0);
 f.db.$client.exec('DROP TRIGGER fail_memory_core');const replay=await f.call('remember',input,'recover');expect(replay.status).toBe(200);expect(f.count()).toBe(1);expect(embed.calls).toBe(before);
 expect((await f.call('remember',{...input,content:'Different'},'recover')).status).toBe(409);
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());expect([401,403]).toContain((await f.call('remember',input,'recover')).status);
});
it('rolls back a private write if receipt insertion fails, leaving a safe retry reservation',async()=>{
 const f=await fixture();f.source.exec("CREATE TRIGGER fail_memory_source BEFORE INSERT ON memory_command_receipts BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('remember',input,'source-fail')).status).toBe(503);expect(f.count()).toBe(0);
 expect(f.source.prepare('SELECT count(*) AS n FROM memory_command_preparations').get()).toEqual({n:1});expect(f.source.prepare('SELECT count(*) AS n FROM memory_command_receipts').get()).toEqual({n:0});
 f.source.exec('DROP TRIGGER fail_memory_source');expect((await f.call('remember',input,'source-fail')).status).toBe(200);expect(f.count()).toBe(1);
});
it('reserves a pending id globally and rolls back when current body authority ends during embedding',async()=>{
 const f=await fixture(),gate=hold(),pending=f.call('remember',input,'pending');await gate.began;
 let writes=0;f.root.operations.register({name:'fixture.write',write:true,input:z.object({}).strict(),output:z.null(),may:()=>true,run(){writes++;return null;}});
 const response=await fetch(f.url+'/api/fixture/write',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{},id:'pending'})});expect(response.status).toBe(409);expect(writes).toBe(0);
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());gate.release();expect([401,403]).toContain((await pending).status);expect(f.count()).toBe(0);
 embed.gate=undefined;f.root.writes.run(()=>f.db.update(s.jobs).set({state:'running'}).where(eq(s.jobs.id,'job')).run());expect((await f.call('remember',input,'pending')).status).toBe(200);expect(f.count()).toBe(1);
});

it('keeps two current bodies in their own files even when their agents share a project',async()=>{
 const f=await fixture(),token='k'.repeat(64),at=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(s.memberAgents).values({member:'bob',agent:'mark'}).run();f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run();});
 const thread=f.root.services.comms!.threads.open({member:'bob',agent:'mark',project:'pond',title:'Other private'});
 f.root.writes.run(()=>{
  f.db.insert(s.jobs).values({id:'other-job',agent:'mark',box:'box',member:'bob',project:'pond',conversation:thread.conversation,title:'Other body',state:'running',brief:'',model:'fixture',startedByKind:'member',startedBy:'bob',houseRepository:'fixture',houseFile:'HOUSE.md',houseBranch:'next',queuedAt:at}).run();
  f.db.update(s.conversations).set({job:'other-job'}).where(eq(s.conversations.id,thread.conversation)).run();
  f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Other body',kind:'agent',agent:'mark',job:'other-job',createdAt:at}).run();
 });
 const own=await f.call('remember',input,'own'),other=await f.call('remember',{...input,content:'beta OTHER_PRIVATE_MEMORY'},'own',token);expect(own.status).toBe(200);expect(other.status).toBe(200);
 const id=other.result.value.ids[0];expect(id).toMatch(/^mark:/);expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`,token)).toEqual({memoryProjectMemory:{content:'beta OTHER_PRIVATE_MEMORY'}});
 expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`)).toEqual({memoryProjectMemory:null});expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`,raw.member)).toEqual({memoryProjectMemory:null});
 expect((await f.call('recall',{query:'alpha',limit:50},'lookup')).result.value.ids).toEqual(own.result.value.ids);
});
it('keeps the original retry deadline after recovery and leaves existing unprepared metadata untouched',async()=>{
 const f=await fixture(),start=f.clock.now();f.db.$client.exec("CREATE TRIGGER fail_memory_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('remember',input,'expiry')).status).toBe(503);
 const deadline=(f.source.prepare('SELECT expires FROM memory_command_receipts').get() as {expires:number}).expires;expect(deadline).toBe(start+30*86400000);
 f.db.$client.exec('DROP TRIGGER fail_memory_core');vi.spyOn(f.clock,'now').mockReturnValue(start+29*86400000);
 expect((await f.call('remember',input,'expiry')).status).toBe(200);expect(f.db.select().from(s.operationResults).all()[0].expiresAt).toBe(new Date(deadline).toISOString());
 expect(f.source.prepare('SELECT expires FROM memory_command_receipts').get()).toEqual({expires:deadline});
 f.source.exec('DROP TABLE memory_command_schema');const before=f.source.serialize();
 expect((await f.call('remember',input,'unprepared')).status).toBe(503);expect(f.source.serialize()).toEqual(before);
});
