import {afterEach,expect,it,vi} from 'vitest';
import {ServerResponse} from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
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
import {importClock} from '../pieces/clock/importer.js';
import {wake as readWake} from '../pieces/clock/store.js';
import {runtimeStore} from '../pieces/runtime/store.js';
import {runClockWorker} from './clock-worker-entry.js';
import {startClockWorker,type ClockWorkerConfig} from './clock-worker.js';
import {ClaudeWorkerSession,type SpawnClaude} from './session.js';
import * as preparation from './clock-input.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'};
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
async function setup(staging=false,privateInput=false,unknownRoot=false,file?:string,adoption?:'direct'|'card'){
 const home=mkdtempSync(join(tmpdir(),'clock-native-'));fixture(home);closes.push(()=>rmSync(home,{recursive:true,force:true}));
 const access=structuredClone(fixtureSharing());
 const clock=new FakeClock();
 const source=join(home,'legacy-clock');
 if(adoption){mkdirSync(join(source,'art'),{recursive:true});writeFileSync(join(source,'art/spool.jsonl'),JSON.stringify({
  id:'w-abcdef',kind:'wake',for:'-',at:'2026-11-11 18:00:01',created:'2026-11-11 18:00:00',
  prompt:'ONLY CURRENT SCHEDULED WORDS',note:'fixture',origin:'agent:art'}));}
 const app=await startLoom({home,clock,next:true,staging,sharing:()=>access,stdout(){},
  ...(adoption?{install(app:Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]){importClock(app.db,source,clock.now());}}:{})});closes.push(app.close);access.services=builtinServices(app.db);
 const storage=runtimeStore(app.db),store={...storage,put:(kind:Parameters<typeof storage.put>[0],value:Parameters<typeof storage.put>[1]&{changedAt?:number},at:number)=>{const {changedAt:_,...record}=value;return app.db.transaction(()=>storage.put(kind,record,at))();}};let n=0;
 const call=(name:string,input:unknown,viewer=owner)=>app.operations.call('direct',viewer,name,input,`fixture-${++n}`);
 app.db.transaction(()=>signin(app).tokens.replace({v:1,tokens:[]},{}))();
 store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());
 store.put('box',{id:'a',name:'a',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
 expect(call('signin.setPrincipal',{kind:'runner',id:'a',active:true}).ok).toBe(true);
 const runner=randomBytes(32).toString('hex');
 signin(app).tokens.change(ts=>ts.push({role:'runner:a',label:'fixture runner',sha256:hash(runner),created:new Date(clock.now()).toISOString()}));
 const post=async(token:string,name:string,input={})=>(await fetch(`${app.url}/api/runtime/${name}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({input,id:`http-${++n}`})})).json();
 const work={agent:'art',...(file?{file}:{prompt:'ONLY CURRENT SCHEDULED WORDS'}),note:'fixture',place:'lane:native',when:'1s'};
 const scheduled=adoption?{ok:true,value:{id:'w-abcdef'}}:privateInput?await app.operations.callAsync('socket',owner,'clock.in',{...work,member:'jonathan',project:'pond'},`private-${++n}`,true):call('clock.in',work,unknownRoot?{kind:'agent',id:'art'}:owner);
 expect(scheduled).toMatchObject({ok:true});const wake=(scheduled as {ok:true;value:{id:string}}).value.id;
 if(adoption){
  const target=`art:${wake}`;
  if(adoption==='card'){
   const requested=call('clock.askVouch',{target});expect(requested).toMatchObject({ok:true});
   if(!requested.ok)throw new Error('vouch request failed');
   expect(call('approvals.answer',{id:(requested.value as {id:string}).id,action:'allow'})).toMatchObject({ok:true});
  }else expect(call('clock.vouch',{target})).toMatchObject({ok:true});
 }
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
 const finish=()=>{const c=calls.at(-1)!,session=c.args[c.args.indexOf(c.args.includes('--resume')?'--resume':'--session-id')+1];
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

it.each([false,true])('native worker reads a standalone checkout file and ACKs actual words (private=%s)',async privateWork=>{
 const f=await setup(false,privateWork,false,'routines/native.md');
 mkdirSync(join(f.home,'routines'));writeFileSync(join(f.home,'routines/native.md'),'ACTUAL CHECKOUT WORDS');
 expect(await f.post(f.config.credential,'readConversation',{})).toMatchObject({ok:false});
 const seq=(f.app.db.prepare('SELECT seq FROM runtime_clock_turns WHERE id=?').get(`clock:${f.wake}`) as {seq:number}).seq;
 expect(await f.post(f.config.credential,'acknowledgeClockInput',{through:seq})).toMatchObject({ok:false});
 const input=new PassThrough(),signals=new EventEmitter(),stderr=vi.fn();
 const completed=runClockWorker({input,args:[],signals,stderr},{clock:f.clock,launch:f.launch});
 input.end(JSON.stringify(f.config));await f.ready;
 expect(f.calls[0].input).toBe('LOCAL OWNER RULES\nACTUAL CHECKOUT WORDS');
 expect(f.calls[0].input).not.toContain('routines/native.md');expect(f.consumed().consumed).toBeNull();
 f.finish();expect(await completed).toBe(0);expect(stderr).not.toHaveBeenCalled();expect(f.consumed().consumed).not.toBeNull();
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(1);
 expect(JSON.stringify(f.app.db.prepare('SELECT * FROM runtime_clock_turns').all())).not.toContain('ACTUAL CHECKOUT WORDS');
});
it.each(['missing','symlink','local','oversize','invalid'] as const)('unsafe standalone file %s never launches or ACKs',async kind=>{
 const f=await setup(false,false,false,'native.md');
 if(kind==='symlink'){writeFileSync(join(f.home,'target.md'),'WORDS');symlinkSync('target.md',join(f.home,'native.md'));}
 if(kind==='local')writeFileSync(join(f.home,'native.md'),'<!-- house: local -->\nWORDS');
 if(kind==='oversize')writeFileSync(join(f.home,'native.md'),'x'.repeat(20001));
 if(kind==='invalid')writeFileSync(join(f.home,'native.md'),Buffer.from([255]));
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
 // Even repairing the file cannot replay an uncertain admitted source.
 if(kind==='symlink')rmSync(join(f.home,'native.md'));
 writeFileSync(join(f.home,'native.md'),'REPAIRED');
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);
});
it.each(['withdraw','path','policy'] as const)('standalone file %s change after preparation prevents spawn',async kind=>{
 const f=await setup(false,false,false,'native.md');writeFileSync(join(f.home,'native.md'),'CURRENT FILE WORDS');
 const original=preparation.prepareClockInput;
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
  const value=original(...args);
  if(kind==='withdraw')f.withdraw();
  if(kind==='path')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.file','other.md') WHERE id=?").run(f.wake);
  if(kind==='policy')f.access.members.jonathan.agents=[];
  return value;
 });
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
});

it('standalone file output remains unacknowledged after withdrawal',async()=>{
 const f=await setup(false,false,false,'native.md');writeFileSync(join(f.home,'native.md'),'FILE WORDS');
 const worker=f.start();await f.ready;f.withdraw();f.finish();
 expect(await worker.completed).toBe(false);expect(f.consumed().consumed).toBeNull();
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(1);
});
it('standalone file native execution retains all three independent staging gates',async()=>{
 const f=await setup(true,false,false,'native.md');writeFileSync(join(f.home,'native.md'),'STAGED FILE WORDS');
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);
 const read=f.app.db.prepare("SELECT id FROM core_effects WHERE id LIKE 'runtime:clock-read:%'").get() as {id:string};
 expect(f.call('core.releaseEffect',{id:read.id}).ok).toBe(true);
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(0);
 expect(f.call('core.releaseEffect',{id:`runtime:clock-native:clock:${f.wake}`}).ok).toBe(true);
 const worker=f.start();await f.ready;expect(f.calls[0].input).toContain('STAGED FILE WORDS');f.finish();
 expect(await worker.completed).toBe(true);
});
it('prompt joining into a standalone file conversation stays held',async()=>{
 const f=await setup(false,false,false,'native.md');
 const joined=await f.joinInput();
 expect(f.store.ids('job')).toEqual([f.job]);
 const row=f.app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(joined) as {record:string};
 expect(JSON.parse(row.record).state).toBe('held');
 expect(f.app.db.prepare('SELECT id FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toBeUndefined();
});

it('standalone file joining an authenticated prompt conversation stays held',async()=>{
 const f=await setup();
 const joined=await f.joinInput({prompt:undefined,file:'native.md'});
 expect(f.store.ids('job')).toEqual([f.job]);
 const row=f.app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(joined) as {record:string};
 expect(JSON.parse(row.record).state).toBe('held');
 expect(f.app.db.prepare('SELECT id FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toBeUndefined();
});

it.each([false,true])('executable worker drains a joined prompt through the same native history (private=%s)',async privateInput=>{
 const f=await setup(false,privateInput),input=new PassThrough(),signals=new EventEmitter(),stderr=vi.fn();
 const completed=runClockWorker({input,args:[],signals,stderr},{clock:f.clock,launch:f.launch});
 input.end(JSON.stringify(f.config));await f.ready;
 const joined=await f.joinInput();
 const next=new Promise<void>(resolve=>{
  const original=preparation.prepareClockInput;
  vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
   const value=original(...args);if(value?.message==='LATER JOINED WORDS')resolve();return value;
  });
 });
 f.finish();
 // A bounded condition wait fails promptly on the unchanged one-turn startup.
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));await next;
 expect(f.calls[1].args).toContain('--resume');
 expect(f.calls[1].args[f.calls[1].args.indexOf('--resume')+1]).toBe(f.calls[0].args[f.calls[0].args.indexOf('--session-id')+1]);
 expect(f.calls[1].input).toBe('LOCAL OWNER RULES\nLATER JOINED WORDS');
 expect(f.consumed().consumed).not.toBeNull();
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
 f.finish();expect(await completed).toBe(0);expect(stderr).not.toHaveBeenCalled();
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:expect.any(Number)});
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(2);
});

it.each(['withdraw','credential','claim','model','policy'] as const)('rechecks joined %s after preparation before resumed spawn',async kind=>{
 const f=await setup(),worker=f.start();await f.ready;const joined=await f.joinInput();
 const original=preparation.prepareClockInput;let changed=false;
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
  const value=original(...args);if(value?.message==='LATER JOINED WORDS'){
   changed=true;
   if(kind==='withdraw')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true')) WHERE id=?").run(joined);
   if(kind==='credential')signin(f.app).tokens.change(ts=>{for(const t of ts)if(t.sha256===hash(f.config.credential))t.revoked=new Date(f.clock.now()).toISOString();});
   if(kind==='claim')f.store.put('job',{...f.store.read('job',f.job)!,claimedAt:f.config.assignment.claimedAt+1},f.clock.now());
   if(kind==='model')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.model','changed') WHERE id=?").run(joined);
   if(kind==='policy')expect(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{deny:['Bash']}}).ok).toBe(true);
  }return value;
 });
 f.finish();expect(await worker.completed).toBe(false);expect(changed).toBe(true);expect(f.calls).toHaveLength(1);
 expect(f.consumed().consumed).not.toBeNull();
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(1);
});
it('a failed resumed child never ACKs or retries that source',async()=>{
 const f=await setup(),worker=f.start();await f.ready;const joined=await f.joinInput();f.finish();
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.calls[1].child.emit('close',1);
 expect(await worker.completed).toBe(false);expect(f.consumed().consumed).not.toBeNull();
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
 expect(await f.attempt()).toBe(false);expect(f.calls).toHaveLength(2);
});
it('pins steering across separately valid admissions rather than reusing old history',async()=>{
 const f=await setup(),worker=f.start();await f.ready;const joined=await f.joinInput();
 const original=globalThis.fetch;let changed=false,admitted=0;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
  const response=await original(...args);
  if(String(args[0]).endsWith('/beginClockExecution')){expect(await response.clone().json()).toMatchObject({ok:false});admitted++;}
  if(String(args[0]).endsWith('/completeClockExecution')&&!changed){
   changed=true;const p=provenanceStore(f.app.db),before=p.read(f.config.binding.conversation)!;
   f.app.db.transaction(()=>p.put(f.config.binding.conversation,{...before,history:{...before.history,people:['pollock'],owner:false}}))();
  }return response;
 });
 f.finish();expect(await worker.completed).toBe(false);expect(changed).toBe(true);expect(admitted).toBe(1);expect(f.calls).toHaveLength(1);
 vi.restoreAllMocks();expect(await f.post(f.config.credential,'beginClockExecution',{})).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
});

it('a retired watchdog failure during completion cannot fence the next native generation',async()=>{
 const f=await setup(),original=globalThis.fetch;let reads=0,rejectRead!:(error:Error)=>void,entered!:()=>void;
 const reading=new Promise<void>(resolve=>{entered=resolve;});
 vi.spyOn(globalThis,'fetch').mockImplementation((...args)=>{
  if(String(args[0]).endsWith('/currentClockExecution')&&++reads===2){entered();return new Promise<Response>((_resolve,reject)=>{rejectRead=reject;});}
  return original(...args);
 });
 const worker=f.start();await f.ready;await f.joinInput();await reading;
 const held=holdResponse('completeClockExecution');
 try {
  f.finish();await held.ready;rejectRead(new Error('retired source no longer current'));await settle();
  expect(f.calls[0].child.killed).toBe(false);held.release();
  await vi.waitFor(()=>expect(f.calls).toHaveLength(2));expect(f.calls[1].child.killed).toBe(false);
  f.finish();expect(await worker.completed).toBe(true);
 }finally {held.release();held.spy.mockRestore();}
});
it('a lost completion never releases a second child even when more input is queued',async()=>{
 const f=await setup(),worker=f.start();await f.ready;const joined=await f.joinInput(),held=holdResponse('completeClockExecution');
 try {f.finish();await held.ready;f.clock.advance(5000);expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(1);}
 finally {held.release();held.spy.mockRestore();}
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
});
it('new generation watchdog still kills a resumed child on source withdrawal',async()=>{
 const f=await setup(),worker=f.start();await f.ready;const joined=await f.joinInput();f.finish();
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
 f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true')) WHERE id=?").run(joined);
 f.clock.advance(1000);expect(await worker.completed).toBe(false);expect(f.calls[1].child.killed).toBe(true);
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
});

it.each([100,101])('drains oldest sources beyond the history window and stops after 100 turns (queued=%s)',async total=>{
 const f=await setup();f.config.idleMs=30_000;
 const joined=await f.joinInput({prompt:'ORDERED 1'});
 // Persisted backlog fixture: ordinary filing capacity limits a current
 // conversation before 100 pending inputs. Clone one real admitted source to
 // witness older/backfilled queues without weakening production capacity.
 const template=JSON.parse((f.app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(joined) as {record:string}).record);
 const turn=JSON.parse((f.app.db.prepare('SELECT record FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`) as {record:string}).record);
 f.app.db.transaction(()=>{
  for(let i=2;i<total;i++){
   const id=`w-native-backlog-${i}`,prompt=`ORDERED ${i}`;
   f.app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(id,JSON.stringify({...template,id,prompt}),f.clock.now());
   f.app.db.prepare('INSERT INTO runtime_clock_turns(id,conversation,job,record) VALUES (?,?,?,?)').run(`clock:${id}`,f.config.binding.conversation,f.job,JSON.stringify({...turn,text:prompt}));
   provenanceStore(f.app.db).note(f.config.binding.conversation,'art',{key:`clock:${id}`,sender:{kind:'schedule',for:'owner'},at:f.clock.now()},['jonathan']);
  }
 })();
 expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_clock_turns WHERE job=?').get(f.job)).toEqual({n:total});
 expect(await f.attempt()).toBe(total===100);expect(f.calls).toHaveLength(100);
 for(let i=1;i<100;i++)expect(f.calls[i].input).toBe(`LOCAL OWNER RULES\nORDERED ${i}`);
 expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_clock_turns WHERE job=? AND consumed IS NOT NULL').get(f.job)).toEqual({n:100});
 if(total===101){
  expect(f.calls.some(c=>c.input.endsWith('ORDERED 100'))).toBe(false);
  f.config.idleMs=0;expect(await f.attempt()).toBe(true);expect(f.calls).toHaveLength(101);
  expect(f.calls[100].args).toContain('--session-id');expect(f.calls[100].args).not.toContain('--resume');
 }
},20_000);
it.each(['root','place','claim'] as const)('does not resume across a separately valid changed %s admission',async kind=>{
 const f=await setup(),worker=f.start();await f.ready;await f.joinInput();
 let replacement:{id:string;record:string}|undefined;
 if(kind==='root'){
  expect(f.call('clock.in',{agent:'art',prompt:'ANOTHER ROOT',note:'other',when:'1s'}).ok).toBe(true);
  f.clock.advance(1000);await settle();replacement=f.app.db.prepare('SELECT id,record FROM runtime_clock_turns WHERE job<>?').get(f.job) as typeof replacement;expect(replacement).toBeTruthy();
 }
 const original=globalThis.fetch;let admitted=0;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
  const response=await original(...args);
  if(String(args[0]).endsWith('/beginClockExecution')){
   expect(await response.clone().json()).toMatchObject({ok:false});admitted++;
  }
  if(String(args[0]).endsWith('/completeClockExecution')){
   if(kind==='root')f.app.db.transaction(()=>{
    f.app.db.prepare('DELETE FROM runtime_clock_turns WHERE id=?').run(replacement!.id);
    f.app.db.prepare('UPDATE runtime_clock_turns SET id=?,record=? WHERE id=?').run(replacement!.id,replacement!.record,`clock:${f.wake}`);
   })();
   if(kind==='place')f.store.put('binding',{...f.store.read('binding',f.config.binding.conversation)!,place:'replacement-place'},f.clock.now());
   if(kind==='claim')f.store.put('job',{...f.store.read('job',f.job)!,claimedAt:f.config.assignment.claimedAt+1},f.clock.now());
  }
  return response;
 });
 f.finish();expect(await worker.completed).toBe(false);expect(admitted).toBe(1);expect(f.calls).toHaveLength(1);
 vi.restoreAllMocks();expect(await f.post(f.config.credential,'beginClockExecution',{})).toMatchObject({ok:true});
});
it('a late successful retired watchdog cannot extend the resumed generation expiry',async()=>{
 const f=await setup(),worker=f.start();await f.ready;
 const held=holdResponse('currentClockExecution',1);
 try {
  await f.joinInput();await held.ready;f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
  // Later current-generation reads receive no response, so only its own
  // pre-spawn window can keep it alive. The old success arrives during it.
  const original=globalThis.fetch;
  vi.spyOn(globalThis,'fetch').mockImplementation((...args)=>{
   if(String(args[0]).endsWith('/currentClockExecution'))return new Promise<Response>((_resolve,reject)=>{
    const signal=(args[1] as RequestInit).signal;signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
   });
   return original(...args);
  });
  f.clock.advance(4000);held.release();await settle();expect(f.calls[1].child.killed).toBe(false);
  f.clock.advance(1000);expect(await worker.completed).toBe(false);expect(f.calls[1].child.killed).toBe(true);
 }finally {held.release();held.spy.mockRestore();}
});

it.each(['before-admission','during-turn'] as const)('earlier completed joined source withdrawal fences retained history %s',async phase=>{
 const f=await setup(),worker=f.start();await f.ready;const earlier=await f.joinInput();await f.joinInput({prompt:'THIRD SOURCE'});
 f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
 const withdraw=()=>f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true')) WHERE id=?").run(earlier);
 if(phase==='before-admission'){
  const original=globalThis.fetch;
  vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
   const response=await original(...args);if(String(args[0]).endsWith('/completeClockExecution'))withdraw();return response;
  });
  f.finish();expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(2);
 }else {
  f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(3));withdraw();f.clock.advance(1000);
  expect(await worker.completed).toBe(false);expect(f.calls[2].child.killed).toBe(true);
 }
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE job=? ORDER BY seq').all(f.job)).toEqual([{consumed:expect.any(Number)},{consumed:expect.any(Number)},{consumed:null}]);
});
it('a watchdog reaching Runtime after completion cannot consume the retained successor proof',async()=>{
 const f=await setup(),original=globalThis.fetch;let reads=0,release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 vi.spyOn(globalThis,'fetch').mockImplementation((...args)=>{
  if(String(args[0]).endsWith('/currentClockExecution')&&++reads===2){
   entered();return new Promise<Response>((resolve,reject)=>{release=()=>{void original(...args).then(resolve,reject);};});
  }
  return original(...args);
 });
 const worker=f.start();await f.ready;await f.joinInput();await ready;
 const held=holdResponse('completeClockExecution');
 try {f.finish();await held.ready;release();await settle();held.release();
  await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.finish();expect(await worker.completed).toBe(true);
 }finally {release();held.release();held.spy.mockRestore();}
});

it.each(['identity','consumption'] as const)('retained source %s tampering blocks successor admission and current execution',async kind=>{
 for(const phase of ['before-admission','during-turn'] as const){
  const f=await setup(),worker=f.start();await f.ready;const earlier=await f.joinInput(),third=await f.joinInput({prompt:'THIRD SOURCE'});
  f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
  const tamper=()=>{
   if(kind==='identity')f.app.db.prepare('UPDATE runtime_clock_turns SET seq=seq+100000 WHERE id=?').run(`clock:${earlier}`);
   else f.app.db.prepare('UPDATE runtime_clock_turns SET consumed=NULL WHERE id=?').run(`clock:${earlier}`);
  };
  if(phase==='before-admission'){
   const original=globalThis.fetch;
   const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
    const response=await original(...args);if(String(args[0]).endsWith('/completeClockExecution'))tamper();return response;
   });
   f.finish();expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(2);spy.mockRestore();
  }else {
   f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(3));tamper();f.clock.advance(1000);
   expect(await worker.completed).toBe(false);expect(f.calls[2].child.killed).toBe(true);
  }
  expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${third}`)).toEqual({consumed:null});
 }
});

it.each(['words','model','authority'] as const)('retained owning Clock source %s changes cannot carry native history forward',async kind=>{
 for(const phase of ['before-admission','during-turn'] as const){
  const f=await setup(),worker=f.start();await f.ready;const earlier=await f.joinInput(),third=await f.joinInput({prompt:'THIRD SOURCE'});
  f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
  const tamper=()=>{
   const row=f.app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(earlier) as {record:string},w=JSON.parse(row.record);
   if(kind==='words')w.prompt='REPLACED EARLIER WORDS';
   if(kind==='model')w.model='changed-earlier-model';
   // Pollock has no grant to give work to Art. The current root and third
   // source, their Runtime rows and the conversation steering stay untouched.
   if(kind==='authority')w.by={kind:'member',id:'pollock'};
   f.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(w),earlier);
  };
  if(phase==='before-admission'){
   const original=globalThis.fetch;
   const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
    const response=await original(...args);if(String(args[0]).endsWith('/completeClockExecution'))tamper();return response;
   });
   f.finish();expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(2);spy.mockRestore();
  }else {
   f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(3));tamper();f.clock.advance(1000);
   expect(await worker.completed).toBe(false);expect(f.calls[2].child.killed).toBe(true);
  }
  expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${earlier}`)).toEqual({consumed:expect.any(Number)});
  expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${third}`)).toEqual({consumed:null});
 }
});

// Completion must have reached the worker and armed its next idle tick before
// advancing the fake clock; a persisted ACK alone doesn't prove that boundary.
async function finishToIdle(f:Awaited<ReturnType<typeof setup>>){
 const at=vi.spyOn(f.clock,'at');
 f.finish();
 await vi.waitFor(()=>expect(at).toHaveBeenCalledWith(f.clock.now()+1000,expect.any(Function)));
 at.mockRestore();
}
it.each([false,true])('executable worker resumes an arrival after an empty-queue completion (private=%s)',async privateInput=>{
 const f=await setup(false,privateInput),input=new PassThrough(),signals=new EventEmitter(),stderr=vi.fn();
 const completed=runClockWorker({input,args:[],signals,stderr},{clock:f.clock,launch:f.launch});
 input.end(JSON.stringify({...f.config,idleMs:4000}));await f.ready;
 await finishToIdle(f);expect(f.consumed().consumed).not.toBeNull();
 const joined=await f.joinInput();
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
 expect(f.calls[1].args).toContain('--resume');
 expect(f.calls[1].args[f.calls[1].args.indexOf('--resume')+1]).toBe(f.calls[0].args[f.calls[0].args.indexOf('--session-id')+1]);
 expect(f.calls[1].input).toBe('LOCAL OWNER RULES\nLATER JOINED WORDS');
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
 await finishToIdle(f);f.clock.advance(4000);
 expect(await completed).toBe(0);expect(stderr).not.toHaveBeenCalled();
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:expect.any(Number)});
});
it('empty idle wait expires successfully without launching or retrying another child',async()=>{
 const f=await setup(),worker=f.start({...f.config,idleMs:3000});await f.ready;
 await finishToIdle(f);f.clock.advance(3000);
 expect(await worker.completed).toBe(true);expect(f.calls).toHaveLength(1);
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(1);
});
it.each(['revokePolicy','stopJob','cancelRequest','close'] as const)('owner %s ends an idle wait promptly',async action=>{
 const f=await setup(),worker=f.start({...f.config,idleMs:30_000});await f.ready;
 await finishToIdle(f);await worker[action]();
 expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(1);
});
it.each(['withdraw','credential','claim','model','policy'] as const)('idle probe rechecks original owning %s before retaining native history',async kind=>{
 const f=await setup(),worker=f.start({...f.config,idleMs:30_000});await f.ready;await finishToIdle(f);
 if(kind==='withdraw')f.withdraw();
 if(kind==='credential')signin(f.app).tokens.change(ts=>ts.splice(0,ts.length));
 if(kind==='claim'){const job=f.store.read('job',f.job)!;f.store.put('job',{...job,claimedAt:job.claimedAt!+1},f.clock.now());}
 if(kind==='model'){const job=f.store.read('job',f.job)!;f.store.put('job',{...job,model:'other'},f.clock.now());}
 if(kind==='policy')expect(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{deny:['Bash']}}).ok).toBe(true);
 f.clock.advance(1000);expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(1);
});
it('a stalled idle probe expires without resuming from a late reply',async()=>{
 const f=await setup(),worker=f.start({...f.config,idleMs:30_000});await f.ready;await finishToIdle(f);
 const held=holdResponse('idleClockExecution'),fetches=vi.spyOn(globalThis,'fetch');
 try{f.clock.advance(1000);await held.ready;f.clock.advance(3000);await settle();
  expect(fetches.mock.calls.filter(([url])=>String(url).endsWith('/api/runtime/idleClockExecution'))).toHaveLength(1);
  expect(held.count).toBe(1);f.clock.advance(2000);
  expect(await worker.completed).toBe(false);held.release();await settle();expect(f.calls).toHaveLength(1);
 }finally{held.release();}
});
it.each([-1,30_001,1.5,'3000',null])('rejects invalid owner idle wait %s before release',async idleMs=>{
 const f=await setup();expect(()=>f.start({...f.config,idleMs:idleMs as number})).toThrow();expect(f.calls).toHaveLength(0);
});

// Record wire ids at the HTTP seam; they remain Runtime ids, never native handles.
function captureExecution(){
 const original=globalThis.fetch;let execution:string|undefined;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
  const response=await original(...args);
  if(String(args[0]).endsWith('/api/runtime/beginClockExecution')){
   const body=await response.clone().json();if(body.ok)execution=body.value.execution;
  }
  return response;
 });
 return ()=>{expect(execution).toBeTruthy();return execution!;};
}
it('idle probes require the completed phase and cannot destroy an active execution',async()=>{
 const f=await setup(),execution=captureExecution(),worker=f.start({...f.config,idleMs:3000});await f.ready;
 expect(await f.post(f.config.credential,'idleClockExecution',{execution:execution()})).toMatchObject({ok:false,code:'denied'});
 await finishToIdle(f);
 expect(await f.post(f.config.credential,'idleClockExecution',{execution:execution()})).toMatchObject({ok:true,value:{current:true,more:false,ttl:5000}});
 // A late foreground watchdog likewise cannot destroy the completed proof.
 expect(await f.post(f.config.credential,'currentClockExecution',{execution:execution()})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.config.credential,'idleClockExecution',{execution:execution()})).toMatchObject({ok:true});
 f.clock.advance(3000);expect(await worker.completed).toBe(true);
});
it('idle probes never extend expiry or authorize cross-startup native history',async()=>{
 const f=await setup(),execution=captureExecution(),worker=f.start({...f.config,idleMs:3000});await f.ready;await finishToIdle(f);
 const previous=execution(),at=vi.spyOn(f.clock,'at');
 f.clock.advance(1000);
 await vi.waitFor(()=>expect(at).toHaveBeenCalledWith(f.clock.now()+1000,expect.any(Function)));at.mockRestore();
 expect(await f.post(f.config.credential,'idleClockExecution',{execution:previous})).toMatchObject({ok:true});
 f.clock.advance(2000);expect(await worker.completed).toBe(true);
 const joined=await f.joinInput();
 expect(await f.post(f.config.credential,'idleClockExecution',{execution:previous})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.config.credential,'beginClockExecution',{previous})).toMatchObject({ok:false,code:'denied'});
 expect(f.app.effects!.status(`runtime:clock-native:clock:${joined}`)).toBeUndefined();
 expect(await f.attempt()).toBe(true);expect(f.calls).toHaveLength(2);
 expect(f.calls[1].args).toContain('--session-id');expect(f.calls[1].args).not.toContain('--resume');
});
it('standalone file completion does not retain idle join authority',async()=>{
 const f=await setup(false,false,false,'native.md'),execution=captureExecution();writeFileSync(join(f.home,'native.md'),'FILE WORDS');
 const worker=f.start({...f.config,idleMs:3000});await f.ready;f.finish();expect(await worker.completed).toBe(true);
 expect(await f.post(f.config.credential,'idleClockExecution',{execution:execution()})).toMatchObject({ok:false,code:'denied'});
 expect(f.calls).toHaveLength(1);
});
it('idle request timeout also honors the earlier original idle deadline',async()=>{
 const f=await setup(),worker=f.start({...f.config,idleMs:3000});await f.ready;await finishToIdle(f);
 const held=holdResponse('idleClockExecution');
 try{f.clock.advance(1000);await held.ready;f.clock.advance(2000);
  expect(await worker.completed).toBe(false);held.release();await settle();expect(f.calls).toHaveLength(1);
 }finally{held.release();}
});

it('idle probes recheck earlier joined sources retained in native history',async()=>{
 const f=await setup(),worker=f.start({...f.config,idleMs:4000});await f.ready;
 const earlier=await f.joinInput();f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
 await f.joinInput();f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(3));
 await finishToIdle(f);
 f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true')) WHERE id=?").run(earlier);
 f.clock.advance(1000);expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(3);
});
it('an unsupported idle arrival gets no native effect or child',async()=>{
 const f=await setup(),worker=f.start({...f.config,idleMs:4000});await f.ready;await finishToIdle(f);
 const joined=await f.joinInput({model:'other'});
 expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(1);
 expect(f.app.effects!.status(`runtime:clock-native:clock:${joined}`)).toBeUndefined();
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
});
it('executable signal drains a sleeping idle worker without another fake-clock tick',async()=>{
 const f=await setup(),input=new PassThrough(),signals=new EventEmitter(),stderr=vi.fn();
 const completed=runClockWorker({input,args:[],signals,stderr},{clock:f.clock,launch:f.launch});
 input.end(JSON.stringify({...f.config,idleMs:30_000}));await f.ready;await finishToIdle(f);
 signals.emit('SIGTERM');expect(await completed).toBe(1);expect(f.calls).toHaveLength(1);
 expect(signals.listenerCount('SIGTERM')).toBe(0);expect(signals.listenerCount('SIGINT')).toBe(0);
});

it.each(['expire','signal','arrival','failure'] as const)('executable owns a real referenced idle handle until %s',async ending=>{
 const f=await setup(),input=new PassThrough(),signals=new EventEmitter(),stderr=vi.fn();
 const intervals=vi.spyOn(globalThis,'setInterval'),clear=vi.spyOn(globalThis,'clearInterval');
 const completed=runClockWorker({input,args:[],signals,stderr},{clock:f.clock,launch:f.launch});
 input.end(JSON.stringify({...f.config,idleMs:3000}));await f.ready;await finishToIdle(f);
 const index=intervals.mock.calls.findIndex(([fn,ms])=>ms===30_000);
 expect(index).toBeGreaterThanOrEqual(0);
 const handle=intervals.mock.results[index].value as NodeJS.Timeout;
 // The actual Node handle is referenced, even though injected Clock timers
 // need no OS handle and production Clock timers deliberately unref.
 expect(handle.hasRef()).toBe(true);expect(clear).not.toHaveBeenCalledWith(handle);
 if(ending==='signal')signals.emit('SIGTERM');
 else if(ending==='failure'){f.withdraw();f.clock.advance(1000);}
 else if(ending==='arrival'){
  await f.joinInput();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
  expect(clear).toHaveBeenCalledWith(handle);signals.emit('SIGTERM');
 }else f.clock.advance(3000);
 expect(await completed).toBe(ending==='expire'?0:1);
 expect(clear).toHaveBeenCalledWith(handle);expect(f.calls).toHaveLength(ending==='arrival'?2:1);
});

// A conservative lower advertised lifetime makes the worker's boundary fast
// without advancing 30 minutes of live watchdog requests. Actual server proof
// clipping at 30 minutes is separately exercised by the protocol fixture.
function lowerExecutionLifetime(){
 const original=globalThis.fetch;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
  const response=await original(...args);
  if(String(args[0]).endsWith('/api/runtime/beginClockExecution')){
   const body=await response.clone().json();
   if(body.ok)return new Response(JSON.stringify({...body,value:{...body.value,lifetime:1500}}),{status:response.status,headers:response.headers});
  }
  return response;
 });
}
it('worker discards idle history at the admission lifetime before the first normal probe tick',async()=>{
 const f=await setup();lowerExecutionLifetime();const worker=f.start({...f.config,idleMs:30_000});await f.ready;
 f.clock.advance(1000);const at=vi.spyOn(f.clock,'at'),intervals=vi.spyOn(globalThis,'setInterval'),close=vi.spyOn(ClaudeWorkerSession.prototype,'close');f.finish();
 await vi.waitFor(()=>expect(intervals).toHaveBeenCalledWith(expect.any(Function),30_000));
 expect(at).toHaveBeenCalledWith(f.clock.now()+500,expect.any(Function));at.mockRestore();
 f.clock.advance(500);await settle();expect(close).toHaveBeenCalled();
 expect(await worker.completed).toBe(true);expect(f.calls).toHaveLength(1);
 const joined=await f.joinInput();expect(await f.attempt()).toBe(true);
 expect(f.calls).toHaveLength(2);expect(f.calls[1].args).not.toContain('--resume');
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:expect.any(Number)});
});
it('the admission lifetime fences native history while a completion response is stalled',async()=>{
 const f=await setup();lowerExecutionLifetime();const worker=f.start({...f.config,idleMs:30_000});await f.ready;
 f.clock.advance(1000);const held=holdResponse('completeClockExecution'),close=vi.spyOn(ClaudeWorkerSession.prototype,'close');
 try{f.finish();await held.ready;f.clock.advance(500);await settle();expect(close).toHaveBeenCalled();
  expect(await worker.completed).toBe(false);held.release();await settle();expect(f.calls).toHaveLength(1);
 }finally{held.release();}
});

it.each([false,true])('a successfully decoded idle reply crossing its deadline stays uncertain (more=%s)',async more=>{
 const f=await setup(),original=globalThis.fetch,now=f.clock.now();
 const readClock=vi.spyOn(f.clock,'now');
 vi.spyOn(globalThis,'fetch').mockImplementation(async(...args)=>{
  const response=await original(...args);
  if(String(args[0]).endsWith('/api/runtime/idleClockExecution')){
   const body=await response.clone().json();expect(body).toMatchObject({ok:true,value:{more}});
   // Simulate time spent decoding a successful response without delivering the
   // overdue timer callback. This is the deadline edge a held socket misses.
   readClock.mockReturnValue(now+3001);
   return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  }
  return response;
 });
 const worker=f.start({...f.config,idleMs:3000});await f.ready;await finishToIdle(f);
 try{
  if(more)await f.joinInput();else f.clock.advance(1000);
  expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(1);
 }finally{readClock.mockRestore();}
});
async function emptyIdleTick(f:Awaited<ReturnType<typeof setup>>){
 const at=vi.spyOn(f.clock,'at');f.clock.advance(1000);
 await vi.waitFor(()=>expect(at).toHaveBeenCalledWith(f.clock.now()+1000,expect.any(Function)));at.mockRestore();
}
it('a successful resumed turn opens a new idle window beyond the first deadline',async()=>{
 const f=await setup(),worker=f.start({...f.config,idleMs:4000});await f.ready;
 await finishToIdle(f);const firstDeadline=f.clock.now()+4000;
 await emptyIdleTick(f);await emptyIdleTick(f);
 await f.joinInput();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
 await finishToIdle(f);const secondDeadline=f.clock.now()+4000;
 await emptyIdleTick(f);
 const third=await f.joinInput();expect(f.clock.now()).toBeGreaterThan(firstDeadline);expect(f.clock.now()).toBeLessThan(secondDeadline);
 await vi.waitFor(()=>expect(f.calls).toHaveLength(3));
 expect(f.calls[2].args).toContain('--resume');
 expect(f.calls[2].args[f.calls[2].args.indexOf('--resume')+1]).toBe(f.calls[0].args[f.calls[0].args.indexOf('--session-id')+1]);
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${third}`)).toEqual({consumed:null});
 await finishToIdle(f);f.clock.advance(4000);expect(await worker.completed).toBe(true);
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${third}`)).toEqual({consumed:expect.any(Number)});
});

it.each(['direct','card'] as const)('fresh owner %s adoption supplies current authorship to actual native execution',async adoption=>{
 const f=await setup(false,false,false,undefined,adoption);
 const adopted=readWake(f.app.db,f.wake)!;
 expect(adopted.legacy).toMatchObject({for:'-',origin:'agent:art'});
 const signals=new EventEmitter(),input=new PassThrough();
 const result=runClockWorker({input,args:[],signals,stderr(){}},{clock:f.clock,launch:f.launch});
 input.end(JSON.stringify(f.config));
 // Await completion or spawn: a refused admission must fail promptly, not hang the test.
 await Promise.race([f.ready,result]);expect(f.calls).toHaveLength(1);
 expect(f.calls[0].input).toBe('LOCAL OWNER RULES\nONLY CURRENT SCHEDULED WORDS');
 expect(f.consumed().consumed).toBeNull();f.finish();expect(await result).toBe(0);
 expect(f.consumed().consumed).not.toBeNull();
 expect(adopted.authorship).toEqual({principal:{for:'owner',people:['jonathan']}});
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(1);
});

it('resuming cannot renew the original worker history lifetime even with a longer successor lease',async()=>{
 const f=await setup();lowerExecutionLifetime();const worker=f.start();await f.ready;
 const joined=await f.joinInput();f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
 expect(f.calls[1].args).toContain('--resume');
 // The successor advertises another 1500 ms, but the original admission has
 // only 500 ms left. A stalled active child must die at that original edge.
 f.clock.advance(499);expect(f.calls[1].child.killed).toBe(false);
 f.clock.advance(1);expect(f.calls[1].child.killed).toBe(true);expect(await worker.completed).toBe(false);
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
});

it.each([false,true])('retained history expires while successor admission is stalled (idle=%s)',async idle=>{
 const f=await setup();lowerExecutionLifetime();const worker=f.start({...f.config,idleMs:idle?30_000:0});await f.ready;
 const close=vi.spyOn(ClaudeWorkerSession.prototype,'close');
 const held=holdResponse('beginClockExecution');
 try{
  let joined:string;
  if(idle){await finishToIdle(f);joined=await f.joinInput();}
  else{joined=await f.joinInput();f.finish();}
  await held.ready;f.clock.advance(500);await settle();
  expect(close).toHaveBeenCalled();expect(await worker.completed).toBe(false);expect(f.calls).toHaveLength(1);
  expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:null});
  held.release();await settle();expect(f.calls).toHaveLength(1);
 }finally{held.release();}
});

it('a completed successor cannot renew idle history beyond the first admission deadline',async()=>{
 const f=await setup();lowerExecutionLifetime();const worker=f.start({...f.config,idleMs:30_000});await f.ready;
 const joined=await f.joinInput();f.finish();await vi.waitFor(()=>expect(f.calls).toHaveLength(2));
 const intervals=vi.spyOn(globalThis,'setInterval'),close=vi.spyOn(ClaudeWorkerSession.prototype,'close');f.finish();
 await vi.waitFor(()=>expect(intervals).toHaveBeenCalledWith(expect.any(Function),30_000));
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${joined}`)).toEqual({consumed:expect.any(Number)});
 f.clock.advance(500);await settle();expect(close).toHaveBeenCalled();expect(await worker.completed).toBe(true);expect(f.calls).toHaveLength(2);
});

it('the first successful admission lifetime starts before its delayed response',async()=>{
 const f=await setup();lowerExecutionLifetime();const held=holdResponse('beginClockExecution'),worker=f.start();
 try{
  await held.ready;f.clock.advance(1000);held.release();await f.ready;
  f.clock.advance(499);expect(f.calls[0].child.killed).toBe(false);
  f.clock.advance(1);expect(f.calls[0].child.killed).toBe(true);expect(await worker.completed).toBe(false);expect(f.consumed().consumed).toBeNull();
 }finally{held.release();}
});
