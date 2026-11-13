import { runtimeRole } from './role.js';
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
 const queued=async()=>{
  let jobs:string[]=[];
  for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await post(runner,'runtime.claimableJobs',{})).jobs;
  expect(jobs).toHaveLength(1);return jobs[0];
 };
 const open=async()=>{const r=await socket('comms.open',{agent:'art',id:'abcdefghijklmnop',text:'PRIVATE inbound sentinel'});expect(r.ok).toBe(true);return value<{thread:string}>(r).thread;};
 return {get app(){return app;},clock,home,owner,runner,unbound,socket,post,open,queued,token,async restart(){ws.terminate();await app.close();app=await startLoom({home,clock,next:true,staging,stdout:()=>{}});}};
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
 const read=await f.post(body,'runtime.readConversation',{});expect(read.ok).toBe(true);expect(JSON.stringify(read)).toContain('PRIVATE after filing');
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
