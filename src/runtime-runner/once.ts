/** Explicit worker startup, not a daemon job. Local owner configuration supplies
 * the already-prepared checkout and compiled policy; no repository is fetched. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildIdentity } from '../pieces/runtime/records.js';
import { connectClaudeWorker, type WorkerControlConfig, type WorkerControlRuntime } from './lifecycle.js';
import type { RunnerBinding, SpawnClaude } from './session.js';
const inputSchema=z.object({job:z.string(),agent:z.string(),house:buildIdentity,brief:z.string(),needs:z.array(z.string()),
  model:z.string().optional(),conversation:z.string().optional(),credential:z.string().optional()}).strict();
const failed=()=>new Error('Runtime worker start unavailable; reconcile the job before retrying');
/** One attempt only. Never retry a claim, input release, report or process after
 * an uncertain response. Native history exists only inside this owned worker.
 * This entry handles unbound jobs only until owning policy/body credential
 * delivery is connected; private and bridge conversations cannot use it. */
export async function runClaudeJob(config:WorkerControlConfig,
  selected:{command:string;env:NodeJS.ProcessEnv;checkout:string;house:z.infer<typeof buildIdentity>;binding:RunnerBinding;rules:unknown;spawn?:SpawnClaude},
  runtime?:WorkerControlRuntime):Promise<void> {
  config={...config};
  selected={...selected,env:{...selected.env},binding:{...selected.binding},house:structuredClone(selected.house),rules:structuredClone(selected.rules)};
  const house=buildIdentity.parse(selected.house),binding={...selected.binding},rules=structuredClone(selected.rules),checkout=selected.checkout;
  const worker=await connectClaudeWorker(config,selected,runtime);
  const request=runtime?.request??fetch;
  // connectClaudeWorker validated and captured its connection; snapshot again
  // before any further await so configuration mutation cannot retarget writes.
  const base=new URL(config.url),token=config.token,job=config.job;
  const call=async(name:string,input:unknown,write=false)=>{
    try {
      const response=await request(new URL(`/api/runtime/${name}`,base),{method:'POST',redirect:'error',
        headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify({input,...(write?{id:randomUUID()}:{})}),signal:AbortSignal.timeout(1500)});
      if(!response.ok)throw failed();
      const result=z.object({ok:z.literal(true),value:z.unknown()}).strict().parse(await response.json());
      return result.value;
    }catch {throw failed();}
  };
  try {
    // Refuse unsupported routing before a claim or input release. The local
    // configuration is owner authority, never an operation or model response.
    if(binding.venue!=='worker'||binding.place!==job||binding.conversation!==job)throw failed();
    const claimed=await call('claimJob',{job},true);
    z.object({job:z.literal(job),state:z.literal('starting')}).strict().parse(claimed);
    const input=inputSchema.parse(await call('takeInput',{job}));
    if(input.job!==job||input.agent!==binding.agent||input.conversation!==undefined||input.credential!==undefined||input.model!==undefined
      ||JSON.stringify(input.house)!==JSON.stringify(house))throw failed();
    await worker.refresh();
    z.object({job:z.literal(job),state:z.literal('running')}).strict().parse(await call('reportJob',{job,state:'running'},true));
    await worker.turn({binding,rules,checkout,message:input.brief,current:()=>true});
    await worker.refresh();
    z.object({job:z.literal(job),state:z.literal('done')}).strict().parse(await call('finishJob',{job,state:'done'},true));
  }catch {throw failed();}
  finally {worker.close();}
}
