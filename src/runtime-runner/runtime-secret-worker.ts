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
export async function startRuntimeSecretWorker(config:WorkerControlConfig,selection:SecretWorkerSelection,runtime?:WorkerControlRuntime) {
  config={...config};selection=structuredClone(selection);
  if(selection.jobs.length!==1||selection.jobs[0].binding.job!==config.job)throw failed();
  const expiresAt=selection.jobs[0].expiresAt;
  let worker:ReturnType<typeof startSecretWorker>|undefined,closing:Promise<void>|undefined;
  const control=await connectWorkerControl(config,()=>{void worker?.close().catch(()=>{});},runtime);
  const close=()=>{
    control.close();
    return closing??=worker?.close()??Promise.resolve();
  };
  try {
    if(!control.current())throw failed();
    worker=startSecretWorker(selection);
    const original=worker.jobs[0];
    const completed=(async()=>{
      try {
        if(!await original.completed)return false;
        // Do not accept a retain response begun before command completion.
        await control.fresh();return control.current()&&Date.now()<expiresAt;
      }catch {return false;}
      finally {await close();}
    })();
    return Object.freeze({
      job:original.job,delivery:original.delivery,completed,refresh:control.refresh,close,
      // This owner has one job: every local retirement also fences final
      // acceptance while an authenticated post-completion read is awaiting.
      revokePolicy:close,revokeGrant:close,stopJob:close,cancelRequest:close,
    });
  }catch {await close();throw failed();}
}
