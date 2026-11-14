/** Worker-side owner of a single native Clock execution. The daemon never
 * imports this module. Config is a local owner capability, not body input. */
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { z } from 'zod';
import {clockExecutionAssignment,clockExecutionBinding as binding,clockExecutionAdmission as begin,clockExecutionCurrent,clockExecutionCompletion,clockExecutionIdle} from '../pieces/runtime/clock-protocol.js';
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
  /** Owner-selected wait after an empty queue; default 0, at most 30 seconds. */
  idleMs?:number;
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
    ||config.idleMs!==undefined&&(!Number.isInteger(config.idleMs)||config.idleMs<0||config.idleMs>30_000)
    ||!config.credential||/[\r\n\0]/.test(config.credential)||!config.job
    ||![config.checkout,config.command].every(p=>isAbsolute(p)&&!p.includes('\0'))
    ||Object.entries(config.env).some(([k,v])=>!k||/[=\0]/.test(k)||v!==undefined&&(typeof v!=='string'||v.includes('\0'))))throw fail();
  const clock=host.clock??realClock;
  const session=new ClaudeWorkerSession(config.command,config.env,host.launch);
  const requests=new Set<AbortController>();
  let generation=0;
  let active=true,deadline=0,cancelWatch:(()=>void)|undefined,cancelExpiry:(()=>void)|undefined;
  let cancelIdle:(()=>void)|undefined,finishIdle:(()=>void)|undefined;
  const fence=()=>{
    cancelIdle?.();finishIdle?.();
    active=false;cancelWatch?.();cancelExpiry?.();session.close();
    for(const controller of requests)controller.abort();
  };
  const local=()=>active&&clock.now()<deadline;
  const call=async(op:string,input:unknown,until=Infinity)=>{
    if(!active)throw fail();
    const controller=new AbortController();requests.add(controller);
    const cancel=clock.at(Math.min(clock.now()+5000,until),()=>controller.abort());
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
      let historyKey:string|undefined,previous:string|undefined,historyUntil=Infinity;
      for(let turn=0;turn<100;turn++){
        const generationId=++generation;
        // Completion retires the per-turn expiry. Retained history still
        // needs a timer while a successor admission is in flight.
        if(previous){
          if(clock.now()>=historyUntil)throw fail();
          cancelExpiry=clock.at(historyUntil,fence);
        }
        const started=clock.now(),input=begin.parse(await call('beginClockExecution',previous?{previous}:{},historyUntil));
        if(input.job!==config.job||JSON.stringify(input.binding)!==JSON.stringify(config.binding)||JSON.stringify(input.assignment)!==JSON.stringify(config.assignment))throw fail();
        // Equality witness only: each source still requires its own admission.
        // Retained local history must not outlive original steering/root/claim.
        historyKey??=input.historyKey;if(input.historyKey!==historyKey)throw fail();
        // This deadline starts BEFORE the request. A delayed successful response
        // cannot mint a fresh local execution window from old authority.
        historyUntil=Math.min(historyUntil,started+input.lifetime);
        const executionUntil=historyUntil;
        deadline=Math.min(started+input.ttl,executionUntil);
        const message=prepareClockInput(input.batch,config.binding.conversation,config.checkout);
        if(!message||!local())throw fail();
        const refresh=async()=>{
          const started=clock.now();
          const value=clockExecutionCurrent.parse(await call('currentClockExecution',{execution:input.execution}));
          if(generationId!==generation)return;
          if(!local()||clock.now()>=started+value.ttl)throw fail();
          // Out-of-order successful reads cannot shorten/restore a fenced lease.
          deadline=Math.min(executionUntil,Math.max(deadline,started+value.ttl));
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
        const idleMs=turn<99&&'text' in input.batch.messages[0]?(config.idleMs??0):0;
        const idleUntil=Math.min(clock.now()+idleMs,executionUntil);
        const receipt=clockExecutionCompletion.parse(await call('completeClockExecution',{execution:input.execution,...(idleMs?{idleMs}:{})}));
        if(!local()||!receipt.acknowledged)throw fail();
        cancelExpiry?.();
        void output;
        if(!receipt.more){
          // Completed history remains private to this startup. Polling supplies
          // no native launch authority: every arrival still needs new admission.
          let more=false;
          // Clock timers deliberately unref in production. A pending promise or
          // signal listener cannot keep this executable alive after stdin/child
          // EOF, so own one referenced handle for precisely this idle window.
          const lifetime=setInterval(()=>{},30_000);
          try {
            while(active&&clock.now()<idleUntil){
              await new Promise<void>(resolve=>{
                finishIdle=resolve;cancelIdle=clock.at(Math.min(clock.now()+1000,idleUntil),resolve);
              });
              cancelIdle?.();cancelIdle=undefined;finishIdle=undefined;
              if(!active)throw fail();
              if(clock.now()>=idleUntil)break;
              const checked=clock.now();
              const idle=clockExecutionIdle.parse(await call('idleClockExecution',{execution:input.execution},idleUntil));
              if(!active||clock.now()>=checked+idle.ttl)throw fail();
              if(clock.now()>=idleUntil)throw fail();
              if(idle.more){more=true;break;}
            }
            if(!active)throw fail();
            if(!more)return true;
          }finally {clearInterval(lifetime);}
        }
        previous=input.execution;
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
