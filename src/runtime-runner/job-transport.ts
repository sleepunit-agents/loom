/** Shared private Runtime job protocol transport. This is not claim authority,
 * a retry owner or executable selection. The caller owns receipt ordering,
 * input validation, process lifetime and fresh post-output control checks. */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {WorkerControlConfig,WorkerControlRuntime} from './control.js';

const failed=()=>new Error('Runtime worker start unavailable; reconcile the job before retrying');
/** Capture the original endpoint and credential before the caller's next await.
 * No automatic retries: a lost write acknowledgement remains uncertain. Values
 * and diagnostics are never logged here or included in failure messages. */
// The owning control connection must validate WorkerControlConfig before this
// transport is created; this helper never replaces that admission.
export function runtimeJobTransport(config:WorkerControlConfig,runtime?:WorkerControlRuntime) {
  const base=new URL(config.url),token=config.token;
  const request=runtime?.request??fetch,deadline=runtime?.deadline.bind(runtime)??(ms=>AbortSignal.timeout(ms));
  return async(name:'claimJob'|'takeInput'|'reportJob'|'finishJob',input:unknown):Promise<unknown>=>{
    try {
      const response=await request(new URL(`/api/runtime/${name}`,base),{method:'POST',redirect:'error',
        headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify({input,...(name==='takeInput'?{}:{id:randomUUID()})}),signal:deadline(1500)});
      if(!response.ok)throw failed();
      return z.object({ok:z.literal(true),value:z.unknown()}).strict().parse(await response.json()).value;
    }catch {throw failed();}
  };
}
