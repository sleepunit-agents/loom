import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {Duplex} from 'node:stream';
import {ServerResponse} from 'node:http';
import {ChildProcess} from 'node:child_process';
import {Server as NetServer} from 'node:net';
import {admissionFixture,holdAdmissionResponse} from './worker-admission.fixture.js';
import {startSecretWorker} from './secret-worker.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
async function setup(staging=true) {
 const f=await admissionFixture(closes,staging);
 const job={binding:{...f.binding},name:'API',config:f.config,expiresAt:Date.now()+20_000};
 const config={policy:['API'],grants:[{binding:{...f.binding},name:'API',expiresAt:job.expiresAt}],jobs:[job]};
 const start=()=>{const worker=startSecretWorker(config);closes.push(worker.close);return worker;};
 return {...f,localJob:job,workerConfig:config,startWorker:start};
}
it('owns actual worker startup without a supplied proof and keeps command and daemon results separate',async()=>{
 const f=await setup(),worker=f.startWorker(),job=worker.jobs[0];
 expect(await job.delivery).toBe(true);expect(await job.completed).toBe(true);
 expect(readFileSync(f.marker,'utf8')).toBe('accepted');expect(f.state(await f.admitted())).toEqual({state:'released'});
});
it.each(['revokePolicy','revokeGrant','stopJob','cancelRequest','close'] as const)('fences original %s during awaited remote authority before the pipe write',async action=>{
 const f=await setup(),write=vi.spyOn(Duplex.prototype,'end'),held=holdAdmissionResponse('/worker-current');
 try {
  const worker=f.startWorker();await held.ready;
  const draining=action==='close'?worker.close():worker[action](f.binding.job);
  held.resume();await draining;
  expect(await worker.jobs[0].delivery).toBe(false);expect(await worker.jobs[0].completed).toBe(false);
  expect(write.mock.calls.some(args=>Buffer.isBuffer(args[0])&&args[0].toString()==='synthetic-admitted-value')).toBe(false);
  expect(existsSync(f.marker)).toBe(false);expect(f.state(await f.admitted())).toEqual({state:'uncertain'});
 }finally{held.resume();}
});
it('fences close during actual listener/process startup and drains the late result',async()=>{
 const f=await setup(),worker=f.startWorker();await worker.close();
 expect(await worker.jobs[0].delivery).toBe(false);expect(await worker.jobs[0].completed).toBe(false);
 expect(f.source).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
});
it('snapshots all worker configuration before startup awaits',async()=>{
 const f=await setup(),worker=f.startWorker();
 f.localJob.binding.job='replacement';f.localJob.name='REPLACED';f.localJob.expiresAt=0;
 f.config.args.length=0;f.config.admission.socket='/missing';f.config.input.socket='/missing';f.config.authority.socket='/missing';
 expect(await worker.jobs[0].delivery).toBe(true);expect(await worker.jobs[0].completed).toBe(true);
 expect(worker.jobs[0].job).toBe(f.binding.job);expect(readFileSync(f.marker,'utf8')).toBe('accepted');
});
it('does not release staging or retry failed delivery',async()=>{
 const f=await setup(false),worker=f.startWorker();
 expect(await worker.jobs[0].delivery).toBe(false);expect(await worker.jobs[0].completed).toBe(false);
 expect(f.source).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
 expect(f.state(await f.admitted())).toEqual({state:'uncertain'});
});
it('rejects duplicate jobs before starting a process or listener',async()=>{
 const f=await setup();expect(()=>startSecretWorker({...f.workerConfig,jobs:[f.localJob,f.localJob]})).toThrow('Secret worker unavailable');
 expect(f.source).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
});
it.each(['policy','grant','expiry','service','claimedAt','runner','box','agent','job'] as const)('refuses missing or mismatched local %s authority before starting IO',async mismatch=>{
 const f=await setup(),config=f.workerConfig;
 if(mismatch==='policy')config.policy=[];
 else if(mismatch==='grant')config.grants=[];
 else if(mismatch==='expiry')config.grants[0].expiresAt=Date.now()-1;
 else if(mismatch==='claimedAt')config.grants[0].binding.claimedAt++;
 else if(mismatch==='job')config.grants[0].binding.job='00000000-0000-4000-8000-000000000000';
 else Object.assign(config.grants[0].binding,{[mismatch]:'replacement'});
 expect(()=>{const worker=startSecretWorker(config);closes.push(worker.close);}).toThrow('Secret worker unavailable');
 expect(f.source).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
 expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});
it('retains original local grant and policy snapshots when caller mutates configuration',async()=>{
 const f=await setup(),held=holdAdmissionResponse('/worker-current');
 try {
  const worker=f.startWorker();await held.ready;
  f.workerConfig.policy.length=0;f.workerConfig.grants[0].expiresAt=0;f.workerConfig.grants[0].binding.claimedAt++;
  held.resume();expect(await worker.jobs[0].delivery).toBe(true);expect(await worker.jobs[0].completed).toBe(true);
 }finally{held.resume();}
});
it('drains a failed real process startup and does not attempt admission or retry',async()=>{
 const f=await setup();f.config.command='/missing-private-executable';
 const worker=f.startWorker();expect(await worker.jobs[0].delivery).toBe(false);expect(await worker.jobs[0].completed).toBe(false);
 await worker.close();expect(f.source).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
 expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});
it('keeps successful daemon delivery separate from a consumer that exits unsuccessfully',async()=>{
 const f=await setup();f.config.args[1]=f.config.args[1].replace('process.exit(0)','process.exit(1)');
 const worker=f.startWorker();expect(await worker.jobs[0].delivery).toBe(true);
 expect(await worker.jobs[0].completed).toBe(false);expect(readFileSync(f.marker,'utf8')).toBe('accepted');
 expect(f.state(await f.admitted())).toEqual({state:'released'});
});
it('rejects distinct valid jobs sharing an input socket before any startup',async()=>{
 const f=await setup(),binding={...f.binding,job:'00000000-0000-4000-8000-000000000000'};
 const config={...f.workerConfig,grants:[...f.workerConfig.grants,{...f.workerConfig.grants[0],binding}],
  jobs:[f.localJob,{...f.localJob,binding}]};
 expect(()=>{const worker=startSecretWorker(config);closes.push(worker.close);}).toThrow('Secret worker unavailable');
 expect(f.source).not.toHaveBeenCalled();expect(existsSync(f.marker)).toBe(false);
 expect(f.app.db.prepare('SELECT count(*) AS n FROM secrets_tickets').get()).toEqual({n:0});
});
it('revokes the original policy for both real jobs sharing the same name',async()=>{
 const first=await setup(false),second=await setup(false),kill=vi.spyOn(ChildProcess.prototype,'kill');
 let resume!:()=>void,entered!:()=>void,admitResume!:()=>void,admitted!:()=>void,count=0,admitCount=0;
 const wait=new Promise<void>(r=>{resume=r;}),ready=new Promise<void>(r=>{entered=r;});
 const admitWait=new Promise<void>(r=>{admitResume=r;}),admitReady=new Promise<void>(r=>{admitted=r;});
 const end=ServerResponse.prototype.end;
 const spy=vi.spyOn(ServerResponse.prototype,'end').mockImplementation(function(this:ServerResponse,...args:Parameters<ServerResponse['end']>){
  if(this.req.url?.endsWith('/admit')&&this.statusCode<300){if(++admitCount===2)admitted();void admitWait.then(()=>end.apply(this,args));return this;}
  if(this.req.url?.endsWith('/worker-current')&&this.statusCode<300){if(++count===2)entered();void wait.then(()=>end.apply(this,args));return this;}
  return end.apply(this,args);
 });
 try {
  const worker=startSecretWorker({policy:['API'],grants:[...first.workerConfig.grants,...second.workerConfig.grants],jobs:[first.localJob,second.localJob]});closes.push(worker.close);
  await admitReady;
  const ids=await Promise.all([first.admitted(),second.admitted()]);
  for(const [i,f] of [first,second].entries()){expect(f.tickets.claim(ids[i])).toBeNull();f.release(ids[i]);}
  admitResume();await ready;
  await worker.revokePolicy(first.binding.job);
  expect(new Set(kill.mock.contexts.map(child=>child.pid)).size).toBe(2);
  resume();
  for(const job of worker.jobs){expect(await job.delivery).toBe(false);expect(await job.completed).toBe(false);}
  expect(existsSync(first.marker)).toBe(false);expect(existsSync(second.marker)).toBe(false);
  expect(first.state(ids[0])).toEqual({state:'uncertain'});expect(second.state(ids[1])).toEqual({state:'uncertain'});
 }finally{resume();admitResume();spy.mockRestore();}
});
it.each(['revokePolicy','revokeGrant','stopJob','cancelRequest'] as const)('fences %s while actual input listener startup is held before process spawn',async action=>{
 const f=await setup();let entered!:()=>void,resume!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});
 const listen=NetServer.prototype.listen,spawn=vi.spyOn(ChildProcess.prototype,'spawn');
 const spy=vi.spyOn(NetServer.prototype,'listen').mockImplementation(function(this:NetServer,...args:Parameters<NetServer['listen']>){
  const callback=args[args.length-1] as ()=>void;
  args[args.length-1]=(()=>{entered();void wait.then(()=>callback());}) as never;
  return Reflect.apply(listen,this,args);
 });
 try {
  const worker=f.startWorker();await ready;let drained=false;
  const closing=worker[action](f.binding.job).then(()=>{drained=true;});
  await new Promise<void>(r=>setImmediate(r));expect(drained).toBe(false);expect(spawn).not.toHaveBeenCalled();
  resume();await closing;
  expect(await worker.jobs[0].delivery).toBe(false);expect(await worker.jobs[0].completed).toBe(false);
  expect(spawn).not.toHaveBeenCalled();expect(existsSync(f.config.input.socket)).toBe(false);expect(f.source).not.toHaveBeenCalled();
 }finally{resume();spy.mockRestore();}
});
it.each(['revokePolicy','revokeGrant','stopJob','cancelRequest','close'] as const)('awaits actual process/listener teardown for %s before resolving its lifecycle promise',async action=>{
 const f=await setup(),authority=holdAdmissionResponse('/worker-current');
 let entered!:()=>void,resume!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});
 const close=NetServer.prototype.close,kill=vi.spyOn(ChildProcess.prototype,'kill');
 let spy:ReturnType<typeof vi.spyOn>|undefined;
 try {
  const worker=f.startWorker();await authority.ready;
  spy=vi.spyOn(NetServer.prototype,'close').mockImplementation(function(this:NetServer,callback?: (error?:Error)=>void){
   return close.call(this,(error?:Error)=>{entered();void wait.then(()=>callback?.(error));});
  });
  let drained=false;
  const closing=(action==='close'?worker.close():worker[action](f.binding.job)).then(()=>{drained=true;});
  await ready;await new Promise<void>(r=>setImmediate(r));expect(drained).toBe(false);
  resume();await closing;expect(drained).toBe(true);
  expect(kill).toHaveBeenCalledWith('SIGKILL');
  for(const child of kill.mock.contexts)if(child.pid)expect(()=>process.kill(child.pid!,0)).toThrow();
  expect(existsSync(f.config.input.socket)).toBe(false);
  expect(await worker.jobs[0].completed).toBe(false);expect(await worker.jobs[0].delivery).toBe(false);
 }finally{resume();authority.resume();spy?.mockRestore();}
});

it.each(['command','cwd','input','authority','admission','holderPin','daemonPin','ca','servername','args','env','socketAlias'] as const)('rejects a later invalid %s selection before the first valid job starts IO',async invalid=>{
 const f=await setup(),listen=vi.spyOn(NetServer.prototype,'listen'),spawn=vi.spyOn(ChildProcess.prototype,'spawn');
 const binding={...f.binding,job:'00000000-0000-4000-8000-000000000000'};
 const config={...f.config,args:[...f.config.args],env:{...f.config.env},input:{...f.config.input,socket:f.home+'/second.sock'},
  authority:{...f.config.authority},admission:{...f.config.admission}};
 if(invalid==='command')config.command='relative';
 if(invalid==='cwd')config.cwd='relative';
 if(invalid==='input'||invalid==='authority'||invalid==='admission')config[invalid].socket='relative';
 if(invalid==='holderPin')config.holderFingerprint='invalid';
 if(invalid==='daemonPin')config.daemonFingerprint='invalid';
 if(invalid==='ca')config.authority.ca='relative';
 if(invalid==='servername')config.admission.servername='';
 if(invalid==='args')config.args=['bad\0arg'];
 if(invalid==='env')config.env={BAD:'bad\0value'};
 if(invalid==='socketAlias')config.input.socket=f.home+'/unused/../admitted-input.sock';
 const selected={...f.workerConfig,grants:[...f.workerConfig.grants,{...f.workerConfig.grants[0],binding}],jobs:[f.localJob,{...f.localJob,binding,config}]};
 expect(()=>{const worker=startSecretWorker(selected);closes.push(worker.close);}).toThrow('Secret worker unavailable');
 expect(listen).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();
});
