/** Normal startup, native body tools and private source persistence; all fictional. */
import {expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {eq} from 'drizzle-orm';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {sharedUiProgram} from '../test/fixtures/shared-ui-program.js';
import {credentialHash} from '../test/fixtures/conversation-body.js';
import {FakeClock} from './core/clock.js';
import {requestLocalLink} from './core/signin/operator.js';
import * as s from './core/data/schema.js';
import {bodyProgramTools} from './runtime/body-program-tools.js';
import {startSharedHome} from './shared-startup.js';
vi.mock('./backends/fastembed.js',()=>({FastEmbedProvider:class{
 readonly dimensions=4;
 async embed(){return [1,0,0,0];}
 async embedBatch(texts:string[]){return texts.map(()=>[1,0,0,0]);}
}}));
it('normal startup carries native Memory tools, private Identity and revisions across restart',async()=>{
 const clock=new FakeClock(Date.parse('2026-11-15T12:00:00Z')),token='f'.repeat(64),words='PRIVATE_NORMAL_STARTUP_MEMORY',creed='PRIVATE_NORMAL_STARTUP_IDENTITY';
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(clock.now());
 let p:Awaited<ReturnType<typeof sharedUiProgram>>|undefined,restarted:Awaited<ReturnType<typeof startSharedHome>>|undefined,tools:ReturnType<typeof bodyProgramTools>|undefined;
 try{
  p=await sharedUiProgram({clock,seed(db,now){
   db.insert(s.members).values([{id:'alice',role:'owner',joinedAt:now()},{id:'peer',role:'member',joinedAt:now()}]).run();
   db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
   db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run();
  }});
  const signin=await fetch(p.printed[0].trim(),{method:'POST',redirect:'manual',headers:{origin:p.url}});expect(signin.status).toBe(303);
  const cookie=signin.headers.get('set-cookie')!.split(';',1)[0];
  const opened=await fetch(p.url+'/api/comms/open',{method:'POST',headers:{cookie,origin:p.url,'content-type':'application/json'},body:JSON.stringify({input:{thread:'th:memory-startup',agent:'art'},id:'startup-thread'})});
  expect(opened.status).toBe(200);const {conversation}=z.object({value:z.object({conversation:z.string()})}).parse(await opened.json()).value;
  const now=new Date(clock.now()).toISOString();
  p.composition.writes.run(()=>{
   p!.db.insert(s.boxes).values({id:'box',name:'Fictional box',owner:'alice',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now}).run();
   p!.db.insert(s.jobs).values({id:'memory-job',agent:'art',box:'box',member:'alice',conversation,title:'Fictional Memory body',state:'running',brief:'',model:'fixture',startedByKind:'member',startedBy:'alice',houseRepository:'fixture',houseFile:'HOUSE.md',houseBranch:'next',queuedAt:now}).run();
   p!.db.update(s.conversations).set({job:'memory-job'}).where(eq(s.conversations.id,conversation)).run();
   p!.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictional Memory body',kind:'agent',agent:'art',job:'memory-job',createdAt:now}).run();
  });
  writeFileSync(join(p.home,'agents/art/IDENTITY.md'),creed);
  const port=(url:string)=>bodyProgramTools({url,token,clock,signal:new AbortController().signal,onStop(){},onStatus(){}});
  tools=port(p.url);
  const invoke=async(name:string,args:unknown)=>{const reply=await tools!.call(name,args);expect(reply.isError).not.toBe(true);return JSON.parse(reply.content[0].text) as unknown;};
  const command=async(operation:string,input:unknown,id:string)=>z.object({ok:z.literal(true),value:z.record(z.string(),z.unknown())}).parse(await invoke('loom_command',{operation,input,id})).value;
  const read=async(query:string)=>z.object({data:z.record(z.string(),z.unknown())}).parse(await invoke('loom_query',{query})).data;
  const id=z.array(z.string()).parse((await command('memory.remember',{category:'user',title:'Fictional retained lesson',content:words,ttl:'permanent'},'startup-remember')).ids)[0];
  expect(await read(`{memoryProjectMemory(id:"${id}"){content} memoryIdentity(agent:"art"){creed topOfMind}}`)).toMatchObject({memoryProjectMemory:{content:words},memoryIdentity:{creed,topOfMind:expect.stringContaining(words)}});
  await command('memory.update',{id,content:'PRIVATE_NORMAL_STARTUP_EDIT'},'startup-edit');
  const history=z.array(z.object({id:z.number(),content:z.string()})).parse((await read(`{memoryHistory(id:"${id}"){id content}}`)).memoryHistory);expect(history).toHaveLength(1);expect(history[0].content).toBe(words);
  await command('memory.restoreRevision',{id,revision_id:history[0].id},'startup-restore-revision');
  const expected=await read(`{memoryProjectMemory(id:"${id}"){content} memoryHistory(id:"${id}"){content}}`);expect(expected).toMatchObject({memoryProjectMemory:{content:words},memoryHistory:[{content:'PRIVATE_NORMAL_STARTUP_EDIT'},{content:words}]});
  const peerLink=await requestLocalLink(p.home,{request:'link',member:'peer',label:'Fictional peer',ttl:30}),peerSignin=await fetch(p.url+peerLink.path,{method:'POST',redirect:'manual',headers:{origin:p.url}});expect(peerSignin.status).toBe(303);const peerCookie=peerSignin.headers.get('set-cookie')!.split(';',1)[0];
  const peerRead=async(url:string)=>{const response=await fetch(url+'/graphql',{method:'POST',headers:{cookie:peerCookie,origin:url,'content-type':'application/json'},body:JSON.stringify({query:`{memoryProjectMemory(id:"${id}"){content}}`})});expect(response.status).toBe(200);return response.json();};
  expect(await peerRead(p.url)).toEqual({data:{memoryProjectMemory:null}});
  p.composition.writes.run(()=>p!.db.insert(s.memberAgents).values({member:'peer',agent:'art'}).run());expect(await peerRead(p.url)).toEqual({data:{memoryProjectMemory:{content:words}}});
  const privatePath=join(p.home,'agents/art/memories.db'),snapshot=()=>{const db=new Database(privatePath,{readonly:true,fileMustExist:true});try{return db.serialize();}finally{db.close();}};
  const before=snapshot();for(const value of [words,creed,'PRIVATE_NORMAL_STARTUP_EDIT',privatePath])expect(p.client.serialize().includes(Buffer.from(value))).toBe(false);
  tools.close();await p.composition.close();
  restarted=await startSharedHome({home:p.home,clock,host:'127.0.0.1',port:0,stdout(){},reportError:error=>{throw error;}});tools=port(restarted.url);
  expect(await read(`{memoryProjectMemory(id:"${id}"){content} memoryHistory(id:"${id}"){content}}`)).toEqual(expected);expect(snapshot()).toEqual(before);
  expect(await peerRead(restarted.url)).toEqual({data:{memoryProjectMemory:{content:words}}});restarted.writes.run(()=>restarted!.services.comms!.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'peer')).run());expect(await peerRead(restarted.url)).toEqual({data:{memoryProjectMemory:null}});
  expect((await command('memory.recall',{query:'retained lesson'},'startup-recall')).ids).toEqual([id]);
  await command('memory.archive',{id,note:'PRIVATE_STARTUP_ARCHIVE_REASON'},'startup-archive');expect((await read(`{memoryProjectMemory(id:"${id}"){content}}`)).memoryProjectMemory).toBeNull();
  await command('memory.restore',{id},'startup-restore');expect((await read(`{memoryProjectMemory(id:"${id}"){content}}`)).memoryProjectMemory).toEqual({content:words});
  await command('memory.forget',{id},'startup-forget');expect((await read(`{memoryProjectMemory(id:"${id}"){content}}`)).memoryProjectMemory).toBeNull();
  restarted.writes.run(()=>restarted!.services.comms!.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'memory-job')).run());
  expect((await tools.call('loom_query',{query:'{memoryIdentity(agent:"art"){creed}}'})).isError).toBe(true);
  expect(p.errors).toEqual([]);
 }finally{try{tools?.close();await restarted?.close();}finally{try{await p?.close();}finally{vi.useRealTimers();}}}
});
