/** Worker-side owner of a single native Clock execution. The daemon never
 * imports this module. Config is a local owner capability, not body input. */
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { z } from 'zod';
import {clockExecutionAssignment,clockExecutionBinding as binding,clockExecutionAdmission as begin,clockExecutionCurrent,clockExecutionCompletion} from '../pieces/runtime/clock-protocol.js';
import { clock as realClock, type Clock } from '../core/clock.js';
import { ClaudeWorkerSession, type RunnerBinding, type SpawnClaude } from './session.js';
import { prepareClockInput } from './clock-input.js';

export interface ClockWorkerConfig {
  url:string;
  /** Existing job-bearing Signin credential from Runtime's takeInput path. */
  credential:string;
  job:string;
  /** Original locally assigned claim and built house, selected by the runner. */
  assignment:z.infer<typeof clockExecutionAssignment>;
  binding:RunnerBinding;
  checkout:string;
  command:string;
  env:NodeJS.ProcessEnv;
  rules:unknown;
}
const fail=()=>new Error('Scheduled worker unavailable');

/** One foreground child at a time, one original assignment, no retry. The
 * HTTP authority is exact-source Runtime admission, not a caller current()
 * witness. Owner lifecycle events fence synchronously across every await. */
export function startClockWorker(raw:ClockWorkerConfig,host:{clock?:Clock;launch?:SpawnClaude}={}) {
  const config={...raw,binding:binding.parse(raw.binding),assignment:clockExecutionAssignment.parse(raw.assignment),env:{...raw.env},rules:structuredClone(raw.rules)};
  const endpoint=new URL(config.url);
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'
    ||!(endpoint.protocol==='https:'||endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1')
    ||!config.credential||/[\r\n\0]/.test(config.credential)||!config.job
    ||![config.checkout,config.command].every(p=>isAbsolute(p)&&!p.includes('\0'))
    ||Object.entries(config.env).some(([k,v])=>!k||/[=\0]/.test(k)||v!==undefined&&(typeof v!=='string'||v.includes('\0'))))throw fail();
  const clock=host.clock??realClock;
  const session=new ClaudeWorkerSession(config.command,config.env,host.launch);
  const requests=new Set<AbortController>();
  let generation=0;
  let active=true,deadline=0,cancelWatch:(()=>void)|undefined,cancelExpiry:(()=>void)|undefined;
  const fence=()=>{
    active=false;cancelWatch?.();cancelExpiry?.();session.close();
    for(const controller of requests)controller.abort();
  };
  const local=()=>active&&clock.now()<deadline;
  const call=async(op:string,input:unknown)=>{
    if(!active)throw fail();
    const controller=new AbortController();requests.add(controller);
    const cancel=clock.at(clock.now()+5000,()=>controller.abort());
    try {
      const response=await fetch(new URL(`/api/runtime/${op}`,endpoint),{method:'POST',redirect:'error',signal:controller.signal,
        headers:{authorization:`Bearer ${config.credential}`,'content-type':'application/json'},body:JSON.stringify({input,id:randomUUID()})});
      // Bound the response while streaming; never trust content-length alone.
      if(!response.ok||!response.body)throw fail();
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try {for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;
        if(size>1_048_576){controller.abort();throw fail();}chunks.push(chunk.value);}}
      finally {reader.releaseLock();}
      const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(!active||!result.ok)throw fail();return result.value as unknown;
    }finally {cancel();requests.delete(controller);}
  };
  const completed=(async()=>{
    try {
      let historyKey:string|undefined;
      for(let turn=0;turn<100;turn++){
        const generationId=++generation;
        const started=clock.now(),input=begin.parse(await call('beginClockExecution',{}));
        if(input.job!==config.job||JSON.stringify(input.binding)!==JSON.stringify(config.binding)||JSON.stringify(input.assignment)!==JSON.stringify(config.assignment))throw fail();
        // Equality witness only: each source still requires its own admission.
        // Retained local history must not outlive original steering/root/claim.
        historyKey??=input.historyKey;if(input.historyKey!==historyKey)throw fail();
        // This deadline starts BEFORE the request. A delayed successful response
        // cannot mint a fresh local execution window from old authority.
        deadline=started+input.ttl;
        const message=prepareClockInput(input.batch,config.binding.conversation,config.checkout);
        if(!message||!local())throw fail();
        const refresh=async()=>{
          const started=clock.now();
          const value=clockExecutionCurrent.parse(await call('currentClockExecution',{execution:input.execution}));
          if(generationId!==generation)return;
          if(!local()||clock.now()>=started+value.ttl)throw fail();
          // Out-of-order successful reads cannot shorten/restore a fenced lease.
          deadline=Math.max(deadline,started+value.ttl);
          cancelExpiry?.();cancelExpiry=clock.at(deadline,fence);
        };
        // Independent owning read after preparation, before the actual spawn.
        await refresh();if(!local())throw fail();
        const watch=()=>{cancelWatch=clock.at(clock.now()+1000,()=>{
          if(!active)return;
          // Cadence belongs to the clock, independently of response latency.
          // At most five one-second reads can overlap the bounded window.
          watch();void refresh().catch(()=>{if(generationId===generation)fence();});
        });};
        watch();
        const output=await session.turn({binding:config.binding,rules:config.rules,message:message.message,
          checkout:config.checkout,current:local});
        // Always start a NEW authority request after output. Never coalesce this
        // with a watchdog read begun while the child was still running.
        await refresh();if(!local())throw fail();
        // Completion invalidates the source. Retire overlapping watchdog reads
        // BEFORE sending it, but keep the existing bounded local expiry.
        ++generation;cancelWatch?.();
        const receipt=clockExecutionCompletion.parse(await call('completeClockExecution',{execution:input.execution}));
        if(!local()||!receipt.acknowledged)throw fail();
        cancelExpiry?.();
        // Only this in-memory session retains native history. No idle polling,
        // serialized resume handle, restart reuse or retry of uncertain work.
        void output;if(!receipt.more)return true;
      }
      return false;
    }catch {return false;}
    finally {fence();}
  })();
  return Object.freeze({completed,
    revokePolicy:fence,stopJob:fence,cancelRequest:fence,
    async close(){fence();await completed;},
  });
}
