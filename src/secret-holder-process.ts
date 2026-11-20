/** Source-only process ownership. No operation, endpoint or peer message may
 * choose the executable. The holder alone opens its private configuration. */
import {fork} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {holderOwner} from './secret-holder-owner.js';
import type {PersistentHolderWorkers} from './secret-holder-startup.js';

const failed=()=>new Error('Secret holder process unavailable');
/** Own the ORIGINAL child, IPC and close event together. A protocol ack is
 * never an OS-exit witness. A failed owner is never restarted or adopted.
 * Callers must join close (including a rejection) before releasing their slot;
 * the signal fences the original selection immediately on transport loss. */
export function startHolderProcess(file:string) {
  if(!isAbsolute(file)||file.includes('\0'))throw failed();
  const stop=new AbortController();
  // Fixed package entrypoint and Node executable; no inherited loaders, env,
  // stdin, stdout or stderr. Config contains paths, not inline secret values.
  let child:ReturnType<typeof fork>;
  try {child=fork(new URL('./secret-holder.js',import.meta.url),['--config',file,'--owned'],{
    execPath:process.execPath,execArgv:[],env:{},cwd:'/',
    stdio:['ignore','ignore','ignore','ipc'],serialization:'json',
  });}catch {throw failed();}
  let closing:Promise<void>|undefined,closed=false,fault=false;
  let finish!:()=>void;
  const exited=new Promise<void>(resolve=>{finish=resolve;});
  const fence=()=>{stop.abort();};
  const error=()=>{fault=true;fence();void close().catch(()=>{});};
  const disconnect=()=>{
    fence();
    if(!closing){fault=true;void close().catch(()=>{});}
  };
  const onClose=(code:number|null,signal:NodeJS.Signals|null)=>{
    closed=true;
    if(code!==0||signal!==null||!closing)fault=true;
    fence();finish();
    if(!closing)void close().catch(()=>{});
  };
  // Observe process lifetime before installing the protocol or starting IO.
  child.on('error',error);child.on('disconnect',disconnect);child.once('close',onClose);
  const owner=holderOwner(child);
  function close():Promise<void> {
    if(closing)return closing;
    // Install the shared join before abort invokes caller listeners. They may
    // synchronously close this same owner while retiring their original source.
    // Defer IO too, so disconnect/error cannot reenter an uninstalled close.
    closing=Promise.resolve().then(async()=>{
      try {await owner.close();}catch {fault=true;owner.abort();}
      // Ack/disconnect can precede process exit. Bound graceful exit, but join
      // the ORIGINAL close event even after SIGKILL; never infer death from kill.
      const kill=()=>{if(!closed)try {child.kill('SIGKILL');}catch {fault=true;}};
      const timer=setTimeout(kill,5000);
      if(fault)kill();
      try {await exited;}finally {clearTimeout(timer);}
      child.off('error',error);child.off('disconnect',disconnect);
      if(fault)throw failed();
    });
    fence();
    void closing.catch(()=>{});return closing;
  }
  const ready=owner.ready.catch(async()=>{fault=true;fence();try {await close();}catch {}throw failed();});
  void ready.catch(()=>{});
  return Object.freeze({ready,signal:stop.signal,close,
    async replaceWorkers(workers:PersistentHolderWorkers) {
      if(stop.signal.aborted)throw failed();
      try {await owner.replaceWorkers(workers);if(stop.signal.aborted)throw failed();}
      catch {fault=true;fence();try {await close();}catch {}throw failed();}
    },
  });
}
