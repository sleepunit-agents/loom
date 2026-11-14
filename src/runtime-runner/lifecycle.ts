/** Worker-side control consumer. Never import into the daemon. The owning
 * worker supplies the original job and authenticated daemon connection. */
import { z } from 'zod';
import { ClaudeWorkerSession, type SpawnClaude, type WorkerTurn, type TurnResult } from './session.js';
const control = z.object({ok:z.literal(true),value:z.object({stop:z.boolean(),history:z.enum(['retain','discard','unknown'])}).strict()}).strict();
const failed=()=>new Error('Runtime worker authority unavailable');
export interface WorkerControlConfig {
  url:string;
  token:string;
  job:string;
}
export interface WorkerControlRuntime {
  request:typeof fetch;
  deadline:(milliseconds:number)=>AbortSignal;
  every:(callback:()=>void,milliseconds:number)=>()=>void;
}
const defaults:WorkerControlRuntime={deadline:ms=>AbortSignal.timeout(ms),request:(...args)=>fetch(...args),every(callback,ms){const timer=setInterval(callback,ms);return ()=>clearInterval(timer);}};
/** One connection, job and native session owner. No process adoption or caller
 * resume id. Losing authority is sticky, including while idle. A new connection
 * always starts a fresh native session, never revives this object's history. */
export async function connectClaudeWorker(config:WorkerControlConfig,
  launch:{command:string;env:NodeJS.ProcessEnv;spawn?:SpawnClaude},runtime:WorkerControlRuntime=defaults) {
  const base=new URL(config.url),token=config.token,job=config.job;
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash
    ||base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname)
    ||!token||/[\r\n]/.test(token)||!job||job.length>200)throw failed();
  const session=new ClaudeWorkerSession(launch.command,{...launch.env},launch.spawn);
  let closed=false,active=false,inFlight:Promise<void>|undefined,cancel:(()=>void)|undefined;
  const requests=new Set<AbortController>();
  const close=()=>{
    if(closed)return;
    closed=true;active=false;session.close();cancel?.();
    for(const request of requests)request.abort();
  };
  const refresh=():Promise<void>=>{
    if(closed)return Promise.reject(failed());
    if(inFlight)return inFlight;
    const controller=new AbortController();requests.add(controller);
    const work=(async()=>{
      try {
        const response=await runtime.request(new URL('/api/runtime/jobControl',base),{method:'POST',redirect:'error',
          headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({input:{job}}),
          signal:AbortSignal.any([controller.signal,runtime.deadline(1500)])});
        if(!response.ok)throw failed();
        const answer=control.parse(await response.json()).value;
        if(closed||answer.stop||answer.history!=='retain')throw failed();
        active=true;
      }catch {close();throw failed();}
      finally {requests.delete(controller);}
    })();
    inFlight=work;
    void work.finally(()=>{if(inFlight===work)inFlight=undefined;}).catch(()=>{});
    return work;
  };
  const fresh=async()=>{if(inFlight)await inFlight;await refresh();};
  try {
    await refresh();
    cancel=runtime.every(()=>{void refresh().catch(()=>{});},1000);
    return Object.freeze({
      /** Checks original authority before input and after output. Polling also
       * kills an active child without waiting for that child to return. */
      async turn(input:WorkerTurn):Promise<TurnResult> {
        const current=input.current,turn={...input,binding:{...input.binding},rules:structuredClone(input.rules)};
        await fresh();
        const result=await session.turn({...turn,current:()=>!closed&&active&&current()===true});
        await fresh();
        let valid=false;try {valid=current()===true;}catch { /* revoke on a failed local proof */ }
        if(closed||!valid){close();throw failed();}
        return result;
      },
      refresh,
      close,
    });
  }catch {close();throw failed();}
}
