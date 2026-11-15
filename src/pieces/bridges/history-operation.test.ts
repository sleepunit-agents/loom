import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runBridgesClient } from '../../cli/bridges-client.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Result } from '../../core/index.js';
import { fixture } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { runtimeStore } from '../runtime/store.js';
const value=<T>(r:Result):T=>{expect(r.ok).toBe(true);return (r as {ok:true;value:T}).value;};
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{try{for(const f of cleanups.splice(0).reverse())await f();}finally{vi.restoreAllMocks();}});
async function setup(staging=false,adapter=true){
 const home=mkdtempSync(join(tmpdir(),'runtime-private-'));fixture(home);cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();const buffers:Buffer[]=[];
 const source={generation:async()=> '00000000-0000-4000-8000-000000000000',read:vi.fn(async()=>{const b=Buffer.from('HISTORY-CREDENTIAL');buffers.push(b);return b;})};
 const request=vi.fn<typeof fetch>(async url=>{
  const path=String(url);
  if(path.endsWith('users/@me'))return Response.json({id:'100',bot:true});
  if(path.endsWith('guilds/300'))return Response.json({id:'300'});
  return Response.json(path.includes('/messages?')?[{id:'500',channel_id:'400',guild_id:'300',type:0,author:{id:'600'},content:'HISTORY WORDS'}]:{id:'400',guild_id:'300',type:0});
 });
 const app=await startLoom({home,clock,next:true,staging,stdout:()=>{},bridges:adapter?{source,request,discordSocket:()=>{
  const socket=new EventEmitter() as EventEmitter & {readyState:number;terminate():void};socket.readyState=1;socket.terminate=()=>{socket.readyState=3;socket.emit('close');};return socket as unknown as WebSocket;
 }}:undefined});cleanups.push(()=>app.close());
 const auth=signin(app);app.db.transaction(()=>auth.tokens.replace({v:1,tokens:[]},{}))();let n=0;
 const token=(role:string)=>{const secret=randomBytes(32).toString('hex');auth.tokens.change(ts=>ts.push({role,sha256:hash(secret),label:role,created:new Date(clock.now()).toISOString()}));return secret;};
 const owner=token('owner'),runner=token('runner:a'),unbound=token('agent:art');
 app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'a',active:true},'enable');
 app.db.transaction(()=>{const store=runtimeStore(app.db);store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());store.put('box',{id:'a',name:'A',owner:'jonathan',local:true,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());})();
 const cookie=auth.createSession(hash(owner));
 let ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${cookie}`,origin:app.url}});await once(ws,'open');cleanups.push(()=>ws.terminate());
 const socket=(name:string,input:unknown)=>new Promise<Result>(resolve=>{const request=`socket-${++n}`;const receive=(raw:unknown)=>{const message=JSON.parse(String(raw));if(message.kind==='result'&&message.request===request){ws.off('message',receive);resolve(message.result);}};ws.on('message',receive);ws.send(JSON.stringify({kind:'call',name,input,id:request,request}));});
 const post=async(secret:string,name:string,input:unknown)=>{const [piece,op]=name.split('.');const r=await fetch(`${app.url}/api/${piece}/${op}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id:`http-${++n}`})});return r.json() as Promise<Result>;};
 const queued=async()=>{
  let jobs:string[]=[];
  for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await post(runner,'runtime.claimableJobs',{})).jobs;
  expect(jobs).toHaveLength(1);return jobs[0];
 };
 const open=async()=>{const r=await socket('comms.open',{agent:'art',id:'abcdefghijklmnop',text:'PRIVATE inbound sentinel'});expect(r.ok).toBe(true);return value<{thread:string}>(r).thread;};
 return {app,clock,home,request,source,buffers,owner,runner,unbound,socket,post,open,queued,token};
}
const query={venue:'discord',channel:'400',kind:'channel'};
async function configured(staging=false,adapter=true) {
 const f=await setup(staging,adapter);const thread=await f.open();
 if(staging){
  const id=`comms-deliver:${thread}:1`;
  await expect.poll(()=>f.app.db.prepare("SELECT state FROM core_effects WHERE id=?").get(id)).toEqual({state:'due'});
  value(await f.post(f.owner,'core.releaseEffect',{id}));f.clock.advance(0);
 }
 const job=await f.queued();
 value(await f.post(f.runner,'runtime.claimJob',{job}));
 if(staging){
  expect(await f.post(f.runner,'runtime.takeInput',{job})).toMatchObject({ok:false});
  value(await f.post(f.owner,'core.releaseEffect',{id:`runtime:input:${job}`}));
 }
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 for(const [name,input] of [
  ['secrets.describe',{name:'discord',description:'fixture bot'}],
  ['bridges.putVenues',{id:'discord',platform:'discord',agent:'art',workspace:'300',bot:'100',tokenSecret:'discord'}],
 ] as const){value(await f.post(f.owner,name,input));}
 return {...f,job,body};
}
it('reads through the installed HTTP operation and generated client with a real running private owner body',async()=>{
 const f=await configured();
 expect(await f.post(f.body,'bridges.discordHistory',query)).toMatchObject({ok:true,value:{messages:[{text:'HISTORY WORDS',user:'600'}]}});
 const tokenFile=join(f.home,'body-token');writeFileSync(tokenFile,f.body);
 let stdout='',stderr='';
 const code=await runBridgesClient(['discordHistory',JSON.stringify(query)],{stdout:s=>stdout+=s,stderr:s=>stderr+=s,stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:f.app.url,LOOM_TOKEN_FILE:tokenFile}});
 expect({code,stderr}).toEqual({code:0,stderr:''});expect(JSON.parse(stdout)).toMatchObject({messages:[{text:'HISTORY WORDS'}]});
 expect(f.buffers.every(b=>b.every(v=>v===0))).toBe(true);
 expect(f.app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name='bridges.discordHistory'").get()).toEqual({n:0});
 expect(f.app.db.prepare('SELECT count(*) AS n FROM bridges_outbox').get()).toEqual({n:0});
});
it('denies typed authority, member, runner, unbound and wrong-agent callers before history IO',async()=>{
 const f=await configured();const before=()=>f.request.mock.calls.filter(([url])=>String(url).includes('/channels/')).length;
 const n=before();
 for(const token of [f.owner,f.runner,f.unbound,f.token(`agent:mark@${f.job}`)])expect(await f.post(token,'bridges.discordHistory',query)).toMatchObject({ok:false});
 for(const patch of [{agent:'art'},{principal:'owner'},{permit:{}},{workspace:'300'},{kind:'dm'}])expect(await f.post(f.body,'bridges.discordHistory',{...query,...patch})).toMatchObject({ok:false,code:'invalid'});
 expect(before()).toBe(n);
});
it.each(['credential','setup','job'] as const)('suppresses late words after %s revocation during history IO',async drift=>{
 const f=await configured();
 f.request.mockImplementation(async url=>{
  if(String(url).includes('/messages?')){
   if(drift==='credential')signin(f.app).tokens.change(ts=>{for(const t of ts)if(t.sha256===hash(f.body))t.revoked=new Date(f.clock.now()).toISOString();});
   if(drift==='setup')value(await f.post(f.owner,'bridges.removeVenues',{id:'discord'}));
   if(drift==='job')value(await f.post(f.runner,'runtime.finishJob',{job:f.job,state:'done'}));
   return Response.json([{id:'500',channel_id:'400',author:{id:'600'},type:0,content:'LATE PRIVATE WORDS'}]);
  }
  return Response.json(String(url).endsWith('users/@me')?{id:'100',bot:true}:String(url).endsWith('guilds/300')?{id:'300'}:{id:'400',guild_id:'300',type:0});
 });
 const result=await f.post(f.body,'bridges.discordHistory',query);expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('holds history in staging before credential acquisition or network IO',async()=>{
 const f=await configured(true);f.request.mockClear();f.source.read.mockClear();
 expect(await f.post(f.body,'bridges.discordHistory',query)).toMatchObject({ok:false});
 expect(f.request).not.toHaveBeenCalled();expect(f.source.read).not.toHaveBeenCalled();
 expect(f.app.db.prepare("SELECT count(*) AS n FROM core_effects WHERE state='due'").get()).toMatchObject({n:expect.any(Number)});
 const held=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due' AND title='Inspect bridge recipients'").get() as {id:string};
 expect(held).toBeDefined();
 value(await f.post(f.owner,'core.releaseEffect',held));f.clock.advance(0);
 expect(await f.post(f.body,'bridges.discordHistory',query)).toMatchObject({ok:true,value:{messages:[{text:'HISTORY WORDS'}]}});
 // Replacing setup invalidates this exact released inspection lifetime.
 value(await f.post(f.owner,'bridges.putVenues',{id:'discord',platform:'discord',agent:'art',workspace:'300',bot:'100',tokenSecret:'discord'}));
 f.request.mockClear();f.source.read.mockClear();
 expect(await f.post(f.body,'bridges.discordHistory',query)).toMatchObject({ok:false});
 expect(f.request).not.toHaveBeenCalled();expect(f.source.read).not.toHaveBeenCalled();
});

it('refuses without an adapter even for a real eligible owner body and configured venue',async()=>{
 const f=await configured(false,false);
 const result=await f.post(f.body,'bridges.discordHistory',query);
 expect(result).toEqual({ok:false,code:'unavailable',message:'History unavailable'});
 expect(f.request).not.toHaveBeenCalled();expect(f.source.read).not.toHaveBeenCalled();
});
it('suppresses late history after holder-generation replacement',async()=>{
 const f=await configured();let enter!:()=>void,release!:(r:Response)=>void;
 const entered=new Promise<void>(r=>enter=r),response=new Promise<Response>(r=>release=r);
 const original=f.request.getMockImplementation()!;
 f.request.mockImplementation((url,init)=>{if(String(url).includes('/messages?')){enter();return response;}return original(url,init);});
 const reading=f.post(f.body,'bridges.discordHistory',query);await entered;
 f.source.generation=async()=> '00000000-0000-4000-8000-000000000001';
 f.clock.advance(5000);
 // A real HTTP turn lets the current holder poll settle while the history reply is held.
 value(await f.post(f.owner,'bridges.status',{platform:'discord'}));
 release(Response.json([{id:'500',channel_id:'400',author:{id:'600'},type:0,content:'LATE PRIVATE WORDS'}]));
 const result=await reading;expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('rechecks the transport lifetime in the final transaction after preparation',async()=>{
 const f=await configured();
 const viewer=signin(f.app).token(hash(f.body))!.viewer;
 let checks=0;
 expect(await f.app.operations.callAsync('http',viewer,'bridges.discordHistory',query)).toMatchObject({ok:true});
 const result=await f.app.operations.callAsync('http',viewer,'bridges.discordHistory',query,undefined,false,()=>{
  if(++checks===1)return true;
  value(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'bridges.removeVenues',{id:'discord'},'last-moment-remove'));
  return true;
 });
 expect(checks).toBe(2);expect(result).toMatchObject({ok:false});
});
