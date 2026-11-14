import {afterEach,expect,it,vi} from 'vitest';
import {ServerResponse} from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startLoom} from '../foundation.js';
import {builtinServices} from '../core/services.js';
import {fixture,fixtureSharing} from '../fixture.js';
import {FakeClock,type Viewer} from '../core/index.js';
import {signin,hash} from '../core/signin/index.js';
import {currentExecution} from '../pieces/runtime/control.js';
import {hearJob} from '../pieces/runtime/heartbeat.js';
import {provenanceStore} from '../pieces/runtime/provenance-store.js';
import {runtimeStore} from '../pieces/runtime/store.js';
import {runClockWorker} from './clock-worker-entry.js';
import {startClockWorker,type ClockWorkerConfig} from './clock-worker.js';
import type {SpawnClaude} from './session.js';
import * as preparation from './clock-input.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'};
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
async function setup(staging=false,privateInput=false,unknownRoot=false){
 const home=mkdtempSync(join(tmpdir(),'clock-native-'));fixture(home);closes.push(()=>rmSync(home,{recursive:true,force:true}));
 const access=structuredClone(fixtureSharing());
 const clock=new FakeClock(),app=await startLoom({home,clock,next:true,staging,sharing:()=>access,stdout(){}});closes.push(app.close);access.services=builtinServices(app.db);
 const storage=runtimeStore(app.db),store={...storage,put:(kind:Parameters<typeof storage.put>[0],value:Parameters<typeof storage.put>[1]&{changedAt?:number},at:number)=>{const {changedAt:_,...record}=value;return app.db.transaction(()=>storage.put(kind,record,at))();}};let n=0;
 const call=(name:string,input:unknown,viewer=owner)=>app.operations.call('direct',viewer,name,input,`fixture-${++n}`);
 app.db.transaction(()=>signin(app).tokens.replace({v:1,tokens:[]},{}))();
 store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());
 store.put('box',{id:'a',name:'a',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
 expect(call('signin.setPrincipal',{kind:'runner',id:'a',active:true}).ok).toBe(true);
 const runner=randomBytes(32).toString('hex');
 signin(app).tokens.change(ts=>ts.push({role:'runner:a',label:'fixture runner',sha256:hash(runner),created:new Date(clock.now()).toISOString()}));
 const post=async(token:string,name:string,input={})=>(await fetch(`${app.url}/api/runtime/${name}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({input,id:`http-${++n}`})})).json();
 const work={agent:'art',prompt:'ONLY CURRENT SCHEDULED WORDS',note:'fixture',place:'lane:native',when:'1s'};
 const scheduled=privateInput?await app.operations.callAsync('socket',owner,'clock.in',{...work,member:'jonathan',project:'pond'},`private-${++n}`,true):call('clock.in',work,unknownRoot?{kind:'agent',id:'art'}:owner);
 expect(scheduled).toMatchObject({ok:true});const wake=(scheduled as {ok:true;value:{id:string}}).value.id;
 clock.advance(1000);await settle();const job=store.ids('job')[0];expect(job).toBeTruthy();
 expect(await post(runner,'claimJob',{job})).toMatchObject({ok:true});
 if(staging){expect(await post(runner,'takeInput',{job})).toMatchObject({ok:false});expect(call('core.releaseEffect',{id:`runtime:input:${job}`}).ok).toBe(true);}
 const input=await post(runner,'takeInput',{job});expect(input).toMatchObject({ok:true,value:{credential:expect.any(String)}});
 expect(await post(runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 const b=store.read('binding',input.value.conversation)!;
 const assigned=store.read('job',job)!;
 const config:ClockWorkerConfig={url:app.url,credential:input.value.credential,job,
  assignment:{runner:assigned.runner,box:assigned.box,claimedAt:assigned.claimedAt!,house:assigned.made!},
  binding:{agent:'art',conversation:b.id,venue:'wake',place:b.place},checkout:home,command:'/worker/claude',env:{WORKER:'yes'},
  rules:{key:'a'.repeat(64),deny:['Bash(rm *)'],sections:[{text:'LOCAL OWNER RULES'}]}};
 const calls:Array<{args:readonly string[];input:string;child:EventEmitter&{stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kill:()=>boolean;killed:boolean};options:unknown}>=[];
 let autoFinish=false;
 let launched!:()=>void;const ready=new Promise<void>(r=>{launched=r;});
 const launch:SpawnClaude=(_cmd,args,options)=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,
   kill(){this.killed=true;queueMicrotask(()=>this.emit('close',null));return true;}});
  const c={args,input:'',child,options};child.stdin.on('data',v=>{c.input+=v.toString();launched();if(autoFinish)queueMicrotask(finish);});calls.push(c);
  return child as ReturnType<SpawnClaude>;
 };
 const finish=()=>{const c=calls.at(-1)!,session=c.args[c.args.indexOf('--session-id')+1];
  c.child.stdout.end(JSON.stringify({type:'result',is_error:false,session_id:session,result:'PRIVATE RESULT'}));c.child.emit('close',0);};
 const start=(override=config)=>{const worker=startClockWorker(override,{clock,launch});closes.push(worker.close);return worker;};
 const withdraw=()=>{fenceSource();};
 const fenceSource=()=>{app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true')) WHERE id=?").run(wake);};
 const attempt=()=>{autoFinish=true;return start().completed.finally(()=>{autoFinish=false;});};
 const joinInput=async(extra:Record<string,unknown>={})=>{
  const response=await (await fetch(`${app.url}/api/clock/in`,{method:'POST',headers:{authorization:`Bearer ${config.credential}`,'content-type':'application/json'},body:JSON.stringify({input:{agent:'art',prompt:'LATER JOINED WORDS',note:'join',place:config.binding.place,when:'1s',...extra},id:`join-${++n}`})})).json();
  expect(response).toMatchObject({ok:true});clock.advance(1000);await settle();return response.value.id as string;
 };
 const consumed=()=>app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${wake}`) as {consumed:number|null};
 return {home,app,clock,store,call,post,wake,job,config,calls,ready,finish,start,attempt,joinInput,launch,runner,consumed,withdraw,access};
}
it('actual worker startup obtains owning Runtime admission, executes the original words and only then ACKs',async()=>{
 const f=await setup(),worker=f.start();await f.ready;
 expect(f.calls).toHaveLength(1);expect(f.calls[0].input).toBe('LOCAL OWNER RULES\nONLY CURRENT SCHEDULED WORDS');
 expect(f.calls[0].args).toContain('--disallowedTools');expect(f.calls[0].args.join(' ')).not.toContain('SCHEDULED');
 expect(f.calls[0].options).toMatchObject({cwd:f.home,shell:false,env:{WORKER:'yes'}});
 expect(f.consumed().consumed).toBeNull();f.finish();expect(await worker.completed).toBe(true);expect(f.consumed().consumed).not.toBeNull();
 // No second execution after success, including a new local worker object.
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(1);
 expect(JSON.stringify(f.app.db.prepare('SELECT * FROM core_operations').all())).not.toContain('PRIVATE RESULT');
});
it('a withdrawn source between Runtime read and native admission refresh never reaches the actual spawn',async()=>{
 const f=await setup(),original=preparation.prepareClockInput;
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{const value=original(...args);f.withdraw();return value;});
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
});
it.each(['place','claim','conversation','policy','credential'] as const)('refuses changed owning %s after read and before native launch',async kind=>{
 const f=await setup(),original=preparation.prepareClockInput;let mutated=false;
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
  const value=original(...args),job=f.store.read('job',f.job)!,binding=f.store.read('binding',f.config.binding.conversation)!;
  if(kind==='place')f.store.put('binding',{...binding,place:'another-valid-place'},f.clock.now());
  if(kind==='claim')f.store.put('job',{...job,claimedAt:job.claimedAt!+1},f.clock.now());
  if(kind==='conversation'){
   f.store.put('binding',{...binding,id:'another-conversation',place:'another-conversation-place'},f.clock.now());
   f.store.put('job',{...job,conversation:'another-conversation'},f.clock.now());
   f.app.db.prepare('UPDATE runtime_clock_turns SET conversation=? WHERE job=?').run('another-conversation',f.job);
   f.app.db.prepare('UPDATE runtime_provenance SET conversation=? WHERE conversation=?').run('another-conversation',binding.id);
  }
  if(kind==='policy')expect(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{deny:['Bash']}}).ok).toBe(true);
  if(kind==='credential')signin(f.app).tokens.change(tokens=>{for(const t of tokens)if(t.sha256===hash(f.config.credential))t.revoked=new Date(f.clock.now()).toISOString();});
  mutated=true;return value;
 });
 expect(await f.attempt()).toBe(false);expect(mutated).toBe(true);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
 if(['place','claim','conversation'].includes(kind))expect(await f.post(f.config.credential,'readConversation',{})).toMatchObject({ok:true});
});
it('withholds ACK on source withdrawal after native output and never retries the uncertain input',async()=>{
 const f=await setup(),worker=f.start();await f.ready;f.finish();f.withdraw();
 expect(await worker.completed).toBe(false);expect(f.consumed().consumed).toBeNull();expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(1);
});
it('watchdog revocation kills the foreground native process and withholds ACK',async()=>{
 const f=await setup(),worker=f.start();await f.ready;f.withdraw();
 f.clock.advance(1000);expect(await worker.completed).toBe(false);expect(f.calls[0].child.killed).toBe(true);expect(f.consumed().consumed).toBeNull();
});
it.each(['revokePolicy','stopJob','cancelRequest','close'] as const)('local %s fences the original worker while admission is awaiting',async action=>{
 const f=await setup(),worker=f.start();await worker[action]();expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
});
it('wrong local assignment cannot authorize a native process, and uncertain admission is not reusable',async()=>{
 const f=await setup();expect(await f.start({...f.config,job:'wrong-job'}).completed).toBe(false);
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
});
it('holds the native execution effect in staging independently of the input/read effects',async()=>{
 const f=await setup(true);
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(0);
 const read=f.app.db.prepare("SELECT id FROM core_effects WHERE id LIKE 'runtime:clock-read:%'").get() as {id:string};
 expect(f.call('core.releaseEffect',{id:read.id}).ok).toBe(true);
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(0);
 const native=`runtime:clock-native:clock:${f.wake}`;expect(f.call('core.releaseEffect',{id:native}).ok).toBe(true);
 const worker=f.start();await f.ready;f.finish();expect(await worker.completed).toBe(true);
});
it('keeps generic box execution valid while independently revoking owning Clock source policy',async()=>{
 const f=await setup(),original=preparation.prepareClockInput;let mutated=false;
 f.store.put('box',{...f.store.read('box','a')!,lentTo:['art']},f.clock.now());
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
  const value=original(...args);f.access.members.jonathan.agents=[];expect(currentExecution(f.store,f.store.read('job',f.job)!,f.access)).toBe(true);mutated=true;return value;
 });
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
 expect(mutated).toBe(true);
});
it.each(['runner','box','claimedAt'] as const)('refuses a replacement of the original local %s before startup',async key=>{
 const f=await setup(),assignment={...f.config.assignment,[key]:key==='claimedAt'?f.config.assignment.claimedAt+1:'other'};
 expect(await f.start({...f.config,assignment}).completed).toBe(false);expect(f.calls).toHaveLength(0);
});
it('captures local rules and assignment before startup awaits',async()=>{
 const f=await setup(),worker=f.start();f.config.binding.place='replacement';f.config.assignment.claimedAt++;
 (f.config.rules as {deny:string[]}).deny=[];f.config.env.WORKER='changed';await f.ready;
 expect(f.calls[0].args).toContain('Bash(rm *)');expect(f.calls[0].options).toMatchObject({env:{WORKER:'yes'}});
 f.finish();expect(await worker.completed).toBe(true);
});

function holdResponse(op:string,n=1){
 const end=ServerResponse.prototype.end;let count=0,release=()=>{},entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const spy=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<typeof end>){
  if(this.req.url===`/api/runtime/${op}`&&++count===n){release=()=>{end.apply(this,args);};entered();return this;}
  return end.apply(this,args);
 });
 return {ready,release:()=>{const pending=release;release=()=>{};pending();},spy,get count(){return count;}};
}
it('a stalled watchdog cannot keep the original foreground child past its local authority window',async()=>{
 const f=await setup(),held=holdResponse('currentClockExecution',2),worker=f.start();
 try {await f.ready;f.clock.advance(1000);await held.ready;f.clock.advance(5000);
  expect(await worker.completed).toBe(false);expect(f.calls[0].child.killed).toBe(true);expect(f.consumed().consumed).toBeNull();
 }finally {held.release();held.spy.mockRestore();}
});
it('a watchdog read begun before native output cannot stand in for the final owning check',async()=>{
 const f=await setup(),held=holdResponse('currentClockExecution',2),worker=f.start();
 try {await f.ready;f.clock.advance(1000);await held.ready;f.finish();f.withdraw();held.release();
  expect(await worker.completed).toBe(false);expect(held.count).toBeGreaterThanOrEqual(3);expect(f.consumed().consumed).toBeNull();
 }finally {held.release();held.spy.mockRestore();}
});
it('a lost native admission response consumes the source and cannot authorize a replacement worker',async()=>{
 const f=await setup(),held=holdResponse('beginClockExecution'),worker=f.start();
 try {await held.ready;f.clock.advance(5000);expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(0);}
 finally {held.release();held.spy.mockRestore();}
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
});

it('uses the same owning native protocol for an independently authorized member-scoped prompt',async()=>{
 const f=await setup(false,true),worker=f.start();await f.ready;expect(f.store.read('job',f.job)?.member).toBe('jonathan');
 f.finish();expect(await worker.completed).toBe(true);expect(f.consumed().consumed).not.toBeNull();
});
it('allows harmless progress timestamps to advance during preparation',async()=>{
 const f=await setup(),original=preparation.prepareClockInput;
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
  const value=original(...args);f.clock.advance(200);f.store.put('job',f.store.read('job',f.job)!,f.clock.now());
  f.store.put('binding',f.store.read('binding',f.config.binding.conversation)!,f.clock.now());
  f.app.db.transaction(()=>hearJob(f.app.db,f.job,f.clock.now()))();return value;
 });
 const worker=f.start();await f.ready;f.finish();expect(await worker.completed).toBe(true);
});

it('executable IO parses bounded stdin and returns success through real HTTP startup with the existing fake child',async()=>{
 const f=await setup(),signals=new EventEmitter(),input=new PassThrough(),errors:string[]=[];
 const result=runClockWorker({input,args:[],signals,stderr:s=>errors.push(s)},{clock:f.clock,launch:f.launch});
 input.end(JSON.stringify(f.config));await f.ready;expect(f.consumed().consumed).toBeNull();f.finish();
 expect(await result).toBe(0);expect(errors).toEqual([]);expect(signals.listenerCount('SIGTERM')).toBe(0);expect(f.consumed().consumed).not.toBeNull();
});
it.each(['argument','invalid-json','oversized','signal-input','signal-admission'] as const)('executable IO rejects %s without native release or private diagnostics',async kind=>{
 const f=await setup(),signals=new EventEmitter(),input=new PassThrough(),errors:string[]=[],held=kind==='signal-admission'?holdResponse('beginClockExecution'):undefined;
 const result=runClockWorker({input,args:kind==='argument'?['--unexpected']:[],signals,stderr:s=>errors.push(s)},{clock:f.clock,launch:f.launch});
 try {
  if(kind==='signal-input')signals.emit('SIGINT');
  else if(kind==='invalid-json')input.end('PRIVATE INVALID JSON');
  else if(kind==='oversized')input.end(Buffer.alloc(1_048_577,65));
  else input.end(JSON.stringify(f.config));
  if(held){await held.ready;signals.emit('SIGTERM');}
  expect(await result).toBe(1);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
  expect(errors.join('')).not.toContain(f.config.credential);expect(errors.join('')).not.toContain('PRIVATE');
  expect(signals.listenerCount('SIGTERM')).toBe(0);expect(signals.listenerCount('SIGINT')).toBe(0);
 }finally {held?.release();held?.spy.mockRestore();input.destroy();}
});
it('starts watchdog reads every second even while an earlier successful response is delayed',async()=>{
 const f=await setup(),held=holdResponse('currentClockExecution',2),worker=f.start();
 try {
  await f.ready;f.clock.advance(1000);await held.ready;
  let entered!:()=>void;const third=new Promise<void>(resolve=>{entered=resolve;});const fetchOriginal=globalThis.fetch;
  const spy=vi.spyOn(globalThis,'fetch').mockImplementation((...args)=>{if(String(args[0]).endsWith('/currentClockExecution'))entered();return fetchOriginal(...args);});
  f.clock.advance(1000);await third;expect(held.count).toBeGreaterThanOrEqual(2);
  spy.mockRestore();await worker.close();expect(await worker.completed).toBe(false);
 }finally {held.release();held.spy.mockRestore();}
});
it('a delayed successful authority response expires from request start, without the watchdog masking its deadline',async()=>{
 const f=await setup(),held=holdResponse('currentClockExecution'),worker=f.start();
 try {
  await held.ready;f.clock.advance(3000);held.release();await f.ready;
  // Prevent additional successful refreshes from extending the tested window.
  const block=holdResponse('currentClockExecution');
  try {f.clock.advance(2000);await settle();expect(f.calls[0].child.killed).toBe(true);expect(await worker.completed).toBe(false);}
  finally {block.release();block.spy.mockRestore();}
 }finally {held.release();held.spy.mockRestore();}
});
it('an uncertain source stays consumed as an attempt after a later join AND a daemon restart',async()=>{
 const f=await setup(),held=holdResponse('beginClockExecution'),worker=f.start();
 try {await held.ready;await worker.close();expect(await worker.completed).toBe(false);}
 finally {held.release();held.spy.mockRestore();}
 await f.joinInput();expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_clock_turns WHERE job=?').get(f.job)).toEqual({n:2});
 await f.app.close();const app=await startLoom({home:f.home,clock:f.clock,next:true,sharing:()=>f.access,stdout(){}});closes.push(app.close);f.access.services=builtinServices(app.db);
 expect(await f.start({...f.config,url:app.url}).completed).toBe(false);expect(f.calls).toHaveLength(0);
 expect(app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE job=?').all(f.job)).toEqual([{consumed:null},{consumed:null}]);
});
it.each(['selected-sequence','source-contents','root-replacement'] as const)('pins exact %s independently of current generic destination authority',async kind=>{
 const f=await setup(),first=f.start();await f.ready;f.finish();expect(await first.completed).toBe(true);
 const selected=await f.joinInput();
 let replacement:{id:string;record:string}|undefined;
 if(kind==='root-replacement'){
  const r=f.call('clock.in',{agent:'art',prompt:'REPLACEMENT ROOT',note:'other',when:'1s'});expect(r.ok).toBe(true);
  f.clock.advance(1000);await settle();replacement=f.app.db.prepare('SELECT id,record FROM runtime_clock_turns WHERE job<>?').get(f.job) as typeof replacement;expect(replacement).toBeTruthy();
 }
 const original=preparation.prepareClockInput;let mutated=false;
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
  const value=original(...args);
  if(kind==='selected-sequence')f.app.db.prepare('UPDATE runtime_clock_turns SET seq=seq+10000 WHERE id=?').run(`clock:${selected}`);
  if(kind==='source-contents')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.prompt','REPLACED WORDS') WHERE id=?").run(selected);
  if(kind==='root-replacement')f.app.db.transaction(()=>{
   f.app.db.prepare('DELETE FROM runtime_clock_turns WHERE id=?').run(replacement!.id);
   f.app.db.prepare('UPDATE runtime_clock_turns SET id=?,record=? WHERE id=?').run(replacement!.id,replacement!.record,`clock:${f.wake}`);
  })();
  mutated=true;return value;
 });
 expect(await f.attempt()).toBe(false);expect(mutated).toBe(true);expect(f.calls).toHaveLength(1);
 if(kind!=='source-contents')expect(await f.post(f.config.credential,'readConversation',{})).toMatchObject({ok:true});
});

it('holds a joined source model override even when the original job has no model override',async()=>{
 const f=await setup(),first=f.start();await f.ready;f.finish();expect(await first.completed).toBe(true);
 const second=await f.joinInput({model:'other-model'});expect(f.store.read('job',f.job)?.model).toBeUndefined();
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(1);
 expect(f.app.effects!.status(`runtime:clock-native:clock:${second}`)).toBeUndefined();
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${second}`)).toEqual({consumed:null});
});
it('holds a source model override introduced after preparation while its old generic source record still matches',async()=>{
 const f=await setup(),original=preparation.prepareClockInput;let mutated=false;
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
  const value=original(...args);f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.model','other-model') WHERE id=?").run(f.wake);mutated=true;return value;
 });
 expect(await f.attempt()).toBe(false);expect(mutated).toBe(true);expect(f.calls).toHaveLength(0);
 expect(await f.post(f.config.credential,'readConversation',{})).toMatchObject({ok:true});expect(f.consumed().consumed).toBeNull();
});
it.each(['revokePolicy','stopJob','cancelRequest','close'] as const)('running local %s kills the child and cannot be restored by a delayed successful authority response',async action=>{
 const f=await setup(),held=holdResponse('currentClockExecution',2),worker=f.start();
 try {
  await f.ready;f.clock.advance(1000);await held.ready;const stopped=worker[action]();
  try {expect(f.calls[0].child.killed).toBe(true);}finally {f.finish();}
  held.release();await stopped;expect(await worker.completed).toBe(false);expect(f.consumed().consumed).toBeNull();
 }finally {held.release();held.spy.mockRestore();}
});
it.each(['job-finish','job-state','credential','policy','job-model','job-account'] as const)('remote %s during native execution kills the foreground child without ACK',async kind=>{
 const f=await setup(),worker=f.start();await f.ready;
 if(kind==='job-finish')expect(await f.post(f.runner,'finishJob',{job:f.job,state:'failed'})).toMatchObject({ok:true});
 if(kind==='job-state')f.store.put('job',{...f.store.read('job',f.job)!,state:'stopped'},f.clock.now());
 if(kind==='job-account')f.store.put('job',{...f.store.read('job',f.job)!,account:'other-account'},f.clock.now());
 if(kind==='job-model')f.store.put('job',{...f.store.read('job',f.job)!,model:'other-model'},f.clock.now());
 if(kind==='credential')signin(f.app).tokens.change(tokens=>{for(const t of tokens)if(t.sha256===hash(f.config.credential))t.revoked=new Date(f.clock.now()).toISOString();});
 if(kind==='policy')expect(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{deny:['Bash']}}).ok).toBe(true);
 f.clock.advance(1000);expect(await worker.completed).toBe(false);expect(f.calls[0].child.killed).toBe(true);expect(f.consumed().consumed).toBeNull();
});

it('holds unknown root steering filed by an authenticated unbound agent',async()=>{
 const f=await setup(false,false,true);expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);
 expect(f.app.effects!.status(`runtime:clock-native:clock:${f.wake}`)).toBeUndefined();expect(f.consumed().consumed).toBeNull();
});
it('holds unknown selected steering independently of a known root and known current history',async()=>{
 const f=await setup(),first=f.start();await f.ready;f.finish();expect(await first.completed).toBe(true);
 const p=provenanceStore(f.app.db),before=p.read(f.config.binding.conversation)!;
 f.app.db.transaction(()=>p.put(f.config.binding.conversation,{...before,history:{...before.history,unknown:true}}))();
 const selected=await f.joinInput();
 const after=p.read(f.config.binding.conversation)!;
 f.app.db.transaction(()=>p.put(f.config.binding.conversation,{...after,history:before.history}))();
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(1);
 expect(f.app.effects!.status(`runtime:clock-native:clock:${selected}`)).toBeUndefined();
});
it.each(['preparation','running'] as const)('unknown conversation history introduced during %s cannot retain native authority',async phase=>{
 const f=await setup(),p=provenanceStore(f.app.db);
 const change=()=>{const before=p.read(f.config.binding.conversation)!;f.app.db.transaction(()=>p.put(f.config.binding.conversation,{...before,history:{...before.history,unknown:true}}))();};
 if(phase==='preparation'){
  const original=preparation.prepareClockInput;vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{const value=original(...args);change();return value;});
  expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);
 }else {const worker=f.start();await f.ready;change();f.clock.advance(1000);expect(await worker.completed).toBe(false);expect(f.calls[0].child.killed).toBe(true);}
 expect(f.consumed().consumed).toBeNull();expect(await f.post(f.config.credential,'readConversation',{})).toMatchObject({ok:true});
});
it('holds an account override at native admission before consuming a source attempt',async()=>{
 const f=await setup();f.store.put('job',{...f.store.read('job',f.job)!,account:'other-account'},f.clock.now());
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);expect(f.app.effects!.status(`runtime:clock-native:clock:${f.wake}`)).toBeUndefined();
});
it.each(['schema','malformed','oversized'] as const)('invalid %s admission response cannot launch a child',async kind=>{
 const f=await setup(),original=globalThis.fetch;let injected=false;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
  const response=await original(...args);if(!String(args[0]).endsWith('/beginClockExecution'))return response;
  const data=await response.json();expect(data.ok).toBe(true);injected=true;
  if(kind==='schema')data.value.ttl=99999;
  return new Response(kind==='malformed'?'PRIVATE INVALID JSON':(kind==='oversized'?' '.repeat(1_048_577):'')+JSON.stringify(data),{status:200});
 });
 expect(await f.attempt()).toBe(false);expect(injected).toBe(true);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
});
it.each(['schema','malformed'] as const)('invalid %s running authority response fences the actual child without ACK',async kind=>{
 const f=await setup(),worker=f.start();await f.ready;const original=globalThis.fetch;
 let entered!:()=>void;const poisoned=new Promise<void>(resolve=>{entered=resolve;});
 vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
  const response=await original(...args);if(!String(args[0]).endsWith('/currentClockExecution'))return response;
  await response.arrayBuffer();entered();return new Response(kind==='malformed'?'PRIVATE INVALID JSON':JSON.stringify({ok:true,value:{current:false,ttl:5000}}),{status:200});
 });
 f.clock.advance(1000);await poisoned;await settle();f.finish();
 expect(await worker.completed).toBe(false);expect(f.calls[0].child.killed).toBe(true);expect(f.consumed().consumed).toBeNull();
});
