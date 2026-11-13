import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { runtimeStore } from './store.js';
import { wake } from '../clock/store.js';
import { START_CONFIRM_MS, clockRuntime } from './clock.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
async function setup(staging=false){
  const home=mkdtempSync(join(tmpdir(),'runtime-start-'));fixture(home);
  cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
  const clock=new FakeClock();let app=await startLoom({home,clock,next:true,staging,stdout:()=>{}});
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
    get store(){return runtimeStore(app.db);},async restart(){await app.close();app=await startLoom({home,clock,next:true,staging,stdout:()=>{}});}};
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
  const f=await setup(),runtime=clockRuntime(f.app);
  const pending=runtime.startBody({viewer:owner,intent:'attempt',wake:{id:'w-fixture',agent:'art',prompt:'work',note:'fixture',due:1,state:'firing',createdAt:1,changedAt:1,by:owner,failures:0}});
  await f.app.close();expect(await pending).toMatchObject({state:'uncertain'});
});
