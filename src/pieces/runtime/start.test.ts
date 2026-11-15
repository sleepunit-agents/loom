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
const authority = vi.hoisted(() => ({enabled:false,current:true}));
vi.mock('./clock-delivery.js', async importOriginal => {
  const original = await importOriginal<typeof import('./clock-delivery.js')>();
  return {...original,clockDelivery:(...args:Parameters<typeof original.clockDelivery>)=>{
    const delivery=original.clockDelivery(...args);
    return {...delivery,inputCurrent:(job:string)=>authority.enabled?()=>authority.current:delivery.inputCurrent(job)};
  }};
});
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{authority.enabled=false;authority.current=true;for(const close of cleanups.splice(0).reverse())await close();});
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
  return {get app(){return app;},clock,call,post,input,jobOf,runner,other,member,token,
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
it('isolates the same source between two member ids and between two authorized agents',async()=>{
  const access=fixtureSharing();access.members.second={owner:true,agents:['art','mark']};
  const f=await setup(false,()=>access);
  f.app.db.transaction(()=>f.store.put('settings',{id:'mark',agent:'mark',boxes:['a'],house:{repo:'/fixture/mark',houseFile:'house/house.json'}},f.clock.now()))();
  const first=f.jobOf(f.call('runtime.startBody',f.input));
  const second=f.jobOf(f.call('runtime.startBody',f.input,{kind:'member',id:'second'}));
  const mark=f.jobOf(f.call('runtime.startBody',{...f.input,agent:'mark'}));
  expect(new Set([first,second,mark]).size).toBe(3);
});
it.each(['before-input','final-release'] as const)('retains the owning input guard at %s without a Clock producer',async boundary=>{
 const f=await setup(),job=f.jobOf(f.call('runtime.startBody',f.input));
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const credentials=signin(f.app).tokens.document();
 authority.enabled=true;
 if(boundary==='before-input')authority.current=false;
 const pending=f.app.operations.callAsync('direct',{kind:'runner',id:'a'},'runtime.takeInput',{job});
 if(boundary==='final-release'){
  expect(f.app.effects!.status(`runtime:input:${job}`)).toBe('done');
  authority.current=false;
 }
 expect(await pending).toMatchObject({ok:false,code:'denied'});
 expect(signin(f.app).tokens.document()).toEqual(credentials);
});
