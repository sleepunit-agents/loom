import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {ChildProcess} from 'node:child_process';
import {generateIdentity} from 'age-encryption';
import {startLoom} from '../foundation.js';
import {SharingDatabase} from '../core/household/sharing.js';
import {signin,hash} from '../core/signin/index.js';
import {runtimeStore} from '../pieces/runtime/store.js';
import {openHolderStore} from '../pieces/secrets/holder-store.js';
import {startPersistentHolder} from '../secret-holder-startup.js';
import {startSecretWorkers} from '../secret-worker-startup.js';
import {secretJobAssignment} from '../secret-job-assignment.js';
import {inspectWorkerReceipts} from './receipts.js';
import {ticketAuthorityFixture} from './ticket-authority.fixture.js';
import {runRuntimeSecretJob} from './secret-job.js';
import {startRuntimeSecretWorker} from './runtime-secret-worker.js';
import {runtimeJobTransport} from './job-transport.js';
import type {WorkerControlRuntime} from './control.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
async function setup(staging=false,commandExit=0,service?:string) {
 const f=await ticketAuthorityFixture(closes,service);await f.authority.close();await f.app.close();
 const app=await startLoom({home:f.home,next:true,staging,clock:f.clock,stdout(){}});closes.push(app.close);
 const sharing=()=>new SharingDatabase(app.db,f.home).sharing();
 const socket=(name:string)=>join(f.home,name+'.sock');
 const daemon=await startSecretWorkers(app,sharing,app.effects!,{authority:f.server,
  admission:{...f.server,socket:socket('admission')},holder:{config:{...f.server,socket:socket('holder'),servername:'holder.test'},fingerprint:f.fingerprint('holder')},
  workers:[{tokenDigest:f.tokenDigest,fingerprint:f.fingerprint('daemon')}]});closes.push(daemon.close);
 const directory=join(f.home,'ciphertext'),identity=join(f.home,'age-key'),fingerprintKey=join(f.home,'retry-key');
 mkdirSync(directory,{mode:0o700});writeFileSync(identity,await generateIdentity(),{mode:0o600});writeFileSync(fingerprintKey,randomBytes(32),{mode:0o600});
 const seed=await openHolderStore(directory,identity,fingerprintKey);
 await seed.set({member:'jonathan',writeId:randomUUID()},'API',Buffer.from('synthetic-owner-value'),'add');seed.close();
 const holderFile=join(f.home,'holder.json');
 writeFileSync(holderFile,JSON.stringify({directory,identity,fingerprintKey,daemonFingerprint:f.fingerprint('daemon'),
  read:{...f.config,socket:socket('read'),servername:undefined},mutation:{...f.config,socket:socket('write'),servername:undefined},
  authority:{...f.config,socket:socket('write-authority')},handoff:{listen:{...f.config,socket:socket('holder'),servername:undefined},authority:f.config,workers:[]}}),{mode:0o600});
 const holder=await startPersistentHolder(holderFile);closes.push(holder.close);
 const store=runtimeStore(app.db),house=store.read('settings','art')!.house!;
 app.db.transaction(()=>{
  const {changedAt:_,claimedAt:_claim,made:_made,...before}=store.read('job',f.id)!;
  store.put('job',{...before,state:'queued'},f.clock.now());
  app.db.prepare('INSERT INTO runtime_inputs(job,brief,needs) VALUES (?,?,?)').run(f.id,'Unused command brief','[]');
 })();
 expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'worker',active:true},randomUUID()).ok).toBe(true);
 const token='synthetic-owner-runner';
 signin(app).tokens.change(tokens=>tokens.push({role:'runner:worker',sha256:hash(token),label:'fixture',created:new Date(f.clock.now()).toISOString()}));
 const receipts=join(f.home,'receipts');mkdirSync(receipts,{mode:0o700});
 const marker=join(f.home,'accepted'),input=socket('input');
 const script="const fs=require('node:fs');process.on('SIGUSR2',()=>process.exit(0));let b=[];fs.createReadStream(null,{fd:3}).on('data',v=>b.push(v)).on('end',()=>{if(Buffer.concat(b).toString()!=='synthetic-owner-value')process.exit(1);fs.writeFileSync(process.argv[1],'accepted');setInterval(()=>{},10000);});";
 const config={job:f.id,agent:'art',tokenDigest:f.tokenDigest,fingerprint:f.fingerprint('daemon'),policy:['API'],name:'API',
  expiresAt:Date.now()+20_000,grantExpiresAt:Date.now()+20_000,
  command:{command:process.execPath,args:['-e',script.replace('process.exit(0)','process.exit('+commandExit+')'),marker],cwd:f.home,env:{},input:{...f.server,socket:input},holderFingerprint:f.fingerprint('holder'),
   authority:{...f.server,servername:'daemon.test'},daemonFingerprint:f.fingerprint('daemon'),admission:{...f.server,socket:socket('admission'),servername:'daemon.test'}},
  holder:{config:{...f.config,socket:input},fingerprint:f.fingerprint('daemon')}};
 const source=secretJobAssignment(app,sharing,config,{daemon,holder});closes.push(source.close);
 let child:ChildProcess|undefined;
 const emit=ChildProcess.prototype.emit;
 vi.spyOn(ChildProcess.prototype,'emit').mockImplementation(function(this:ChildProcess,...args:Parameters<ChildProcess['emit']>){
  if(args[0]==='spawn')child=this;return Reflect.apply(emit,this,args);
 });
 const calls:{name:string;body:unknown}[]=[],ticks=new Set<()=>void>();
 const runtime:WorkerControlRuntime={deadline:ms=>AbortSignal.timeout(ms),every(callback){ticks.add(callback);return ()=>{ticks.delete(callback);};},request:async(url,init)=>{
  const name=new URL(String(url)).pathname.split('/').pop()!;calls.push({name,body:JSON.parse(String(init?.body))});
  const response=await fetch(url,init);
  if(name==='reportJob'&&response.ok){await expect.poll(()=>existsSync(marker)).toBe(true);child?.kill('SIGUSR2');}
  return response;
 }};
 const start=()=>runRuntimeSecretJob({url:app.url,token,job:f.id},{agent:'art',house,receipts},source,runtime);
 return {...f,app,source,config,runtime,calls,start,marker,receipts,directory,store,controlConfig:{url:app.url,token,job:f.id},complete(){child?.kill('SIGUSR2');},tick(){for(const tick of [...ticks])tick();}};
}
it('drives a real queued claim through original source routes, persistent holder, fd3 command and value-free finish',async()=>{
 const f=await setup();f.clock.advance(17);
 await f.start();
 const job=f.store.read('job',f.id)!;
 expect(job).toMatchObject({state:'done',claimedAt:f.clock.now()});
 const row=f.app.db.prepare('SELECT destination,state FROM secrets_tickets').get() as {destination:string;state:string};
 expect(JSON.parse(row.destination)).toMatchObject({job:f.id,claimedAt:job.claimedAt,agent:'art',runner:'worker',box:'worker'});
 expect(row.state).toBe('released');expect(readFileSync(f.marker,'utf8')).toBe('accepted');
 expect(f.calls.filter(c=>c.name!=='jobControl').map(c=>c.name)).toEqual(['claimJob','takeInput','reportJob','finishJob']);
 expect(f.calls.find(c=>c.name==='finishJob')!.body).toMatchObject({input:{job:f.id,state:'done'}});
 expect(Object.keys((f.calls.find(c=>c.name==='finishJob')!.body as {input:object}).input)).toEqual(['job','execution','state']);
 expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{job:f.id,phase:'finished'}]);
 for(const {name} of f.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]) {
  expect(JSON.stringify(f.app.db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all())).not.toContain('synthetic-owner-value');
 }
 for(const file of ['holder.db','holder.db-wal'])if(existsSync(join(f.directory,file)))expect(readFileSync(join(f.directory,file)).includes('synthetic-owner-value')).toBe(false);
 await expect(f.start()).rejects.toThrow();
});
it('holds actual Runtime input in staging without installing routes or spawning a command',async()=>{
 const f=await setup(true),spawn=vi.spyOn(ChildProcess.prototype,'spawn');
 await expect(f.start()).rejects.toThrow();expect(spawn).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
 expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{phase:'input-attempt'}]);
 expect(f.calls.filter(c=>c.name!=='jobControl').map(c=>c.name)).toEqual(['claimJob','takeInput']);
});
it('a failed original source credential cannot be replaced after the claim',async()=>{
 const f=await setup(),original=f.runtime.request;
 f.runtime.request=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/claimJob'))signin(f.app).tokens.change(tokens=>{for(const token of tokens)if(token.sha256===f.tokenDigest)token.revoked=new Date(f.clock.now()).toISOString();});return response;};
 await expect(f.start()).rejects.toThrow();expect(existsSync(f.marker)).toBe(false);
 expect(f.calls.some(c=>c.name==='reportJob'||c.name==='finishJob')).toBe(false);
});
it.each(['claimJob','takeInput','reportJob','finishJob'] as const)('never retries an uncertain %s acknowledgement',async name=>{
 const f=await setup(),request=f.runtime.request;
 f.runtime.request=async(...args)=>{const response=await request(...args);if(String(args[0]).endsWith('/'+name))throw Error('private diagnostic');return response;};
 await expect(f.start()).rejects.toThrow(/^Secret job stopped; reconcile the job before retrying$/);
 expect(f.calls.filter(call=>call.name===name)).toHaveLength(1);
 if(name==='takeInput') {
  expect(existsSync(f.marker)).toBe(false);
  expect(f.app.effects!.status('runtime:input:'+f.id)).toBe('done');
  await expect(f.start()).rejects.toThrow();
  expect(f.calls.filter(call=>call.name===name)).toHaveLength(1);
 }
 expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{phase:name==='claimJob'?'claim-attempt':name==='takeInput'?'input-attempt':name==='reportJob'?'running-attempt':'finish-attempt'}]);
});
it('snapshots command and endpoint selection before claim IO',async()=>{
 const f=await setup();f.config.command.command='/missing';f.config.command.input.socket='/missing';f.config.holder.config.socket='/missing';f.config.policy.length=0;
 await f.start();expect(readFileSync(f.marker,'utf8')).toBe('accepted');
});
it('source retirement during claim IO fences the late acknowledgement before input release',async()=>{
 const f=await setup(),request=f.runtime.request;
 f.runtime.request=async(...args)=>{const response=await request(...args);if(String(args[0]).endsWith('/claimJob'))await f.source.close();return response;};
 await expect(f.start()).rejects.toThrow();expect(f.calls.some(c=>c.name==='takeInput')).toBe(false);expect(existsSync(f.marker)).toBe(false);
});
it.each(['credential','conversation','model','account','job','agent','house'] as const)('refuses %s input before selecting any source route',async field=>{
 const f=await setup(),request=f.runtime.request,spawn=vi.spyOn(ChildProcess.prototype,'spawn');
 f.runtime.request=async(...args)=>{
  const response=await request(...args);if(!String(args[0]).endsWith('/takeInput'))return response;
  const envelope=await response.json();envelope.value[field]=field==='house'?{repo:'/other',houseFile:'house/house.json'}:'synthetic-foreign';
  return Response.json(envelope);
 };
 await expect(f.start()).rejects.toThrow();expect(spawn).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
 expect(f.calls.some(c=>c.name==='reportJob'||c.name==='finishJob')).toBe(false);
 expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{phase:'input-attempt'}]);
});
it.each(['claimJob','reportJob','finishJob'] as const)('refuses a mismatched %s acknowledgement without another write',async name=>{
 const f=await setup(),request=f.runtime.request;
 f.runtime.request=async(...args)=>{const response=await request(...args);return String(args[0]).endsWith('/'+name)?Response.json({ok:true,value:{job:'foreign',state:name==='claimJob'?'starting':name==='reportJob'?'running':'done'}}):response;};
 await expect(f.start()).rejects.toThrow();expect(f.calls.filter(c=>c.name===name)).toHaveLength(1);
 if(name==='claimJob')expect(f.calls.some(c=>c.name==='takeInput')).toBe(false);
 if(name==='reportJob')expect(f.calls.some(c=>c.name==='finishJob')).toBe(false);
});
it.each(['retire','assignment'] as const)('fences %s after delivery while the running acknowledgement is awaiting',async action=>{
 const f=await setup(),request=f.runtime.request;let enter!:()=>void,release!:()=>void;
 const ready=new Promise<void>(resolve=>{enter=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
 f.runtime.request=async(...args)=>{
  if(String(args[0]).endsWith('/reportJob')){enter();await wait;}
  return request(...args);
 };
 const kill=vi.spyOn(ChildProcess.prototype,'kill'),running=f.start();void running.catch(()=>{});
 try {
  await ready;
  if(action==='retire')await f.source.close();
  else {const {changedAt:_,...before}=f.store.read('job',f.id)!;f.app.db.transaction(()=>f.store.put('job',{...before,claimedAt:f.clock.now()+1},f.clock.now()))();f.tick();}
  await expect.poll(()=>kill.mock.calls.some(args=>args[0]==='SIGKILL')).toBe(true);
  release();await expect(running).rejects.toThrow();expect(f.calls.some(c=>c.name==='finishJob')).toBe(false);
  expect(existsSync(f.config.command.input.socket)).toBe(false);
 }finally {release();await running.catch(()=>{});}
});
it('retirement during the dedicated worker initial control read cannot spawn a late command',async()=>{
 const f=await setup(),request=f.runtime.request,spawn=vi.spyOn(ChildProcess.prototype,'spawn');let reads=0;
 f.runtime.request=async(...args)=>{
  const response=await request(...args);
  if(String(args[0]).endsWith('/jobControl')&&++reads===3)void f.source.close();
  return response;
 };
 await expect(f.start()).rejects.toThrow();expect(spawn).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
 expect(f.calls.some(c=>c.name==='reportJob'||c.name==='finishJob')).toBe(false);
});
it('captures runtime callbacks and their receiver before initial control IO',async()=>{
 const f=await setup(),request=f.runtime.request;let first=true;
 const deadline=vi.fn(function(this:WorkerControlRuntime,ms:number){expect(this).toBe(f.runtime);return AbortSignal.timeout(ms);});f.runtime.deadline=deadline;
 f.runtime.request=async(...args)=>{
  const response=await request(...args);if(first){first=false;f.runtime.request=()=>Promise.reject(Error('replacement'));f.runtime.deadline=()=>{throw Error('replacement');};f.runtime.every=()=>{throw Error('replacement');};}
  return response;
 };
 await f.start();expect(deadline).toHaveBeenCalled();
});
it('retains original expiry through the outer post-completion authority read',async()=>{
 const f=await setup(),request=f.runtime.request;let postReportReads=0;
 f.runtime.request=async(...args)=>{
  const response=await request(...args);
  if(String(args[0]).endsWith('/jobControl')&&f.calls.some(c=>c.name==='reportJob')&&++postReportReads===2)vi.spyOn(Date,'now').mockReturnValue(f.config.expiresAt);
  return response;
 };
 await expect(f.start()).rejects.toThrow();expect(f.calls.some(c=>c.name==='finishJob')).toBe(false);
 expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{phase:'output-returned'}]);
});

it('does not finish a delivered command that exits unsuccessfully',async()=>{
 const f=await setup(false,1);
 await expect(f.start()).rejects.toThrow();expect(readFileSync(f.marker,'utf8')).toBe('accepted');
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets').get()).toEqual({state:'released'});
 expect(f.calls.some(c=>c.name==='reportJob')).toBe(true);expect(f.calls.some(c=>c.name==='finishJob')).toBe(false);
 expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{phase:'running'}]);
});

it('pins the released Runtime input through the final completion boundary',async()=>{
 const f=await setup(),request=f.runtime.request;let postReportReads=0;
 f.runtime.request=async(...args)=>{
  if(String(args[0]).endsWith('/jobControl')&&f.calls.some(c=>c.name==='reportJob')&&++postReportReads===2)
   f.app.db.prepare('UPDATE runtime_inputs SET brief=? WHERE job=?').run('Replacement otherwise-valid brief',f.id);
  return request(...args);
 };
 await expect(f.start()).rejects.toThrow();expect(f.calls.some(c=>c.name==='finishJob')).toBe(false);
 expect(f.store.read('job',f.id)).toMatchObject({state:'running'});
 const input=f.calls.find(c=>c.name==='takeInput')!.body as {input:unknown};expect(input.input).toEqual({job:f.id,pinUnbound:true});
 const controls=f.calls.filter(c=>c.name==='jobControl').map(c=>(c.body as {input:{execution?:string}}).input.execution);
 expect(controls.filter(Boolean).every(pin=>pin===controls.find(Boolean))).toBe(true);
});

it('carries a service-bearing original source assignment through a real claim and both routes',async()=>{
 const f=await setup(false,0,'bridge');let worker:Awaited<ReturnType<typeof startRuntimeSecretWorker>>|undefined;
 f.source.own(async()=>{await worker?.close();});
 const call=runtimeJobTransport(f.controlConfig,f.runtime);
 expect(await call('claimJob',{job:f.id})).toEqual({job:f.id,state:'starting'});
 const assignment=await f.source.claimed(f.id);
 expect(assignment.selection.jobs[0].binding).toMatchObject({job:f.id,service:'bridge',claimedAt:f.clock.now()});
 worker=await startRuntimeSecretWorker(f.controlConfig,assignment.selection,f.runtime,{signal:f.source.signal,current:assignment.current});closes.push(worker.close);
 expect(await worker.delivery).toBe(true);await expect.poll(()=>existsSync(f.marker)).toBe(true);f.complete();expect(await worker.completed).toBe(true);
 const row=f.app.db.prepare('SELECT destination,state FROM secrets_tickets').get() as {destination:string;state:string};
 expect(JSON.parse(row.destination)).toEqual(assignment.selection.jobs[0].binding);expect(row.state).toBe('released');
 await f.source.close();
});
it('source retirement joins the actual child close before allowing exclusive slots to be reused',async()=>{
 const f=await setup(),request=f.runtime.request;let report!:()=>void,resumeReport!:()=>void,childClosed!:()=>void;
 const ready=new Promise<void>(resolve=>{report=resolve;}),wait=new Promise<void>(resolve=>{resumeReport=resolve;}),closedEvent=new Promise<void>(resolve=>{childClosed=resolve;});
 f.runtime.request=async(...args)=>{if(String(args[0]).endsWith('/reportJob')){report();await wait;}return request(...args);};
 const delegate=vi.mocked(ChildProcess.prototype.emit).getMockImplementation()!;
 let lateChild:ChildProcess|undefined,lateArgs:Parameters<ChildProcess['emit']>|undefined,released=false;
 vi.mocked(ChildProcess.prototype.emit).mockImplementation(function(this:ChildProcess,...args:Parameters<ChildProcess['emit']>){
  if(args[0]==='close'&&!released){lateChild=this;lateArgs=args;childClosed();return true;}
  return Reflect.apply(delegate,this,args);
 });
 const running=f.start();void running.catch(()=>{});let drained=false;
 try {
  await ready;const closing=f.source.close().then(()=>{drained=true;});
  await closedEvent;await new Promise<void>(resolve=>setImmediate(resolve));expect(drained).toBe(false);
  released=true;Reflect.apply(delegate,lateChild!,lateArgs!);await closing;expect(drained).toBe(true);
  resumeReport();await expect(running).rejects.toThrow();expect(existsSync(f.config.command.input.socket)).toBe(false);
 }finally {
  released=true;if(lateChild&&lateArgs)Reflect.apply(delegate,lateChild,lateArgs);resumeReport();await running.catch(()=>{});
 }
});
it.each(['reportJob','finishJob'] as const)('atomically refuses an otherwise-valid input replacement immediately before %s',async name=>{
 const f=await setup(),request=f.runtime.request;
 f.runtime.request=async(...args)=>{
  if(String(args[0]).endsWith('/'+name))f.app.db.prepare('UPDATE runtime_inputs SET brief=? WHERE job=?').run('Later valid brief',f.id);
  return request(...args);
 };
 await expect(f.start()).rejects.toThrow();expect(f.store.read('job',f.id)!.state).not.toBe('done');
 expect(f.calls.filter(c=>c.name===name)).toHaveLength(1);
 expect(inspectWorkerReceipts(f.receipts)).toMatchObject([{phase:name==='reportJob'?'running-attempt':'finish-attempt'}]);
});
it('snapshots the dedicated worker execution assertion before its initial control read',async()=>{
 const f=await setup(),call=runtimeJobTransport(f.controlConfig,f.runtime);
 await call('claimJob',{job:f.id});const input=await call('takeInput',{job:f.id,pinUnbound:true}) as {execution:string};
 let worker:Awaited<ReturnType<typeof startRuntimeSecretWorker>>|undefined,starting:Promise<Awaited<ReturnType<typeof startRuntimeSecretWorker>>>|undefined;
 f.source.own(async()=>{await (worker??await starting?.catch(()=>undefined))?.close();});
 const assignment=await f.source.claimed(f.id),owner={signal:f.source.signal,current:assignment.current,execution:input.execution},request=f.runtime.request;
 let first=true;f.runtime.request=async(...args)=>{const response=await request(...args);if(first){first=false;owner.execution='0'.repeat(64);}return response;};
 starting=startRuntimeSecretWorker(f.controlConfig,assignment.selection,f.runtime,owner);worker=await starting;closes.push(worker.close);
 expect(await worker.delivery).toBe(true);await expect.poll(()=>existsSync(f.marker)).toBe(true);f.complete();expect(await worker.completed).toBe(true);
 const pins=f.calls.filter(c=>c.name==='jobControl').map(c=>(c.body as {input:{execution?:string}}).input.execution).filter(Boolean);
 expect(pins).toEqual([input.execution,input.execution]);
});
