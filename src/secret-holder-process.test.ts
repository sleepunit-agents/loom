import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import * as processes from 'node:child_process';
import {startHolderProcess} from './secret-holder-process.js';

vi.mock('node:child_process',()=>({fork:vi.fn()}));
class Child extends EventEmitter {
  connected=true;
  sent:unknown[]=[];
  kill=vi.fn(()=>true);
  send(message:unknown,callback:(error:Error|null)=>void) {
    this.sent.push(message);callback(null);return true;
  }
  disconnect(){if(this.connected){this.connected=false;this.emit('disconnect');}}
  reply(op:string,seq:number){this.emit('message',{op,seq});}
  end(code:number|null=0,signal:NodeJS.Signals|null=null){this.emit('close',code,signal);}
}
function setup(){
  const child=new Child();vi.mocked(processes.fork).mockReturnValue(child as unknown as processes.ChildProcess);
  const owner=startHolderProcess('/private/holder.json');
  return {child,owner};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();vi.useRealTimers();});
it('forks only the fixed packaged entrypoint with isolated process channels',async()=>{
  const {child,owner}=setup();
  expect(processes.fork).toHaveBeenCalledWith(new URL('./secret-holder.js',import.meta.url),['--config','/private/holder.json','--owned'],{
    execPath:process.execPath,execArgv:[],env:{},cwd:'/',stdio:['ignore','ignore','ignore','ipc'],serialization:'json',
  });
  child.reply('ready',0);await owner.ready;
  let done=false;const closing=owner.close().then(()=>{done=true;});
  expect(owner.close()).toBe(owner.close());expect(owner.signal.aborted).toBe(true);
  await turn();expect(child.sent).toEqual([{op:'close',seq:1}]);
  child.reply('closed',1);await turn();expect(done).toBe(false);
  expect(child.kill).not.toHaveBeenCalled();child.end();await closing;
  expect(done).toBe(true);expect(child.listenerCount('error')).toBe(0);
});
it('retains only the original channel and forwards value-free route metadata',async()=>{
  const {child,owner}=setup();child.reply('ready',0);await owner.ready;
  const binding={agent:'art',job:'11111111-1111-4111-8111-111111111111',runner:'worker',box:'worker',claimedAt:42,service:'bridge'};
  const fingerprint=Array(32).fill('AB').join(':');
  const selected={binding:{...binding},fingerprint,config:{socket:'/private/input.sock',ca:'/private/ca',cert:'/private/cert',key:'/private/key',servername:'worker.test'}};
  const replacing=owner.replaceWorkers([selected]);
  selected.binding.claimedAt=99;selected.config.key='PRIVATE-SENTINEL';
  await turn();
  expect(child.sent).toEqual([{op:'replace',seq:1,workers:[{binding,fingerprint}]}]);
  expect(JSON.stringify(child.sent)).not.toMatch(/private|PRIVATE-SENTINEL|config|key/);
  child.reply('replaced',1);await replacing;
  const closing=owner.close();await turn();child.reply('closed',2);child.end();await closing;
});
it.each(['disconnect','error','wrong-ack'] as const)('fences %s immediately and rejects only after original child closure',async(kind)=>{
  const {child,owner}=setup();child.reply('ready',0);await owner.ready;
  const pending=owner.replaceWorkers([]);const rejected=expect(pending).rejects.toThrow('Secret holder process unavailable');
  await turn();
  if(kind==='wrong-ack')child.reply('replaced',99);
  else if(kind==='error')child.emit('error',new Error('private diagnostic'));
  else child.disconnect();
  expect(owner.signal.aborted).toBe(true);
  let joined=false;void pending.catch(()=>{joined=true;});await turn();
  expect(joined).toBe(false);expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  child.end(null,'SIGKILL');await rejected;await expect(owner.close()).rejects.toThrow('Secret holder process unavailable');
  await expect(owner.replaceWorkers([])).rejects.toThrow('Secret holder process unavailable');
  expect(processes.fork).toHaveBeenCalledOnce();
});
it('joins late readiness and child exit when stopped during startup',async()=>{
  const {child,owner}=setup();const closing=owner.close();
  await turn();expect(child.sent).toEqual([]);
  child.reply('ready',0);await owner.ready;await turn();
  child.reply('closed',1);await turn();
  let done=false;void closing.then(()=>{done=true;});await turn();expect(done).toBe(false);
  child.end();await closing;
});
it('kills a child that acknowledges close but does not exit, then still joins close',async()=>{
  vi.useFakeTimers();const {child,owner}=setup();child.reply('ready',0);await owner.ready;
  const closing=owner.close();await vi.advanceTimersByTimeAsync(0);child.reply('closed',1);
  await vi.advanceTimersByTimeAsync(5000);expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  let done=false;void closing.catch(()=>{done=true;});await vi.advanceTimersByTimeAsync(0);expect(done).toBe(false);
  child.end(null,'SIGKILL');await expect(closing).rejects.toThrow('Secret holder process unavailable');
});
it('burns a failed startup without leaking diagnostics or inferring death from error',async()=>{
  const {child,owner}=setup();const ready=expect(owner.ready).rejects.toThrow('Secret holder process unavailable');
  child.emit('error',new Error('private-value'));await turn();
  let done=false;void owner.ready.catch(()=>{done=true;});await turn();expect(done).toBe(false);
  child.end(-2);await ready;await expect(owner.close()).rejects.toThrow('Secret holder process unavailable');
});
it('rejects invalid paths and synchronous spawn failures generically',()=>{
  expect(()=>startHolderProcess('relative')).toThrow('Secret holder process unavailable');
  expect(()=>startHolderProcess('/bad\0path')).toThrow('Secret holder process unavailable');
  vi.mocked(processes.fork).mockImplementation(()=>{throw Error('private-value');});
  expect(()=>startHolderProcess('/private/holder.json')).toThrow('Secret holder process unavailable');
});
it.each(['startup','idle'] as const)('fences an independent child closure during %s',async(phase)=>{
  vi.useFakeTimers();const {child,owner}=setup();
  const ready=phase==='startup'?expect(owner.ready).rejects.toThrow('Secret holder process unavailable'):undefined;
  if(phase==='idle'){child.reply('ready',0);await owner.ready;}
  child.end(1);expect(owner.signal.aborted).toBe(true);
  const closing=expect(owner.close()).rejects.toThrow('Secret holder process unavailable');
  await vi.advanceTimersByTimeAsync(5000);await closing;await ready;
  await expect(owner.replaceWorkers([])).rejects.toThrow('Secret holder process unavailable');
  expect(processes.fork).toHaveBeenCalledOnce();
});
it.each([[1,null],[null,'SIGTERM']] as const)('rejects independent abnormal exit after a valid close ack (%s,%s)',async(code,signal)=>{
  const {child,owner}=setup();child.reply('ready',0);await owner.ready;
  const closing=owner.close(),rejected=expect(closing).rejects.toThrow('Secret holder process unavailable');
  await turn();child.reply('closed',1);await turn();
  // Neither protocol nor parent has failed. The OS outcome alone must fail it.
  child.end(code,signal);await rejected;
});
it.each(['ready','replace','close'] as const)('missing %s acknowledgement burns the owner and joins the killed original child',async(op)=>{
  vi.useFakeTimers();const {child,owner}=setup();
  if(op!=='ready'){child.reply('ready',0);await owner.ready;}
  const pending=op==='ready'?owner.ready:op==='replace'?owner.replaceWorkers([]):owner.close();
  let settled=false;void pending.catch(()=>{settled=true;});
  const rejected=expect(pending).rejects.toThrow('Secret holder process unavailable');
  await vi.advanceTimersByTimeAsync(5000);
  expect(owner.signal.aborted).toBe(true);expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(settled).toBe(false);
  await expect(owner.replaceWorkers([])).rejects.toThrow('Secret holder process unavailable');
  child.end(null,'SIGKILL');await rejected;
  await expect(owner.close()).rejects.toThrow('Secret holder process unavailable');
  expect(processes.fork).toHaveBeenCalledOnce();
});
it('shutdown during a held replacement poisons both operations and shares the original child join',async()=>{
  const {child,owner}=setup();child.reply('ready',0);await owner.ready;
  const replacing=owner.replaceWorkers([]);let replaced=false;void replacing.catch(()=>{replaced=true;});
  const replacementRejected=expect(replacing).rejects.toThrow('Secret holder process unavailable');
  await turn();expect(child.sent).toEqual([{op:'replace',seq:1,workers:[]}]);
  const closing=owner.close();expect(owner.close()).toBe(closing);
  let closed=false;void closing.catch(()=>{closed=true;});
  const closeRejected=expect(closing).rejects.toThrow('Secret holder process unavailable');
  await turn();expect(owner.signal.aborted).toBe(true);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');expect(replaced).toBe(false);expect(closed).toBe(false);
  child.reply('replaced',1);await turn();expect(replaced).toBe(false);expect(closed).toBe(false);
  child.end(null,'SIGKILL');await Promise.all([replacementRejected,closeRejected]);
});
it('installs one shutdown promise before synchronous abort listeners reenter close',async()=>{
  const {child,owner}=setup();child.reply('ready',0);await owner.ready;
  let nested:Promise<void>|undefined;
  owner.signal.addEventListener('abort',()=>{nested=owner.close();},{once:true});
  const outer=owner.close();
  try {expect(nested).toBe(outer);expect(owner.close()).toBe(outer);}
  finally {
    await turn();child.reply('closed',1);child.end();await Promise.all([outer,nested]);
  }
  expect(child.sent).toEqual([{op:'close',seq:1}]);
  expect(child.kill).not.toHaveBeenCalled();
});
