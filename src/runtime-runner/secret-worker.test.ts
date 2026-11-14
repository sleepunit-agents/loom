import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {Duplex} from 'node:stream';
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
 expect(()=>startSecretWorker(config)).toThrow('Secret worker unavailable');
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
