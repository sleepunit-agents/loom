/** Private worker composition. Owner selections only; no operation, discovery,
 * model prompt or daemon response chooses an executable or peer endpoint. */
import {connectWorkerControl,type WorkerControlConfig,type WorkerControlRuntime} from './control.js';
import {startSecretWorker,type SecretWorkerSelection} from './secret-worker.js';
const failed=()=>new Error('Runtime secret worker unavailable');
/** Own one already-assigned Runtime job's dedicated fd3 command. This is not a
 * Claude prompt turn or a claim/take/report loop. Original Signin/Runtime and
 * local policy/grant/request proofs still gate admission and every pipe write.
 * Runtime control additionally kills an active command on stop/history loss,
 * including after delivery when no further secret transport request occurs. */
export async function startRuntimeSecretWorker(config:WorkerControlConfig,selection:SecretWorkerSelection,runtime?:WorkerControlRuntime,owner?:{signal:AbortSignal;current():boolean;execution?:string}) {
  config={...config};selection=structuredClone(selection);
  if(selection.jobs.length!==1||selection.jobs[0].binding.job!==config.job)throw failed();
  const expiresAt=selection.jobs[0].expiresAt;
  const retained=owner?.current.bind(owner)??(()=>true),signal=owner?.signal,execution=owner?.execution;
  const current=()=>!signal?.aborted&&retained()===true;
  let worker:ReturnType<typeof startSecretWorker>|undefined,closing:Promise<void>|undefined;
  let control:Awaited<ReturnType<typeof connectWorkerControl>>|undefined;
  const abort=()=>{control?.close();void worker?.close().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  const close=()=>{
    signal?.removeEventListener('abort',abort);
    control?.close();
    return closing??=worker?.close()??Promise.resolve();
  };
  try {
    if(!current())throw failed();
    control=await connectWorkerControl(config,()=>{void worker?.close().catch(()=>{});},runtime,current);
    if(execution){control.pinExecution(execution);await control.fresh();}
    if(!current()||!control.current())throw failed();
    const originalControl=control;
    worker=startSecretWorker(selection);
    const original=worker.jobs[0];
    const completed=(async()=>{
      try {
        if(!await original.completed)return false;
        // Do not accept a retain response begun before command completion.
        await originalControl.fresh();return current()&&originalControl.current()&&Date.now()<expiresAt;
      }catch {return false;}
      finally {await close();}
    })();
    return Object.freeze({
      job:original.job,delivery:original.delivery,completed,refresh:originalControl.refresh,close,
      // This owner has one job: every local retirement also fences final
      // acceptance while an authenticated post-completion read is awaiting.
      revokePolicy:close,revokeGrant:close,stopJob:close,cancelRequest:close,
    });
  }catch {await close();throw failed();}
}
