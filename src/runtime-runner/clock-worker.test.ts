import {afterEach,expect,it,vi} from 'vitest';
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
import {runtimeStore} from '../pieces/runtime/store.js';
import {startClockWorker,type ClockWorkerConfig} from './clock-worker.js';
import type {SpawnClaude} from './session.js';
import * as preparation from './clock-input.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'};
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
async function setup(staging=false){
 const home=mkdtempSync(join(tmpdir(),'clock-native-'));fixture(home);closes.push(()=>rmSync(home,{recursive:true,force:true}));
 const access=structuredClone(fixtureSharing());
 const clock=new FakeClock(),app=await startLoom({home,clock,next:true,staging,sharing:()=>access,stdout(){}});closes.push(app.close);access.services=builtinServices(app.db);
 const storage=runtimeStore(app.db),store={...storage,put:(...args:Parameters<typeof storage.put>)=>app.db.transaction(()=>storage.put(...args))()};let n=0;
 const call=(name:string,input:unknown,viewer=owner)=>app.operations.call('direct',viewer,name,input,`fixture-${++n}`);
 app.db.transaction(()=>signin(app).tokens.replace({v:1,tokens:[]},{}))();
 store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());
 store.put('box',{id:'a',name:'a',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
 expect(call('signin.setPrincipal',{kind:'runner',id:'a',active:true}).ok).toBe(true);
 const runner=randomBytes(32).toString('hex');
 signin(app).tokens.change(ts=>ts.push({role:'runner:a',label:'fixture runner',sha256:hash(runner),created:new Date(clock.now()).toISOString()}));
 const post=async(token:string,name:string,input={})=>(await fetch(`${app.url}/api/runtime/${name}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({input,id:`http-${++n}`})})).json();
 const scheduled=call('clock.in',{agent:'art',prompt:'ONLY CURRENT SCHEDULED WORDS',note:'fixture',when:'1s'});
 expect(scheduled).toMatchObject({ok:true});const wake=(scheduled as {ok:true;value:{id:string}}).value.id;
 clock.advance(1000);await settle();const job=store.ids('job')[0];expect(job).toBeTruthy();
 expect(await post(runner,'claimJob',{job})).toMatchObject({ok:true});
 if(staging){expect(await post(runner,'takeInput',{job})).toMatchObject({ok:false});expect(call('core.releaseEffect',{id:`runtime:input:${job}`}).ok).toBe(true);}
 const input=await post(runner,'takeInput',{job});expect(input).toMatchObject({ok:true,value:{credential:expect.any(String)}});
 expect(await post(runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 const b=store.read('binding',input.value.conversation)!;
 const config:ClockWorkerConfig={url:app.url,credential:input.value.credential,job,
  binding:{agent:'art',conversation:b.id,venue:'wake',place:b.place},checkout:home,command:'/worker/claude',env:{WORKER:'yes'},
  rules:{key:'a'.repeat(64),deny:['Bash(rm *)'],sections:[{text:'LOCAL OWNER RULES'}]}};
 const calls:Array<{args:readonly string[];input:string;child:EventEmitter&{stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kill:()=>boolean;killed:boolean};options:unknown}>=[];
 let launched!:()=>void;const ready=new Promise<void>(r=>{launched=r;});
 const launch:SpawnClaude=(_cmd,args,options)=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,
   kill(){this.killed=true;queueMicrotask(()=>this.emit('close',null));return true;}});
  const c={args,input:'',child,options};child.stdin.on('data',v=>{c.input+=v.toString();launched();});calls.push(c);
  return child as ReturnType<SpawnClaude>;
 };
 const finish=()=>{const c=calls.at(-1)!,session=c.args[c.args.indexOf('--session-id')+1];
  c.child.stdout.end(JSON.stringify({type:'result',is_error:false,session_id:session,result:'PRIVATE RESULT'}));c.child.emit('close',0);};
 const start=(override=config)=>{const worker=startClockWorker(override,{clock,launch});closes.push(worker.close);return worker;};
 const withdraw=()=>{fenceSource();};
 const fenceSource=()=>{app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true')) WHERE id=?").run(wake);};
 const consumed=()=>app.db.prepare('SELECT consumed FROM runtime_clock_turns WHERE id=?').get(`clock:${wake}`) as {consumed:number|null};
 return {home,app,clock,store,call,post,wake,job,config,calls,ready,finish,start,consumed,withdraw,access};
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
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
});
it.each(['place','claim','conversation','policy','credential'] as const)('refuses changed owning %s after read and before native launch',async kind=>{
 const f=await setup(),original=preparation.prepareClockInput;
 vi.spyOn(preparation,'prepareClockInput').mockImplementation((...args)=>{
  const value=original(...args),job=f.store.read('job',f.job)!,binding=f.store.read('binding',f.config.binding.conversation)!;
  if(kind==='place')f.store.put('binding',{...binding,place:'another-valid-place'},f.clock.now());
  if(kind==='claim')f.store.put('job',{...job,claimedAt:job.claimedAt!+1},f.clock.now());
  if(kind==='conversation'){
   f.store.put('binding',{...binding,id:'another-conversation'},f.clock.now());
   f.store.put('job',{...job,conversation:'another-conversation'},f.clock.now());
  }
  if(kind==='policy')expect(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{deny:['Bash']}}).ok).toBe(true);
  if(kind==='credential')signin(f.app).tokens.change(tokens=>{for(const t of tokens)if(t.sha256===hash(f.config.credential))t.revoked=new Date(f.clock.now()).toISOString();});
  return value;
 });
 expect(await f.start().completed).toBe(false);expect(f.calls).toHaveLength(0);expect(f.consumed().consumed).toBeNull();
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
