/** Explicit worker startup, not a daemon job. Local owner configuration supplies
 * the already-prepared checkout and compiled policy; no repository is fetched. */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { buildIdentity } from '../pieces/runtime/records.js';
import { connectClaudeWorker, type WorkerControlConfig, type WorkerControlRuntime } from './lifecycle.js';
import type { RunnerBinding, SpawnClaude } from './session.js';
import { reserveWorkerReceipt } from './receipts.js';
import { runtimeJobTransport } from './job-transport.js';
const inputSchema=z.object({job:z.string(),agent:z.string(),house:buildIdentity,brief:z.string(),needs:z.array(z.string()),
  model:z.string().optional(),account:z.string().optional(),conversation:z.string().optional(),credential:z.string().optional()}).strict();
const failed=()=>new Error('Runtime worker start unavailable; reconcile the job before retrying');
/** One attempt only. Never retry a claim, input release, report or process after
 * an uncertain response. Native history exists only inside this owned worker.
 * This entry handles unbound jobs only until owning policy/body credential
 * delivery is connected; private and bridge conversations cannot use it. */
export async function runClaudeJob(config:WorkerControlConfig,
  selected:{command:string;env:NodeJS.ProcessEnv;checkout:string;receipts:string;house:z.infer<typeof buildIdentity>;binding:RunnerBinding;rules:unknown;spawn?:SpawnClaude},
  runtime?:WorkerControlRuntime):Promise<void> {
  config={...config};
  selected={...selected,env:{...selected.env},binding:{...selected.binding},house:structuredClone(selected.house),rules:structuredClone(selected.rules)};
  const house=buildIdentity.parse(selected.house),binding={...selected.binding},rules=structuredClone(selected.rules),checkout=selected.checkout;
  let startedResolve:()=>void=()=>{},startedReject:()=>void=()=>{};
  const started=new Promise<void>((resolve,reject)=>{startedResolve=resolve;startedReject=()=>reject(failed());});
  void started.catch(()=>{});
  const launch=selected.spawn??spawn;
  const receipt=reserveWorkerReceipt(selected.receipts,config.job);
  let worker:Awaited<ReturnType<typeof connectClaudeWorker>>|undefined;
  try {
    worker=await connectClaudeWorker(config,{...selected,spawn:(...args)=>{
      const child=launch(...args);child.once('spawn',()=>{
        try {receipt.advance('spawned');startedResolve();}
        catch {child.kill('SIGKILL');startedReject();}
      });child.once('error',startedReject);child.once('close',startedReject);return child;
    }},runtime);
    const job=config.job,call=runtimeJobTransport(config,runtime);
    // Refuse unsupported routing before a claim or input release. The local
    // configuration is owner authority, never an operation or model response.
    if(binding.venue!=='worker'||binding.place!==job||binding.conversation!==job)throw failed();
    receipt.advance('claim-attempt');
    const claimed=await call('claimJob',{job});
    z.object({job:z.literal(job),state:z.literal('starting')}).strict().parse(claimed);
    receipt.advance('claimed');
    receipt.advance('input-attempt');
    const input=inputSchema.parse(await call('takeInput',{job}));
    if(input.job!==job||input.agent!==binding.agent||input.conversation!==undefined||input.credential!==undefined||input.model!==undefined||input.account!==undefined
      ||JSON.stringify(input.house)!==JSON.stringify(house))throw failed();
    receipt.advance('input-received');
    await worker.refresh();
    receipt.advance('launch-attempt');
    const [result]=await Promise.all([worker.turn({binding,rules,checkout,message:input.brief,current:()=>true}),
      started.then(async()=>{
        receipt.advance('running-attempt');
        z.object({job:z.literal(job),state:z.literal('running')}).strict().parse(await call('reportJob',{job,state:'running'}));
        receipt.advance('running');
      })]);
    receipt.advance('output-returned');
    await worker.refresh();
    receipt.advance('finish-attempt');
    z.object({job:z.literal(job),state:z.literal('done')}).strict().parse(await call('finishJob',{job,state:'done',exit:0,log:result.text.slice(-4000)}));
    receipt.advance('finished');
  }catch {throw failed();}
  finally {try {worker?.close();}finally {receipt.close();}}
}
