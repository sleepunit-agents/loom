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
 const f=await setup(),thread=await f.open();let jobs:string[]=[];
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
 expect(await f.socket('comms.send',{thread,id:'cdefghijklmnopqr',text:'PRIVATE after filing'})).toMatchObject({ok:true});
 const read=await f.post(body,'runtime.readConversation',{});expect(read.ok,read.ok?undefined:JSON.stringify(read)).toBe(true);expect(JSON.stringify(read)).toContain('PRIVATE after filing');
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
 const effect=(prefix:string)=>(f.app.db.prepare('SELECT id FROM core_effects WHERE id LIKE ?').get(prefix+'%') as {id:string}).id;
 expect(await f.post(f.owner,'core.releaseEffect',{id:effect('comms-deliver:')})).toMatchObject({ok:true});
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
