import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {PassThrough} from 'node:stream';
import {runSecretWorker} from '../cli/secret-worker.js';
import type {IOStreams} from '../cli/io.js';
import {ChildProcess} from 'node:child_process';
import {Duplex} from 'node:stream';
import {signin,hash} from '../core/signin/index.js';
import {admissionFixture,holdAdmissionResponse} from './worker-admission.fixture.js';
import {startRuntimeSecretWorker} from './runtime-secret-worker.js';
import type {WorkerControlRuntime} from './control.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
async function setup() {
 const f=await admissionFixture(closes);
 f.call('signin.setPrincipal',{kind:'runner',id:'worker',active:true});
 const token='synthetic-control-token';
 signin(f.app).tokens.change(tokens=>tokens.push({role:'runner:worker',label:'control',sha256:hash(token),created:new Date(f.clock.now()).toISOString()}));
 const config={url:f.app.url,token,job:f.id};
 const expiresAt=Date.now()+20_000;
 const selection={policy:['API'],grants:[{binding:{...f.binding},name:'API',expiresAt}],jobs:[{binding:{...f.binding},name:'API',config:f.config,expiresAt}]};
 let tick:(()=>void)|undefined,revoked!:()=>void;
 const stopped=new Promise<void>(resolve=>{revoked=resolve;});
 const runtime:WorkerControlRuntime={request:fetch,deadline:ms=>AbortSignal.timeout(ms),every(callback){tick=callback;return ()=>{tick=undefined;revoked();};}};
 const start=async()=>{const worker=await startRuntimeSecretWorker(config,selection,runtime);closes.push(worker.close);return worker;};
 return {...f,controlConfig:config,selection,runtime,start,tick:()=>tick?.(),stopped};
}
it('composes actual Runtime control, original admission, remote proof and a real fd3 consumer',async()=>{
 const f=await setup(),worker=await f.start();
 expect(await worker.delivery).toBe(true);expect(await worker.completed).toBe(true);
 expect(readFileSync(f.marker,'utf8')).toBe('accepted');expect(f.state(await f.admitted())).toEqual({state:'released'});
 await f.stopped;
});
it.each(['stop','reset','lost','offline'] as const)('kills the owned command from scheduled control alone after %s during held final worker proof',async reason=>{
 const f=await setup(),held=holdAdmissionResponse('/worker-current'),write=vi.spyOn(Duplex.prototype,'end');
 let offline=false;
 f.runtime.request=(...args)=>offline?Promise.reject(Error('private failure')):fetch(...args);
 try {
  const worker=await f.start();await held.ready;
  if(reason==='offline')offline=true;
  else f.job(reason==='stop'?{state:'stopped'}:reason==='lost'?{state:'uncertain'}:{principalReset:{approval:'a-owner',by:'jonathan',at:f.clock.now()},state:'stopped'});
  f.tick();await f.stopped;await worker.close();held.resume();
  expect(await worker.delivery).toBe(false);expect(await worker.completed).toBe(false);
  expect(write.mock.calls.some(args=>Buffer.isBuffer(args[0])&&args[0].toString()==='synthetic-admitted-value')).toBe(false);
  expect(existsSync(f.marker)).toBe(false);expect(f.state(await f.admitted())).toEqual({state:'uncertain'});
 }finally{held.resume();}
});
it('kills the owned command after successful delivery even without another secret request',async()=>{
 const f=await setup(),kill=vi.spyOn(ChildProcess.prototype,'kill');
 // Keep the consumer running after its EOF, with no wall-clock wait in the test.
 f.config.args[1]=f.config.args[1].replace('setTimeout(()=>process.exit(0),200)','setInterval(()=>{},10000)');
 const worker=await f.start();expect(await worker.delivery).toBe(true);
 f.job({state:'stopped'});f.tick();await f.stopped;await worker.close();
 expect(await worker.completed).toBe(false);expect(kill).toHaveBeenCalledWith('SIGKILL');
 for(const child of kill.mock.contexts)if(child.pid)expect(()=>process.kill(child.pid!,0)).toThrow();
 expect(existsSync(f.config.input.socket)).toBe(false);
});
it('refuses a stopped Runtime job before a secret command starts',async()=>{
 const f=await setup(),spawn=vi.spyOn(ChildProcess.prototype,'spawn');f.job({state:'stopped'});
 await expect(f.start()).rejects.toThrow();expect(spawn).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();
});
it('rejects another job selection before sending the control credential',async()=>{
 const f=await setup(),request=vi.spyOn(f.runtime,'request');f.selection.jobs[0].binding.job='00000000-0000-4000-8000-000000000000';
 await expect(f.start()).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});
it('snapshots selected endpoints and local authority before the initial authenticated read awaits',async()=>{
 const f=await setup();let release!:()=>void,observed!:()=>void;
 const ready=new Promise<void>(resolve=>{observed=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
 let first=true;
 f.runtime.request=async(...args)=>{const response=await fetch(...args);if(first){first=false;observed();await wait;}return response;};
 const pending=f.start();await ready;
 f.controlConfig.job='replacement';f.selection.policy.length=0;f.selection.grants[0].expiresAt=0;f.controlConfig.token='replacement';f.controlConfig.url='http://invalid.example';
 f.controlConfig.job='replacement';f.selection.jobs[0].config.input.socket='/missing';release();
 const worker=await pending;expect(await worker.delivery).toBe(true);expect(await worker.completed).toBe(true);
});

it('the executable entry owns the real command without outputting its credential or logging command output',async()=>{
 const f=await setup(),file=f.home+'/owner.json',tokenFile=f.home+'/control-token';
 writeFileSync(tokenFile,f.controlConfig.token,{mode:0o600});
 writeFileSync(file,JSON.stringify({url:f.controlConfig.url,job:f.id,tokenFile,selection:f.selection}));
 let output='';const io:IOStreams={stdin:new PassThrough(),stdinIsTTY:false,env:{DO_NOT_INHERIT:'private'},stdout:text=>{output+=text;},stderr:text=>{output+=text;}};
 expect(await runSecretWorker([file],io,f.runtime)).toBe(0);expect(output).toBe('');
 expect(readFileSync(f.marker,'utf8')).toBe('accepted');expect(f.state(await f.admitted())).toEqual({state:'released'});
});
it('the executable reports only a generic failure for an invalid owner selection',async()=>{
 const f=await setup(),file=f.home+'/owner.json';writeFileSync(file,JSON.stringify({private:'never echo'}));
 let output='';const io:IOStreams={stdin:new PassThrough(),stdinIsTTY:false,env:{},stdout:text=>{output+=text;},stderr:text=>{output+=text;}};
 expect(await runSecretWorker([file],io,f.runtime)).toBe(1);expect(output).toBe('Secret worker stopped; reconcile the job before retrying.\n');expect(f.source).not.toHaveBeenCalled();
});
