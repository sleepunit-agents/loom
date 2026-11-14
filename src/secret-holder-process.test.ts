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
  const replacing=owner.replaceWorkers([]);await turn();
  expect(child.sent).toEqual([{op:'replace',seq:1,workers:[]}]);
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
