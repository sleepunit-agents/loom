/** Private, one-shot source composition. Never register this as an operation.
 * Daemon keeps original database/proof ownership; only the holder child opens
 * its file. The dedicated worker command owns its separate OS child. */
import type {Foundation} from './core/app.js';
import type {Sharing} from './core/index.js';
import type {OutsideEffects} from './core/effects.js';
import {startSecretWorkers,snapshotSecretWorkers,type SecretWorkersConfig} from './secret-worker-startup.js';
import {startHolderProcess} from './secret-holder-process.js';
import {secretJobAssignment} from './secret-job-assignment.js';
import {runRuntimeSecretJob} from './runtime-runner/secret-job.js';
import type {WorkerControlConfig,WorkerControlRuntime} from './runtime-runner/control.js';

type Assignment=Parameters<typeof secretJobAssignment>[2];
type Selected=Parameters<typeof runRuntimeSecretJob>[1];
const failed=()=>new Error('Secret job supervisor unavailable');
/** One original attempt, including failure. No retries, adoption, slot reuse,
 * public executable/endpoint selection or serialization of proof capabilities.
 * Caller must join close (even rejection) before closing the Foundation. */
export function startSecretJobSupervisor(app:Foundation,sharing:()=>Sharing,effects:OutsideEffects,
  config:{daemon:Omit<SecretWorkersConfig,'workers'>;holderFile:string;
    assignment:Assignment;control:WorkerControlConfig;selected:Selected},runtime?:WorkerControlRuntime) {
  config={daemon:snapshotSecretWorkers({...config.daemon,workers:[]}),holderFile:config.holderFile,
    assignment:structuredClone(config.assignment),control:{...config.control},selected:structuredClone(config.selected)};
  runtime=runtime&&{request:runtime.request,deadline:runtime.deadline.bind(runtime),every:runtime.every.bind(runtime)};
  const stop=new AbortController();
  let daemon:Awaited<ReturnType<typeof startSecretWorkers>>|undefined;
  let holder:ReturnType<typeof startHolderProcess>|undefined;
  let source:ReturnType<typeof secretJobAssignment>|undefined;
  let retiring:Promise<void>|undefined;
  const retire=()=>source?(retiring??=source.close()):Promise.resolve();
  let execution:Promise<void>|undefined,closing:Promise<void>|undefined,used=false,fault=false;
  const lost=()=>{fault=true;void close().catch(()=>{});};
  const startup=Promise.resolve().then(async()=>{
    if(stop.signal.aborted||config.assignment.job!==config.control.job||config.assignment.agent!==config.selected.agent)throw failed();
    daemon=await startSecretWorkers(app,sharing,effects,{...config.daemon,workers:[]});
    if(stop.signal.aborted)throw failed();
    holder=startHolderProcess(config.holderFile);
    holder.signal.addEventListener('abort',lost,{once:true});
    if(holder.signal.aborted)throw failed();
    await holder.ready;
    if(stop.signal.aborted)throw failed();
    source=secretJobAssignment(app,sharing,config.assignment,{daemon,holder});
  });
  function close():Promise<void> {
    if(closing)return closing;
    // Install before abort: callers may synchronously reenter close.
    closing=Promise.resolve().then(async()=>{
      await startup.catch(()=>{fault=true;});
      holder?.signal.removeEventListener('abort',lost);
      // Retire routes before closing the IPC channel: it permits only one
      // outstanding command. Join the attempt even when retirement fails,
      // then the original holder child before central authority disappears.
      const outcomes=await Promise.allSettled([
        Promise.resolve().then(retire),
        Promise.resolve().then(()=>execution),
      ]);
      if(outcomes.some(result=>result.status==='rejected'))fault=true;
      try {await holder?.close();}catch {fault=true;}
      try {await daemon?.close();}catch {fault=true;}
      if(fault)throw failed();
    });
    stop.abort();
    // Fence command startup immediately, including an initial control read.
    void retire().catch(()=>{fault=true;});
    void closing.catch(()=>{});return closing;
  }
  const ready=startup.catch(async()=>{fault=true;try {await close();}catch {}throw failed();});
  void ready.catch(()=>{});
  return Object.freeze({ready,signal:stop.signal,close,
    run():Promise<void> {
      if(used||stop.signal.aborted)return Promise.reject(failed());used=true;
      execution=Promise.resolve().then(async()=>{
        await startup;if(stop.signal.aborted||!source)throw failed();
        await runRuntimeSecretJob(config.control,config.selected,source,runtime);
      });
      return execution.then(async()=>{await close();},async()=>{fault=true;try {await close();}catch {}throw failed();});
    },
  });
}
