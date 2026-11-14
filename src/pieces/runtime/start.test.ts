import { CLOCK_BRIEF } from './clock-delivery.js';
import { builtinServices } from '../../core/services.js';
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
import { hearJob, jobHeard } from './heartbeat.js';
import { wake, wakes } from '../clock/store.js';
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
  const schedule=async(viewer=owner)=>{const r=call('clock.in',{agent:'art',prompt:'PRIVATE wake words',note:'fixture',when:'1s'},viewer);expect(r.ok).toBe(true);const id=(r as {ok:true;value:{id:string}}).value.id;clock.advance(1000);await settle();return id;};
  return {get app(){return app;},clock,call,post,input,jobOf,runner,other,member,schedule,token,
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
  expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:true,value:{brief:CLOCK_BRIEF}});
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
it('holds an uncomposed bridge instead of executing a caller-supplied wake clone',async()=>{
  const f=await setup(),runtime=clockRuntime(f.app,f.app.effects!);
  const pending=runtime.startBody({viewer:owner,intent:'attempt',wake:{id:'w-fixture',agent:'art',prompt:'work',note:'fixture',due:1,state:'firing',createdAt:1,changedAt:1,by:owner,failures:0}});
  expect(await pending).toMatchObject({state:'held'});
  expect(f.store.ids('job')).toEqual([]);await f.app.close();
});
it('never calls a rejected retry definitely unstarted when this wake already has an accepted intent',async()=>{
  const f=await setup(),id=await f.schedule(),original=wake(f.app.db,id)!;
  const result=await f.app.operations.callAsync('direct',{kind:'service',id:'clock'},'runtime.acceptClock',{wake:id,attempt:'different-attempt'},'bad-attempt');
  expect(result).toMatchObject({ok:false,code:'denied'});
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
it.each([{staging:false,runNow:false},{staging:true,runNow:false},{staging:false,runNow:true},{staging:true,runNow:true}])('delivers a stored file-backed lane prompt through the owning inbox ($staging, runNow=$runNow)',async ({staging,runNow})=>{
  const f=await setup(staging),text='Stored household instructions, not a host file read';
  const lane=f.call('clock.laneSet',{name:'upkeep',agent:'art',at:'03:31',text,source:'routines/upkeep.md'});
  expect(lane.ok).toBe(true);const id=(lane as {ok:true;value:{id:string}}).value.id;
  let work:Wake;
  if(runNow){const result=f.call('clock.scheduleRun',{id});expect(result.ok).toBe(true);work=(result as {ok:true;value:Wake}).value;}
  else work=wakes(f.app.db).find(w=>w.schedule===id&&w.state==='pending')!;
  f.clock.advance(work.due-f.clock.now());await settle();
  expect(wakes(f.app.db).filter(w=>w.schedule===id&&w.state==='pending')).toHaveLength(1);
  expect(wake(f.app.db,work.id)).toMatchObject({state:'firing',laneVersion:expect.any(String)});
  const job=f.store.ids('job')[0];expect(job).toBeTruthy();
  expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
  if(staging){
    expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
    expect(f.call('core.releaseEffect',{id:`runtime:input:${job}`}).ok).toBe(true);
  }
  const payload=await f.post(f.runner,'takeInput',{job});
  expect(payload).toMatchObject({ok:true,value:{brief:CLOCK_BRIEF,credential:expect.any(String)}});
  expect(JSON.stringify(payload)).not.toContain(text);
  expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
  expect(wake(f.app.db,work.id)).toMatchObject({state:'fired',outcome:job});
  const body=payload.value.credential;
  if(staging){
    expect(await f.post(body,'readConversation',{})).toMatchObject({ok:false,code:'conflict'});
    expect(f.call('core.releaseEffect',{id:`runtime:clock-read:${job}:1`}).ok).toBe(true);
  }
  expect(await f.post(f.runner,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
  const read=await f.post(body,'readConversation',{});
  expect(read).toMatchObject({ok:true,value:{messages:[{text:work.prompt}]}});
  expect(read.value.messages[0].text).toContain(text);
  expect(await f.post(body,'acknowledgeClockInput',{through:read.value.messages[0].seq})).toMatchObject({ok:true});
  expect(f.store.ids('job')).toEqual([job]);
});
it.each(['local','slot'])('keeps %s household lanes held before any job',async feature=>{
  const f=await setup();
  const lane=f.call('clock.laneSet',{name:'restricted',agent:'art',at:'03:31',text:'Work',
    ...(feature==='local'?{local:true}:{slot:'restricted'})});
  expect(lane.ok).toBe(true);
  const result=f.call('clock.scheduleRun',{id:(lane as {ok:true;value:{id:string}}).value.id});
  expect(result.ok).toBe(true);f.clock.advance(0);await settle();
  expect(wake(f.app.db,(result as {ok:true;value:Wake}).value.id)).toMatchObject({state:'held'});
  expect(f.store.ids('job')).toEqual([]);
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
it('isolates the same source between two member ids and between two authorized agents',async()=>{
  const access=fixtureSharing();access.members.second={owner:true,agents:['art','mark']};
  const f=await setup(false,()=>access);
  f.app.db.transaction(()=>f.store.put('settings',{id:'mark',agent:'mark',boxes:['a'],house:{repo:'/fixture/mark',houseFile:'house/house.json'}},f.clock.now()))();
  const first=f.jobOf(f.call('runtime.startBody',f.input));
  const second=f.jobOf(f.call('runtime.startBody',f.input,{kind:'member',id:'second'}));
  const mark=f.jobOf(f.call('runtime.startBody',{...f.input,agent:'mark'}));
  expect(new Set([first,second,mark]).size).toBe(3);
});
it('keeps the original agent viewer in the installed Clock start path',async()=>{
  const f=await setup(),id=await f.schedule({kind:'agent',id:'art'}),job=f.store.ids('job')[0];
  const member=f.jobOf(f.call('runtime.startBody',{agent:'art',title:'Scheduled work',brief:'PRIVATE wake words',source:{kind:'wake',id}}));
  expect(member).not.toBe(job);
  expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
  expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
  expect(wake(f.app.db,id)).toMatchObject({state:'fired',outcome:job,by:{kind:'agent',id:'art'}});
});

it('issues Clock lane witnesses from current Runtime bindings, never Comms/bridge or copied metadata',async()=>{
 const {clockDestination}=await import('./clock-destination.js');
 const {provenanceStore}=await import('./provenance-store.js');
 const f=await setup(),job=f.jobOf(f.call('runtime.startBody',{...f.input,conversation:'cv-lane'}));
 await f.post(f.runner,'claimJob',{job});await f.post(f.runner,'takeInput',{job});await f.post(f.runner,'reportJob',{job,state:'running'});
 const input={agent:'art',place:'lane:daily'},read=clockDestination(f.app,()=>fixtureSharing());
 expect(read(input)).toBeUndefined();
 f.app.db.transaction(()=>{
  f.store.put('binding',{id:'cv-lane',agent:'art',place:'lane:daily',venue:'wake',job},f.clock.now());
  provenanceStore(f.app.db).note('cv-lane','art',{key:'clock-source',sender:{kind:'unknown'},at:f.clock.now()},['jonathan']);
 })();
 const witness=read(input)!;expect(witness).toMatchObject({agent:'art',conversation:'cv-lane',place:'lane:daily'});expect(witness.current()).toBe(true);
 for(const change of [{place:'lane:other'},{agent:'mark'},{member:'jonathan'},{project:'pond'}])expect(read({...input,...change})).toBeUndefined();
 const binding=f.store.read('binding','cv-lane')!,before=f.store.read('job',job)!;
 for(const change of [{runner:'b',box:'b'},{claimedAt:before.claimedAt!+1}]){
  f.app.db.transaction(()=>{const {changedAt:_,...j}=before;f.store.put('job',{...j,...change},f.clock.now());})();
  expect(witness.current()).toBe(false);expect(read(input)?.current()).toBe(true);
 }
 f.app.db.transaction(()=>{const {changedAt:_,...j}=before;f.store.put('job',j,f.clock.now());})();
 expect(witness.current()).toBe(true);
 for(const change of [{venue:'loom'},{venue:'bridge:discord'},{job:'missing'},{member:'jonathan'},{project:'pond'},{agent:'mark'}]){
  f.app.db.transaction(()=>{const {changedAt:_,...b}=binding;f.store.put('binding',{...b,...change},f.clock.now());})();
  expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
 }
 f.app.db.transaction(()=>{const {changedAt:_,...b}=binding;f.store.put('binding',b,f.clock.now());})();
 expect(witness.current()).toBe(true);
 for(const change of [{state:'done' as const},{endedAt:f.clock.now()},{imported:{history:'unknown' as const}},
  {principalReset:{approval:'a-reset',by:'jonathan',at:f.clock.now()}},{writtenOff:{approval:'a-off',by:'jonathan',at:f.clock.now()}},
  {agent:'mark'},{member:'jonathan'},{project:'pond'},{conversation:'cv-elsewhere'},{service:'slack'},{runner:'b'},{claimedAt:undefined}]){
  f.app.db.transaction(()=>{const {changedAt:_,...j}=before;f.store.put('job',{...j,...change},f.clock.now());})();
  expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
 }
 f.app.db.transaction(()=>{const {changedAt:_,...j}=before;f.store.put('job',j,f.clock.now());
  f.store.put('binding',{id:'cv-replacement',agent:'art',place:'lane:replacement',venue:'wake',job},f.clock.now());})();
 expect(()=>f.app.db.transaction(()=>f.store.put('binding',{id:'cv-duplicate',agent:'art',place:'lane:daily',venue:'wake',job},f.clock.now()))()).toThrow(/UNIQUE/);
 f.app.db.prepare('DELETE FROM runtime_bindings WHERE id=?').run('cv-replacement');
 expect(witness.current()).toBe(true);
 const history=provenanceStore(f.app.db).read('cv-lane')!;
 f.app.db.transaction(()=>provenanceStore(f.app.db).put('cv-lane',{...history,agent:'mark'}))();
 expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
 f.app.db.transaction(()=>provenanceStore(f.app.db).put('cv-lane',history))();
 expect(witness.current()).toBe(true);
 f.app.db.prepare('DELETE FROM runtime_provenance WHERE conversation=?').run('cv-lane');
 expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
});
it('holds a verified Clock join instead of starting a second body',async()=>{
 const f=await setup(),input:Wake={id:'w-join',agent:'art',prompt:'PRIVATE join words',note:'join',schedule:'daily',state:'firing',due:1,createdAt:0,changedAt:0,by:owner,failures:0,
  authorship:{origin:'art',conversation:'cv-own',principal:{for:'owner',people:['jonathan']}}};
 const current=()=>true;
 const runtime=clockRuntime(f.app,f.app.effects!,()=>({agent:'art',place:'lane:daily',conversation:'cv-own',current}));
 const result=runtime.startBody({wake:input,viewer:owner,intent:'join'});f.clock.advance(START_CONFIRM_MS);
 expect(await result).toMatchObject({state:'held'});
 expect(f.store.ids('job')).toEqual([]);
});
it('rechecks independent private member/project access, hosting, policy and shutdown on a Clock witness',async()=>{
 const {clockDestination}=await import('./clock-destination.js');
 const {provenanceStore}=await import('./provenance-store.js');
 const access=structuredClone(fixtureSharing()),f=await setup(false,()=>access);
 const job=f.jobOf(f.call('runtime.startBody',{...f.input,conversation:'cv-private-lane'}));
 await f.post(f.runner,'claimJob',{job});await f.post(f.runner,'takeInput',{job});await f.post(f.runner,'reportJob',{job,state:'running'});
 const input={agent:'art',place:'lane:daily',member:'jonathan',project:'pond'};
 f.app.db.transaction(()=>{
  const {changedAt:_,...j}=f.store.read('job',job)!;
  f.store.put('job',{...j,member:input.member,project:input.project},f.clock.now());
  f.store.put('binding',{id:'cv-private-lane',...input,venue:'wake',job},f.clock.now());
  provenanceStore(f.app.db).note('cv-private-lane','art',{key:'private-clock-source',sender:{kind:'unknown'},at:f.clock.now()},['jonathan']);
 })();
 const read=clockDestination(f.app,()=>access),witness=read(input)!;
 expect(witness).toMatchObject({member:'jonathan',project:'pond'});expect(witness.current()).toBe(true);
 access.projects.pond.agents=[];
 expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();access.projects.pond.agents=['art'];
 access.members.jonathan.agents=[];
 expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();access.members.jonathan.agents=['art'];
 const settings=f.store.read('settings','art')!;
 f.app.db.transaction(()=>{const {changedAt:_,...s}=settings;f.store.put('settings',{...s,house:{repo:'/changed',houseFile:'house/house.json'}},f.clock.now());})();
 expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
 f.app.db.transaction(()=>{const {changedAt:_,...s}=settings;f.store.put('settings',s,f.clock.now());})();
 expect(witness.current()).toBe(true);
 const box=f.store.read('box','a')!;
 f.app.db.transaction(()=>{const {changedAt:_,...b}=box;f.store.put('box',{...b,revokedAt:f.clock.now()},f.clock.now());})();
 expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
 f.app.db.transaction(()=>{const {changedAt:_,...b}=box;f.store.put('box',b,f.clock.now());})();
 expect(witness.current()).toBe(true);
 f.app.db.transaction(()=>{const {changedAt:_,...b}=box;f.store.put('box',{...b,mayHost:[]},f.clock.now());})();
 expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
 f.app.db.transaction(()=>{const {changedAt:_,...b}=box;f.store.put('box',b,f.clock.now());})();
 expect(witness.current()).toBe(true);
 f.app.db.prepare('INSERT INTO runtime_body_policy(agent,record) VALUES (?,?)').run('art','{}');
 expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
 f.app.db.prepare('DELETE FROM runtime_body_policy WHERE agent=?').run('art');
 expect(witness.current()).toBe(true);
 await f.app.close();expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();
});
it('uses the destination reader in installed Clock dispatch and rechecks memberless project policy',async()=>{
 const {clockDestination}=await import('./clock-destination.js');
 const {provenanceStore}=await import('./provenance-store.js');
 const access=structuredClone(fixtureSharing()),f=await setup(false,()=>access);
 access.services=builtinServices(f.app.db);
 const job=f.jobOf(f.call('runtime.startBody',{...f.input,conversation:'cv-clock-lane',project:'pond'}));
 await f.post(f.runner,'claimJob',{job});await f.post(f.runner,'takeInput',{job});await f.post(f.runner,'reportJob',{job,state:'running'});
 const input={agent:'art',project:'pond',place:'lane:daily'};
 f.app.db.transaction(()=>{
  f.store.put('binding',{id:'cv-clock-lane',...input,venue:'wake',job},f.clock.now());
  provenanceStore(f.app.db).note('cv-clock-lane','art',{key:'clock-source',sender:{kind:'unknown'},at:f.clock.now()},['jonathan']);
 })();
 const read=clockDestination(f.app,()=>access),witness=read(input)!;expect(witness.current()).toBe(true);
 access.projects.pond.agents=[];expect(witness.current()).toBe(false);expect(read(input)).toBeUndefined();access.projects.pond.agents=['art'];
 const result=f.call('clock.in',{...input,prompt:'PRIVATE scheduled join',note:'join',when:'1s'});expect(result.ok).toBe(true);
 const id=(result as {ok:true;value:{id:string}}).value.id,scheduled=wake(f.app.db,id)!;
 // The delivery producer is not installed yet: seed only owning routing metadata
 // in this fixture. The real Clock daemon and next composition then run normally.
 scheduled.authorship={origin:'art',conversation:'cv-clock-lane',project:'pond',principal:{for:'?',people:[]}};
 f.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(scheduled),id);
 f.clock.advance(1000);await settle();
 expect(wake(f.app.db,id)).toMatchObject({state:'held'});
 expect(f.app.db.prepare('SELECT * FROM runtime_clock_turns').all()).toEqual([]);
 expect(f.store.ids('job')).toEqual([job]);
});

it('creates a real wake binding and joins only after the authenticated body reads the new input',async()=>{
 const f=await setup();
 const initial=f.call('clock.in',{agent:'art',prompt:'First lane input',note:'lane',place:'lane:daily',when:'1s'});
 expect(initial.ok).toBe(true);f.clock.advance(1000);await settle();
 const job=f.store.ids('job')[0];expect(job).toBeTruthy();
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const payload=await f.post(f.runner,'takeInput',{job});
 expect(payload).toMatchObject({ok:true,value:{brief:CLOCK_BRIEF,credential:expect.any(String),conversation:expect.any(String)}});
 const body=payload.value.credential;
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'First lane input'}]}});
 const cv=payload.value.conversation;
 expect(f.store.read('binding',cv)).toMatchObject({venue:'wake',place:'lane:daily',job});
 const filed=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${body}`},body:JSON.stringify({id:'body-chain',input:{agent:'art',prompt:'Joined lane input',note:'chain',place:'lane:daily',when:'1s'}})})).json();
 expect(filed.ok).toBe(true);
 expect(wake(f.app.db,filed.value.id)?.authorship).toMatchObject({origin:'art',conversation:cv,principal:{for:'owner'}});
 f.clock.advance(1000);await settle();
 expect(f.store.ids('job')).toEqual([job]);expect(wake(f.app.db,filed.value.id)?.state).toBe('firing');
 expect(await f.post(f.runner,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.member,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'First lane input'},{text:'Joined lane input'}]}});
 await settle();expect(wake(f.app.db,filed.value.id)?.state).toBe('firing');
 expect(await f.post(f.runner,'acknowledgeClockInput',{through:2})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'acknowledgeClockInput',{through:999})).toMatchObject({ok:false,code:'conflict'});
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'First lane input'},{text:'Joined lane input'}]}});
 expect(await f.post(body,'acknowledgeClockInput',{through:2})).toMatchObject({ok:true});
 await settle();expect(wake(f.app.db,filed.value.id)).toMatchObject({state:'fired',outcome:job});
 expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_clock_turns').get()).toEqual({n:2});
 expect(JSON.stringify(f.app.db.prepare('SELECT result FROM core_operations WHERE name LIKE ?').all('runtime.%'))).not.toContain('Joined lane input');
 // The permanent sender history survives consumption and restart. A copied viewer gets none.
 await f.restart();
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'First lane input'},{text:'Joined lane input'}]}});
 const after=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${body}`},body:JSON.stringify({id:'after-restart',input:{agent:'art',prompt:'After restart',note:'history',when:'1h'}})})).json();
 expect(after.ok).toBe(true);
 expect(wake(f.app.db,after.value.id)?.authorship).toMatchObject({origin:'art',conversation:cv,principal:{for:'owner',people:['jonathan']}});
 expect(JSON.parse((f.app.db.prepare('SELECT record FROM runtime_provenance WHERE conversation=?').get(cv) as {record:string}).record).history).toMatchObject({owners:['jonathan'],owner:true,unknown:false});

 const raced=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${body}`},body:JSON.stringify({id:'raced-join',input:{agent:'art',prompt:'Cancelled during read preparation',note:'race',place:'lane:daily',when:'1s'}})})).json();
 expect(raced.ok).toBe(true);f.clock.advance(1000);await settle();
 const authenticated=signin(f.app).token(hash(body))!.viewer;
 const prepared=f.app.operations.callAsync('direct',authenticated,'runtime.readConversation',{},'raced-read');
 expect(f.call('clock.cancel',{id:raced.value.id}).ok).toBe(true);
 expect(await prepared).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${raced.value.id}`)).toEqual({consumed:null});
 const following=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${body}`},body:JSON.stringify({id:'following-join',input:{agent:'art',prompt:'Valid after cancellation',note:'following',place:'lane:daily',when:'1s'}})})).json();
 expect(following.ok).toBe(true);f.clock.advance(1000);await settle();
 const followingRead=await f.post(body,'readConversation',{});expect(followingRead.ok).toBe(true);
 expect(followingRead.value.messages.map((m:{text:string})=>m.text)).toEqual(['First lane input','Joined lane input','Valid after cancellation']);
 const through=followingRead.value.messages.at(-1).seq;
 expect(await f.post(body,'acknowledgeClockInput',{through})).toMatchObject({ok:true});await settle();
 expect(wake(f.app.db,following.value.id)).toMatchObject({state:'fired',outcome:job});
 expect(f.store.ids('job')).toEqual([job]);
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${raced.value.id}`)).toEqual({consumed:null});

 const box=f.store.read('box','a')!;
 f.app.db.transaction(()=>{const {changedAt:_,...b}=box;f.store.put('box',{...b,revokedAt:f.clock.now()},f.clock.now());})();
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
});

it('holds both initial and joined scheduled words behind staging, then confirms only the bound read',async()=>{
 const f=await setup(true);
 const initial=f.call('clock.in',{agent:'art',prompt:'Staged first input',note:'lane',place:'lane:staged',when:'1s'});
 expect(initial.ok).toBe(true);f.clock.advance(1000);await settle();const job=f.store.ids('job')[0];
 await f.post(f.runner,'claimJob',{job});
 expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
 expect(f.call('core.releaseEffect',{id:`runtime:input:${job}`}).ok).toBe(true);
 const payload=await f.post(f.runner,'takeInput',{job}),body=payload.value.credential;
 await f.post(f.runner,'reportJob',{job,state:'running'});await settle();
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:false,code:'conflict'});
 expect(f.call('core.releaseEffect',{id:`runtime:clock-read:${job}:1`}).ok).toBe(true);
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'Staged first input'}]}});
 const r=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${body}`},body:JSON.stringify({id:'staged-chain',input:{agent:'art',prompt:'Staged joined input',note:'chain',place:'lane:staged',when:'1s'}})})).json();
 expect(r.ok).toBe(true);f.clock.advance(1000);await settle();
 expect(f.store.ids('job')).toEqual([job]);expect(wake(f.app.db,r.value.id)?.state).toBe('firing');
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:false,code:'conflict'});
 expect(await f.post(body,'acknowledgeClockInput',{through:2})).toMatchObject({ok:false,code:'conflict'});
 expect(f.call('core.releaseEffect',{id:`runtime:clock-read:${job}:2`}).ok).toBe(true);
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'Staged first input'},{text:'Staged joined input'}]}});
 expect(await f.post(body,'acknowledgeClockInput',{through:2})).toMatchObject({ok:true});
 await settle();expect(wake(f.app.db,r.value.id)).toMatchObject({state:'fired',outcome:job});
});

it('rechecks original Clock source authority at the words boundary, without accepting cloned source data',async()=>{
 const access=structuredClone(fixtureSharing()),f=await setup(false,()=>access);access.services=builtinServices(f.app.db);
 const r=f.call('clock.in',{agent:'art',prompt:'Revocable scheduled input',note:'source',place:'lane:revocable',when:'1s'});
 expect(r.ok).toBe(true);const id=(r as {ok:true;value:{id:string}}).value.id;
 f.clock.advance(1000);await settle();const job=f.store.ids('job')[0],attempt=wake(f.app.db,id)!.attempt!;
 expect(f.call('runtime.acceptClock',{wake:id,attempt,prompt:'forged words'},{kind:'service',id:'clock'})).toMatchObject({ok:false,code:'invalid'});
 expect(f.call('runtime.acceptClock',{wake:id,attempt:'forged-attempt'},{kind:'service',id:'clock'})).toMatchObject({ok:false,code:'denied'});
 await f.post(f.runner,'claimJob',{job});const payload=await f.post(f.runner,'takeInput',{job});
 await f.post(f.runner,'reportJob',{job,state:'running'});await settle();
 access.members.jonathan.agents=[];
 expect(await f.post(payload.value.credential,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns').get()).toEqual({consumed:null});
 access.members.jonathan.agents=['art'];
 expect(await f.post(payload.value.credential,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'Revocable scheduled input'}]}});
 access.members.jonathan.agents=[];
 expect(await f.post(payload.value.credential,'acknowledgeClockInput',{through:1})).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns').get()).toEqual({consumed:null});
 access.members.jonathan.agents=['art'];
 expect(await f.post(payload.value.credential,'acknowledgeClockInput',{through:1})).toMatchObject({ok:true});
 access.members.jonathan.agents=[];
 expect(await f.post(payload.value.credential,'readConversation',{})).toMatchObject({ok:false,code:'denied'});

});

it('issues the original restricted service on the scheduled body credential, separately from Clock dispatch',async()=>{
 const f=await setup(),restricted=f.token('agent:art/restricted');
 const r=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${restricted}`},body:JSON.stringify({id:'restricted-source',input:{agent:'art',prompt:'Restricted scheduled input',note:'source',when:'1s'}})})).json();
 expect(r.ok).toBe(true);const id=r.value.id;
 expect(wake(f.app.db,id)?.authorship).toMatchObject({origin:'art',service:'restricted',principal:{for:'?'}});
 f.clock.advance(1000);await settle();const job=f.store.ids('job')[0];
 expect(f.store.read('job',job)?.service).toBe('restricted');
 await f.post(f.runner,'claimJob',{job});const payload=await f.post(f.runner,'takeInput',{job});
 expect(payload.ok).toBe(true);const viewer=signin(f.app).token(hash(payload.value.credential))!.viewer;
 expect(signin(f.app).body(viewer)).toMatchObject({agent:'art',job,service:'restricted'});
 await f.post(f.runner,'reportJob',{job,state:'running'});await settle();
 expect(await f.post(payload.value.credential,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'Restricted scheduled input'}]}});
});

it('requires the exact Clock cross-piece type and operation grants before acceptance and replay',async()=>{
 const access=structuredClone(fixtureSharing()),f=await setup(false,()=>access);access.services=builtinServices(f.app.db);
 const r=f.call('clock.in',{agent:'art',prompt:'Granted scheduled input',note:'grant',when:'1s'});
 expect(r.ok).toBe(true);const id=(r as {ok:true;value:{id:string}}).value.id;
 f.clock.advance(1000);const attempt=wake(f.app.db,id)!.attempt!,grant=access.services.clock;
 for(const denied of [{...grant,types:grant.types.filter(t=>t!=='runtime.job')},{...grant,operations:grant.operations.filter(op=>op!=='runtime.acceptClock')}]){
  access.services={...access.services,clock:denied};
  expect(f.call('runtime.acceptClock',{wake:id,attempt},{kind:'service',id:'clock'})).toMatchObject({ok:false,code:'denied'});
  expect(f.store.ids('job')).toEqual([]);expect(f.store.ids('binding')).toEqual([]);
 }
 access.services={...access.services,clock:grant};
 const accepted=f.call('runtime.acceptClock',{wake:id,attempt},{kind:'service',id:'clock'},'grant-accept');
 expect(accepted.ok).toBe(true);
 access.services={...access.services,clock:{...grant,operations:[]}};
 expect(f.call('runtime.acceptClock',{wake:id,attempt},{kind:'service',id:'clock'},'grant-accept')).toMatchObject({ok:false,code:'denied'});
 expect(f.store.ids('job')).toHaveLength(1);
 access.services={...access.services,clock:grant};await settle();
});

it('rolls back the complete owning acceptance after a late provenance write failure',async()=>{
 const f=await setup(),r=f.call('clock.in',{agent:'art',prompt:'Atomic scheduled input',note:'atomic',place:'lane:atomic',when:'1s'});
 expect(r.ok).toBe(true);const id=(r as {ok:true;value:{id:string}}).value.id;
 f.clock.advance(1000);const attempt=wake(f.app.db,id)!.attempt!;
 f.app.db.exec("CREATE TEMP TRIGGER fail_clock_provenance BEFORE INSERT ON runtime_provenance_sources BEGIN SELECT RAISE(ABORT,'fixture interrupted acceptance'); END");
 expect(f.call('runtime.acceptClock',{wake:id,attempt},{kind:'service',id:'clock'})).toMatchObject({ok:false,code:'unavailable'});
 for(const table of ['runtime_bindings','runtime_jobs','runtime_inputs','runtime_clock_turns','runtime_provenance','runtime_provenance_sources'])
  expect(f.app.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({n:0});
 f.app.db.exec('DROP TRIGGER fail_clock_provenance');
 expect(f.call('runtime.acceptClock',{wake:id,attempt},{kind:'service',id:'clock'}).ok).toBe(true);
 expect(f.store.ids('job')).toHaveLength(1);expect(f.store.ids('binding')).toHaveLength(1);
 expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_clock_turns').get()).toEqual({n:1});
 await settle();
});

it('uses real scheduled-body provenance for agent-authored six-hour self-rearm suppression',async()=>{
 const f=await setup();await f.schedule();const job=f.store.ids('job')[0];
 await f.post(f.runner,'claimJob',{job});const payload=await f.post(f.runner,'takeInput',{job}),body=payload.value.credential;
 await f.post(f.runner,'reportJob',{job,state:'running'});await settle();
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true});
 expect(await f.post(body,'acknowledgeClockInput',{through:1})).toMatchObject({ok:true});
 const clockCall=async(token:string,operation:string,input:unknown,id:string)=>(await fetch(`${f.app.url}/api/clock/${operation}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({id,input})})).json();
 const scheduled=await clockCall(body,'scheduleSet',{agent:'art',id:'art/self-rearm',at:'13:17',file:'routines/care.md',note:'schedule'},'body-schedule');
 expect(scheduled.ok).toBe(true);
 const occurrence=wakes(f.app.db).find(w=>w.schedule==='art/self-rearm')!,input={agent:'art',file:'routines/care.md',note:'self-rearm',when:`${(occurrence.due-f.clock.now())/1000}s`};
 // The originating conversation's twenty one-off slots are full. A schedule
 // acknowledgement must not allocate or require a twenty-first slot.
 for(let n=0;n<20;n++)expect(await clockCall(body,'in',{agent:'art',prompt:'Independent future work',note:'capacity',when:'2d'},`body-capacity-${n}`)).toMatchObject({ok:true});
 expect(await clockCall(body,'in',{agent:'art',prompt:'Over capacity',note:'capacity',when:'2d'},'body-over-capacity')).toMatchObject({ok:false,code:'invalid'});
 const before=wakes(f.app.db).length;
 expect(await clockCall(body,'in',input,'body-rearm')).toEqual({ok:true,value:{alreadyScheduled:true,schedule:'art/self-rearm',due:occurrence.due}});
 expect(wakes(f.app.db)).toHaveLength(before);
 const unbound=f.token('agent:art');
 expect(await clockCall(unbound,'in',input,'unbound-rearm')).toMatchObject({ok:true,value:{state:'pending'}});
});
it.each([false,true].flatMap(staging=>['once','recurring','runNow'].map(mode=>({staging,mode}))))('delivers private timed words only to its authenticated body ($mode, staging=$staging)',async ({staging,mode})=>{
 const access=structuredClone(fixtureSharing()),f=await setup(staging,()=>access);access.services=builtinServices(f.app.db);
 const input={agent:'art',member:'jonathan',project:'pond',prompt:'PRIVATE timed household words',note:'private'};
 const made=await f.app.operations.callAsync('socket',owner,mode==='once'?'clock.in':'clock.scheduleSet',mode==='once'?{...input,when:'1s'}:{...input,id:'private-care',at:'03:31'},'private-timer',true);
 expect(made.ok).toBe(true);
 if(mode==='runNow')expect(await f.app.operations.callAsync('socket',owner,'clock.scheduleRun',{id:'private-care'},'private-run',true)).toMatchObject({ok:true});
 const work=wakes(f.app.db).filter(w=>w.member==='jonathan').sort((a,b)=>a.due-b.due)[0];
 f.clock.advance(work.due-f.clock.now());await settle();
 if(mode!=='once')expect(wakes(f.app.db).filter(w=>w.schedule==='private-care'&&w.state==='pending')).toHaveLength(1);
 expect(wake(f.app.db,work.id)).toMatchObject({state:'firing'});
 const job=f.store.ids('job')[0];expect(job).toBeTruthy();
 expect(f.store.read('job',job)).toMatchObject({member:'jonathan',project:'pond'});
 expect(await f.post(f.other,'claimJob',{job})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 if(staging){
  expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
  expect(f.call('core.releaseEffect',{id:`runtime:input:${job}`}).ok).toBe(true);
 }
 const payload=await f.post(f.runner,'takeInput',{job});
 expect(payload).toMatchObject({ok:true,value:{brief:CLOCK_BRIEF,credential:expect.any(String)}});
 expect(JSON.stringify(payload)).not.toContain(work.prompt);
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
 expect(wake(f.app.db,work.id)?.state).toBe('fired');
 const body=payload.value.credential;
 for(const token of [f.runner,f.member,f.token('agent:art')])
  expect(await f.post(token,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
 if(staging){
  expect(await f.post(body,'readConversation',{})).toMatchObject({ok:false,code:'conflict'});
  expect(f.call('core.releaseEffect',{id:`runtime:clock-read:${job}:1`}).ok).toBe(true);
 }
 const read=await f.post(body,'readConversation',{});
 expect(read).toMatchObject({ok:true,value:{messages:[{text:work.prompt}]}});
 const ack=async()=> (await fetch(`${f.app.url}/api/runtime/acknowledgeClockInput`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${body}`},body:JSON.stringify({id:'private-ack-replay',input:{through:read.value.messages[0].seq}})})).json();
 expect(await ack()).toMatchObject({ok:true});
 const committed=wake(f.app.db,work.id)!;
 f.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...committed,member:'pollock'}),work.id);
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'acknowledgeClockInput',{through:read.value.messages[0].seq})).toMatchObject({ok:false,code:'denied'});
 f.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(committed),work.id);
 // Revocation is checked on both read and ACK, including a replay receipt.
 access.members.jonathan.agents=[];
 expect(await ack()).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'acknowledgeClockInput',{through:read.value.messages[0].seq})).toMatchObject({ok:false,code:'denied'});
 access.members.jonathan.agents=['art'];access.projects.pond.agents=[];
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:false,code:'denied'});
 access.projects.pond.agents=['art'];
 expect(await ack()).toMatchObject({ok:true});
 expect(await f.post(body,'acknowledgeClockInput',{through:read.value.messages[0].seq})).toMatchObject({ok:true});
 // A self-rearm inherits member/project from the owning Clock body.
 const chain=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${body}`},body:JSON.stringify({id:'private-chain',input:{agent:'art',prompt:'PRIVATE chained words',note:'chain',when:'1s'}})})).json();
 expect(chain).toMatchObject({ok:true});expect(JSON.stringify(chain)).not.toContain('PRIVATE chained words');
 const next=wakes(f.app.db).find(w=>w.prompt==='PRIVATE chained words')!;
 expect(next).toMatchObject({member:'jonathan',project:'pond',authorship:{member:'jonathan',project:'pond',principal:{for:'owner',people:['jonathan']}}});
 f.clock.advance(1000);await settle();expect(wake(f.app.db,next.id)?.state).toBe('firing');
 expect(f.store.ids('job')).toHaveLength(2);
 if(!staging&&mode==='once'){
  // Demotion preserves agent/project grants but must narrow named steering.
  access.projects.pond.members.push('jonathan');access.members.jonathan.owner=false;
  const child=f.store.ids('job').find(id=>id!==job)!;
  expect(await f.post(f.runner,'claimJob',{job:child})).toMatchObject({ok:true});
  const childInput=await f.post(f.runner,'takeInput',{job:child});expect(childInput.ok).toBe(true);
  expect(await f.post(f.runner,'reportJob',{job:child,state:'running'})).toMatchObject({ok:true});
  expect(await f.post(childInput.value.credential,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:next.prompt}]}});
  const third=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${childInput.value.credential}`},body:JSON.stringify({id:'demoted-rearm',input:{agent:'art',prompt:'After owner demotion',note:'chain',when:'1s'}})})).json();
  expect(third).toMatchObject({ok:true});
  expect(wakes(f.app.db).find(w=>w.prompt==='After owner demotion')).toMatchObject({member:'jonathan',authorship:{principal:{for:'jonathan',people:['jonathan']}}});
 }
});

it.each(['place','claim','runner','box','house'] as const)('pins the original Clock %s across asynchronous read preparation',async changed=>{
 const f=await setup(),id=await f.schedule(),job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const payload=await f.post(f.runner,'takeInput',{job});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
 const viewer=signin(f.app).token(hash(payload.value.credential))!.viewer;
 const before=f.store.read('job',job)!,binding=f.store.read('binding',before.conversation!)!;
 const pending=f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{});
 f.app.db.transaction(()=>{
  const {changedAt:_,...j}=before;
  if(changed==='place'){
   const {changedAt:__,...b}=binding;f.store.put('binding',{...b,place:'lane:replacement'},f.clock.now());
  }else if(changed==='claim')f.store.put('job',{...j,claimedAt:before.claimedAt!+1},f.clock.now());
  else if(changed==='runner')f.store.put('job',{...j,runner:'b'},f.clock.now());
  else if(changed==='box')f.store.put('job',{...j,box:'b'},f.clock.now());
  else {
   const settings=f.store.read('settings','art')!;
   const {changedAt:__,...s}=settings;
   const house={repo:'/fixture/replacement',houseFile:'house/house.json'};
   f.store.put('settings',{...s,house},f.clock.now());
   f.store.put('job',{...j,made:house},f.clock.now());
  }
 })();
 expect(await pending).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${id}`)).toEqual({consumed:null});
 // A new read can independently authorize the replacement; the stale prepared
 // words never acquire authority from it. Ordinary progress is not a rebind.
 expect(await f.post(payload.value.credential,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'PRIVATE wake words'}]}});
});

it('allows Clock progress and heartbeat metadata to change during read preparation',async()=>{
 const f=await setup();await f.schedule();const job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const payload=await f.post(f.runner,'takeInput',{job});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
 const viewer=signin(f.app).token(hash(payload.value.credential))!.viewer;
 const changedAt=f.store.read('job',job)!.changedAt,heardAt=jobHeard(f.app.db,job)!;
 const pending=f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{});
 f.clock.advance(1);
 expect(f.call('runtime.reportJob',{job,state:'waiting'},{kind:'runner',id:'a'})).toMatchObject({ok:true});
 expect(f.store.read('job',job)!.changedAt).toBeGreaterThan(changedAt);
 expect(jobHeard(f.app.db,job)).toBeGreaterThan(heardAt);
 expect(await pending).toMatchObject({ok:true,value:{messages:[{text:'PRIVATE wake words'}]}});
});

it('refuses a destination replaced by the outside gate before marking Clock words released',async()=>{
 const f=await setup(),id=await f.schedule(),job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const payload=await f.post(f.runner,'takeInput',{job});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
 const viewer=signin(f.app).token(hash(payload.value.credential))!.viewer;
 const original=f.app.effects!.beforeOutside.bind(f.app.effects!);
 const gate=vi.spyOn(f.app.effects!,'beforeOutside').mockImplementation(action=>{
  if(action.id.startsWith('runtime:clock-read:'))f.app.db.transaction(()=>{
   const {changedAt:_,...binding}=f.store.read('binding',payload.value.conversation)!;
   f.store.put('binding',{...binding,place:'lane:gate-replacement'},f.clock.now());
  })();
  return original(action);
 });
 try {
  expect(await f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{})).toMatchObject({ok:false,code:'denied'});
  expect(gate).toHaveBeenCalled();
  expect(f.app.db.prepare('SELECT released,consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${id}`)).toEqual({released:null,consumed:null});
 }finally {gate.mockRestore();}
});

it.each(['preparation','outside-gate'] as const)('refuses Clock policy revoked during %s',async boundary=>{
 const access=structuredClone(fixtureSharing()),f=await setup(false,()=>access);access.services=builtinServices(f.app.db);
 const id=await f.schedule(),job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const payload=await f.post(f.runner,'takeInput',{job});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});await settle();
 const viewer=signin(f.app).token(hash(payload.value.credential))!.viewer;
 const original=f.app.effects!.beforeOutside.bind(f.app.effects!);
 const gate=boundary==='outside-gate'?vi.spyOn(f.app.effects!,'beforeOutside').mockImplementation(action=>{
  if(action.id.startsWith('runtime:clock-read:'))access.members.jonathan.agents=[];
  return original(action);
 }):undefined;
 try {
  const pending=f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{});
  if(boundary==='preparation')access.members.jonathan.agents=[];
  expect(await pending).toMatchObject({ok:false,code:'denied'});
  expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${id}`)).toEqual({consumed:null});
  if(boundary==='outside-gate')expect(f.app.db.prepare('SELECT released FROM runtime_clock_turns WHERE id=?').get(`clock:${id}`)).toEqual({released:null});
 }finally {gate?.mockRestore();}
});

it.each(['before-input','during-input'] as const)('denies a public Clock start withdrawn %s',async boundary=>{
 const f=await setup(),id=await f.schedule(),job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 if(boundary==='before-input')expect(f.call('clock.cancel',{id}).ok).toBe(true);
 else {
  const finish=f.app.effects!.finish;
  vi.spyOn(f.app.effects!,'finish').mockImplementation((effect,certain)=>{
   finish(effect,certain);
   if(effect===`runtime:input:${job}`)expect(f.call('clock.cancel',{id}).ok).toBe(true);
  });
 }
 const credentials=signin(f.app).tokens.document();
 expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false,code:'denied'});
 expect(signin(f.app).tokens.document()).toEqual(credentials);
 expect(f.app.db.prepare('SELECT released,consumed FROM runtime_clock_turns').get()).toEqual({released:null,consumed:null});
 if(boundary==='before-input')expect(f.app.effects!.status(`runtime:input:${job}`)).toBeUndefined();
 else expect(f.app.effects!.status(`runtime:input:${job}`)).toBe('done');
});

it.each(['place','claim','conversation','runner','box','house'] as const)('denies a prepared Clock start after an independently valid %s replacement',async field=>{
 const f=await setup();await f.schedule();const job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const original=f.store.read('job',job)!,binding=f.store.read('binding',original.conversation!)!;
 const finish=f.app.effects!.finish;
 const spy=vi.spyOn(f.app.effects!,'finish').mockImplementation((effect,certain)=>{
  finish(effect,certain);
  if(effect!==`runtime:input:${job}`)return;
  f.app.db.transaction(()=>{
   const {changedAt:_,...b}=binding,{changedAt:__,...j}=original;
   if(field==='place')f.store.put('binding',{...b,place:'lane:replacement'},f.clock.now());
   if(field==='claim')f.store.put('job',{...j,claimedAt:j.claimedAt!+1},f.clock.now());
   if(field==='runner')f.store.put('job',{...j,runner:'b'},f.clock.now());
   if(field==='box')f.store.put('job',{...j,box:'b'},f.clock.now());
   if(field==='house'){
    const {changedAt:___,...settings}=f.store.read('settings','art')!;
    const house={repo:'/fixture/replacement',houseFile:'house/house.json'};
    f.store.put('settings',{...settings,house},f.clock.now());
    f.store.put('job',{...j,made:house},f.clock.now());
   }
   if(field==='conversation'){
    const conversation='clock-replacement';
    f.store.put('binding',{...b,id:conversation,place:'lane:new-conversation'},f.clock.now());
    f.store.put('job',{...j,conversation},f.clock.now());
    f.app.db.prepare('UPDATE runtime_clock_turns SET conversation=? WHERE job=?').run(conversation,job);
    f.app.db.prepare('UPDATE runtime_provenance SET conversation=? WHERE conversation=?').run(conversation,binding.id);
   }
  })();
 });
 const credentials=signin(f.app).tokens.document();
 expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false,code:'denied'});
 expect(signin(f.app).tokens.document()).toEqual(credentials);
 spy.mockRestore();
 // A fresh owning read is independently allowed on the replacement; only the
 // one-time input already consumed by the race cannot be released again.
 f.app.db.transaction(()=>{
  const {changedAt:_,...j}=f.store.read('job',job)!;
  f.store.put('job',{...j,state:'running'},f.clock.now());
 })();
 const body=f.app.db.transaction(()=>signin(f.app).issueBody('art',job))();
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'PRIVATE wake words'}]}});
 f.app.db.transaction(()=>{
  const {changedAt:_,...j}=f.store.read('job',job)!;
  f.store.put('job',{...j,state:'starting',runner:'a',box:'a'},f.clock.now());
 })();
 expect(f.app.effects!.status(`runtime:input:${job}`)).toBe('done');
 expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
});

it.each(['withdrawal','place','policy'] as const)('denies Clock input after %s at the final asynchronous boundary',async change=>{
 const f=await setup(),id=await f.schedule(),job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const credentials=signin(f.app).tokens.document();
 const pending=f.app.operations.callAsync('direct',{kind:'runner',id:'a'},'runtime.takeInput',{job});
 expect(f.app.effects!.status(`runtime:input:${job}`)).toBe('done');
 if(change==='withdrawal')expect(f.call('clock.cancel',{id}).ok).toBe(true);
 if(change==='place')f.app.db.transaction(()=>{
  const binding=f.store.read('binding',f.store.read('job',job)!.conversation!)!;
  const {changedAt:_,...b}=binding;
  f.store.put('binding',{...b,place:'lane:final-replacement'},f.clock.now());
 })();
 if(change==='policy')f.app.db.prepare('INSERT INTO runtime_body_policy(agent,record) VALUES (?,?)').run('art','{}');
 expect(await pending).toMatchObject({ok:false,code:'denied'});
 expect(signin(f.app).tokens.document()).toEqual(credentials);
 expect(f.app.db.prepare('SELECT released,consumed FROM runtime_clock_turns').get()).toEqual({released:null,consumed:null});
});

it.each(['before-input','final-release'] as const)('refuses withdrawn private Clock input at %s without issuing credentials',async boundary=>{
 const f=await setup();
 const made=await f.app.operations.callAsync('socket',owner,'clock.in',{
  agent:'art',member:'jonathan',project:'pond',prompt:'PRIVATE withdrawal words',note:'private race',when:'1s',
 },'private-withdrawal',true);
 expect(made.ok).toBe(true);if(!made.ok)throw Error('Fixture filing failed');
 const id=(made.value as {id:string}).id;
 f.clock.advance(1000);await settle();const job=f.store.ids('job')[0];
 expect(f.store.read('job',job)).toMatchObject({member:'jonathan',project:'pond'});
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const credentials=signin(f.app).tokens.document();
 // Window cancellation awaits preparation before committing. Queue it first,
 // then prepare input synchronously so cancellation commits before final release.
 const cancellation=f.app.operations.callAsync('socket',owner,'clock.cancel',{id},'private-cancel',true);
 const pending=boundary==='final-release'?f.app.operations.callAsync('direct',{kind:'runner',id:'a'},'runtime.takeInput',{job}):undefined;
 if(pending)expect(f.app.effects!.status(`runtime:input:${job}`)).toBe('done');
 expect((await cancellation).ok).toBe(true);
 expect(await (pending??f.post(f.runner,'takeInput',{job}))).toMatchObject({ok:false,code:'denied'});
 expect(signin(f.app).tokens.document()).toEqual(credentials);
 expect(f.app.effects!.status(`runtime:input:${job}`)).toBe(pending?'done':undefined);
 expect(f.app.db.prepare('SELECT released,consumed FROM runtime_clock_turns').get()).toEqual({released:null,consumed:null});
});

it('allows advancing Clock heartbeat and non-authority metadata during runner input preparation',async()=>{
 const f=await setup();await f.schedule();const job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 f.app.db.transaction(()=>hearJob(f.app.db,job,f.clock.now()))();
 const before=f.store.read('job',job)!,heard=jobHeard(f.app.db,job)!;
 const pending=f.app.operations.callAsync('direct',{kind:'runner',id:'a'},'runtime.takeInput',{job});
 f.clock.advance(1);
 f.app.db.transaction(()=>{
  const {changedAt:_,...j}=before;
  f.store.put('job',{...j,title:'Updated progress title'},f.clock.now());
  hearJob(f.app.db,job,f.clock.now());
 })();
 expect(f.store.read('job',job)!.changedAt).toBeGreaterThan(before.changedAt);
 expect(jobHeard(f.app.db,job)).toBeGreaterThan(heard);
 expect(await pending).toMatchObject({ok:true,value:{brief:CLOCK_BRIEF,credential:expect.any(String)}});
});

it.each(['before-input','final-release'] as const)('denies public Clock input after owning source policy revocation at %s',async boundary=>{
 const access=structuredClone(fixtureSharing()),f=await setup(false,()=>access);access.services=builtinServices(f.app.db);
 // Keep runner/box execution independently valid after source ownership is
 // revoked, so generic input checks cannot satisfy this source regression.
 f.app.db.transaction(()=>{
  const {changedAt:_,...box}=f.store.read('box','a')!;
  f.store.put('box',{...box,lentTo:['art']},f.clock.now());
 })();
 await f.schedule();const job=f.store.ids('job')[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const credentials=signin(f.app).tokens.document();
 const pending=boundary==='final-release'?f.app.operations.callAsync('direct',{kind:'runner',id:'a'},'runtime.takeInput',{job}):undefined;
 if(pending)expect(f.app.effects!.status(`runtime:input:${job}`)).toBe('done');
 access.members.jonathan.agents=[];
 expect(await (pending??f.post(f.runner,'takeInput',{job}))).toMatchObject({ok:false,code:'denied'});
 expect(signin(f.app).tokens.document()).toEqual(credentials);
 expect(f.app.effects!.status(`runtime:input:${job}`)).toBe(pending?'done':undefined);
 expect(f.app.db.prepare('SELECT released,consumed FROM runtime_clock_turns').get()).toEqual({released:null,consumed:null});
});
