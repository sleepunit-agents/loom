import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer, type Sharing } from '../../core/index.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { runtimeStore } from './store.js';
import { wake } from '../clock/store.js';
import { START_CONFIRM_MS, clockRuntime } from './clock.js';
import type { Wake } from '../clock/store.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
async function setup(staging=false,sharing?:()=>Sharing){
  const home=mkdtempSync(join(tmpdir(),'runtime-start-'));fixture(home);
  cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
  const clock=new FakeClock();let app=await startLoom({home,clock,next:true,staging,sharing,stdout:()=>{}});
  cleanups.push(()=>app.close());
  app.db.transaction(()=>{
    signin(app).tokens.replace({v:1,tokens:[]},{});
    const store=runtimeStore(app.db);
    store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());
    for(const id of ['a','b'])store.put('box',{id,name:id,owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
  })();
  let n=0;
  const call=(name:string,input:unknown,viewer=owner,id=`op-${++n}`)=>app.operations.call('direct',viewer,name,input,id);
  const token=(role:string)=>{const token=randomBytes(32).toString('hex');signin(app).tokens.change(ts=>ts.push({role,label:`test-${++n}`,sha256:hash(token),created:new Date(clock.now()).toISOString()}));return token;};
  for(const id of ['a','b'])expect(call('signin.setPrincipal',{kind:'runner',id,active:true}).ok).toBe(true);
  const runner=token('runner:a'),other=token('runner:b'),member=token('owner');
  const post=async(token:string,op:string,input:unknown)=> (await fetch(`${app.url}/api/runtime/${op}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({input,id:`http-${++n}`})})).json();
  const input={agent:'art',title:'Fixture start',brief:'PRIVATE start words',source:{kind:'manual',id:'fixture'}};
  const jobOf=(r:ReturnType<typeof call>):string=>{expect(r.ok).toBe(true);return (r as {ok:true;value:{job:string}}).value.job;};
  const schedule=async()=>{const r=call('clock.in',{agent:'art',prompt:'PRIVATE wake words',note:'fixture',when:'1s'});expect(r.ok).toBe(true);const id=(r as {ok:true;value:{id:string}}).value.id;clock.advance(1000);await settle();return id;};
  return {get app(){return app;},clock,call,post,input,jobOf,runner,other,member,schedule,
    get store(){return runtimeStore(app.db);},async restart(){await app.close();app=await startLoom({home,clock,next:true,staging,sharing,stdout:()=>{}});}};
}
it('offers real startBody over HTTP and preserves the source intent across new receipts and restart',async()=>{
  const f=await setup(),r=await f.post(f.member,'startBody',f.input),job=f.jobOf(r);
  expect(r).toEqual({ok:true,value:{job,state:'queued'}});
  await f.restart();
  expect(f.jobOf(f.call('runtime.startBody',f.input))).toBe(job);
  expect(f.store.ids('job')).toEqual([job]);
  expect(f.call('runtime.startBody',{...f.input,brief:'different'})).toMatchObject({ok:false,code:'conflict'});
  expect(f.call('runtime.startBody',f.input,{kind:'runner',id:'a'})).toMatchObject({ok:false,code:'denied'});
  expect(f.call('runtime.startBody',f.input,{kind:'member',id:'pollock'})).toMatchObject({ok:false,code:'denied'});
  expect(JSON.stringify(f.app.db.prepare('SELECT result FROM core_operations').all())).not.toContain('PRIVATE');
  // Expire only operation receipts, avoiding a month of unrelated fake timers.
  f.app.db.prepare('UPDATE core_operations SET expires=?').run(f.clock.now()-1);
  expect(f.jobOf(f.call('runtime.startBody',f.input))).toBe(job);
  expect(f.store.ids('job')).toEqual([job]);
});
it('separates authenticated sources, scopes work centrally and refuses unavailable features before queueing',async()=>{
  const f=await setup();
  const own=f.jobOf(f.call('runtime.startBody',f.input,{kind:'agent',id:'art'}));
  const member=f.jobOf(f.call('runtime.startBody',f.input));expect(own).not.toBe(member);
  for(const input of [{...f.input,agent:'mark'},{...f.input,project:'unknown'},{...f.input,member:'pollock'}])
    expect(f.call('runtime.startBody',input,{kind:'agent',id:'art'})).toMatchObject({ok:false,code:'denied'});
  for(const input of [{...f.input,member:'jonathan'},{...f.input,account:'account'}])
    expect(f.call('runtime.startBody',input)).toMatchObject({ok:false,code:'unavailable'});
  expect(f.store.ids('job').sort()).toEqual([own,member].sort());
});
it('passes the requested model to the one-time runner input, without claiming it has started',async()=>{
  const f=await setup(),job=f.jobOf(f.call('runtime.startBody',{...f.input,model:'fixture-model'}));
  expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
  expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:true,value:{model:'fixture-model'}});
  expect(f.store.read('job',job)?.state).toBe('starting');
});
it('keeps the wake firing through queue, wrong runner, claim and input; only confirmation fires it',async()=>{
  const f=await setup(true),id=await f.schedule(),job=f.store.ids('job')[0];
  expect(wake(f.app.db,id)?.state).toBe('firing');
  expect(await f.post(f.other,'claimJob',{job})).toMatchObject({ok:false,code:'denied'});
  expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
  expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
  expect(wake(f.app.db,id)?.state).toBe('firing');
  expect(f.call('core.releaseEffect',{id:`runtime:input:${job}`}).ok).toBe(true);
  expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:true,value:{brief:'PRIVATE wake words'}});
  expect(wake(f.app.db,id)?.state).toBe('firing');
  expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
  await settle();expect(wake(f.app.db,id)).toMatchObject({state:'fired',outcome:job});
  expect(await f.post(f.runner,'finishJob',{job,state:'done'})).toMatchObject({ok:true});
  expect(f.store.ids('job')).toEqual([job]);
});
it('holds a staging start and keeps an unconfirmed normal start uncertain without another dispatch',async()=>{
  const f=await setup(true),id=await f.schedule(),job=f.store.ids('job')[0];
  await f.post(f.runner,'claimJob',{job});await f.post(f.runner,'takeInput',{job});
  f.clock.advance(START_CONFIRM_MS);await settle();
  expect(wake(f.app.db,id)).toMatchObject({state:'held',hold:'staging'});
  const normal=await setup(),otherWake=await normal.schedule(),only=normal.store.ids('job')[0];
  normal.clock.advance(START_CONFIRM_MS);await settle();
  expect(wake(normal.app.db,otherWake)).toMatchObject({state:'held',hold:'uncertain'});
  await normal.restart();normal.clock.advance(3600_000);await settle();
  expect(normal.store.ids('job')).toEqual([only]);
  expect(wake(normal.app.db,otherWake)?.state).toBe('held');
});
it('records a definite pre-queue refusal and creates no runtime job',async()=>{
  const f=await setup();f.app.db.transaction(()=>f.app.db.prepare('DELETE FROM runtime_boxes').run())();
  const id=await f.schedule();
  expect(wake(f.app.db,id)).toMatchObject({state:'pending',failures:1});
  expect(f.store.ids('job')).toEqual([]);
});
it('does not requeue after restart during dispatch or after losing confirmation',async()=>{
  const f=await setup(),id=await f.schedule(),job=f.store.ids('job')[0];
  await f.post(f.runner,'claimJob',{job});
  await f.restart();await settle();
  expect(wake(f.app.db,id)).toMatchObject({state:'held',hold:'uncertain'});
  f.clock.advance(3600_000);await settle();expect(f.store.ids('job')).toEqual([job]);
});
it('waits for the real outcome and closes pending waiters without claiming a start',async()=>{
  const f=await setup(),runtime=clockRuntime(f.app,f.app.effects!);
  const pending=runtime.startBody({viewer:owner,intent:'attempt',wake:{id:'w-fixture',agent:'art',prompt:'work',note:'fixture',due:1,state:'firing',createdAt:1,changedAt:1,by:owner,failures:0}});
  await f.app.close();expect(await pending).toMatchObject({state:'uncertain'});
});
it('never calls a rejected retry definitely unstarted when this wake already has an accepted intent',async()=>{
  const f=await setup(),id=await f.schedule(),original=wake(f.app.db,id)!;
  const result=await clockRuntime(f.app,f.app.effects!).startBody({viewer:owner,intent:'different-attempt',wake:{...original,prompt:'changed work'}});
  expect(result).toMatchObject({state:'uncertain'});
  expect(f.store.ids('job')).toHaveLength(1);
});
it('replays explicit placement without re-authorizing a revoked box and rejects changed placement intent',async()=>{
  const f=await setup(),input={...f.input,box:'a'},job=f.jobOf(f.call('runtime.startBody',input));
  f.app.db.transaction(()=>{const {changedAt:_,...box}=f.store.read('box','a')!;f.store.put('box',{...box,revokedAt:0,mayHost:[]},f.clock.now());})();
  expect(f.jobOf(f.call('runtime.startBody',input))).toBe(job);
  expect(f.call('runtime.startBody',f.input)).toMatchObject({ok:false,code:'conflict'});
  const auto={...f.input,source:{kind:'manual',id:'auto'}};
  // Use another box for the automatic placement fixture.
  f.app.db.transaction(()=>f.store.put('settings',{id:'art',agent:'art',boxes:['b'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},f.clock.now()))();
  f.jobOf(f.call('runtime.startBody',auto));
  expect(f.call('runtime.startBody',{...auto,box:'b'})).toMatchObject({ok:false,code:'conflict'});
});
it('keeps source-less operation identity after restart and receipt expiry',async()=>{
  const f=await setup(),{source:_,...input}=f.input;
  const job=f.jobOf(f.call('runtime.startBody',input,owner,'source-less'));
  await f.restart();f.app.db.prepare('UPDATE core_operations SET expires=?').run(f.clock.now()-1);
  expect(f.jobOf(f.call('runtime.startBody',input,owner,'source-less'))).toBe(job);
  expect(f.call('runtime.startBody',{...input,brief:'changed'},owner,'source-less')).toMatchObject({ok:false,code:'conflict'});
});
it.each(['file','continuation','slot','approval','local','missing-house'])('holds %s work through the installed Clock without creating a job',async feature=>{
  const f=await setup();
  if(feature==='missing-house') f.app.db.prepare('DELETE FROM runtime_settings').run();
  const extra=feature==='file'?{file:'routines/upkeep.md'}:feature==='local'?{prompt:'<!-- house: local -->\nWork'}:
    feature==='missing-house'?{prompt:'work'}:{prompt:'work',[feature]:'fixture'};
  const result=f.call('clock.in',{agent:'art',note:'fixture',when:'1s',...extra});expect(result.ok).toBe(true);
  const {id}=(result as {ok:true;value:Wake}).value;f.clock.advance(1000);await settle();
  expect(wake(f.app.db,id)).toMatchObject({state:'held'});expect(f.store.ids('job')).toEqual([]);
});
it('holds a file-backed lane run-now through the actual Clock adapter',async()=>{
  const f=await setup(),lane=f.call('clock.laneSet',{name:'upkeep',agent:'art',at:'03:31',text:'work',source:'routines/upkeep.md'});
  expect(lane.ok).toBe(true);const id=(lane as {ok:true;value:{id:string}}).value.id;
  const result=f.call('clock.scheduleRun',{id});expect(result.ok).toBe(true);
  const work=(result as {ok:true;value:Wake}).value;f.clock.advance(0);await settle();
  expect(wake(f.app.db,work.id)).toMatchObject({state:'held'});expect(f.store.ids('job')).toEqual([]);
});
it('keeps terminal-without-confirmation uncertain and accepts waiting as runner confirmation',async()=>{
  const f=await setup(),id=await f.schedule(),job=f.store.ids('job')[0];
  await f.post(f.runner,'claimJob',{job});
  await f.post(f.runner,'finishJob',{job,state:'failed'});await settle();
  expect(wake(f.app.db,id)).toMatchObject({state:'held',hold:'uncertain'});
  expect(f.call('clock.now',{id})).toMatchObject({ok:false,code:'invalid'});
  expect(f.store.ids('job')).toEqual([job]);
  const other=await setup(),otherWake=await other.schedule(),otherJob=other.store.ids('job')[0];
  await other.post(other.runner,'claimJob',{job:otherJob});
  await other.post(other.runner,'reportJob',{job:otherJob,state:'waiting'});await settle();
  expect(wake(other.app.db,otherWake)).toMatchObject({state:'fired',outcome:otherJob});
});
it('publishes only metadata for successful starts and emits no brief words',async()=>{
  const f=await setup(),changed=vi.spyOn(f.app.live,'changed');
  const job=f.jobOf(f.call('runtime.startBody',f.input));
  for(const name of ['runtime.listJobs','runtime.listSettings','runtime.listBindings']) {
    const result=f.call(name,{});expect(result.ok).toBe(true);expect(JSON.stringify(result)).not.toContain(f.input.brief);
  }
  expect(f.store.read('job',job)).toMatchObject({state:'queued'});
  expect(JSON.stringify(changed.mock.calls)).not.toContain(f.input.brief);
});
it('keeps agent-scoped service starts denied with missing, partial, complete and revoked grants',async()=>{
  const access=fixtureSharing(),f=await setup(false,()=>access),service:Viewer={kind:'service',id:'worker'};
  for(const grants of [{types:[],operations:[]},{types:['runtime.job'],operations:[]},
    {types:[],operations:['runtime.startBody']},{types:['runtime.job'],operations:['runtime.startBody']},
    {types:[],operations:[]}]) {
    access.services.worker=grants;
    // Central mayCreate separately checks the agent scope; a service type grant
    // does not confer that agent's authority, even with an operation grant.
    expect(f.call('runtime.startBody',f.input,service)).toMatchObject({ok:false,code:'denied'});
  }
  expect(f.store.ids('job')).toEqual([]);
});
it('updates a late-confirmed job without unholding its wake or creating another start',async()=>{
  const f=await setup(),id=await f.schedule(),job=f.store.ids('job')[0];
  f.clock.advance(START_CONFIRM_MS);await settle();
  expect(wake(f.app.db,id)).toMatchObject({state:'held',hold:'uncertain'});
  expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
  expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
  expect(f.store.read('job',job)?.state).toBe('running');
  expect(wake(f.app.db,id)).toMatchObject({state:'held',hold:'uncertain'});
  expect(f.call('clock.now',{id})).toMatchObject({ok:false,code:'invalid'});
  expect(f.store.ids('job')).toEqual([job]);
});
