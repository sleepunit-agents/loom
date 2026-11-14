import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/index.js';
import { fixture } from '../fixture.js';
import { signin, hash } from '../core/signin/index.js';
import { jobResults } from '../pieces/runtime/results.js';
import { runtimeStore } from '../pieces/runtime/store.js';
import { connectClaudeWorker, type WorkerControlRuntime } from './lifecycle.js';
import { runClaudeJob } from './once.js';
import { runClaudeWorker } from '../cli/claude-worker.js';
import type { IOStreams } from '../cli/io.js';
import type { SpawnClaude } from './session.js';
import { inspectWorkerReceipts } from './receipts.js';
const cleanups:Array<()=>unknown>=[];
vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof fs>();return {...actual,fsyncSync:vi.fn(actual.fsyncSync)};});
const actualFs=await vi.importActual<typeof fs>('node:fs');
afterEach(async()=>{vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);for(const close of cleanups.splice(0).reverse())await close();});
const house={repo:'/fixture/art',houseFile:'house/house.json'};
const rules={key:'a'.repeat(64),deny:['mcp__secrets'],sections:[{text:'OWNER FLOOR'}]};
const binding={agent:'art',conversation:'j',venue:'worker',place:'j'};
async function setup() {
 const home=mkdtempSync(join(tmpdir(),'worker-control-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));fixture(home);
 const clock=new FakeClock(),app=await startLoom({home,clock,next:true});cleanups.push(app.close);
 const store=runtimeStore(app.db),auth=signin(app),token=randomBytes(32).toString('hex');
 app.db.transaction(()=>{
  store.put('settings',{id:'art',agent:'art',boxes:[],house},clock.now());
  store.put('box',{id:'r',name:'r',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:1},clock.now());
  store.put('job',{id:'j',agent:'art',runner:'r',box:'r',title:'work',state:'queued',createdAt:1},clock.now());
  app.db.prepare('INSERT INTO runtime_inputs(job,brief,needs) VALUES (?,?,?)').run('j','PRIVATE WORK','[]');
 })();
 app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'r',active:true},'principal');
 auth.tokens.change(tokens=>tokens.push({role:'runner:r',label:'worker',sha256:hash(token),created:new Date(clock.now()).toISOString()}));
 const config={url:app.url,token,job:'j'};
 const calls:Array<{command:string;options:unknown;args:readonly string[];input:string;child:EventEmitter&{stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;kill:()=>boolean;killed:boolean}}>=[];
 const listeners:Array<()=>void>=[];
 const waitSpawn=(count:number)=>new Promise<void>(resolve=>{if(calls.length>=count)resolve();else listeners.push(()=>{if(calls.length>=count)resolve();});});
 const spawn:SpawnClaude=(command,args,options)=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,kill(){this.killed=true;queueMicrotask(()=>this.emit('close',null));return true;}});
  const call={command,options,args,input:'',child};child.stdin.on('data',data=>call.input+=data.toString());calls.push(call);queueMicrotask(()=>child.emit('spawn'));for(const notify of listeners)notify();
  return child as ReturnType<SpawnClaude>;
 };
 const receipts=join(home,'receipts');mkdirSync(receipts,{mode:0o700});
 const selected={command:'/worker/claude',env:{WORKER:'true'},checkout:'/fixture/art',receipts,house,binding,rules,spawn};
 let tick:(()=>void)|undefined,closedResolve:()=>void=()=>{};
 const controlClosed=new Promise<void>(resolve=>{closedResolve=resolve;});
 const runtime:WorkerControlRuntime={request:fetch,deadline:ms=>{expect(ms).toBe(1500);const controller=new AbortController();clock.at(clock.now()+ms,()=>controller.abort());return controller.signal;},every(callback,ms){expect(ms).toBe(1000);tick=callback;return ()=>{tick=undefined;closedResolve();};}};
 const update=(set:object)=>app.db.transaction(()=>{const {changedAt:_,...job}=store.read('job','j')!;store.put('job',{...job,...set},clock.now());})();
 const finish=()=>{const c=calls.at(-1)!;const flag=c.args.includes('--resume')?'--resume':'--session-id';c.child.stdout.write(JSON.stringify({type:'result',is_error:false,session_id:c.args[c.args.indexOf(flag)+1],result:'PRIVATE RESULT'}));c.child.emit('close',0);};
 const connect=async()=>{const worker=await connectClaudeWorker(config,selected,runtime);cleanups.push(worker.close);return worker;};
 return {home,app,clock,store,config,calls,selected,runtime,update,finish,connect,waitSpawn,controlClosed,tick:()=>tick?.()};
}
it('actual API control wraps the real Claude argv/stdin path and retains only its own history',async()=>{
 const f=await setup(),worker=await f.connect();
 // A queued job is not executable merely because control says retain: the
 // owning start path must claim/take/report, exercised separately below.
 const turn={binding,rules,message:'PRIVATE TURN',checkout:'/fixture/art',current:()=>true};
 const p=worker.turn(turn);await f.app.operations.callAsync('direct',{kind:'runner',id:'r'},'runtime.jobControl',{job:'j'});
 // Wait on the observable spawn, never elapsed time.
 await f.waitSpawn(1);f.finish();await p;
 const q=worker.turn(turn);await f.waitSpawn(2);expect(f.calls[1].args).toContain('--resume');f.finish();await q;
 expect(f.calls[0].input).toBe('OWNER FLOOR\nPRIVATE TURN');worker.close();
});

it.each(['principalReset','writtenOff','imported','uncertain','denied'] as const)('kills active execution and rejects late results/history after %s',async reason=>{
 const f=await setup(),worker=await f.connect();
 const turn={binding,rules,message:'PRIVATE TURN',current:()=>true};
 const p=worker.turn(turn);const rejected=expect(p).rejects.toThrow();await f.waitSpawn(1);
 if(reason==='uncertain')f.update({state:'uncertain'});
 else if(reason==='denied')f.app.db.transaction(()=>{const {changedAt:_,...box}=f.store.read('box','r')!;f.store.put('box',{...box,revokedAt:f.clock.now()},f.clock.now());})();
 else f.update(reason==='imported'?{imported:{history:'unknown'}}:{[reason]:{approval:'a-owner',by:'jonathan',at:f.clock.now()}});
 await expect(worker.refresh()).rejects.toThrow();await rejected;
 expect(f.calls[0].child.killed).toBe(true);await expect(worker.turn(turn)).rejects.toThrow();expect(f.calls).toHaveLength(1);
});
it('a returning worker cannot start a written-off job, and a fresh connection has no old resume authority',async()=>{
 const f=await setup();f.update({writtenOff:{approval:'a-owner',by:'jonathan',at:1},state:'lost'});
 await expect(f.connect()).rejects.toThrow();expect(f.calls).toHaveLength(0);
});
it('the external startup claims, takes one gated input, runs and finishes through the real API',async()=>{
 const f=await setup(),p=runClaudeJob(f.config,f.selected,f.runtime);
 await f.waitSpawn(1);
 expect(f.calls[0].input).toBe('OWNER FLOOR\nPRIVATE WORK');f.finish();await p;
 expect(f.store.read('job','j')?.state).toBe('done');expect(jobResults(f.app.db).read('j')).toEqual({exit:0,log:'PRIVATE RESULT'});
 expect(inspectWorkerReceipts(f.selected.receipts)).toMatchObject([{job:'j',phase:'finished'}]);
 await expect(runClaudeJob(f.config,f.selected,f.runtime)).rejects.toThrow();expect(f.calls).toHaveLength(1);
});
it('does not launch an input with a conversation that lacks owning policy delivery',async()=>{
 const f=await setup();f.update({conversation:'cv-bridge'});
 await expect(runClaudeJob(f.config,f.selected,f.runtime)).rejects.toThrow();expect(f.calls).toHaveLength(0);
});
it('does not start after an uncertain input response and never retries that request',async()=>{
 const f=await setup();let takes=0;
 const runtime={...f.runtime,request:async(...args:Parameters<typeof fetch>)=>{if(String(args[0]).endsWith('/takeInput')){takes++;await fetch(...args);throw Error('lost');}return fetch(...args);}};
 await expect(runClaudeJob(f.config,f.selected,runtime)).rejects.toThrow();expect(takes).toBe(1);expect(f.calls).toHaveLength(0);
 expect(inspectWorkerReceipts(f.selected.receipts)).toMatchObject([{phase:'input-attempt'}]);
 const noRetry={...f.runtime,request:async()=>{throw Error('restart must not call the daemon');}};
 await expect(runClaudeJob(f.config,f.selected,noRetry)).rejects.toThrow();expect(takes).toBe(1);
});
it('the scheduled control consumer fences an idle session before another turn',async()=>{
 const f=await setup(),worker=await f.connect();
 f.update({writtenOff:{approval:'a-owner',by:'jonathan',at:1},state:'lost'});f.tick();
 // Observe closure from the scheduled read alone; no independent refresh.
 await f.controlClosed;
 await expect(worker.turn({binding,rules,message:'late',current:()=>true})).rejects.toThrow();expect(f.calls).toHaveLength(0);
});
it('an unavailable daemon revokes an active session instead of preserving an offline execution lease',async()=>{
 const f=await setup();let offline=false;
 const runtime={...f.runtime,request:async(...args:Parameters<typeof fetch>)=>{if(offline)throw Error('PRIVATE TRANSPORT');return fetch(...args);}};
 const worker=await connectClaudeWorker(f.config,f.selected,runtime);cleanups.push(worker.close);
 const p=worker.turn({binding,rules,message:'private',current:()=>true}),rejected=expect(p).rejects.toThrow();
 await f.waitSpawn(1);offline=true;await expect(worker.refresh()).rejects.toThrow('authority');await rejected;expect(f.calls[0].child.killed).toBe(true);
});
it('a new connection after an ordinary worker restart cannot resume the previous native history',async()=>{
 const f=await setup(),first=await f.connect(),turn={binding,rules,message:'private',current:()=>true};
 const p=first.turn(turn);await f.waitSpawn(1);f.finish();const original=await p;first.close();
 const second=await f.connect(),q=second.turn(turn);await f.waitSpawn(2);expect(f.calls[1].args).not.toContain('--resume');f.finish();expect((await q).session).not.toBe(original.session);
});
it.each(['house','model','account'] as const)('refuses unsupported or mismatched %s input without a process',async drift=>{
 const f=await setup();if(drift!=='house')f.update({[drift]:'some-selection'});
 await expect(runClaudeJob(f.config,{...f.selected,...(drift==='house'?{house:{...house,repo:'/different'}}:{})},f.runtime)).rejects.toThrow();expect(f.calls).toHaveLength(0);
});
it('post-output acceptance reads authority after completion even when an earlier retain response is delayed',async()=>{
 const f=await setup();let hold=false,release:()=>void=()=>{},observed:()=>void=()=>{};
 const retained=new Promise<void>(resolve=>{observed=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const runtime={...f.runtime,request:async(...args:Parameters<typeof fetch>)=>{const response=await fetch(...args);if(hold){hold=false;observed();await gate;}return response;}};
 const worker=await connectClaudeWorker(f.config,f.selected,runtime);cleanups.push(worker.close);
 const p=worker.turn({binding,rules,message:'private',current:()=>true}),rejected=expect(p).rejects.toThrow();await f.waitSpawn(1);
 hold=true;f.tick();await retained;f.update({principalReset:{approval:'a-owner',by:'jonathan',at:1},state:'stopped'});
 f.finish();release();await rejected;
 await expect(worker.turn({binding,rules,message:'late',current:()=>true})).rejects.toThrow();expect(f.calls).toHaveLength(1);
});
it('rejects a reset observed only by the post-output check',async()=>{
 const f=await setup(),worker=await f.connect(),p=worker.turn({binding,rules,message:'private',current:()=>true}),rejected=expect(p).rejects.toThrow();
 await f.waitSpawn(1);f.update({principalReset:{approval:'a-owner',by:'jonathan',at:1},state:'stopped'});f.finish();await rejected;
});
it('the control deadline cancels a hung read and kills foreground execution',async()=>{
 const f=await setup();let hang=false,observed:()=>void=()=>{};
 const pending=new Promise<void>(resolve=>{observed=resolve;});
 const runtime={...f.runtime,request:async(...args:Parameters<typeof fetch>)=>{
  if(!hang)return fetch(...args);
  observed();return new Promise<Response>((_resolve,reject)=>{const signal=args[1]!.signal!;signal.addEventListener('abort',()=>reject(Error('deadline')),{once:true});});
 }};
 const worker=await connectClaudeWorker(f.config,f.selected,runtime);cleanups.push(worker.close);
 const p=worker.turn({binding,rules,message:'private',current:()=>true}),rejected=expect(p).rejects.toThrow();await f.waitSpawn(1);
 hang=true;const read=worker.refresh(),readRejected=expect(read).rejects.toThrow();await pending;
 f.clock.advance(1499);expect(f.calls[0].child.killed).toBe(false);f.clock.advance(1);await readRejected;await rejected;expect(f.calls[0].child.killed).toBe(true);
});
it('the executable configuration boundary uses the selected token file, command, environment, checkout and rules',async()=>{
 const f=await setup(),file=join(f.home,'worker-config.json'),tokenFile=join(f.home,'worker-token');
 writeFileSync(tokenFile,f.config.token);writeFileSync(file,JSON.stringify({url:f.config.url,tokenFile,job:'j',agent:'art',command:f.selected.command,checkout:f.selected.checkout,receipts:f.selected.receipts,house,env:{ONLY:'owner'},rules}));
 let diagnostic='';const io:IOStreams={stdin:new PassThrough(),stdinIsTTY:false,env:{PRIVATE_RUNNER:'never inherited'},stdout:()=>{throw Error('unexpected stdout');},stderr:text=>{diagnostic+=text;}};
 const p=runClaudeWorker([file],io,{...f.runtime,spawn:f.selected.spawn});await f.waitSpawn(1);
 expect(f.calls[0]).toMatchObject({command:'/worker/claude',input:'OWNER FLOOR\nPRIVATE WORK',options:{cwd:'/fixture/art',env:{ONLY:'owner'},shell:false}});
 expect(f.calls[0].args).toContain('mcp__secrets');f.finish();expect(await p).toBe(0);expect(diagnostic).toBe('');expect(f.store.read('job','j')?.state).toBe('done');
});
it.each(['claimJob','reportJob','finishJob'] as const)('does not retry or advance after an accepted %s response is lost',async lost=>{
 const f=await setup(),operations:string[]=[];
 const runtime={...f.runtime,request:async(...args:Parameters<typeof fetch>)=>{
  const name=new URL(String(args[0])).pathname.split('/').at(-1)!;operations.push(name);
  const response=await fetch(...args);if(name===lost)throw Error('lost response after commit');return response;
 }};
 const p=runClaudeJob(f.config,f.selected,runtime),rejected=expect(p).rejects.toThrow();
 if(lost==='finishJob'){await f.waitSpawn(1);f.finish();}
 await rejected;expect(operations.filter(name=>name===lost)).toHaveLength(1);
 if(lost==='claimJob'){expect(operations).not.toContain('takeInput');expect(f.calls).toHaveLength(0);expect(f.store.read('job','j')?.state).toBe('starting');}
 if(lost==='reportJob'){expect(operations).not.toContain('finishJob');expect(f.calls).toHaveLength(1);expect(f.calls[0].child.killed).toBe(true);expect(f.store.read('job','j')?.state).toBe('running');}
 if(lost==='finishJob'){expect(f.calls).toHaveLength(1);expect(f.store.read('job','j')?.state).toBe('done');}
 expect(inspectWorkerReceipts(f.selected.receipts)).toMatchObject([{phase:lost==='claimJob'?'claim-attempt':lost==='reportJob'?'running-attempt':'finish-attempt'}]);
 const before=[...operations];await expect(runClaudeJob(f.config,f.selected,runtime)).rejects.toThrow();expect(operations).toEqual(before);
});
it('the read-only inspection command emits wordless receipts without contacting the daemon',async()=>{
 const f=await setup(),p=runClaudeJob(f.config,f.selected,f.runtime);await f.waitSpawn(1);f.finish();await p;
 let output='';const io:IOStreams={stdin:new PassThrough(),stdinIsTTY:false,env:{},stdout:s=>{output+=s;},stderr:()=>{throw Error('unexpected diagnostic');}};
 expect(await runClaudeWorker(['--inspect',f.selected.receipts],io)).toBe(0);
 expect(JSON.parse(output)).toEqual([{v:1,job:'j',attempt:expect.any(String),phase:'finished'}]);
 for(const word of ['PRIVATE','OWNER FLOOR',f.config.token,'/worker/claude'])expect(output).not.toContain(word);
 expect(f.calls).toHaveLength(1);
});
it.each(['claim-attempt','input-attempt','launch-attempt','spawned','finish-attempt'] as const)('a failed durable %s write prevents advancing the real HTTP/process boundary',async phase=>{
 const f=await setup(),requests:string[]=[];
 vi.mocked(fs.fsyncSync).mockImplementation(fd=>{
  if(fs.fstatSync(fd).isFile()&&inspectWorkerReceipts(f.selected.receipts)[0]?.phase===phase)throw Error('disk failed');
  actualFs.fsyncSync(fd);
 });
 const runtime={...f.runtime,request:async(...args:Parameters<typeof fetch>)=>{requests.push(new URL(String(args[0])).pathname.split('/').at(-1)!);return fetch(...args);}};
 const p=runClaudeJob(f.config,f.selected,runtime),rejected=expect(p).rejects.toThrow();
 if(phase==='finish-attempt'){await f.waitSpawn(1);f.finish();}
 await rejected;
 const forbidden=phase==='claim-attempt'?'claimJob':phase==='input-attempt'?'takeInput':phase==='finish-attempt'?'finishJob':'reportJob';
 expect(requests).not.toContain(forbidden);
 if(phase==='spawned'||phase==='finish-attempt'){expect(f.calls).toHaveLength(1);if(phase==='spawned')expect(f.calls[0].child.killed).toBe(true);}
 else expect(f.calls).toHaveLength(0);
 const before=[...requests];await expect(runClaudeJob(f.config,f.selected,runtime)).rejects.toThrow();expect(requests).toEqual(before);
});
it('refuses remote plaintext HTTP before sending a runner credential or starting a scheduler',async()=>{
 const f=await setup();let requests=0,schedules=0;
 const runtime={...f.runtime,request:async()=>{requests++;throw Error();},every(){schedules++;return ()=>{};}};
 await expect(connectClaudeWorker({...f.config,url:'http://remote.example'},f.selected,runtime)).rejects.toThrow();expect(requests).toBe(0);expect(schedules).toBe(0);expect(f.calls).toHaveLength(0);
});
it.each(['false','throws'] as const)('rechecks the original local proof after an asynchronous post-output control read (%s)',async mode=>{
 const f=await setup();let current=true,hold=false,release:()=>void=()=>{},observed:()=>void=()=>{};
 const waiting=new Promise<void>(resolve=>{observed=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const runtime={...f.runtime,request:async(...args:Parameters<typeof fetch>)=>{const response=await fetch(...args);if(hold){hold=false;observed();await gate;}return response;}};
 const worker=await connectClaudeWorker(f.config,f.selected,runtime);cleanups.push(worker.close);
 const p=worker.turn({binding,rules,message:'private',current:()=>{if(!current&&mode==='throws')throw Error('revoked');return current;}}),rejected=expect(p).rejects.toThrow();await f.waitSpawn(1);
 hold=true;f.finish();await waiting;current=false;release();await rejected;
 await expect(worker.turn({binding,rules,message:'late',current:()=>true})).rejects.toThrow();
});
