/** One source-selected dedicated command attempt. Never a model/prompt path.
 * No retry, adopted receipt, diagnostic output or credential-bearing result. */
import {z} from 'zod';
import {buildIdentity} from '../pieces/runtime/records.js';
import type {SecretAssignment,SecretAssignmentSource} from '../secret-job-assignment.js';
import {connectWorkerControl,type WorkerControlConfig,type WorkerControlRuntime} from './control.js';
import {runtimeJobTransport} from './job-transport.js';
import {reserveWorkerReceipt} from './receipts.js';
import {startRuntimeSecretWorker} from './runtime-secret-worker.js';
const failed=()=>new Error('Secret job stopped; reconcile the job before retrying');
const input=z.object({job:z.string(),agent:z.string(),house:buildIdentity,brief:z.string(),needs:z.array(z.string()),execution:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export async function runRuntimeSecretJob(config:WorkerControlConfig,
  selected:{agent:string;house:z.infer<typeof buildIdentity>;receipts:string},source:SecretAssignmentSource,runtime?:WorkerControlRuntime):Promise<void> {
  config={...config};selected=structuredClone(selected);
  runtime=runtime&&{request:runtime.request,deadline:runtime.deadline.bind(runtime),every:runtime.every.bind(runtime)};
  const claimed=source.claimed.bind(source),job=config.job,house=buildIdentity.parse(selected.house);
  if(source.signal.aborted)throw failed();
  const receipt=reserveWorkerReceipt(selected.receipts,job);
  let assignment:SecretAssignment|undefined,worker:Awaited<ReturnType<typeof startRuntimeSecretWorker>>|undefined;
  let starting:Promise<Awaited<ReturnType<typeof startRuntimeSecretWorker>>>|undefined;
  let stopped=false;
  try {source.own(async()=>{
    stopped=true;
    const original=worker??await starting?.catch(()=>undefined);
    await original?.close();
  });}catch {receipt.close();throw failed();}
  const stop=()=>{stopped=true;void worker?.close().catch(()=>{});};
  source.signal.addEventListener('abort',stop,{once:true});
  if(source.signal.aborted)stop();
  const control=await connectWorkerControl(config,stop,runtime,
    ()=>!stopped&&(!assignment||assignment.current())).catch(()=>{source.signal.removeEventListener('abort',stop);receipt.close();throw failed();});
  const current=()=>!stopped&&control.current()&&assignment?.current()===true;
  const call=runtimeJobTransport(config,runtime);
  const ack=(state:'starting'|'running'|'done',value:unknown)=>z.object({job:z.literal(job),state:z.literal(state)}).strict().parse(value);
  try {
    receipt.advance('claim-attempt');ack('starting',await call('claimJob',{job}));receipt.advance('claimed');
    if(stopped)throw failed();
    receipt.advance('input-attempt');
    const value=input.parse(await call('takeInput',{job,pinUnbound:true}));
    if(value.job!==job||value.agent!==selected.agent||JSON.stringify(value.house)!==JSON.stringify(house))throw failed();
    receipt.advance('input-received');
    control.pinExecution(value.execution);await control.fresh();
    assignment=await claimed(job);
    if(!current()||assignment.selection.jobs.length!==1
      ||assignment.selection.jobs[0].binding.agent!==selected.agent||assignment.selection.jobs[0].binding.job!==job)throw failed();
    receipt.advance('launch-attempt');
    starting=startRuntimeSecretWorker(config,assignment.selection,runtime,{signal:source.signal,current:assignment.current,execution:value.execution});
    worker=await starting;
    if(!current()){await worker.close();throw failed();}
    // Delivery acknowledgement implies the dedicated process spawned and its
    // original fd3 write completed. No command output becomes Runtime input.
    if(!await worker.delivery||!current())throw failed();
    receipt.advance('spawned');receipt.advance('running-attempt');
    ack('running',await call('reportJob',{job,execution:value.execution,state:'running'}));receipt.advance('running');
    if(!await worker.completed||!current())throw failed();
    receipt.advance('output-returned');
    await control.fresh();if(!current())throw failed();
    receipt.advance('finish-attempt');
    ack('done',await call('finishJob',{job,execution:value.execution,state:'done'}));receipt.advance('finished');
  }catch {throw failed();}
  finally {
    source.signal.removeEventListener('abort',stop);stopped=true;control.close();
    try {
      try {await worker?.close();}finally {await assignment?.close();}
    }catch {throw failed();}finally {receipt.close();}
  }
}
