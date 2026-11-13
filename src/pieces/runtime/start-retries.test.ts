import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach,it,expect,vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock,type Viewer } from '../../core/index.js';
import { fixture,fixtureSharing } from '../../fixture.js';
import { signin,hash } from '../../core/signin/index.js';
import { canHost } from './boxes.js';
import { placeBody } from './placement.js';
import { runtimeStore } from './store.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.restoreAllMocks();});
async function setup(staging=false){
 const home=mkdtempSync(join(tmpdir(),'runtime-retry-'));fixture(home);cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock(),sharing=fixtureSharing();let app=await startLoom({home,clock,next:true,staging,sharing:()=>sharing,stdout:()=>{}});cleanups.push(()=>app.close());
 const owner:Viewer={kind:'member',id:'jonathan'};let n=0;
 const call=(name:string,input:unknown,viewer=owner,id=`op-${++n}`)=>app.operations.call('direct',viewer,`runtime.${name}`,input,id);
 app.db.transaction(()=>{const store=runtimeStore(app.db);signin(app).tokens.replace({v:1,tokens:[]},{});
 store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());
 store.put('box',{id:'a',name:'A',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());})();
 expect(app.operations.call('direct',owner,'signin.setPrincipal',{kind:'runner',id:'a',active:true},'enable').ok).toBe(true);
 const runner=randomBytes(32).toString('hex');signin(app).tokens.change(ts=>ts.push({role:'runner:a',label:'runner',sha256:hash(runner),created:new Date(clock.now()).toISOString()}));
 const post=async(op:string,input:unknown,id=`http-${++n}`)=>(await fetch(`${app.url}/api/runtime/${op}`,{method:'POST',headers:{authorization:`Bearer ${runner}`,'content-type':'application/json'},body:JSON.stringify({input,id})})).json();
 const input={agent:'art',title:'Retry me',brief:'PRIVATE retry words',model:'test-model',source:{kind:'manual',id:'first'}};
 const start=(extra={})=>{const r=call('startBody',{...input,...extra});expect(r.ok).toBe(true);return (r as {value:{job:string}}).value.job;};
 const progress=(job:string)=>{const r=call('startProgress',{job});expect(r.ok).toBe(true);return (r as {value:{current:string;state:string;attempt:number;due?:number}}).value;};
 const fail=async(job:string,fence=true)=>{expect(await post('claimJob',{job})).toMatchObject({ok:true});expect(await post('finishJob',{job,state:'failed',...(fence?{startFailure:'not-started'}:{})})).toMatchObject({ok:true});};
 return {get app(){return app;},get store(){return runtimeStore(app.db);},home,clock,sharing,call,post,start,progress,fail,input,async restart(){await app.close();app=await startLoom({home,clock,next:true,staging,sharing:()=>sharing,stdout:()=>{}});}};
}
it('retries only fenced unstarted attempts at 1, 4 and 10 minutes, preserving input and permanently bounding attempts',async()=>{
 const f=await setup(),root=f.start();let job=root;
 for(const [i,delay] of [60_000,240_000,600_000].entries()){
  await f.fail(job);expect(f.progress(root)).toMatchObject({state:'due',attempt:i+1,due:f.clock.now()+delay});
  const previous=job;f.clock.advance(delay-1);expect(f.progress(root).current).toBe(previous);
  f.clock.advance(1);job=f.progress(root).current;expect(job).not.toBe(previous);
  expect(f.store.read('job',previous)).toMatchObject({state:'failed',startFailed:true});
  expect(f.store.read('job',job)).toMatchObject({state:'queued',model:'test-model'});
  expect(f.app.db.prepare('SELECT brief FROM runtime_inputs WHERE job=?').get(job)).toEqual({brief:'PRIVATE retry words'});
  expect(await f.post('reportJob',{job:previous,state:'running'})).toMatchObject({ok:false,code:'conflict'});
 }
 await f.fail(job);expect(f.progress(root)).toMatchObject({state:'exhausted',attempt:4});f.clock.advance(86400_000);expect(f.store.ids('job')).toHaveLength(4);
 const receipts=JSON.stringify(f.app.db.prepare('SELECT * FROM core_operations').all());expect(receipts).not.toContain('PRIVATE retry words');
});
it('recovers the exact deadline after restart, never renews it on finish replay and deduplicates the attempt transaction',async()=>{
 const f=await setup(),root=f.start();await f.post('claimJob',{job:root});
 const done={job:root,state:'failed',startFailure:'not-started'};
 expect(await f.post('finishJob',done,'stable-finish')).toMatchObject({ok:true});const due=f.progress(root).due!;
 f.clock.advance(30_000);expect(await f.post('finishJob',done,'stable-finish')).toMatchObject({ok:true});expect(f.progress(root).due).toBe(due);
 await f.restart();f.clock.advance(30_000);const next=f.progress(root).current;expect(next).not.toBe(root);
 await f.restart();f.clock.advance(1_000_000);expect(f.progress(root).current).toBe(next);expect(f.store.ids('job')).toHaveLength(2);
 expect(f.start()).toBe(root);
});
it('keeps ordinary failures, timeouts, running work and owner recovery out of automatic retry',async()=>{
 const f=await setup(),normal=f.start();await f.fail(normal,false);f.clock.advance(1_000_000);expect(f.progress(normal).state).toBe('settled');expect(f.store.ids('job')).toEqual([normal]);
 const unknown=f.start({source:{kind:'spawn',id:'unknown'}});await f.post('claimJob',{job:unknown});f.clock.advance(1_000_000);expect(f.progress(unknown).current).toBe(unknown);
 expect(await f.post('reportJob',{job:unknown,state:'running'})).toMatchObject({ok:true});
 expect(await f.post('finishJob',{job:unknown,state:'failed',startFailure:'not-started'})).toMatchObject({ok:false,code:'conflict'});
 expect(f.store.ids('job')).toHaveLength(2);
});
it('does not adopt Clock, conversation or queueBody work into the independent retry chain',async()=>{
 const f=await setup();for(const extra of [{source:{kind:'wake',id:'wake'}},{conversation:'cv-external',source:{kind:'conversation',id:'external'}}, {source:{kind:'spawn',id:'conversation'},conversation:'cv-other'}]){
  const job=f.start(extra);await f.fail(job);expect(f.call('startProgress',{job})).toMatchObject({ok:false,code:'not-found'});
 }
 const r=f.call('queueBody',{agent:'art',title:'Queue',brief:'work'}) as {ok:true;value:{job:string}};expect(r.ok).toBe(true);await f.fail(r.value.job);f.clock.advance(1_000_000);expect(f.store.ids('job')).toHaveLength(4);
});
it.each(['permission','house','box','import','recovery'] as const)('holds due work after %s changes instead of recreating authority',async(change)=>{
 const f=await setup(),root=f.start();await f.fail(root);
 f.app.db.transaction(()=>{
  if(change==='permission')f.sharing.members.jonathan={owner:false,agents:[]};
  if(change==='house'){const {changedAt:_,...settings}=f.store.read('settings','art')!;f.store.put('settings',{...settings,house:{repo:'/different',houseFile:'house.json'}},f.clock.now());}
  if(change==='box'){const {changedAt:_,...box}=f.store.read('box','a')!;f.store.put('box',{...box,revokedAt:f.clock.now()},f.clock.now());}
  if(change==='import'||change==='recovery'){const {changedAt:_,...job}=f.store.read('job',root)!;f.store.put('job',{...job,...(change==='import'?{imported:{history:'unknown' as const}}:{writtenOff:{approval:'old',by:'jonathan',at:1}})},f.clock.now());}
 })();f.clock.advance(60_000);expect(f.store.ids('job')).toEqual([root]);
 // An owner who withdrew access cannot inspect the old intent either.
 const row=f.app.db.prepare('SELECT record FROM runtime_start_attempts WHERE root=?').get(root) as {record:string};expect(JSON.parse(row.record).state).toBe('held');
});
it('rolls finish scheduling and replacement creation back with later transaction failures',async()=>{
 const f=await setup(),root=f.start();await f.post('claimJob',{job:root});
 f.app.db.exec("CREATE TRIGGER fail_attempt BEFORE UPDATE ON runtime_start_attempts BEGIN SELECT RAISE(ABORT,'abort'); END");
 expect(await f.post('finishJob',{job:root,state:'failed',startFailure:'not-started'},'failed-finish')).toMatchObject({ok:false});
 expect(f.store.read('job',root)?.state).toBe('starting');expect(f.progress(root).state).toBe('active');f.app.db.exec('DROP TRIGGER fail_attempt');
 expect(await f.post('finishJob',{job:root,state:'failed',startFailure:'not-started'},'failed-finish')).toMatchObject({ok:true});
 f.app.db.exec("CREATE TRIGGER fail_attempt BEFORE UPDATE ON runtime_start_attempts BEGIN SELECT RAISE(ABORT,'abort'); END");
 f.clock.advance(60_000);expect(f.store.ids('job')).toEqual([root]);expect(f.progress(root).state).toBe('due');f.app.db.exec('DROP TRIGGER fail_attempt');
 f.app.live.changed([{type:'runtime.job',id:'unrelated'}]);f.clock.advance(4999);expect(f.store.ids('job')).toEqual([root]);
 f.clock.advance(1);expect(f.store.ids('job')).toHaveLength(2);expect(f.progress(root).state).toBe('active');
});
it('applies staging independently to each replacement and filters progress through central scope',async()=>{
 const f=await setup(true),root=f.start();await f.fail(root);f.clock.advance(60_000);const job=f.progress(root).current;
 await f.post('claimJob',{job});expect(await f.post('takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
 expect(f.call('startProgress',{job:root},{kind:'agent',id:'mark'})).toMatchObject({ok:false,code:'denied'});
 expect(f.call('startProgress',{job:root},{kind:'service',id:'runtime'})).toMatchObject({ok:false,code:'denied'});
 expect(f.call('startProgress',{job:root},{kind:'agent',id:'art'})).toMatchObject({ok:true});
});

it.each(['project','give-work'] as const)('rechecks %s independently while placement stays eligible',async(kind)=>{
 const f=await setup();
 const r=f.call('startBody',{...f.input,...(kind==='project'?{project:'pond'}:{})},kind==='project'?{kind:'agent',id:'art'}:undefined) as {ok:true;value:{job:string}};
 expect(r.ok).toBe(true);const root=r.value.job;await f.fail(root);
 if(kind==='project')f.sharing.projects.pond.agents=[];
 else f.sharing.members.jonathan.agents=[]; // Still owner; only give-work is lost.
 expect(canHost(f.store.read('box','a')!,'art',f.sharing)).toBe(true);
 expect(placeBody(f.store,f.sharing,'art',{},f.clock.now())).toBe('a');
 f.clock.advance(60_000);expect(f.store.ids('job')).toEqual([root]);
 expect(JSON.parse((f.app.db.prepare('SELECT record FROM runtime_start_attempts WHERE root=?').get(root) as {record:string}).record).state).toBe('held');
});
it('retains explicit placement, project and title after restart and changed preferences',async()=>{
 const f=await setup();const root=f.start({box:'a',project:'pond',title:'Original title'});await f.fail(root);
 f.app.db.transaction(()=>{
  const {changedAt:_,...a}=f.store.read('box','a')!;f.store.put('box',{...a,id:'b',name:'B'},f.clock.now());
  const {changedAt:_s,...settings}=f.store.read('settings','art')!;f.store.put('settings',{...settings,boxes:['b']},f.clock.now());
 })();await f.restart();f.clock.advance(60_000);const job=f.progress(root).current;
 expect(job).not.toBe(root);expect(f.store.read('job',job)).toMatchObject({title:'Original title',project:'pond',box:'a',model:'test-model',startRequest:{box:'a'}});
 expect(await f.post('claimJob',{job})).toMatchObject({ok:true});
 expect(await f.post('takeInput',{job})).toMatchObject({ok:true,value:{brief:'PRIVATE retry words',model:'test-model'}});
});
it('pins the retry house across the queued-to-claimed interval and settles a successful replacement',async()=>{
 const f=await setup(),root=f.start();await f.fail(root);f.clock.advance(60_000);const job=f.progress(root).current;
 const settings=f.store.read('settings','art')!;
 f.app.db.transaction(()=>{const {changedAt:_,...value}=settings;f.store.put('settings',{...value,house:{repo:'/different',houseFile:'new.json'}},f.clock.now());})();
 expect(await f.post('claimJob',{job})).toMatchObject({ok:false,code:'conflict'});expect(await f.post('takeInput',{job})).toMatchObject({ok:false});
 expect(f.store.read('job',job)?.state).toBe('queued');
 f.app.db.transaction(()=>{const {changedAt:_,...value}=settings;f.store.put('settings',value,f.clock.now());})();
 expect(await f.post('claimJob',{job})).toMatchObject({ok:true});
 // Configuration can also change while runner input release awaits the async door.
 f.app.db.transaction(()=>{const {changedAt:_,...value}=settings;f.store.put('settings',{...value,house:{repo:'/different',houseFile:'new.json'}},f.clock.now());})();
 expect(await f.post('takeInput',{job})).toMatchObject({ok:false});
 f.app.db.transaction(()=>{const {changedAt:_,...value}=settings;f.store.put('settings',value,f.clock.now());})();
 expect(await f.post('takeInput',{job})).toMatchObject({ok:true,value:{house:settings.house}});
 expect(await f.post('reportJob',{job,state:'running'})).toMatchObject({ok:true});
 expect(await f.post('finishJob',{job,state:'done'})).toMatchObject({ok:true});
 expect(f.progress(root)).toMatchObject({state:'settled',current:job,attempt:2});f.clock.advance(1_000_000);expect(f.store.ids('job')).toHaveLength(2);
});
