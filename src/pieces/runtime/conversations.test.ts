import * as conversationModule from './conversations.js';
import * as services from '../../core/services.js';
import * as corePolicy from '../../core/index.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { wakes } from '../clock/store.js';
import { exportDatabase } from '../../core/index.js';
import { provenanceStore } from './provenance-store.js';
import { readApproval } from '../approvals/store.js';
import * as commsCrypto from '../comms/crypto.js';
import { runtimeRole } from './role.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { afterEach, expect, it, vi } from 'vitest';
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
const realConversationRuntime=conversationModule.conversationRuntime;
const realLoadKey=commsCrypto.loadKey;
const value=<T>(r:Result):T=>{expect(r.ok).toBe(true);return (r as {ok:true;value:T}).value;};
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{try{for(const f of cleanups.splice(0).reverse())await f();}finally{vi.restoreAllMocks();}});
async function setup(staging=false,member='jonathan'){
 const home=mkdtempSync(join(tmpdir(),'runtime-private-'));fixture(home);cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();let app=await startLoom({home,clock,next:true,staging,stdout:()=>{}});cleanups.push(()=>app.close());
 const auth=signin(app);app.db.transaction(()=>auth.tokens.replace({v:1,tokens:[]},{}))();let n=0;
 if(member!=='jonathan')app.db.transaction(()=>new HouseholdDatabase(app.db).change(home,raw=>{const m=(raw.members as Array<{person:string;agents:string[]}>).find(m=>m.person===member)!;m.agents=['art'];}))();
 const token=(role:string,person?:string)=>{const secret=randomBytes(32).toString('hex');auth.tokens.change(ts=>ts.push({role,...(person?{member:person}:{}),sha256:hash(secret),label:role,created:new Date(clock.now()).toISOString()}));return secret;};
 const owner=token('owner'),runner=token('runner:a'),unbound=token('agent:art');
 app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'a',active:true},'enable');
 app.db.transaction(()=>{const store=runtimeStore(app.db);store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());store.put('box',{id:'a',name:'A',owner:'jonathan',local:true,mayHost:'*',lentTo:member==='jonathan'?[]:['art'],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());})();
 const cookie=auth.createSession(hash(member==='jonathan'?owner:token('owner',member)));
 let ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${cookie}`,origin:app.url}});await once(ws,'open');cleanups.push(()=>ws.terminate());
 const socket=(name:string,input:unknown)=>new Promise<Result>(resolve=>{const request=`socket-${++n}`;const receive=(raw:unknown)=>{const message=JSON.parse(String(raw));if(message.kind==='result'&&message.request===request){ws.off('message',receive);resolve(message.result);}};ws.on('message',receive);ws.send(JSON.stringify({kind:'call',name,input,id:request,request}));});
 const post=async(secret:string,name:string,input:unknown)=>{const [piece,op]=name.split('.');const r=await fetch(`${app.url}/api/${piece}/${op}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id:`http-${++n}`})});return r.json() as Promise<Result>;};
 const queued=async()=>{
  let jobs:string[]=[];
  for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await post(runner,'runtime.claimableJobs',{})).jobs;
  expect(jobs).toHaveLength(1);return jobs[0];
 };
 const open=async()=>{const r=await socket('comms.open',{agent:'art',id:'abcdefghijklmnop',text:'PRIVATE inbound sentinel'});expect(r.ok).toBe(true);return value<{thread:string}>(r).thread;};
 return {get app(){return app;},clock,home,owner,runner,unbound,socket,post,open,queued,token,async restart(){ws.terminate();await app.close();app=await startLoom({home,clock,next:true,staging,stdout:()=>{}});ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${cookie}`,origin:app.url}});await once(ws,'open');}};
}
it('runs private conversation input/reply/status through actual next auth, socket and runner API',async()=>{
 const f=await setup(),thread=await f.open();
 // Async encryption and delivery settle through the public acknowledgement and
 // authoritative claimable API, with no sleeps or process fake.
 let jobs:string[]=[];
 for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
 expect(jobs).toHaveLength(1);const job=jobs[0];
 expect(runtimeStore(f.app.db).read('job',job)).toMatchObject({state:'queued',member:'jonathan'});
 const conversation=runtimeStore(f.app.db).read('job',job)!.conversation!;
 const provenance=provenanceStore(f.app.db).read(conversation)!;
 expect(provenance).toMatchObject({agent:'art',history:{owner:true,unknown:false,owners:['jonathan'],people:[]},queue:[{sender:{kind:'person',person:'jonathan'}}]});
 expect(JSON.stringify(provenance)).not.toContain('PRIVATE');
 expect(JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).working).toBe(false);
 expect(await f.post(f.runner,'runtime.listJobs',{})).toMatchObject({ok:true,value:{records:[]}});
 expect(await f.post(f.runner,'runtime.claimJob',{job})).toMatchObject({ok:true});
 const input=await f.post(f.runner,'runtime.takeInput',{job});expect(input).toMatchObject({ok:true,value:{job,credential:expect.any(String)}});
 expect(JSON.stringify(input)).not.toContain('PRIVATE inbound');
 const body=value<{credential:string}>(input).credential;
 expect(JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).working).toBe(false);
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.runner,'runtime.reportJob',{job,state:'running'})).toMatchObject({ok:true});
 expect(provenanceStore(f.app.db).read(conversation)?.queue).toEqual([]);
 expect(provenanceStore(f.app.db).read(conversation)?.history.owners).toEqual(['jonathan']);
 expect(await f.socket('comms.messages',{thread})).toMatchObject({ok:true});
 for(const secret of [f.runner,f.owner,f.unbound,f.token('agent:art@another')])expect(await f.post(secret,'runtime.readConversation',{})).toMatchObject({ok:false});
 const wrongAgent=f.token(`agent:mark@${job}`);
 expect(await f.post(wrongAgent,'runtime.readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(wrongAgent,'runtime.reply',{id:'wrong-agent-reply',conversation:runtimeStore(f.app.db).read('job',job)!.conversation,text:'forged Mark reply'})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true,value:{thread:{working:true},messages:[expect.objectContaining({text:'PRIVATE inbound sentinel'})]}});
 expect(await f.post(body,'runtime.reply',{id:'reply-1',text:'PRIVATE outbound sentinel'})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.reply',{id:'reply-1',text:'PRIVATE outbound sentinel'})).toMatchObject({ok:true});
 const history=await f.socket('comms.messages',{thread});expect(JSON.stringify(history)).toContain('PRIVATE outbound sentinel');
 expect(await f.post(body,'runtime.conversationStatus',{state:'working'})).toMatchObject({ok:true,value:{stop:false}});
 expect(await f.socket('comms.change',{thread,action:'stop'})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.conversationStatus',{})).toMatchObject({ok:true,value:{stop:true}});
 expect(await f.post(body,'runtime.conversationStatus',{})).toMatchObject({ok:true,value:{stop:false}});
 expect(await f.socket('comms.send',{thread,id:'bcdefghijklmnopq',text:'PRIVATE second message'})).toMatchObject({ok:true});
 expect(value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs).toEqual([]);
 expect(await f.post(f.runner,'runtime.finishJob',{job,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false});
 for(const table of ['runtime_inputs','runtime_jobs','runtime_bindings','runtime_deliveries','core_operations']){
  const text=JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all());expect(text).not.toContain('PRIVATE');expect(text).not.toContain(body);
 }
});
it('holds both Comms dispatch and runner input under staging and survives restart without a second job',async()=>{
 // Opening a thread acknowledges the encrypted write, before background
 // delivery finishes decrypting it and reaches the staging gate. Hold that
 // exact boundary so a fast HTTP round trip cannot accidentally hide the race.
 let releaseDecrypt:()=>void=()=>{},entered:()=>void=()=>{};
 const decrypting=new Promise<void>(resolve=>{entered=resolve;});
 const decryptGate=new Promise<void>(resolve=>{releaseDecrypt=resolve;});
 vi.spyOn(commsCrypto,'loadKey').mockImplementation(async home=>{
  const key=await realLoadKey(home);
  return {...key,async open(blob){entered();await decryptGate;return key.open(blob);}};
 });
 const f=await setup(true);
 try {
 const thread=await f.open();await decrypting;
 expect(value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs).toEqual([]);
 const release=`comms-deliver:${thread}:1`;
 const heldDelivery=()=>f.app.db.prepare("SELECT id FROM core_effects WHERE id=? AND state='due'").get(release) as {id:string}|undefined;
 expect(heldDelivery()).toBeUndefined();
 releaseDecrypt();
 // Observe the durable effect we intend to release, rather than treating an
 // unrelated runner read as a barrier for asynchronous Comms decryption.
 await expect.poll(heldDelivery).toEqual({id:release});
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
 } finally {releaseDecrypt();}
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
 const cv=runtimeStore(f.app.db).read('job',job)!.conversation!;
 expect(await runtimeRole(f.app.operations).reply(viewer,{conversation:cv,job,id:'role-reply',text:'Private role reply'},'role-retry')).toMatchObject({ok:true});
 expect(await f.app.operations.callAsync('direct',{...viewer},'runtime.readConversation',{})).toMatchObject({ok:false,code:'denied'});
 const pending=f.app.operations.callAsync('direct',viewer,'runtime.reply',{id:'racing-revoke',text:'must not post after revoke'});
 const pendingRead=f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{});
 auth.tokens.change(tokens=>{for(const token of tokens)if(token.role===`agent:art@${job}`)token.revoked=new Date(f.clock.now()).toISOString();});
 expect(await pending).toMatchObject({ok:false});
 expect(await pendingRead).toMatchObject({ok:false});
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
 const delivery=`comms-deliver:${thread}:1`;
 await expect.poll(()=>f.app.db.prepare("SELECT id FROM core_effects WHERE id=? AND state='due'").get(delivery)).toEqual({id:delivery});
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
it('rechecks hosting, house, linkage and ownership during read and reply crypto',async()=>{
 for(const drift of ['hosting','house','linkage','ownership'] as const){
  const f=await setup();await f.open();let jobs:string[]=[];
  for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
  const job=jobs[0];await f.post(f.runner,'runtime.claimJob',{job});
  const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
  await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
  const viewer=signin(f.app).token(hash(body))!.viewer;
  const pending=f.app.operations.callAsync('direct',viewer,'runtime.reply',{id:'drift-reply',text:'must not post after drift'});
  const pendingRead=f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{});
  f.app.db.transaction(()=>{const store=runtimeStore(f.app.db);
   if(drift==='hosting'){const {changedAt:_,...box}=store.read('box','a')!;store.put('box',{...box,mayHost:[]},f.clock.now());}
   else if(drift==='house'){const {changedAt:_,...settings}=store.read('settings','art')!;store.put('settings',{...settings,house:{repo:'/changed',houseFile:'house.json'}},f.clock.now());}
   else if(drift==='linkage'){const cv=store.read('job',job)!.conversation!;const {changedAt:_,...binding}=store.read('binding',cv)!;store.put('binding',{...binding,job:'different-job'},f.clock.now());}
   else {const h=new HouseholdDatabase(f.app.db).household(f.home)!;new HouseholdDatabase(f.app.db).replace(f.home,{v:1,agents:h.agents,owner:'pollock',members:[{person:'pollock',role:'owner',agents:'*'},{person:'jonathan',role:'member',agents:[]}]});}
  })();
  expect(await pending).toMatchObject({ok:false,code:'denied'});
  expect(await pendingRead).toMatchObject({ok:false,code:'denied'});
  expect(f.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE id='drift-reply'").get()).toEqual({n:0});
 }
});

it('follows an authorized thread filing change without losing delivery or creating another active job',async()=>{
 // Force delivery settlement to overlap a body read. Reads deliberately reject
 // a changed encrypted-page snapshot; sending acknowledges persistence, not delivery.
 const original=commsCrypto.loadKey;let overlap=false,opens=0;
 let releaseDelivery:()=>void=()=>{},releaseRead:()=>void=()=>{},readStarted:()=>void=()=>{};
 const deliveryGate=new Promise<void>(r=>{releaseDelivery=r;}),readGate=new Promise<void>(r=>{releaseRead=r;}),reading=new Promise<void>(r=>{readStarted=r;});
 vi.spyOn(commsCrypto,'loadKey').mockImplementation(async home=>{
  const key=await original(home);return {...key,async open(blob){
   if(overlap){if(++opens===1)await deliveryGate;else {readStarted();await readGate;}}
   return key.open(blob);
  }};
 });
 const f=await setup();cleanups.push(()=>{overlap=false;releaseDelivery();releaseRead();});
 const thread=await f.open();let jobs:string[]=[];
 for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
 const job=jobs[0];await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 f.app.db.exec("CREATE TRIGGER fail_refile BEFORE UPDATE ON runtime_bindings BEGIN SELECT RAISE(ABORT,'filing interrupted'); END");
 expect(await f.socket('comms.change',{thread,action:'project',project:'pond'})).toMatchObject({ok:false});
 expect(runtimeStore(f.app.db).read('job',job)?.project).toBeUndefined();
 expect(JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).project).toBeUndefined();
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true});
 f.app.db.exec('DROP TRIGGER fail_refile');
 expect(await f.socket('comms.change',{thread,action:'project',project:'pond'})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.reply',{id:'after-filing',text:'Reply immediately after filing'})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.conversationStatus',{})).toMatchObject({ok:true});
 overlap=true;
 expect(await f.socket('comms.send',{thread,id:'cdefghijklmnopqr',text:'PRIVATE after filing'})).toMatchObject({ok:true});
 const concurrentRead=f.post(body,'runtime.readConversation',{});
 try {
  expect(await Promise.race([reading.then(()=>({started:true})),concurrentRead.then(result=>({completed:result}))])).toEqual({started:true});
  releaseDelivery();
  await expect.poll(()=>f.app.db.prepare("SELECT json_extract(record,'$.delivery') AS delivery FROM comms_messages WHERE id=?").get('cdefghijklmnopqr')).toEqual({delivery:'delivered'});
 } finally {overlap=false;releaseDelivery();releaseRead();}
 expect(await concurrentRead).toMatchObject({ok:false,code:'conflict',message:'Thread changed; load this page again'});
 const read=await f.post(body,'runtime.readConversation',{});expect(read).toMatchObject({ok:true});expect(JSON.stringify(read)).toContain('PRIVATE after filing');
 expect(runtimeStore(f.app.db).read('job',job)?.project).toBe('pond');
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
 const cv=runtimeStore(f.app.db).read('job',job)!.conversation!;
 expect(runtimeStore(f.app.db).read('binding',cv)?.project).toBe('pond');
});

it('does not turn another message into a second execution for an uncertain accepted job',async()=>{
 const f=await setup(),thread=await f.open();let jobs:string[]=[];
 for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
 const job=jobs[0];
 f.app.db.transaction(()=>{const store=runtimeStore(f.app.db),{changedAt:_,...before}=store.read('job',job)!;store.put('job',{...before,state:'uncertain'},f.clock.now());})();
 expect(await f.socket('comms.send',{thread,id:'defghijklmnopqrs',text:'New message while uncertain'})).toMatchObject({ok:true});
 expect(value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs).toEqual([]);
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
});


it('publishes a fenced final-start failure and retries only the member-selected generation',async()=>{
 const f=await setup(),thread=await f.open();const job=await f.queued();expect(job).toBeTruthy();
 expect(await f.socket('comms.retryStart',{thread,seq:1,generation:0})).toMatchObject({ok:false});
 expect(await f.post(f.runner,'runtime.claimJob',{job})).toMatchObject({ok:true});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 // Receipt rollback must not authorize Retry or leave an outcome marker.
 f.app.db.exec("CREATE TRIGGER fail_finish BEFORE INSERT ON core_operations WHEN NEW.name='runtime.finishJob' BEGIN SELECT RAISE(ABORT,'interrupted'); END");
 expect(await f.post(f.runner,'runtime.finishJob',{job,state:'failed',startFailure:'not-started'})).toMatchObject({ok:false});
 expect(runtimeStore(f.app.db).read('job',job)).toMatchObject({state:'starting'});
 expect(runtimeStore(f.app.db).read('job',job)?.startFailed).toBeUndefined();
 expect(signin(f.app).token(hash(body))).toBeDefined();
 expect(await f.socket('comms.retryStart',{thread,seq:1,generation:0})).toMatchObject({ok:false});
 f.app.db.exec('DROP TRIGGER fail_finish');
 expect(await f.post(f.runner,'runtime.finishJob',{job,state:'failed',startFailure:'not-started'})).toMatchObject({ok:true});
 expect(runtimeStore(f.app.db).read('job',job)).toMatchObject({state:'failed',startFailed:true});
 expect(signin(f.app).token(hash(body))).toBeUndefined();
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false});
 expect(await f.post(f.runner,'runtime.reportJob',{job,state:'running'})).toMatchObject({ok:false});
 let history:Result=await f.socket('comms.messages',{thread});
 for(let i=0;i<15&&!JSON.stringify(history).includes('start-failed');i++)history=await f.socket('comms.messages',{thread});
 expect(JSON.stringify(history)).toContain('start-failed');
 expect(await f.socket('comms.send',{thread,id:'fghijklmnopqrstu',text:'Another message after the fenced failure'})).toMatchObject({ok:true});
 expect(value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs).toEqual([]);
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
 expect(await f.socket('comms.retryStart',{thread,seq:1,generation:0})).toMatchObject({ok:true});
 const retry=await f.queued();expect(retry).not.toBe(job);
 expect(await f.socket('comms.retryStart',{thread,seq:1,generation:1})).toMatchObject({ok:false});
 expect(await f.socket('comms.retryStart',{thread,seq:1,generation:0})).toMatchObject({ok:false});
 // Startup replays the old failure, which must not authorize generation 1.
 await f.restart();
 expect(await f.post(f.runner,'runtime.claimJob',{job:retry})).toMatchObject({ok:true});
 const retryBody=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job:retry})).credential;
 expect(await f.post(f.runner,'runtime.reportJob',{job:retry,state:'running'})).toMatchObject({ok:true});
 expect(await f.post(retryBody,'runtime.readConversation',{})).toMatchObject({ok:true,value:{thread:{working:true}}});
 expect(await f.post(f.runner,'runtime.finishJob',{job:retry,state:'failed',startFailure:'not-started'})).toMatchObject({ok:false});
 expect(await f.post(f.runner,'runtime.finishJob',{job:retry,state:'failed'})).toMatchObject({ok:true});
 expect(runtimeStore(f.app.db).read('job',retry)?.startFailed).toBeUndefined();
 expect(runtimeStore(f.app.db).ids('job')).toHaveLength(2);
});

it('recovers a committed final-start failure after restart without creating another execution',async()=>{
 const f=await setup(),thread=await f.open();const job=await f.queued();await f.post(f.runner,'runtime.claimJob',{job});
 // Model a committed terminal outcome whose after-commit observer never ran.
 f.app.db.transaction(()=>{const store=runtimeStore(f.app.db),{changedAt:_,...before}=store.read('job',job)!;store.put('job',{...before,state:'failed',startFailed:true,endedAt:f.clock.now()},f.clock.now());})();
 await f.restart();
 // Real authenticated read also waits for startup's async encrypted notice.
 const read=await f.post(f.owner,'runtime.claimableJobs',{});expect(read.ok).toBe(false);
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
 // Only encrypted Comms rows contain the notice; no private text in metadata.
 for(let i=0;i<15;i++){
  if(f.app.db.prepare("SELECT 1 FROM comms_messages WHERE thread=? AND id='start:1'").get(thread))break;
  await f.post(f.runner,'runtime.claimableJobs',{});
 }
 expect(f.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE thread=? AND id='start:1'").get(thread)).toEqual({n:1});
 await f.restart();await f.post(f.runner,'runtime.claimableJobs',{});
 expect(f.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE thread=? AND id='start:1'").get(thread)).toEqual({n:1});
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
});


it('keeps ordinary failed claims uncertain and rejects final-start attestations after confirmation',async()=>{
 const f=await setup(),thread=await f.open();const job=await f.queued();await f.post(f.runner,'runtime.claimJob',{job});
 expect(await f.post(f.runner,'runtime.finishJob',{job,state:'done',startFailure:'not-started'})).toMatchObject({ok:false});
 expect(await f.post(f.runner,'runtime.finishJob',{job,state:'failed'})).toMatchObject({ok:true});
 expect(runtimeStore(f.app.db).read('job',job)?.startFailed).toBeUndefined();
 expect(await f.socket('comms.send',{thread,id:'efghijklmnopqrst',text:'New message after an unconfirmed failure'})).toMatchObject({ok:true});
 expect(value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs).toEqual([]);
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
 await f.restart();await f.post(f.runner,'runtime.claimableJobs',{});
 expect(f.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE id='start:1'").get()).toEqual({n:0});
});


it('accepts final-start attestations only from the assigned authenticated runner',async()=>{
 const f=await setup();await f.open();const job=await f.queued();await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 f.app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'b',active:true},'enable-other');
 const before=runtimeStore(f.app.db).read('job',job);
 for(const secret of [f.owner,f.unbound,body,f.token('runner:b')]){
  const receipts=f.app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name='runtime.finishJob'").get();
  expect(await f.post(secret,'runtime.finishJob',{job,state:'failed',startFailure:'not-started'})).toMatchObject({ok:false,code:'denied'});
  expect(runtimeStore(f.app.db).read('job',job)).toEqual(before);
  expect(signin(f.app).token(hash(body))).toBeDefined();
  expect(f.app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE name='runtime.finishJob'").get()).toEqual(receipts);
 }
});


it('echoes generation one failure and rejects stale retry after restart reconciliation',async()=>{
 const f=await setup(),thread=await f.open();const first=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job:first});
 await f.post(f.runner,'runtime.finishJob',{job:first,state:'failed',startFailure:'not-started'});
 let retry:Result={ok:false,code:'conflict',message:'pending'};
 for(let i=0;i<15&&!retry.ok;i++)retry=await f.socket('comms.retryStart',{thread,seq:1,generation:0});
 expect(retry.ok).toBe(true);
 const second=await f.queued();await f.post(f.runner,'runtime.claimJob',{job:second});
 expect(await f.post(f.runner,'runtime.finishJob',{job:second,state:'failed',startFailure:'not-started'})).toMatchObject({ok:true});
 await f.restart();
 let history:Result=await f.socket('comms.messages',{thread});
 for(let i=0;i<15&&!JSON.stringify(history).includes('"generation":1');i++)history=await f.socket('comms.messages',{thread});
 expect(JSON.stringify(history)).toContain('"generation":1');
 expect(await f.socket('comms.retryStart',{thread,seq:1,generation:0})).toMatchObject({ok:false});
 expect(await f.socket('comms.retryStart',{thread,seq:1,generation:1})).toMatchObject({ok:true});
 expect(await f.queued()).not.toBe(second);
 expect(runtimeStore(f.app.db).ids('job')).toHaveLength(3);
});

for(const boundary of ['scope','generation'] as const)it(`fences a runtime failure notice when ${boundary} changes during encryption`,async()=>{
 const original=commsCrypto.loadKey;let pause=false,release:()=>void=()=>{},began:()=>void=()=>{};
 const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
 vi.spyOn(commsCrypto,'loadKey').mockImplementation(async home=>{
  const key=await original(home);
  return {...key,seal:async words=>{
   if(pause&&JSON.parse(words).step?.error==='start-failed'){began();await waiting;}
   return key.seal(words);
  }};
 });
 const f=await setup(),thread=await f.open();cleanups.push(release);
 const job=await f.queued();await f.post(f.runner,'runtime.claimJob',{job});pause=true;
 expect(await f.post(f.runner,'runtime.finishJob',{job,state:'failed',startFailure:'not-started'})).toMatchObject({ok:true});
 await started;
 if(boundary==='generation')f.app.db.prepare("UPDATE comms_messages SET record=json_set(record,'$.generation',1) WHERE thread=? AND seq=1").run(thread);
 else f.app.db.prepare("UPDATE comms_threads SET record=json_set(record,'$.project','pond') WHERE id=?").run(thread);
 release();await f.restart();
 expect(f.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE thread=? AND id='start:1'").get(thread)).toEqual({n:0});
 expect(await f.socket('comms.retryStart',{thread,seq:1,generation:boundary==='generation'?1:0})).toMatchObject({ok:false});
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
});


it('derives Approval caller only from the live authenticated body and database membership, across restart',async()=>{
 for(const member of ['jonathan','pollock']){
  const f=await setup(false,member),thread=await f.open(),job=await f.queued();
  await f.post(f.runner,'runtime.claimJob',{job});
  const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
  await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
  const cv=runtimeStore(f.app.db).read('job',job)!.conversation!;
  const ask={kind:'github-write',target:'repo:exact',what:'Write this change',why:'A bounded fixture',conversation:cv,
   principal:'owner',for:'owner',who:{agent:'mark',where:'forged (owner)'},caller:{who:{agent:'art',where:'forged'},for:'owner'},project:'other',people:['jonathan']};
  const expected={for:member==='jonathan'?'owner':member,member,people:[member],conversation:cv,who:{agent:'art',where:job}};
  const receipt=value<{id:string}>(await f.post(body,'approvals.request',ask));
  expect(receipt).toMatchObject({id:expect.any(String),state:'pending'});
  expect(JSON.stringify(receipt)).not.toContain('repo:exact');
  expect(readApproval(f.app.db,receipt.id)).toMatchObject(expected);
  expect(receipt).not.toHaveProperty('project');
  // Shared agent credentials, another job, and a copied Viewer have no principal.
  for(const secret of [f.unbound,f.token('agent:art@another')]){
   const other=value<{for:string}>(await f.post(secret,'approvals.request',{...ask,target:'unknown:'+secret.slice(0,8)}));
   expect(other).toMatchObject({for:'?'});expect(other).not.toHaveProperty('conversation');
  }
  const original=signin(f.app).token(hash(body))!.viewer;
  const copied=value<{for:string}>(f.app.operations.call('direct',{...original},'approvals.request',{...ask,target:'copy:viewer'},'copy-viewer'));
  expect(copied.for).toBe('?');
  await f.restart();
  expect(await f.post(body,'approvals.request',{...ask,target:'after:restart'})).toMatchObject({ok:true,value:{id:expect.any(String),state:'pending'}});
  // Filing propagates scope from the actual current binding; input cannot choose it.
  expect(await f.socket('comms.change',{thread,action:'project',project:'pond'})).toMatchObject({ok:true});
  expect(await f.post(body,'approvals.request',{...ask,target:'after:filing'})).toMatchObject({ok:true,value:{id:expect.any(String),state:'pending'}});
  // Authority remains tied to current household membership, never saved request data.
  f.app.db.transaction(()=>new HouseholdDatabase(f.app.db).change(f.home,raw=>{
   const members=raw.members as Array<{person:string;role:string;agents:string[]|string}>;const m=members.find(m=>m.person===member)!;m.agents=[];m.role='member';if(member==='jonathan'){const other=members.find(m=>m.person==='pollock')!;other.role='owner';other.agents='*';}
  }))();
  expect(await f.post(body,'approvals.request',{...ask,target:'after:removal'})).toMatchObject({ok:true,value:{for:'?',who:{agent:'art'}}});
  expect(await f.post(body,'approvals.use',{id:receipt.id,kind:ask.kind,target:ask.target})).toMatchObject({ok:false});
 }
});
it('retains centrally authenticated service-house spend identity and fences stale body bindings',async()=>{
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});await f.post(f.runner,'runtime.takeInput',{job});
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const service=f.token(`agent:art/discord@${job}`),other=f.token(`agent:art/slack@${job}`);
 const ask={kind:'github-write',target:'service:exact',what:'Write a fixture',why:'Exercise exact service binding'};
 const receipt=value<{id:string}>(await f.post(service,'approvals.request',ask));
 expect(readApproval(f.app.db,receipt.id)).toMatchObject({for:'owner',member:'jonathan',who:{agent:'art',where:`${job} (discord)`}});
 expect(await f.socket('approvals.answer',{id:receipt.id,action:'allow'})).toMatchObject({ok:true,value:{state:'allowed'}});
 const ack=await f.post(service,'approvals.command',{argv:['request','--kind',ask.kind,'--target',ask.target,'--what',ask.what,'--why',ask.why]});
 expect(ack).toMatchObject({ok:true,value:{exit:0,stdout:`${receipt.id}: allowed; open the decision in your signed-in window\n`}});
 expect(JSON.stringify(ack)).not.toContain(ask.target);
 expect(await f.post(other,'approvals.use',{id:receipt.id,kind:ask.kind,target:ask.target})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(service,'approvals.use',{id:receipt.id,kind:ask.kind,target:ask.target})).toMatchObject({ok:false,code:'denied'});
 expect(readApproval(f.app.db,receipt.id)?.state).toBe('allowed');
 expect(await f.post(service,'approvals.use',{id:receipt.id,kind:ask.kind,target:ask.target})).toMatchObject({ok:false});
 // An archived thread no longer proves a person, even before asynchronous end work settles.
 await f.socket('comms.change',{thread,action:'archive'});
 expect(await f.post(service,'approvals.request',{...ask,target:'after:archive'})).toMatchObject({ok:false,code:'denied'});
});

it('keeps service restrictions without a job or after execution loses its binding',async()=>{
 const f=await setup();await f.open();const job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});await f.post(f.runner,'runtime.takeInput',{job});
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const discord=f.token(`agent:art/discord@${job}`),slack=f.token('agent:art/slack'),same=f.token('agent:art/discord');
 f.app.db.transaction(()=>{const store=runtimeStore(f.app.db),cv=store.read('job',job)!.conversation!,{changedAt:_,...b}=store.read('binding',cv)!;store.put('binding',{...b,job:'unbound'},f.clock.now());})();
 const ask={kind:'github-write',target:'unknown:service',what:'A restricted service write',why:'Prove fail closed spending'};
 const receipt=value<{id:string}>(await f.post(discord,'approvals.request',ask));
 expect(receipt).toMatchObject({for:'?',who:{where:`${job} (discord)`}});
 expect(await f.socket('approvals.answer',{id:receipt.id,action:'allow'})).toMatchObject({ok:true});
 expect(await f.post(slack,'approvals.use',{id:receipt.id,kind:ask.kind,target:ask.target})).toMatchObject({ok:false,code:'denied'});
 const unknown=value<{for:string}>(await f.post(slack,'approvals.request',{...ask,target:'unknown:slack',principal:'owner'}));
 expect(unknown).toMatchObject({for:'?',who:{where:'a body (slack)'}});
 expect(await f.post(same,'approvals.use',{id:receipt.id,kind:ask.kind,target:ask.target})).toMatchObject({ok:true,value:{state:'used'}});
 const viewer=signin(f.app).token(hash(slack))!.viewer;
 expect(signin(f.app).agent(viewer)).toMatchObject({agent:'art',service:'slack'});
 expect(signin(f.app).body(viewer)).toBeUndefined();expect(signin(f.app).agent({...viewer})).toBeUndefined();
 signin(f.app).tokens.change(tokens=>{tokens.find(t=>t.sha256===hash(slack))!.revoked=new Date(f.clock.now()).toISOString();});
 expect(signin(f.app).agent(viewer)).toBeUndefined();
 expect(await f.post(slack,'approvals.request',{...ask,target:'revoked:service'})).toMatchObject({ok:false,code:'denied'});
});

it('removes archived conversation authority while staging retains a live job and credential',async()=>{
 const f=await setup(true),thread=await f.open();
 await f.post(f.runner,'runtime.claimableJobs',{});
 const delivery=`comms-deliver:${thread}:1`;
 await expect.poll(()=>f.app.db.prepare("SELECT id FROM core_effects WHERE id=? AND state='due'").get(delivery)).toEqual({id:delivery});
 expect(await f.post(f.owner,'core.releaseEffect',{id:delivery})).toMatchObject({ok:true});
 const job=await f.queued();
 expect(await f.post(f.runner,'runtime.claimJob',{job})).toMatchObject({ok:true});
 expect(await f.post(f.runner,'runtime.takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
 expect(await f.post(f.owner,'core.releaseEffect',{id:`runtime:input:${job}`})).toMatchObject({ok:true});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 expect(await f.post(f.runner,'runtime.reportJob',{job,state:'running'})).toMatchObject({ok:true});
 expect(await f.socket('comms.change',{thread,action:'project',project:'pond'})).toMatchObject({ok:true});
 const conversation=runtimeStore(f.app.db).read('job',job)!.conversation!;
 const ask={kind:'github-write',target:'before:archive',what:'Check current conversation',why:'Prove archived thread fencing',conversation};
 expect(await f.post(body,'approvals.request',ask)).toMatchObject({ok:true,value:{id:expect.any(String),state:'pending'}});
 expect(await f.socket('comms.change',{thread,action:'archive'})).toMatchObject({ok:true});
 expect(runtimeStore(f.app.db).read('job',job)).toMatchObject({state:'running'});
 expect(signin(f.app).token(hash(body))).toBeDefined();
 const receipt=value<Record<string,unknown>>(await f.post(body,'approvals.request',{...ask,target:'after:archive',principal:'owner',project:'pond'}));
 expect(receipt).toMatchObject({for:'?',who:{agent:'art',where:job}});
 for(const field of ['conversation','project','people'])expect(receipt).not.toHaveProperty(field);
});

it('removes terminal job principal authority even when its credential and private binding remain valid',async()=>{
 const f=await setup();await f.open();const job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const store=runtimeStore(f.app.db),conversation=store.read('job',job)!.conversation!;
 const ask={kind:'github-write',target:'running:principal',what:'Check a current job',why:'Test terminal job attribution',conversation};
 expect(await f.post(body,'approvals.request',ask)).toMatchObject({ok:true,value:{id:expect.any(String),state:'pending'}});
 for(const state of ['done','failed','stopped','lost','uncertain','queued','starting'] as const){
  // Model durable state ahead of credential cleanup. Calling finishJob would
  // revoke the token as well and could conceal a missing resolver state check.
  f.app.db.transaction(()=>{const {changedAt:_,...record}=store.read('job',job)!;store.put('job',{...record,state},f.clock.now());})();
  expect(signin(f.app).token(hash(body))).toBeDefined();
  expect(store.read('binding',conversation)).toMatchObject({job,member:'jonathan'});
  const receipt=value<Record<string,unknown>>(await f.post(body,'approvals.request',{...ask,target:state+':principal',principal:'owner'}));
  expect(receipt).toMatchObject({for:'?',who:{agent:'art',where:job}});
  for(const field of ['people','conversation','project'])expect(receipt).not.toHaveProperty(field);
 }
});

it('composes Clock local filing and approval-only recovery from the exact running private body, returning acknowledgements only',async()=>{
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const prompt='<!-- house: local -->\nInspect host disk usage.',note='PRIVATE LOCAL EXACT note';
 const input={agent:'art',prompt,note};
 for(const secret of [f.owner,f.runner,f.unbound,f.token('agent:art@another')]) expect(await f.post(secret,'clock.requestLocal',input)).toMatchObject({ok:false});
 expect(await f.post(body,'clock.requestLocal',{...input,caller:{for:'owner'},member:'jonathan'})).toMatchObject({ok:false});
 const before=f.app.db.prepare('SELECT record FROM approvals_approvals').all();
 for(const extra of [['--standing'],['--model','other'],['--slot','other'],['--continuation','opaque'],['--place','local']]) {
  const result=await f.post(body,'clock.command',{agent:'art',argv:['in','1h','-p',prompt,...extra]});
  expect(result).toMatchObject({ok:true,value:{exit:1}});
  expect(f.app.db.prepare('SELECT record FROM approvals_approvals').all()).toEqual(before);
  expect(wakes(f.app.db)).toHaveLength(0);
 }
 const card=value<{id:string;state:string}>(await f.post(body,'clock.requestLocal',input));
 expect(Object.keys(card).sort()).toEqual(['id','state']);
 expect(readApproval(f.app.db,card.id)).toMatchObject({member:'jonathan',people:['jonathan'],conversation:runtimeStore(f.app.db).read('job',job)!.conversation});
 expect(wakes(f.app.db)).toHaveLength(0);
 expect(await f.post(body,'clock.recoverLocal',{agent:'art',approval:card.id,when:'1h',mode:'in'})).toMatchObject({ok:false});
 value(await f.socket('approvals.answer',{id:card.id,action:'allow'}));
 await f.restart();
 const ack=value<{id:string;due:number}>(await f.post(body,'clock.recoverLocal',{agent:'art',approval:card.id,when:'1h',mode:'in'}));
 expect(Object.keys(ack).sort()).toEqual(['due','id']);
 expect(wakes(f.app.db)).toEqual([expect.objectContaining({id:ack.id,prompt,note,member:'jonathan',agent:'art',by:{kind:'agent',id:'art'}})]);
 expect(JSON.stringify(exportDatabase(f.app.db))).not.toContain(note);
 const command=value<{exit:number;stdout:string}>(await f.post(body,'clock.command',{agent:'art',argv:['in','1h','-p',prompt+' Again','--note','COMMAND PRIVATE']}));
 expect(command).toMatchObject({exit:0,stdout:expect.stringContaining('nothing armed')});
 const second=command.stdout.match(/a-[0-9a-f]{8}/)![0];
 value(await f.socket('approvals.answer',{id:second,action:'allow'}));
 const original=signin(f.app).token(hash(body))!.viewer;
 const localCommand={agent:'art',argv:['in','1h','--approval',second]};
 const recoveredResult=f.app.operations.call('http',original,'clock.command',localCommand,'local-history-independent');
 const recovered=value<{exit:number;stdout:string}>(recoveredResult);
 expect(recovered).toMatchObject({exit:0,stdout:expect.stringContaining('will wake at')});
 expect(JSON.stringify(recovered)).not.toContain('COMMAND PRIVATE');
 expect(wakes(f.app.db)).toHaveLength(2);
 f.app.db.prepare('DELETE FROM runtime_provenance WHERE conversation=?').run(runtimeStore(f.app.db).read('job',job)!.conversation);
 expect(f.app.operations.call('http',original,'clock.command',localCommand,'local-history-independent')).toEqual(recoveredResult);
 expect(await f.post(body,'clock.list',{agent:'art'})).toMatchObject({ok:true,value:[]});
 expect(await f.socket('clock.list',{agent:'art'})).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({prompt,note})])});
});
it('refuses private non-owner local public requests without publishing a card',async()=>{
 const f=await setup(false,'pollock');await f.open();const job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 expect(await f.post(body,'clock.command',{argv:['in','1h','-p','<!-- house: local --> Inspect host','--note','PRIVATE REFUSED'],agent:'art'})).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT count(*) AS n FROM approvals_approvals').get()).toEqual({n:0});
 expect(wakes(f.app.db)).toHaveLength(0);
});

it('recovers standing private work through the public body command without returning words or replaying after receipt expiry',async()=>{
 const f=await setup();const thread=await f.open();const job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 value(await f.socket('comms.change',{thread,action:'project',project:'pond'}));
 const card=value<{id:string}>(await f.post(body,'clock.requestLocal',{agent:'art',prompt:'<!-- house: local --> Inspect disk',note:'PRIVATE STANDING'}));
 value(await f.socket('approvals.every-time',{id:card.id}));
 const original=signin(f.app).token(hash(body))!.viewer;
 const beforeRestrictions=f.app.db.prepare('SELECT record FROM approvals_rules').all();
 for(const extra of [['--model','other'],['--slot','other'],['--continuation','opaque'],['--place','local'],['-f','routines/host.md']]) {
  expect(await f.post(body,'clock.command',{agent:'art',argv:['in','1h','--approval',card.id,'--standing',...extra]})).toMatchObject({ok:true,value:{exit:1}});
  expect(f.app.db.prepare('SELECT record FROM approvals_rules').all()).toEqual(beforeRestrictions);
  expect(wakes(f.app.db)).toHaveLength(0);
 }
 const input={agent:'art',approval:card.id,mode:'in',when:'1h',standing:true};
 const first=f.app.operations.call('http',original,'clock.recoverLocal',input,'standing-public');value(first);
 // Expires only the ordinary core receipt; the private owning receipt must remain.
 f.app.db.prepare("DELETE FROM core_operations WHERE id='standing-public'").run();
 expect(f.app.operations.call('http',original,'clock.recoverLocal',input,'standing-public')).toEqual(first);
 expect(f.app.operations.call('http',original,'clock.in',{agent:'art',prompt:'new',note:'',when:'2h'},'standing-public')).toMatchObject({ok:false,code:'conflict'});
 expect(wakes(f.app.db)).toHaveLength(1);
 expect(JSON.stringify(first)).not.toContain('PRIVATE STANDING');
 expect(await f.post(body,'clock.command',{agent:'art',argv:['in','1h','--approval',card.id,'--standing']})).toMatchObject({ok:true,value:{exit:1}});
 value(await f.socket('clock.cancel',{id:value<{id:string}>(first).id}));
 const commandInput={agent:'art',argv:['in','1h','--approval',card.id,'--standing']};
 const command=f.app.operations.call('http',original,'clock.command',commandInput,'command-standing');
 expect(command).toMatchObject({ok:true,value:{exit:0,stdout:expect.stringContaining('will wake at')}});
 f.app.db.prepare("DELETE FROM core_operations WHERE id='command-standing'").run();
 expect(f.app.operations.call('http',original,'clock.command',commandInput,'command-standing')).toEqual(command);
 expect(wakes(f.app.db)).toHaveLength(2);
 expect(f.app.operations.call('http',original,'clock.in',{agent:'art',prompt:'new',note:'',when:'2h'},'command-standing')).toMatchObject({ok:false,code:'conflict'});
 expect(f.app.operations.call('direct',{...original},'clock.requestLocal',{agent:'art',prompt:'<!-- house: local --> Copy proof',note:''},'copied-local-viewer')).toMatchObject({ok:false});
 const exported=JSON.stringify(exportDatabase(f.app.db));
 expect(exported).not.toContain('command-standing');expect(exported).not.toContain('standing-public');
 const replayDenied=()=>{
  for(const expired of [false,true]){
   if(expired)f.app.db.prepare("DELETE FROM core_operations WHERE id IN ('standing-public','command-standing')").run();
   expect(f.app.operations.call('http',original,'clock.recoverLocal',input,'standing-public')).toMatchObject({ok:false,code:'denied'});
   expect(f.app.operations.call('http',original,'clock.command',commandInput,'command-standing')).toMatchObject({ok:false,code:'denied'});
  }
 };
 const builtin=services.builtinServices;
 const spy=vi.spyOn(services,'builtinServices').mockImplementation(db=>{const s=builtin(db);return {...s,clock:{...s.clock,operations:s.clock.operations.filter(n=>n!=='approvals.piece-standing-local')}};});
 replayDenied();spy.mockRestore();
 f.app.db.transaction(()=>new SharingDatabase(f.app.db,f.home).setAgents('pond',[]))();
 replayDenied();

});

it('gives Clock capacity only to a current owning conversation, never copied proof or a public job conversation string',async()=>{
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const conversation=runtimeStore(f.app.db).read('job',job)!.conversation!;
 const input={agent:'art',when:'1h',prompt:'Ordinary future work',note:''};
 const first=value<{id:string}>(await f.post(body,'clock.in',{...input,conversation:'forged',apiCapacity:{origin:'other',bucket:'forged'}}));
 const bucket=wakes(f.app.db).find(w=>w.id===first.id)!.apiCapacity!.bucket;
 expect(bucket).toMatch(/^[a-f0-9]{64}$/);expect(bucket).not.toBe(conversation);
 expect(first).toEqual({id:first.id,due:f.clock.now()+3600_000,state:'pending',private:true});
 expect(wakes(f.app.db).find(w=>w.id===first.id)).toMatchObject({member:'jonathan',authorship:{origin:'art',conversation,member:'jonathan',principal:{for:'owner',people:['jonathan']}}});
 expect(JSON.stringify(await f.post(body,'clock.list',{}))).not.toContain('Ordinary future work');
 expect(JSON.stringify(exportDatabase(f.app.db))).not.toContain(first.id);
 const viewer=signin(f.app).token(hash(body))!.viewer;
 const copy=value<{id:string}>(f.app.operations.call('direct',{...viewer},'clock.in',input,'capacity-copy'));
 expect(wakes(f.app.db).find(w=>w.id===copy.id)?.apiCapacity).toEqual({origin:'art'});
 for(let n=0;n<19;n++)expect(await f.post(f.unbound,'clock.in',input)).toMatchObject({ok:true});
 expect(await f.post(f.unbound,'clock.in',input)).toMatchObject({ok:false,code:'invalid'});
 // This public start is member-free. Its conversation argument cannot bind it
 // to the private job that owns that Comms thread, even once it is running.
 const forged=value<{job:string}>(await f.post(f.owner,'runtime.startBody',{agent:'art',conversation,brief:'Ordinary public job',title:'Public start'})).job;
 expect(await f.post(f.runner,'runtime.claimJob',{job:forged})).toMatchObject({ok:true});
 expect(await f.post(f.runner,'runtime.takeInput',{job:forged})).toMatchObject({ok:true});
 expect(await f.post(f.runner,'runtime.reportJob',{job:forged,state:'running'})).toMatchObject({ok:true});
 const other=f.token(`agent:art@${forged}`);
 expect(await f.post(other,'clock.in',input)).toMatchObject({ok:false,code:'invalid',message:expect.stringContaining('20 API-origin')});
 expect(await f.post(body,'clock.in',input)).toMatchObject({ok:true});
 await f.restart();
 const after=value<{id:string}>(await f.post(body,'clock.in',input));
 expect(wakes(f.app.db).find(w=>w.id===after.id)?.apiCapacity?.bucket).toBe(bucket);
 // Drift ahead of credential cleanup cannot keep a private share alive.
 const store=runtimeStore(f.app.db),binding=store.read('binding',conversation)!;
 f.app.db.prepare("UPDATE runtime_bindings SET record=json_set(record,'$.job','another-job') WHERE id=?").run(conversation);
 expect(await f.post(body,'clock.in',input)).toMatchObject({ok:false,code:'invalid'});
 f.app.db.transaction(()=>{const {changedAt:_,...before}=binding;store.put('binding',before,f.clock.now());})();
 expect(await f.post(body,'clock.in',input)).toMatchObject({ok:true});
 expect(await f.socket('comms.change',{thread,action:'archive'})).toMatchObject({ok:true});
 expect(await f.post(body,'clock.in',input)).toMatchObject({ok:false});
});

it('shares the proven one-off quota with private local recovery and refuses before spending its approval',async()=>{
 const f=await setup();await f.open();const job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 for(let n=0;n<20;n++)expect(await f.post(body,'clock.in',{agent:'art',when:'1h',prompt:'Future work',note:''})).toMatchObject({ok:true});
 const bucket=wakes(f.app.db)[0].apiCapacity!.bucket;
 const card=value<{id:string}>(await f.post(body,'clock.requestLocal',{agent:'art',prompt:'<!-- house: local --> Inspect disk',note:'PRIVATE capacity'}));
 value(await f.socket('approvals.answer',{id:card.id,action:'allow'}));
 const recovery={agent:'art',approval:card.id,mode:'in',when:'1h'};
 expect(await f.post(body,'clock.recoverLocal',recovery)).toMatchObject({ok:false,code:'invalid',message:expect.stringContaining('20 API-origin')});
 expect(readApproval(f.app.db,card.id)?.state).toBe('allowed');expect(wakes(f.app.db)).toHaveLength(20);
 value(await f.socket('clock.cancel',{id:wakes(f.app.db)[0].id}));
 const recovered=value<{id:string}>(await f.post(body,'clock.recoverLocal',recovery));
 expect(wakes(f.app.db).find(w=>w.id===recovered.id)).toMatchObject({member:'jonathan',apiCapacity:{origin:'art',bucket}});
 expect(readApproval(f.app.db,card.id)?.state).toBe('used');
 expect(await f.post(body,'clock.list',{agent:'art'})).toMatchObject({ok:true,value:expect.not.arrayContaining([expect.objectContaining({id:recovered.id})])});
});


it('issues current Clock principal history only through the exact private body binding',async()=>{
 let role:ReturnType<typeof realConversationRuntime>;
 vi.spyOn(conversationModule,'conversationRuntime').mockImplementation((...args)=>role=realConversationRuntime(...args));
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 const viewer=signin(f.app).token(hash(body))!.viewer;
 expect(role!.clockProvenance(viewer)).toBeUndefined();
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const conversation=runtimeStore(f.app.db).read('job',job)!.conversation!;
 const expected={agent:'art',member:'jonathan',conversation,principal:{for:'owner',people:['jonathan']}};
 expect(role!.clockProvenance(viewer)).toEqual(expected);
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'waiting'}));
 expect(role!.clockProvenance(viewer)).toEqual(expected);
 expect(provenanceStore(f.app.db).read(conversation)?.queue).toEqual([]);
 for(const v of [{...viewer},{kind:'agent',id:'art'},{kind:'member',id:'jonathan'},{kind:'runner',id:'a'},{kind:'service',id:'clock'}] as const)
  expect(role!.clockProvenance(v)).toBeUndefined();
 const restricted=f.token(`agent:art/slack@${job}`);
 expect(role!.clockProvenance(signin(f.app).token(hash(restricted))!.viewer)).toEqual({...expected,service:'slack'});
 // A public, member-free start with the same conversation does not own it.
 const forged=value<{job:string}>(await f.post(f.owner,'runtime.startBody',{agent:'art',conversation,brief:'Public work',title:'Public'})).job;
 await f.post(f.runner,'runtime.claimJob',{job:forged});await f.post(f.runner,'runtime.takeInput',{job:forged});await f.post(f.runner,'runtime.reportJob',{job:forged,state:'running'});
 expect(role!.clockProvenance(signin(f.app).token(hash(f.token(`agent:art@${forged}`)))!.viewer)).toBeUndefined();
 // History, not the latest owner message, determines principal after steering.
 f.app.db.transaction(()=>provenanceStore(f.app.db).note(conversation,'art',{key:'unknown-source',sender:{kind:'unknown'},at:f.clock.now()},['jonathan']))();
 expect(role!.clockProvenance(viewer)).toEqual({...expected,principal:{for:'?',people:['jonathan']}});
 await f.restart();
 const current=signin(f.app).token(hash(body))!.viewer;
 expect(role!.clockProvenance(current)).toEqual({...expected,principal:{for:'?',people:['jonathan']}});
 const before=provenanceStore(f.app.db).read(conversation)!;
 f.app.db.prepare('DELETE FROM runtime_provenance WHERE conversation=?').run(conversation);
 expect(role!.capacityConversation(current)).toBe(conversation);
 expect(role!.clockProvenance(current)).toBeUndefined();
 f.app.db.transaction(()=>provenanceStore(f.app.db).put(conversation,{...before,agent:'mark'}))();
 expect(role!.clockProvenance(current)).toBeUndefined();
 f.app.db.transaction(()=>provenanceStore(f.app.db).put(conversation,before))();
 f.app.db.prepare("UPDATE runtime_bindings SET record=json_set(record,'$.job','another-job') WHERE id=?").run(conversation);
 expect(role!.clockProvenance(current)).toBeUndefined();
 // Restore the binding before archiving so that archive is an independent gate.
 f.app.db.prepare("UPDATE runtime_bindings SET record=json_set(record,'$.job',?) WHERE id=?").run(job,conversation);
 expect(role!.clockProvenance(current)).toBeDefined();
 value(await f.socket('comms.change',{thread,action:'archive'}));
 expect(role!.clockProvenance(current)).toBeUndefined();
});

it('retains Clock private project scope and re-evaluates former owners without changing local approval semantics',async()=>{
 let role:ReturnType<typeof realConversationRuntime>;
 vi.spyOn(conversationModule,'conversationRuntime').mockImplementation((...args)=>role=realConversationRuntime(...args));
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const viewer=signin(f.app).token(hash(body))!.viewer;
 value(await f.socket('comms.change',{thread,action:'project',project:'pond'}));
 expect(role!.clockProvenance(viewer)).toMatchObject({member:'jonathan',project:'pond',principal:{for:'owner',people:['jonathan']}});
 // Local approvalCaller retains the member requester, independently of history.
 const cv=runtimeStore(f.app.db).read('job',job)!.conversation!;
 f.app.db.transaction(()=>provenanceStore(f.app.db).note(cv,'art',{key:'steering',sender:{kind:'unknown'},at:f.clock.now()},['jonathan']))();
 expect(role!.clockProvenance(viewer)).toMatchObject({member:'jonathan',project:'pond',principal:{for:'?',people:['jonathan']}});
 expect(role!.approvalCaller(viewer)).toMatchObject({for:'owner',member:'jonathan',people:['jonathan'],project:'pond'});
 // Recounting current owners must not retain a former owner's broad principal.
 f.app.db.transaction(()=>{
  const source=provenanceStore(f.app.db).read(cv)!;
  provenanceStore(f.app.db).put(cv,{...source,history:{...source.history,unknown:false}});
  const store=runtimeStore(f.app.db),{changedAt:_,...box}=store.read('box','a')!;
  store.put('box',{...box,lentTo:['art']},f.clock.now());
  new HouseholdDatabase(f.app.db).change(f.home,raw=>{
   raw.owner='pollock';
   raw.members=[{person:'pollock',role:'owner',agents:'*'},{person:'jonathan',role:'member',agents:['art']}];
  });
 })();
 expect(role!.clockProvenance(viewer)).toMatchObject({member:'jonathan',project:'pond',principal:{for:'jonathan',people:['jonathan']}});
});

it.each(['credential','box','hosting','house','member','stopped'] as const)('revokes Clock provenance for a retained Viewer after %s changes',async drift=>{
 let role:ReturnType<typeof realConversationRuntime>;
 vi.spyOn(conversationModule,'conversationRuntime').mockImplementation((...args)=>role=realConversationRuntime(...args));
 const f=await setup();await f.open();const job=await f.queued();
 value(await f.post(f.runner,'runtime.claimJob',{job}));
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 const viewer=signin(f.app).token(hash(body))!.viewer;
 expect(role!.clockProvenance(viewer)).toMatchObject({agent:'art',member:'jonathan',principal:{for:'owner'}});
 const store=runtimeStore(f.app.db);
 f.app.db.transaction(()=>{
  if(drift==='credential')signin(f.app).tokens.change(rows=>{rows.splice(rows.findIndex(t=>t.sha256===hash(body)),1);});
  else if(drift==='house') {const {changedAt:_,...settings}=store.read('settings','art')!;store.put('settings',{...settings,house:{repo:'/changed',houseFile:'house.json'}},f.clock.now());}
  else if(drift==='stopped') {const {changedAt:_,...before}=store.read('job',job)!;store.put('job',{...before,state:'stopped'},f.clock.now());}
  else {
   const {changedAt:_,...box}=store.read('box','a')!;
   if(drift==='box')store.put('box',{...box,revokedAt:f.clock.now()},f.clock.now());
   else if(drift==='hosting')store.put('box',{...box,mayHost:[]},f.clock.now());
   else {
    // Retain hosting, independently remove only the member's right to Art.
    store.put('box',{...box,lentTo:['art']},f.clock.now());
    new HouseholdDatabase(f.app.db).change(f.home,raw=>{raw.owner='pollock';raw.members=[{person:'pollock',role:'owner',agents:'*'},{person:'jonathan',role:'member',agents:[]}];});
   }
  }
 })();
 expect(role!.clockProvenance(viewer)).toBeUndefined();
});

it.each(['done','failed'] as const)('clears private working immediately on runner %s without a final body heartbeat or reply',async state=>{
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true,value:{thread:{working:true}}});
 const messagesBefore=value<{messages:unknown[]}>(await f.socket('comms.messages',{thread}));
 expect(await f.post(f.runner,'runtime.finishJob',{job,state})).toMatchObject({ok:true});
 const record=JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record);
 expect(record.working).toBe(false);
 expect(await f.post(body,'runtime.conversationStatus',{state:'working'})).toMatchObject({ok:false});
 expect(value(await f.socket('comms.messages',{thread}))).toEqual(messagesBefore);
});

it('keeps working on rolled-back completion and repairs committed terminal state at startup',async()=>{
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});await f.post(f.runner,'runtime.takeInput',{job});
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const working=()=>JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).working;
 f.app.db.exec("CREATE TRIGGER fail_terminal_receipt BEFORE INSERT ON core_operations WHEN NEW.name='runtime.finishJob' BEGIN SELECT RAISE(ABORT,'interrupted'); END");
 expect(await f.post(f.runner,'runtime.finishJob',{job,state:'done'})).toMatchObject({ok:false});
 expect(working()).toBe(true);expect(runtimeStore(f.app.db).read('job',job)?.state).toBe('running');
 f.app.db.exec('DROP TRIGGER fail_terminal_receipt');
 // Model a crash after terminal commit but before its live notification.
 f.app.db.transaction(()=>{const {changedAt:_,...before}=runtimeStore(f.app.db).read('job',job)!;runtimeStore(f.app.db).put('job',{...before,state:'failed',endedAt:f.clock.now()},f.clock.now());})();
 await f.restart();expect(working()).toBe(false);
});

it('does not let an old terminal job clear a replacement binding working state',async()=>{
 const f=await setup(),thread=await f.open(),old=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job:old});await f.post(f.runner,'runtime.takeInput',{job:old});
 await f.post(f.runner,'runtime.reportJob',{job:old,state:'running'});
 const store=runtimeStore(f.app.db),job=store.read('job',old)!;
 f.app.db.transaction(()=>{
  const {changedAt:_,...before}=job;store.put('job',{...before,id:'replacement'},f.clock.now());
  const {changedAt:__,...binding}=store.read('binding',job.conversation!)!;store.put('binding',{...binding,job:'replacement'},f.clock.now());
 })();
 expect(await f.post(f.runner,'runtime.finishJob',{job:old,state:'done'})).toMatchObject({ok:false,code:'denied'});
 // A committed old completion may still have a delayed live notification.
 f.app.db.transaction(()=>{const {changedAt:_,...before}=job;store.put('job',{...before,state:'done',endedAt:f.clock.now()},f.clock.now());})();
 f.app.live.changed([{type:'runtime.job',id:old}]);
 expect(JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).working).toBe(true);
});


it('clears working on a stopped unarchived current job',async()=>{
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});await f.post(f.runner,'runtime.takeInput',{job});
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const record=()=>JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record);
 expect(record()).toMatchObject({working:true,archived:null});
 f.app.db.transaction(()=>{const {changedAt:_,...before}=runtimeStore(f.app.db).read('job',job)!;runtimeStore(f.app.db).put('job',{...before,state:'stopped',endedAt:f.clock.now()},f.clock.now());})();
 f.app.live.changed([{type:'runtime.job',id:job}]);
 expect(record()).toMatchObject({working:false,archived:null});
});

it.each(['imported','agent','member','conversation','project','venue','archived','membership'] as const)('protects %s scope on terminal notification and startup',async mismatch=>{
 const f=await setup(false,mismatch==='membership'?'pollock':'jonathan'),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});await f.post(f.runner,'runtime.takeInput',{job});
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 const store=runtimeStore(f.app.db),record=()=>JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record);
 expect(record().working).toBe(true);
 f.app.db.transaction(()=>{
  const {changedAt:_,...before}=store.read('job',job)!;
  const change=mismatch==='imported'?{imported:{history:'discard' as const}}:mismatch==='agent'?{agent:'mark'}:mismatch==='member'?{member:'pollock'}:mismatch==='conversation'?{conversation:'other'}:mismatch==='project'?{project:'pond'}:{};
  store.put('job',{...before,...change,state:'done',endedAt:f.clock.now()},f.clock.now());
  if(mismatch==='venue'){const {changedAt:__,...binding}=store.read('binding',before.conversation!)!;store.put('binding',{...binding,venue:'spawn'},f.clock.now());}
  if(mismatch==='archived'){const t=record();t.archived=f.clock.now();f.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(t),thread);}
  if(mismatch==='membership')new HouseholdDatabase(f.app.db).change(f.home,raw=>{(raw.members as Array<{person:string;agents:string[]}>).find(m=>m.person==='pollock')!.agents=['pond-bot'];});
 })();
 f.app.live.changed([{type:'runtime.job',id:job}]);expect(record().working).toBe(true);
 await f.restart();expect(record().working).toBe(true);
});

it('cannot redirect terminal reconciliation onto another working private thread of the same agent and member',async()=>{
 const f=await setup(),first=await f.open(),a=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job:a});await f.post(f.runner,'runtime.takeInput',{job:a});await f.post(f.runner,'runtime.reportJob',{job:a,state:'running'});
 const second=value<{thread:string}>(await f.socket('comms.open',{agent:'art',id:'ponmlkjihgfedcba',text:'Separate private conversation'})).thread,b=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job:b});await f.post(f.runner,'runtime.takeInput',{job:b});await f.post(f.runner,'runtime.reportJob',{job:b,state:'running'});
 const working=(thread:string)=>JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record).working;
 expect(working(first)).toBe(true);expect(working(second)).toBe(true);
 const store=runtimeStore(f.app.db);
 f.app.db.transaction(()=>{
  const {changedAt:_,...job}=store.read('job',a)!;store.put('job',{...job,state:'done',endedAt:f.clock.now()},f.clock.now());
  // Swap places through a temporary value to preserve the unique place index.
  const {changedAt:__,...other}=store.read('binding',store.read('job',b)!.conversation!)!;
  store.put('binding',{...other,place:'temporary-place'},f.clock.now());
  const {changedAt:___,...binding}=store.read('binding',job.conversation!)!;store.put('binding',{...binding,place:second},f.clock.now());
  store.put('binding',{...other,place:first},f.clock.now());
 })();
 f.app.live.changed([{type:'runtime.job',id:a}]);expect(working(first)).toBe(true);expect(working(second)).toBe(true);
 await f.restart();expect(working(first)).toBe(true);expect(working(second)).toBe(true);
});

async function commsBodyFixture(member='jonathan'){
 const f=await setup(false,member),thread=await f.open(),job=await f.queued();
 value(await f.post(f.runner,'runtime.claimJob',{job}));
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 const record=()=>JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record);
 return {...f,get app(){return f.app;},thread,job,body,record};
}
it('derives private description, title and monotonic activity from the authenticated body only',async()=>{
 const f=await commsBodyFixture();
 const description=value<{brief:string[];readers:string[]}>(await f.post(f.body,'runtime.describeConversation',{}));
 expect(description.readers).toEqual(['jonathan']);
 expect(description.brief.join(' ')).toContain(runtimeStore(f.app.db).read('job',f.job)!.conversation);
 expect(JSON.stringify(description)).not.toContain('PRIVATE inbound');
 const descriptionViewer=signin(f.app).token(hash(f.body))!.viewer;
 expect(f.app.operations.call('direct',descriptionViewer,'runtime.describeConversation',{},'description-receipt')).toMatchObject({ok:true});
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE name='runtime.describeConversation'").all()).toEqual([]);
 for(const secret of [f.owner,f.runner,f.unbound,f.token(`agent:mark@${f.job}`)]){
  for(const [name,input] of [['describeConversation',{}],['titleConversation',{title:'Forbidden'}],['conversationActivity',{at:f.clock.now()}]] as const)
   expect(await f.post(secret,`runtime.${name}`,input)).toMatchObject({ok:false});
 }
 for(const [name,input] of [['describeConversation',{thread:f.thread}],['titleConversation',{title:'PRIVATE title',conversation:'forged'}],['conversationActivity',{at:f.clock.now(),job:f.job}]] as const)
  expect(await f.post(f.body,`runtime.${name}`,input)).toMatchObject({ok:false,code:'invalid'});
 expect(await f.post(f.body,'runtime.titleConversation',{title:'PRIVATE title'})).toMatchObject({ok:true,value:{updated:true}});
 expect(f.record()).toMatchObject({title:'PRIVATE title',titledBy:'agent'});
 expect(await f.post(f.body,'runtime.conversationActivity',{at:f.clock.now(),tokens:25})).toMatchObject({ok:true});
 expect(f.record()).toMatchObject({aliveAt:f.clock.now(),aliveTokens:25});
 const working=f.record().workingBeat;
 f.clock.advance(1);
 await f.post(f.body,'runtime.conversationActivity',{at:f.clock.now()-1,tokens:99});
 expect(f.record()).toMatchObject({aliveTokens:25,workingBeat:working});
 await f.post(f.body,'runtime.conversationActivity',{at:f.clock.now(),tokens:30});
 expect(f.record()).toMatchObject({aliveAt:f.clock.now(),aliveTokens:30,workingBeat:working});
 value(await f.socket('comms.change',{thread:f.thread,action:'title',title:'Member title'}));
 expect(await f.post(f.body,'runtime.titleConversation',{title:'Replace member title'})).toMatchObject({ok:false,code:'conflict'});
 expect(f.record().title).toBe('Member title');
 for(const table of ['runtime_inputs','core_operations'])expect(JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain('PRIVATE');
});
it.each(['imported','reset','writeoff','ended','binding','project','venue','archived','membership','policy','archived-policy','service','box','house','credential','terminal','live-conversation','live-project','live-thread','ambiguous-owner','deleted-owner'] as const)('refuses bound Comms controls after %s changes',async drift=>{
 const f=await commsBodyFixture(drift==='membership'?'pollock':'jonathan'),store=runtimeStore(f.app.db);
 expect(await f.post(f.body,'runtime.describeConversation',{})).toMatchObject({ok:true});
 const viewer=signin(f.app).token(hash(f.body))!.viewer;
 const writes=[['titleConversation',{title:'Before drift'},'title-before-drift'],['conversationActivity',{at:f.clock.now(),tokens:1},'activity-before-drift']] as const;
 for(const [name,input,id] of writes)expect(f.app.operations.call('direct',viewer,`runtime.${name}`,input,id)).toMatchObject({ok:true});
 const other=drift==='live-thread'?value<{thread:string}>(await f.socket('comms.open',{agent:'art',id:'ponmlkjihgfedcba',text:'Separate private conversation'})).thread:undefined;
 if(other)await f.queued();
 f.app.db.transaction(()=>{
  const {changedAt:_,...job}=store.read('job',f.job)!;
  if(drift==='imported')store.put('job',{...job,imported:{history:'discard'}},f.clock.now());
  if(drift==='reset')store.put('job',{...job,principalReset:{approval:'a-reset',by:'jonathan',at:f.clock.now()}},f.clock.now());
  if(drift==='writeoff')store.put('job',{...job,writtenOff:{approval:'a-writeoff',by:'jonathan',at:f.clock.now()}},f.clock.now());
  if(drift==='ended')store.put('job',{...job,endedAt:f.clock.now()},f.clock.now());
  if(drift==='terminal')store.put('job',{...job,state:'done'},f.clock.now());
  if(other){
   const {changedAt:__,...binding}=store.read('binding',job.conversation!)!,otherBinding=store.ids('binding').map(id=>store.read('binding',id)!).find(b=>b.place===other)!;
   const {changedAt:___,...otherBefore}=otherBinding;store.put('binding',{...otherBefore,place:'temporary-place'},f.clock.now());
   store.put('binding',{...binding,place:other},f.clock.now());store.put('binding',{...otherBefore,place:f.thread},f.clock.now());
  }
  if(['binding','project','venue'].includes(drift)){
   const {changedAt:__,...binding}=store.read('binding',job.conversation!)!;
   store.put('binding',{...binding,...(drift==='binding'?{job:'replacement'}:drift==='project'?{project:'pond'}:{venue:'spawn'})},f.clock.now());
  }
  if(drift==='archived'){const t=f.record();t.archived=f.clock.now();f.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(t),f.thread);}
  if(drift==='live-conversation'||drift==='live-project'){const t=f.record();if(drift==='live-conversation')t.conversation='other-conversation';else t.project='pond';f.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(t),f.thread);}
  if(drift==='ambiguous-owner'){
   const t=f.record(),copy={...t,id:'th:duplicate-owner'};
   f.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run(copy.id,copy.member,copy.agent,copy.project??null,JSON.stringify(copy));
  }
  if(drift==='deleted-owner'){
   const t=f.record();f.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('th:deleted-owner',t.member,t.agent,t.conversation,f.clock.now());
  }
  if(drift==='membership')new HouseholdDatabase(f.app.db).change(f.home,raw=>{(raw.members as Array<{person:string;agents:string[]}>).find(m=>m.person==='pollock')!.agents=[];});
  if(drift==='service')store.put('job',{...job,service:'discord'},f.clock.now());
  if(drift==='archived-policy')f.app.db.prepare('INSERT INTO runtime_import_documents (collection,key,record) VALUES (?,?,?)').run('gates','art',JSON.stringify({doc:'{}'}));
  if(drift==='policy')f.app.db.prepare('INSERT INTO runtime_body_policy (agent,record) VALUES (?,?)').run('art','{}');
  if(drift==='box'){const {changedAt:__,...box}=store.read('box','a')!;store.put('box',{...box,revokedAt:f.clock.now()},f.clock.now());}
  if(drift==='house'){const {changedAt:__,...settings}=store.read('settings','art')!;store.put('settings',{...settings,house:{repo:'/changed',houseFile:'house.json'}},f.clock.now());}
  if(drift==='credential')signin(f.app).tokens.change(ts=>ts.splice(ts.findIndex(t=>t.sha256===hash(f.body)),1));
 })();
 const before=f.record();
 for(const [name,input,id] of writes)expect(f.app.operations.call('direct',viewer,`runtime.${name}`,input,id)).toMatchObject({ok:false});
 for(const [name,input] of [['askQuestion',{id:'held-question',question:{ask:'PRIVATE held'}}],['readConversation',{}],['reply',{id:'held-reply',text:'PRIVATE held'}],['conversationStatus',{state:'working'}],['describeConversation',{}],['titleConversation',{title:'Forbidden title'}],['conversationActivity',{at:f.clock.now(),tokens:99}]] as const)
  expect(await f.post(f.body,`runtime.${name}`,input)).toMatchObject({ok:false});
 expect(f.record()).toEqual(before);
});

it('queues bound Comms publication until commit and replays acknowledgements without overwriting newer values',async()=>{
 const f=await commsBodyFixture(),viewer=signin(f.app).token(hash(f.body))!.viewer;
 const seen:unknown[]=[];const transactions:boolean[]=[];const stop=f.app.live.observe(changes=>{seen.push(...changes);transactions.push(f.app.db.inTransaction);});cleanups.push(stop);
 for(const [name,input] of [['titleConversation',{title:'Rolled back'}],['conversationActivity',{at:f.clock.now(),tokens:9}]] as const){
  const before=f.record();seen.length=0;
  f.app.db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON core_operations WHEN NEW.name='runtime.${name}' BEGIN SELECT RAISE(ABORT,'interrupted'); END`);
  expect(f.app.operations.call('direct',viewer,`runtime.${name}`,input,`rollback-${name}`)).toMatchObject({ok:false});
  expect(f.record()).toEqual(before);expect(seen).toEqual([]);
  f.app.db.exec('DROP TRIGGER reject_receipt');
  const result=f.app.operations.call('direct',viewer,`runtime.${name}`,input,`commit-${name}`);
  expect(result).toMatchObject({ok:true});expect(seen).toEqual([{type:'thread',id:f.thread}]);expect(transactions.every(active=>!active)).toBe(true);
  seen.length=0;
  expect(f.app.operations.call('direct',{...viewer},`runtime.${name}`,input,`forged-${name}`)).toMatchObject({ok:false,code:'denied'});
  if(name==='titleConversation')value(await f.socket('comms.change',{thread:f.thread,action:'title',title:'Member replacement'}));
  else {f.clock.advance(1);value(f.app.operations.call('direct',viewer,`runtime.${name}`,{at:f.clock.now(),tokens:20},'new-activity'));}
  const newer=f.record();seen.length=0;
  expect(f.app.operations.call('direct',viewer,`runtime.${name}`,input,`commit-${name}`)).toEqual(result);
  expect(f.record()).toEqual(newer);expect(seen).toEqual([]);
 }
});
it('rejects a centrally authenticated service credential for the same private job with different service provenance',async()=>{
 const f=await commsBodyFixture(),secret=f.token(`agent:art/discord@${f.job}`);
 expect(signin(f.app).body(signin(f.app).token(hash(secret))!.viewer)).toMatchObject({agent:'art',job:f.job,service:'discord'});
 for(const [name,input] of [['describeConversation',{}],['titleConversation',{title:'Service title'}],['conversationActivity',{at:f.clock.now()}]] as const)
  expect(await f.post(secret,`runtime.${name}`,input)).toMatchObject({ok:false,code:'denied'});
});

it.each(['duplicate','tombstone','imported','policy','venue','reset','writeoff','ended','service'] as const)('refuses pending private read/reply after %s authority evidence appears',async drift=>{
 const f=await commsBodyFixture(),viewer=signin(f.app).token(hash(f.body))!.viewer;
 const read=f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{});
 const reply=f.app.operations.callAsync('direct',viewer,'runtime.reply',{id:'ownership-race',text:'PRIVATE must not escape'});
 const t=f.record();
 if(drift==='duplicate'){
  const copy={...t,id:'th:duplicate-race'};
  f.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run(copy.id,copy.member,copy.agent,copy.project??null,JSON.stringify(copy));
 }else if(drift==='tombstone')f.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('th:deleted-race',t.member,t.agent,t.conversation,f.clock.now());
 else f.app.db.transaction(()=>{
  const store=runtimeStore(f.app.db),{changedAt:_,...job}=store.read('job',f.job)!;
  if(drift==='policy')f.app.db.prepare('INSERT INTO runtime_body_policy (agent,record) VALUES (?,?)').run('art','{}');
  else if(drift==='venue'){
   const {changedAt:__,...binding}=store.read('binding',job.conversation!)!;store.put('binding',{...binding,venue:'spawn'},f.clock.now());
  }else store.put('job',{...job,...(drift==='imported'?{imported:{history:'discard' as const}}:drift==='reset'?{principalReset:{approval:'a-reset',by:'jonathan',at:f.clock.now()}}:drift==='writeoff'?{writtenOff:{approval:'a-writeoff',by:'jonathan',at:f.clock.now()}}:drift==='service'?{service:'discord'}:{endedAt:f.clock.now()})},f.clock.now());
 })();
 expect(await read).toMatchObject({ok:false,code:'denied'});
 expect(await reply).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare("SELECT * FROM comms_messages WHERE id='ownership-race'").all()).toEqual([]);
});

it.each(['duplicate','tombstone'] as const)('refuses delivery acceptance and receipt with %s ownership evidence',async drift=>{
 let role!:ReturnType<typeof realConversationRuntime>;
 vi.spyOn(conversationModule,'conversationRuntime').mockImplementation((...args)=>role=realConversationRuntime(...args));
 const f=await setup(true),thread=await f.open();
 await expect.poll(()=>f.app.db.prepare("SELECT id FROM core_effects WHERE id=? AND state='due'").get(`comms-deliver:${thread}:1`)).toBeDefined();
 const t=JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string}).record);
 const route={thread,conversation:t.conversation,agent:t.agent,member:t.member,seq:1};
 expect(await role.delivery.receipt!(route)).toBe('not-accepted');
 if(drift==='duplicate'){
  const copy={...t,id:'th:duplicate-delivery'};
  f.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run(copy.id,copy.member,copy.agent,copy.project??null,JSON.stringify(copy));
 }else f.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('th:deleted-delivery',t.member,t.agent,t.conversation,f.clock.now());
 expect(await role.delivery.receipt!(route)).toBe('unknown');
 await expect(role.delivery.deliver({...route,text:'PRIVATE delivery must refuse'})).rejects.toThrow();
 for(const table of ['runtime_jobs','runtime_bindings','runtime_deliveries'])expect(f.app.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE name='runtime.acceptConversation'").all()).toEqual([]);
 if(drift==='duplicate')f.app.db.prepare("DELETE FROM comms_threads WHERE id='th:duplicate-delivery'").run();
 else f.app.db.prepare("DELETE FROM comms_deleted WHERE id='th:deleted-delivery'").run();
 expect(await role.delivery.receipt!(route)).toBe('not-accepted');
 await role.delivery.deliver({...route,text:'PRIVATE source stays in Comms'});
 expect(await role.delivery.receipt!(route)).toBe('accepted');
 expect(runtimeStore(f.app.db).ids('job')).toHaveLength(1);
 // A cached acceptance acknowledgement must not bypass current ownership.
 f.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('th:deleted-replay',t.member,t.agent,t.conversation,f.clock.now());
 expect(await role.delivery.receipt!(route)).toBe('unknown');
 await expect(role.delivery.deliver({...route,text:'PRIVATE replay'})).rejects.toThrow();
 expect(runtimeStore(f.app.db).ids('job')).toHaveLength(1);
 for(const table of ['runtime_inputs','runtime_jobs','runtime_bindings','runtime_deliveries','core_operations'])expect(JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain('PRIVATE');
});

async function spawnFilingFixture(place='job-h-1862',withJob=true){
 const f=await commsBodyFixture(),store=runtimeStore(f.app.db),conversation=store.read('job',f.job)!.conversation!;
 f.app.db.transaction(()=>{
  const {changedAt:_,...job}=store.read('job',f.job)!;
  store.put('job',{...job,imported:{history:'discard'}},f.clock.now());
  const {changedAt:__,job:___,...binding}=store.read('binding',conversation)!;
  store.put('binding',{...binding,venue:'spawn',place,...(withJob?{job:f.job}:{})},f.clock.now());
 })();
 return {...f,get app(){return f.app;},conversation};
}
it.each([
 ['job-h-1862',true],['sp-0123456789abcdef01234567',true],['job-h-1862',false],
] as const)('files the unique owning thread while preserving spawn transport %s (job %s)',async(place,withJob)=>{
 const f=await spawnFilingFixture(place,withJob),store=runtimeStore(f.app.db);
 const binding=store.read('binding',f.conversation)!,job=store.read('job',f.job)!;
 const receipts=f.app.db.prepare('SELECT * FROM runtime_deliveries').all(),inputs=f.app.db.prepare('SELECT * FROM runtime_inputs').all();
 const seen:unknown[]=[];const stop=f.app.live.observe(changes=>seen.push(...changes));cleanups.push(stop);
 value(await f.socket('comms.change',{thread:f.thread,action:'project',project:'pond'}));
 expect(store.read('binding',f.conversation)).toEqual({...binding,project:'pond'});
 expect(store.read('job',f.job)).toEqual(withJob?{...job,project:'pond'}:job);
 expect(f.record().project).toBe('pond');
 expect(seen).toContainEqual({type:'runtime.binding',id:f.conversation});
 if(withJob)expect(seen).toContainEqual({type:'runtime.job',id:f.job});
 // Metadata filing never reconciles an imported job into execution authority.
 for(const [name,input] of [['readConversation',{}],['reply',{id:'imported-filing-reply',text:'PRIVATE must stay held'}],['describeConversation',{}],['conversationStatus',{state:'working'}]] as const)
  expect(await f.post(f.body,`runtime.${name}`,input)).toMatchObject({ok:false});
 expect(await f.post(f.runner,'runtime.jobControl',{job:f.job})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.runner,'runtime.takeInput',{job:f.job})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM runtime_deliveries').all()).toEqual(receipts);
 expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toEqual(inputs);
 expect(store.ids('job')).toEqual([f.job]);
 await f.restart();
 expect(runtimeStore(f.app.db).read('binding',f.conversation)).toEqual({...binding,project:'pond'});
 value(await f.socket('comms.change',{thread:f.thread,action:'project',project:null}));
 const after=runtimeStore(f.app.db);
 expect(after.read('binding',f.conversation)).toEqual(binding);
 expect(after.read('job',f.job)).toEqual(job);
 expect(f.record().project).toBeUndefined();
});
it.each(['duplicate','deleted','missing','member','agent','binding-project','job-project','job-member','job-conversation','missing-job','venue','loom-place'] as const)('refuses %s evidence before filing a spawn owner',async drift=>{
 const f=await spawnFilingFixture(),store=runtimeStore(f.app.db),t=f.record();
 f.app.db.transaction(()=>{
  if(drift==='duplicate'){
   const copy={...t,id:'th:ambiguous-filing'};
   f.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run(copy.id,copy.member,copy.agent,copy.project??null,JSON.stringify(copy));
  }
  if(drift==='deleted')f.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('th:deleted-filing',t.member,t.agent,t.conversation,f.clock.now());
  if(drift==='missing')f.app.db.prepare('DELETE FROM comms_threads WHERE id=?').run(f.thread);
  if(['member','agent','binding-project','missing-job','venue','loom-place'].includes(drift)){
   const {changedAt:_,...b}=store.read('binding',f.conversation)!;
   store.put('binding',{...b,...(drift==='member'?{member:'pollock'}:drift==='agent'?{agent:'mark'}:drift==='binding-project'?{project:'pond'}:drift==='missing-job'?{job:'missing-job'}:drift==='venue'?{venue:'bridge:discord'}:{venue:'loom'})},f.clock.now());
  }
  if(drift.startsWith('job-')){
   const {changedAt:_,...job}=store.read('job',f.job)!;
   store.put('job',{...job,...(drift==='job-project'?{project:'pond'}:drift==='job-member'?{member:'pollock'}:{conversation:'other-conversation'})},f.clock.now());
  }
 })();
 const snapshot=()=>['comms_threads','runtime_jobs','runtime_bindings','runtime_inputs','runtime_deliveries','core_operations'].map(table=>f.app.db.prepare(`SELECT * FROM ${table}`).all());
 const before=snapshot(),seen:unknown[]=[];const stop=f.app.live.observe(changes=>seen.push(...changes));cleanups.push(stop);
 expect(await f.socket('comms.change',{thread:f.thread,action:'project',project:'pond'})).toMatchObject({ok:false});
 expect(snapshot()).toEqual(before);expect(seen).toEqual([]);
});
it('rolls back spawn project filing across Comms, binding, job, receipt and live publication',async()=>{
 const f=await spawnFilingFixture(),store=runtimeStore(f.app.db),binding=store.read('binding',f.conversation),job=store.read('job',f.job),thread=f.record();
 const receipts=f.app.db.prepare('SELECT * FROM core_operations').all();
 const seen:unknown[]=[];const stop=f.app.live.observe(changes=>seen.push(...changes));cleanups.push(stop);
 f.app.db.exec("CREATE TRIGGER reject_spawn_filing BEFORE UPDATE ON runtime_bindings BEGIN SELECT RAISE(ABORT,'interrupted'); END");
 expect(await f.socket('comms.change',{thread:f.thread,action:'project',project:'pond'})).toMatchObject({ok:false});
 expect(store.read('binding',f.conversation)).toEqual(binding);expect(store.read('job',f.job)).toEqual(job);expect(f.record()).toEqual(thread);
 expect(f.app.db.prepare('SELECT * FROM core_operations').all()).toEqual(receipts);expect(seen).toEqual([]);
});

it.each(['reset','writeoff','history-unknown','policy','archived-policy'] as const)('preserves %s execution holds when filing spawned metadata across restart',async hold=>{
 const f=await spawnFilingFixture(),store=runtimeStore(f.app.db);
 f.app.db.transaction(()=>{
  const {changedAt:_,...job}=store.read('job',f.job)!;
  if(hold==='reset')store.put('job',{...job,principalReset:{approval:'a-reset',by:'jonathan',at:f.clock.now()}},f.clock.now());
  if(hold==='writeoff')store.put('job',{...job,writtenOff:{approval:'a-writeoff',by:'jonathan',at:f.clock.now()}},f.clock.now());
  if(hold==='history-unknown')store.put('job',{...job,imported:{history:'unknown'}},f.clock.now());
  if(hold==='policy')f.app.db.prepare('INSERT INTO runtime_body_policy (agent,record) VALUES (?,?)').run('art','{}');
  if(hold==='archived-policy')f.app.db.prepare('INSERT INTO runtime_import_documents (collection,key,record) VALUES (?,?,?)').run('gates','art',JSON.stringify({doc:'{}'}));
 })();
 const job=store.read('job',f.job)!,binding=store.read('binding',f.conversation)!;
 const policies=()=>['runtime_body_policy','runtime_import_documents'].map(table=>f.app.db.prepare(`SELECT * FROM ${table}`).all());
 const before=policies();
 value(await f.socket('comms.change',{thread:f.thread,action:'project',project:'pond'}));
 expect(store.read('job',f.job)).toEqual({...job,project:'pond'});expect(policies()).toEqual(before);
 await f.restart();
 const after=runtimeStore(f.app.db);
 expect(after.read('job',f.job)).toEqual({...job,project:'pond'});
 expect(after.read('binding',f.conversation)).toEqual({...binding,project:'pond'});expect(policies()).toEqual(before);
 expect(await f.post(f.body,'runtime.readConversation',{})).toMatchObject({ok:false});
 expect(await f.post(f.runner,'runtime.takeInput',{job:f.job})).toMatchObject({ok:false});
});
it.each(['runtime.binding','runtime.job'] as const)('honors central %s move refusal before committing spawned filing',async type=>{
 const f=await spawnFilingFixture(),realMove=corePolicy.mayMove;
 // Both valid records have the same private scope today. Inject each central
 // policy refusal independently to prove both call boundaries are enforced.
 const move=vi.spyOn(corePolicy,'mayMove').mockImplementation((viewer,before,after,sharing,operation)=>before.type===type?false:realMove(viewer,before,after,sharing,operation));
 const snapshot=()=>['comms_threads','runtime_jobs','runtime_bindings','core_operations'].map(table=>f.app.db.prepare(`SELECT * FROM ${table}`).all());
 const before=snapshot(),seen:unknown[]=[];const stop=f.app.live.observe(changes=>seen.push(...changes));cleanups.push(stop);
 expect(await f.socket('comms.change',{thread:f.thread,action:'project',project:'pond'})).toMatchObject({ok:false,code:'denied'});
 expect(move).toHaveBeenCalledWith({kind:'member',id:'jonathan'},expect.objectContaining({type,member:'jonathan',agent:'art'}),expect.objectContaining({type,member:'jonathan',agent:'art',project:'pond'}),expect.any(Object),'runtime.acceptConversation');
 expect(snapshot()).toEqual(before);expect(seen).toEqual([]);
});

it('binds private questions to the original body and seals words without publishing caller authority',async()=>{
 const f=await setup(),thread=await f.open(),job=await f.queued();
 await f.post(f.runner,'runtime.claimJob',{job});
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 const input={id:'question-1',question:{ask:'PRIVATE BODY QUESTION',why:'PRIVATE BODY WHY',if_yes:'PRIVATE BODY YES',refs:['private-body-reference'],answers:'words'}};
 expect(await f.post(body,'runtime.askQuestion',input)).toMatchObject({ok:false});
 await f.post(f.runner,'runtime.reportJob',{job,state:'running'});
 for(const secret of [f.owner,f.runner,f.unbound,f.token('agent:art@another'),f.token(`agent:mark@${job}`),f.token(`agent:art/discord@${job}`)])
  expect(await f.post(secret,'runtime.askQuestion',input)).toMatchObject({ok:false});
 const viewer=signin(f.app).token(hash(body))!.viewer;
 expect(await f.app.operations.callAsync('direct',{...viewer},'runtime.askQuestion',input,'copied-question')).toMatchObject({ok:false});
 for(const extra of [{agent:'art'},{member:'jonathan'},{conversation:'forged'},{thread},{source:{kind:'conversation',id:'forged'}}])
  expect(await f.post(body,'runtime.askQuestion',{...input,...extra})).toMatchObject({ok:false});
 expect(await f.post(body,'runtime.askQuestion',{...input,question:{...input.question,waits_on:{approval:'forged'}}})).toMatchObject({ok:false});
 expect(await f.socket('runtime.askQuestion',input)).toMatchObject({ok:false});
 const ack=value<{ref:string;seq:number}>(await f.post(body,'runtime.askQuestion',input));
 expect(Object.keys(ack).sort()).toEqual(['ref','seq']);
 expect(await f.post(body,'runtime.askQuestion',input)).toEqual({ok:true,value:ack});
 expect(await f.post(body,'runtime.askQuestion',{...input,question:{ask:'altered'}})).toMatchObject({ok:false,code:'conflict'});
 expect(await f.socket('attention.get',{id:ack.ref})).toMatchObject({ok:true,value:{member:'jonathan',agent:'art',privateQuestion:{thread,seq:ack.seq},state:'open'}});
 expect(await f.socket('comms.messages',{thread})).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({ask:input.question})])});
 for(const table of ['attention_asks','core_operations','runtime_inputs','runtime_jobs','runtime_bindings','runtime_deliveries','comms_messages']){
  const stored=JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all());
  for(const word of [input.question.ask,input.question.why,input.question.if_yes,...input.question.refs])expect(stored).not.toContain(word);
 }
 expect(await f.socket('comms.replyToAsk',{ref:ack.ref,text:'PRIVATE QUESTION ANSWER'})).toMatchObject({ok:true});
 expect(await f.post(body,'runtime.askQuestion',input)).toEqual({ok:true,value:ack});
 expect(await f.socket('attention.get',{id:ack.ref})).toMatchObject({ok:true,value:{state:'answered'}});
 await f.restart();
 expect(await f.post(body,'runtime.askQuestion',input)).toEqual({ok:true,value:ack});
 expect(await f.socket('attention.get',{id:ack.ref})).toMatchObject({ok:true,value:{state:'answered'}});
});

it.each(['credential','policy','archive','imported','reset','writeoff','ended','service','binding','duplicate','tombstone','member','box','hosting','house','membership','lending','relocation'] as const)('rejects a private question revoked during actual encryption by %s without partial persistence',async drift=>{
 let armed=false,entered:()=>void=()=>{},release:()=>void=()=>{};
 const sealing=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 vi.spyOn(commsCrypto,'loadKey').mockImplementation(async home=>{
  const key=await realLoadKey(home);
  return {...key,async seal(words){if(armed&&words.includes('PRIVATE INFLIGHT QUESTION')){entered();await gate;}return key.seal(words);}};
 });
 const f=await commsBodyFixture(drift==='membership'||drift==='lending'?'pollock':'jonathan'),viewer=signin(f.app).token(hash(f.body))!.viewer;
 const relocated=drift==='relocation'?value<{thread:string}>(await f.socket('comms.open',{agent:'art',id:'relocationthread',text:'Separate owning private thread'})).thread:undefined;
 if(relocated)await f.queued();
 const snapshot=()=>['attention_asks','comms_messages'].map(table=>f.app.db.prepare(`SELECT * FROM ${table}`).all());
 const before=snapshot();armed=true;
 const pending=f.app.operations.callAsync('http',viewer,'runtime.askQuestion',{id:'inflight-question',question:{ask:'PRIVATE INFLIGHT QUESTION'}},'inflight-question');
 try {
 await sealing;
 f.app.db.transaction(()=>{
  const store=runtimeStore(f.app.db),{changedAt:_,...job}=store.read('job',f.job)!,t=f.record();
  if(relocated){
   const other=store.ids('binding').map(id=>store.read('binding',id)!).find(b=>b.place===relocated)!;
   const {changedAt:__,...binding}=other;
   store.put('binding',{...binding,job:f.job},f.clock.now());
   store.put('job',{...job,conversation:binding.id},f.clock.now());
  }
  if(['box','hosting','lending'].includes(drift)){const {changedAt:__,...box}=store.read('box','a')!;store.put('box',{...box,...(drift==='box'?{revokedAt:f.clock.now()}:drift==='hosting'?{mayHost:[]}:{lentTo:[]})},f.clock.now());}
  if(drift==='house'){const {changedAt:__,...settings}=store.read('settings','art')!;store.put('settings',{...settings,house:{repo:'/changed',houseFile:'house.json'}},f.clock.now());}
  if(drift==='membership')new HouseholdDatabase(f.app.db).change(f.home,raw=>{(raw.members as Array<{person:string;agents:string[]}>).find(m=>m.person==='pollock')!.agents=[];});
  if(drift==='credential')signin(f.app).tokens.change(ts=>ts.splice(ts.findIndex(t=>t.sha256===hash(f.body)),1));
  if(drift==='policy')f.app.db.prepare('INSERT INTO runtime_body_policy (agent,record) VALUES (?,?)').run('art','{}');
  if(drift==='archive'){t.archived=f.clock.now();f.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(t),f.thread);}
  if(drift==='imported')store.put('job',{...job,imported:{history:'discard'}},f.clock.now());
  if(drift==='reset')store.put('job',{...job,principalReset:{approval:'a-reset',by:'jonathan',at:f.clock.now()}},f.clock.now());
  if(drift==='writeoff')store.put('job',{...job,writtenOff:{approval:'a-writeoff',by:'jonathan',at:f.clock.now()}},f.clock.now());
  if(drift==='ended')store.put('job',{...job,endedAt:f.clock.now()},f.clock.now());
  if(drift==='service')store.put('job',{...job,service:'discord'},f.clock.now());
  if(drift==='binding'){const {changedAt:__,...binding}=store.read('binding',job.conversation!)!;store.put('binding',{...binding,job:'replacement'},f.clock.now());}
  if(drift==='duplicate'){const copy={...t,id:'th:duplicate-question'};f.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run(copy.id,copy.member,copy.agent,copy.project??null,JSON.stringify(copy));}
  if(drift==='tombstone')f.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('th:deleted-question',t.member,t.agent,t.conversation,f.clock.now());
  if(drift==='member'){t.member='pollock';f.app.db.prepare('UPDATE comms_threads SET member=?,record=? WHERE id=?').run(t.member,JSON.stringify(t),f.thread);}
 })();
 release();expect(await pending).toMatchObject({ok:false,code:'denied'});
 expect(snapshot()).toEqual(before);
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE name='runtime.askQuestion'").all()).toEqual([]);
 }finally{release();await pending;}
});

it('keeps non-owner private questions with their original member instead of the household owner',async()=>{
 const f=await commsBodyFixture('pollock');
 const ack=value<{ref:string;seq:number}>(await f.post(f.body,'runtime.askQuestion',{id:'member-question',question:{ask:'PRIVATE MEMBER QUESTION'}}));
 expect(await f.socket('attention.get',{id:ack.ref})).toMatchObject({ok:true,value:{member:'pollock',privateQuestion:{thread:f.thread,seq:ack.seq}}});
 const owner=signin(f.app).token(hash(f.owner))!.viewer;
 expect(f.app.operations.call('http',owner,'attention.get',{id:ack.ref})).toMatchObject({ok:false});
});

it('namespaces private question identities by the actual replacement job',async()=>{
 const f=await commsBodyFixture(),input={id:'same-question-id',question:{ask:'PRIVATE FIRST JOB QUESTION'}};
 const first=value<{ref:string;seq:number}>(await f.post(f.body,'runtime.askQuestion',input));
 value(await f.post(f.runner,'runtime.finishJob',{job:f.job,state:'done'}));
 value(await f.socket('comms.send',{thread:f.thread,id:'replacementwords',text:'Start the replacement turn'}));
 const job=await f.queued();expect(job).not.toBe(f.job);
 value(await f.post(f.runner,'runtime.claimJob',{job}));
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 const second=value<{ref:string;seq:number}>(await f.post(body,'runtime.askQuestion',{...input,question:{ask:'PRIVATE SECOND JOB QUESTION'}}));
 expect(second.ref).not.toBe(first.ref);expect(second.seq).toBeGreaterThan(first.seq);
 expect(await f.post(f.body,'runtime.askQuestion',input)).toMatchObject({ok:false});
 const messages=value<Array<{ask?:{ask:string}}>>(await f.socket('comms.messages',{thread:f.thread}));
 expect(messages.filter(m=>m.ask).map(m=>m.ask!.ask)).toEqual(['PRIVATE FIRST JOB QUESTION','PRIVATE SECOND JOB QUESTION']);
});

it('enforces bounded private Question fields before encryption and accepts their exact limits',async()=>{
 const f=await commsBodyFixture(),input={id:'bounded-question',question:{ask:'PRIVATE BOUNDED QUESTION'}};
 const snapshot=()=>['attention_asks','comms_messages'].map(table=>f.app.db.prepare(`SELECT * FROM ${table}`).all());
 const before=snapshot();
 const invalid=[
  {...input,id:''},{...input,id:'x'.repeat(201)},
  ...['ask','why','if_yes','if_no'].flatMap(field=>['','x'.repeat(4001)].map(text=>({...input,question:{...input.question,[field]:text}}))),
  {...input,question:{...input.question,href:'x'.repeat(2001)}},
  {...input,question:{...input.question,refs:Array.from({length:101},()=> 'ref')}},
  {...input,question:{...input.question,refs:['x'.repeat(201)]}},
  {...input,question:{...input.question,refs:['']}},
 ];
 for(const candidate of invalid){
  expect(await f.post(f.body,'runtime.askQuestion',candidate)).toMatchObject({ok:false,code:'invalid'});
  expect(snapshot()).toEqual(before);
 }
 const maximum={id:'q'.repeat(200),question:{ask:'a'.repeat(4000),why:'w'.repeat(4000),if_yes:'y'.repeat(4000),if_no:'n'.repeat(4000),href:'h'.repeat(2000),refs:Array.from({length:100},()=> 'r'.repeat(200)),answers:'yes-no'}};
 const ack=value<{ref:string;seq:number}>(await f.post(f.body,'runtime.askQuestion',maximum));
 expect(await f.socket('comms.messages',{thread:f.thread})).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({ask:maximum.question})])});
 expect(await f.socket('attention.get',{id:ack.ref})).toMatchObject({ok:true,value:{answers:'yes-no'}});
});

it('withholds a former-thread question acknowledgement if the same job moves after the authorized commit',async()=>{
 const f=await commsBodyFixture(),other=value<{thread:string}>(await f.socket('comms.open',{agent:'art',id:'ackrelocatethrda',text:'Other private thread'})).thread;
 await f.queued();let moved=false;
 const stop=f.app.live.observe(changes=>{
  if(moved||!changes.some(c=>c.type==='attention.ask'))return;
  moved=true;expect(f.app.db.inTransaction).toBe(false);
  f.app.db.transaction(()=>{
   const store=runtimeStore(f.app.db),{changedAt:_,...job}=store.read('job',f.job)!;
   const {changedAt:__,...binding}=store.ids('binding').map(id=>store.read('binding',id)!).find(b=>b.place===other)!;
   store.put('binding',{...binding,job:f.job},f.clock.now());store.put('job',{...job,conversation:binding.id},f.clock.now());
  })();
 });cleanups.push(stop);
 expect(await f.post(f.body,'runtime.askQuestion',{id:'former-thread-ack',question:{ask:'PRIVATE AUTHORIZED QUESTION'}})).toMatchObject({ok:false,code:'denied'});
 expect(moved).toBe(true);
 // The write was authorized when committed; only its late acknowledgement is withheld.
 expect(f.app.db.prepare("SELECT thread FROM comms_messages WHERE kind='ask'").all()).toEqual([{thread:f.thread}]);
 expect(await f.post(f.body,'runtime.describeConversation',{})).toMatchObject({ok:true});
});

it('preserves the original private question receipt and answered projection after authorized project filing and restart',async()=>{
 const f=await commsBodyFixture(),input={id:'question-before-filing',question:{ask:'PRIVATE FILING QUESTION'}};
 const first=value<{ref:string;seq:number}>(await f.post(f.body,'runtime.askQuestion',input));
 value(await f.socket('comms.replyToAsk',{ref:first.ref,text:'PRIVATE FILING ANSWER'}));
 const projection=value(await f.socket('attention.get',{id:first.ref}));
 const ciphertext=f.app.db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(f.thread,first.seq);
 value(await f.socket('comms.change',{thread:f.thread,action:'project',project:'pond'}));
 const job=runtimeStore(f.app.db).read('job',f.job)!;
 expect(job.project).toBe('pond');expect(runtimeStore(f.app.db).read('binding',job.conversation!)!.project).toBe('pond');
 expect(await f.post(f.body,'runtime.askQuestion',input)).toEqual({ok:true,value:first});
 expect(value(await f.socket('attention.get',{id:first.ref}))).toEqual(projection);
 await f.restart();
 expect(await f.post(f.body,'runtime.askQuestion',input)).toEqual({ok:true,value:first});
 expect(f.app.db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(f.thread,first.seq)).toEqual(ciphertext);
 expect(value(await f.socket('attention.get',{id:first.ref}))).toEqual(projection);
 expect(await f.post(f.body,'runtime.askQuestion',{...input,question:{ask:'Changed after filing'}})).toMatchObject({ok:false,code:'conflict'});
 value(await f.socket('comms.change',{thread:f.thread,action:'archive'}));
 expect(await f.post(f.body,'runtime.askQuestion',input)).toMatchObject({ok:false});
});
it('delivers a private restricted-service timer from a real member body and retains named steering through self-rearm',async()=>{
 const f=await setup(false,'pollock'),thread=await f.open(),source=await f.queued();
 value(await f.post(f.runner,'runtime.claimJob',{job:source}));
 value(await f.post(f.runner,'runtime.takeInput',{job:source}));
 value(await f.post(f.runner,'runtime.reportJob',{job:source,state:'running'}));
 const conversation=runtimeStore(f.app.db).read('job',source)!.conversation!;
 const restricted=f.token(`agent:art/slack@${source}`);
 const input={agent:'art',prompt:'PRIVATE restricted timer words',note:'timer',when:'1s'};
 expect(await f.post(restricted,'clock.in',input)).toMatchObject({ok:true});
 const scheduled=wakes(f.app.db).find(w=>w.prompt===input.prompt)!;
 expect(scheduled).toMatchObject({member:'pollock',authorship:{member:'pollock',origin:'art',conversation,service:'slack',principal:{for:'pollock',people:['pollock']}}});
 f.clock.advance(1000);
 const job=await f.queued(),store=runtimeStore(f.app.db);
 expect(store.read('job',job)).toMatchObject({member:'pollock',service:'slack'});
 value(await f.post(f.runner,'runtime.claimJob',{job}));
 const payload=value<{credential:string;brief:string}>(await f.post(f.runner,'runtime.takeInput',{job}));
 expect(payload.brief).not.toContain(input.prompt);
 expect(signin(f.app).body(signin(f.app).token(hash(payload.credential))!.viewer)).toMatchObject({agent:'art',job,service:'slack'});
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 const read=value<{messages:Array<{seq:number;text:string}>}>(await f.post(payload.credential,'runtime.readConversation',{}));
 expect(read.messages.map(m=>m.text)).toEqual([input.prompt]);
 value(await f.post(payload.credential,'runtime.acknowledgeClockInput',{through:read.messages[0].seq}));
 const chained={...input,prompt:'PRIVATE restricted chained words'};
 expect(await f.post(payload.credential,'clock.in',chained)).toMatchObject({ok:true});
 const next=wakes(f.app.db).find(w=>w.prompt===chained.prompt)!;
 expect(next).toMatchObject({member:'pollock',authorship:{member:'pollock',origin:'art',conversation:store.read('job',job)!.conversation,service:'slack',principal:{for:'pollock',people:['pollock']}}});
 // The source's permanent receipt and provenance keep the independent scope.
 const receipt=f.app.db.prepare('SELECT record FROM runtime_clock_turns WHERE job=?').get(job) as {record:string};
 expect(JSON.parse(receipt.record)).toMatchObject({member:'pollock',service:'slack',authorship:{principal:{for:'pollock',people:['pollock']}}});
 f.clock.advance(1000);
 const second=await f.queued();expect(store.read('job',second)).toMatchObject({member:'pollock',service:'slack'});
 value(await f.post(f.runner,'runtime.claimJob',{job:second}));
 const secondBody=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job:second})).credential;
 value(await f.post(f.runner,'runtime.reportJob',{job:second,state:'running'}));
 expect(await f.post(secondBody,'runtime.readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:chained.prompt}]}});
 expect(store.ids('job')).toHaveLength(3);
 expect(thread).toBeTruthy();
});

it('does not return prepared Clock words through a separately valid replacement Comms binding',async()=>{
 const f=await setup();await f.open();const commsJob=await f.queued(),store=runtimeStore(f.app.db);
 const comms=store.read('job',commsJob)!,conversation=comms.conversation!;
 value(await f.socket('clock.in',{agent:'art',prompt:'PRIVATE Clock words for original destination',note:'race',when:'1s'}));
 f.clock.advance(1000);
 let jobs:string[]=[];
 for(let i=0;i<15&&!jobs.some(j=>j!==commsJob);i++)jobs=value<{jobs:string[]}>(await f.post(f.runner,'runtime.claimableJobs',{})).jobs;
 const job=jobs.find(j=>j!==commsJob)!;expect(job).toBeTruthy();
 value(await f.post(f.runner,'runtime.claimJob',{job}));
 const payload=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job}));
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 const viewer=signin(f.app).token(hash(payload.credential))!.viewer;
 const pending=f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{});
 f.app.db.transaction(()=>{
  const {changedAt:_,...j}=store.read('job',job)!,{changedAt:__,...b}=store.read('binding',conversation)!;
  store.put('job',{...j,conversation,member:comms.member,project:comms.project},f.clock.now());
  store.put('binding',{...b,job},f.clock.now());
 })();
 expect(await pending).toMatchObject({ok:false,code:'denied'});
 // Prove the alternate consumer really is authorized; a denied replacement
 // cannot discriminate the branch-switch bypass.
 expect(await f.post(payload.credential,'runtime.describeConversation',{})).toMatchObject({ok:true});
 expect(await f.post(payload.credential,'runtime.readConversation',{})).toMatchObject({ok:true,value:{messages:[expect.objectContaining({text:'PRIVATE inbound sentinel'})]}});
});
