import { HouseholdDatabase } from '../../core/household/document.js';
import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Result } from '../../core/index.js';
import { fixture } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { runtimeStore } from './store.js';
const value=<T>(r:Result):T=>{expect(r.ok).toBe(true);return (r as {ok:true;value:T}).value;};
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
async function setup(staging=false){
 const home=mkdtempSync(join(tmpdir(),'runtime-private-'));fixture(home);cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();let app=await startLoom({home,clock,next:true,staging,stdout:()=>{}});cleanups.push(()=>app.close());
 const auth=signin(app);app.db.transaction(()=>auth.tokens.replace({v:1,tokens:[]},{}))();let n=0;
 const token=(role:string)=>{const secret=randomBytes(32).toString('hex');auth.tokens.change(ts=>ts.push({role,sha256:hash(secret),label:role,created:new Date(clock.now()).toISOString()}));return secret;};
 const owner=token('owner'),runner=token('runner:a'),unbound=token('agent:art');
 app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'a',active:true},'enable');
 app.db.transaction(()=>{const store=runtimeStore(app.db);store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());store.put('box',{id:'a',name:'A',owner:'jonathan',local:true,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());})();
 const cookie=auth.createSession(hash(owner));
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${cookie}`,origin:app.url}});await once(ws,'open');cleanups.push(()=>ws.terminate());
 const socket=(name:string,input:unknown)=>new Promise<Result>(resolve=>{const request=`socket-${++n}`;const receive=(raw:unknown)=>{const message=JSON.parse(String(raw));if(message.kind==='result'&&message.request===request){ws.off('message',receive);resolve(message.result);}};ws.on('message',receive);ws.send(JSON.stringify({kind:'call',name,input,id:request,request}));});
 const post=async(secret:string,name:string,input:unknown)=>{const [piece,op]=name.split('.');const r=await fetch(`${app.url}/api/${piece}/${op}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id:`http-${++n}`})});return r.json() as Promise<Result>;};
 const open=async()=>{const r=await socket('comms.open',{agent:'art',id:'abcdefghijklmnop',text:'PRIVATE inbound sentinel'});expect(r.ok).toBe(true);return value<{thread:string}>(r).thread;};
 return {get app(){return app;},clock,home,owner,runner,unbound,socket,post,open,token,async restart(){ws.terminate();await app.close();app=await startLoom({home,clock,next:true,staging,stdout:()=>{}});}};
}
it('runs private conversation input/reply/status through actual next auth, socket and runner API',async()=>{
 const f=await setup(),thread=await f.open();
 // Async encryption and delivery settle through the public acknowledgement and
 // authoritative claimable API, with no sleeps or process fake.
 let jobs:string[]=[];
 for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
 expect(jobs).toHaveLength(1);const job=jobs[0];
 expect(runtimeStore(f.app.db).read('job',job)).toMatchObject({state:'queued',member:'jonathan'});
 expect(JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).working).toBe(false);
 expect(await f.post(f.runner,'runtime.listJobs',{})).toMatchObject({ok:true,value:{records:[]}});
 expect(await f.post(f.runner,'runtime.claimJob',{job})).toMatchObject({ok:true});
 const input=await f.post(f.runner,'runtime.takeInput',{job});expect(input).toMatchObject({ok:true,value:{job,credential:expect.any(String)}});
 expect(JSON.stringify(input)).not.toContain('PRIVATE inbound');
 const body=value<{credential:string}>(input).credential;
 expect(JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).working).toBe(false);
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.runner,'runtime.reportJob',{job,state:'running'})).toMatchObject({ok:true});
 expect(await f.socket('comms.messages',{thread})).toMatchObject({ok:true});
 for(const secret of [f.runner,f.owner,f.unbound,f.token('agent:art@another')])expect(await f.post(secret,'runtime.readConversation',{})).toMatchObject({ok:false});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true,value:{thread:{working:true},messages:[expect.objectContaining({text:'PRIVATE inbound sentinel'})]}});
 expect(await f.post(body,'runtime.reply',{id:'reply-1',text:'PRIVATE outbound sentinel'})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.reply',{id:'reply-1',text:'PRIVATE outbound sentinel'})).toMatchObject({ok:true});
 const history=await f.socket('comms.messages',{thread});expect(JSON.stringify(history)).toContain('PRIVATE outbound sentinel');
 expect(await f.post(body,'runtime.conversationStatus',{state:'working'})).toMatchObject({ok:true,value:{stop:false}});
 expect(await f.socket('comms.send',{thread,id:'bcdefghijklmnopq',text:'PRIVATE second message'})).toMatchObject({ok:true});
 expect(value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs).toEqual([]);
 expect(await f.post(f.runner,'runtime.finishJob',{job,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false});
 for(const table of ['runtime_inputs','runtime_jobs','runtime_bindings','runtime_deliveries','core_operations']){
  const text=JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all());expect(text).not.toContain('PRIVATE');expect(text).not.toContain(body);
 }
});
it('holds both Comms dispatch and runner input under staging and survives restart without a second job',async()=>{
 const f=await setup(true),thread=await f.open();
 expect(value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs).toEqual([]);
 const rows=f.app.db.prepare('SELECT id FROM core_effects').all() as {id:string}[];
 expect(rows.some(r=>r.id.startsWith('comms-deliver:'))).toBe(true);
 const release=rows.find(r=>r.id.startsWith('comms-deliver:'))!.id;
 expect(await f.post(f.owner,'core.releaseEffect',{id:release})).toMatchObject({ok:true});
 await f.restart();
 let jobs:string[]=[];for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
 expect(jobs).toHaveLength(1);const job=jobs[0];
 expect(await f.post(f.runner,'runtime.claimJob',{job})).toMatchObject({ok:true});
 expect(await f.post(f.runner,'runtime.takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
 expect(await f.post(f.owner,'core.releaseEffect',{id:`runtime:input:${job}`})).toMatchObject({ok:true});
 expect(await f.post(f.runner,'runtime.takeInput',{job})).toMatchObject({ok:true});
 expect(await f.post(f.runner,'runtime.takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
 expect(runtimeStore(f.app.db).ids('binding')).toHaveLength(1);expect(thread).toMatch(/^th:/);
});

it('keeps authenticated job proof across restart, fences revoked bodies and never releases input twice',async()=>{
 const f=await setup();await f.open();let jobs:string[]=[];
 for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
 const job=jobs[0];expect(job).toBeTruthy();
 await f.post(f.runner,'runtime.claimJob',{job});const input=await f.post(f.runner,'runtime.takeInput',{job});const body=value<{credential:string}>(input).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 await f.restart();
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true});
 expect(await f.post(f.runner,'runtime.takeInput',{job})).toMatchObject({ok:false});
 const auth=signin(f.app);
 const viewer=auth.token(hash(body))!.viewer;
 expect(await f.app.operations.callAsync('direct',{...viewer},'runtime.readConversation',{})).toMatchObject({ok:false,code:'denied'});
 const pending=f.app.operations.callAsync('direct',viewer,'runtime.reply',{id:'racing-revoke',text:'must not post after revoke'});
 auth.tokens.change(tokens=>{for(const token of tokens)if(token.role===`agent:art@${job}`)token.revoked=new Date(f.clock.now()).toISOString();});
 expect(await pending).toMatchObject({ok:false});
 expect(f.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE id='racing-revoke'").get()).toEqual({n:0});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false});
 expect(await f.post(body,'runtime.reply',{id:'late',text:'must not post'})).toMatchObject({ok:false});
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
});

it('rejects private runner confirmation after hosting or house drift',async()=>{
 for(const drift of ['hosting','house'] as const){
  const f=await setup(),thread=await f.open();let jobs:string[]=[];
  for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
  const job=jobs[0];await f.post(f.runner,'runtime.claimJob',{job});
  const input=await f.post(f.runner,'runtime.takeInput',{job});expect(input.ok).toBe(true);
  f.app.db.transaction(()=>{const store=runtimeStore(f.app.db);
   if(drift==='hosting'){const {changedAt:_,...box}=store.read('box','a')!;store.put('box',{...box,mayHost:[]},f.clock.now());}
   else {const {changedAt:_,...setting}=store.read('settings','art')!;store.put('settings',{...setting,house:{repo:'/changed',houseFile:'house.json'}},f.clock.now());}
  })();
  expect(await f.post(f.runner,'runtime.reportJob',{job,state:'running'})).toMatchObject({ok:false,code:'denied'});
  expect(JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).working).toBe(false);
 }
});
it('rolls back job, binding, acceptance and nested receipts if either final write fails',async()=>{
 const f=await setup(true),thread=await f.open();
 const t=JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record) as {member:string;agent:string;conversation:string};
 const routing={thread,agent:t.agent,member:t.member,conversation:t.conversation,seq:1};
 for(const trigger of [
  "CREATE TRIGGER fail_accept BEFORE INSERT ON runtime_deliveries BEGIN SELECT RAISE(ABORT,'interrupted'); END",
  "CREATE TRIGGER fail_accept BEFORE INSERT ON core_operations WHEN NEW.name='runtime.acceptConversation' BEGIN SELECT RAISE(ABORT,'interrupted'); END",
 ]){
  f.app.db.exec(trigger);
  expect(f.app.operations.call('direct',{kind:'member',id:t.member},'runtime.acceptConversation',routing,'retry-atomic')).toMatchObject({ok:false});
  for(const table of ['runtime_jobs','runtime_bindings','runtime_deliveries'])expect(f.app.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({n:0});
  expect(f.app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name IN ('runtime.acceptConversation','runtime.startBody')").get()).toEqual({n:0});
  f.app.db.exec('DROP TRIGGER fail_accept');
 }
 expect(f.app.operations.call('direct',{kind:'member',id:t.member},'runtime.acceptConversation',routing,'retry-atomic')).toMatchObject({ok:true});
 expect(runtimeStore(f.app.db).ids('job')).toHaveLength(1);
});

it('resumes a staging-held archive end without restarting and revokes its body credential',async()=>{
 const f=await setup(true),thread=await f.open();
 await f.post(f.runner,'runtime.claimableJobs',{});
 const delivery=(f.app.db.prepare("SELECT id FROM core_effects WHERE id LIKE 'comms-deliver:%'").get() as {id:string}).id;
 await f.post(f.owner,'core.releaseEffect',{id:delivery});
 let jobs:string[]=[];for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
 const job=jobs[0];await f.post(f.runner,'runtime.claimJob',{job});await f.post(f.runner,'runtime.takeInput',{job});
 await f.post(f.owner,'core.releaseEffect',{id:`runtime:input:${job}`});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 expect(await f.socket('comms.change',{thread,action:'archive'})).toMatchObject({ok:true});
 expect(runtimeStore(f.app.db).read('job',job)?.state).toBe('running');
 const end=(f.app.db.prepare("SELECT id FROM core_effects WHERE id LIKE 'comms-end:%'").get() as {id:string}).id;
 expect(await f.post(f.owner,'core.releaseEffect',{id:end})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false});
 expect(runtimeStore(f.app.db).read('job',job)?.state).toBe('stopped');
 expect(signin(f.app).token(hash(body))).toBeUndefined();
});
it('rechecks hosting, house, linkage and ownership after reply crypto has begun',async()=>{
 for(const drift of ['hosting','house','linkage','ownership'] as const){
  const f=await setup();await f.open();let jobs:string[]=[];
  for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
  const job=jobs[0];await f.post(f.runner,'runtime.claimJob',{job});
  const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
  await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
  const viewer=signin(f.app).token(hash(body))!.viewer;
  const pending=f.app.operations.callAsync('direct',viewer,'runtime.reply',{id:'drift-reply',text:'must not post after drift'});
  f.app.db.transaction(()=>{const store=runtimeStore(f.app.db);
   if(drift==='hosting'){const {changedAt:_,...box}=store.read('box','a')!;store.put('box',{...box,mayHost:[]},f.clock.now());}
   else if(drift==='house'){const {changedAt:_,...settings}=store.read('settings','art')!;store.put('settings',{...settings,house:{repo:'/changed',houseFile:'house.json'}},f.clock.now());}
   else if(drift==='linkage'){const cv=store.read('job',job)!.conversation!;const {changedAt:_,...binding}=store.read('binding',cv)!;store.put('binding',{...binding,job:'different-job'},f.clock.now());}
   else {const h=new HouseholdDatabase(f.app.db).household(f.home)!;new HouseholdDatabase(f.app.db).replace(f.home,{v:1,agents:h.agents,owner:'pollock',members:[{person:'pollock',role:'owner',agents:'*'},{person:'jonathan',role:'member',agents:[]}]});}
  })();
  expect(await pending).toMatchObject({ok:false,code:'denied'});
  expect(f.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE id='drift-reply'").get()).toEqual({n:0});
 }
});
