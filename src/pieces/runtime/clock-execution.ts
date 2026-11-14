/** Owning Runtime admission for one native Clock input. No worker paths,
 * harness handles or credentials are accepted from a request. */
import {clockExecutionMessage,clockExecutionAssignment,clockExecutionAdmission,clockExecutionCurrent,clockExecutionCompletion,clockExecutionIdle} from './clock-protocol.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, type Context, type Viewer } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import type { OutsideEffects } from '../../core/effects.js';

export interface ClockExecutionInput {
  historyKey:string;
  more():boolean;
  /** Source-only retained history check; current input owns the shared binding. */
  retainedCurrent():boolean;
  assignment:z.infer<typeof clockExecutionAssignment>;
  job:string;
  binding:{agent:string;conversation:string;venue:'wake';place:string};
  message:z.infer<typeof clockExecutionMessage>;
  current(viewer:Viewer,completed?:boolean):boolean;
  acknowledge(ctx:Context):void;
}
const denied=()=>new OperationError('denied','Scheduled execution authority ended');
const token=z.object({execution:z.uuid()}).strict();
export function installClockExecution(app:Foundation,effects:OutsideEffects,
  prepare:(viewer:Viewer)=>ClockExecutionInput) {
  const {operations}=app;
  const executions=new Map<string,{input:ClockExecutionInput;history:ClockExecutionInput[];completed:boolean;expires:number;deadline:number}>();
  const occupied=()=>[...executions.values()].reduce((n,e)=>n+1+e.history.length,0);
  const prune=()=>{for(const [id,e] of executions)if(e.expires<=operations.clock.now())executions.delete(id);};
  const current=(viewer:Viewer,id:string,completed=false)=>{
    prune();const e=executions.get(id);
    // A late watchdog for a completed turn cannot destroy its successor proof.
    if(!e||e.completed!==completed)throw denied();
    if(!e.input.current(viewer,completed)||!e.history.every(input=>input.retainedCurrent())){executions.delete(id);throw denied();}
    return e;
  };
  app.onClose(()=>executions.clear());
  operations.register(operation({name:'runtime.beginClockExecution',doors:['http','direct'],
    input:z.object({previous:z.uuid().optional()}).strict(),output:clockExecutionAdmission,
    may:v=>v.kind==='agent',
    async prepare(request,{viewer}) {
      prune();if(occupied()>=1024)throw new OperationError('unavailable','Scheduled execution is busy');
      const previous=request.previous?current(viewer,request.previous,true):undefined;
      if(previous&&previous.history.length>=99)throw denied();
      const input=prepare(viewer);
      if(previous&&previous.input.historyKey!==input.historyKey)throw denied();
      if(!input.current(viewer))throw denied();
      // One durable effect PER SOURCE, not per batch/worker/receipt. A lost
      // response, crash or later join can never release this source twice.
      const id=`runtime:clock-native:${input.message.id}`;
      if(!effects.beforeOutside({id,kind:'body-start',title:'Execute scheduled input on its worker'}))
        throw new OperationError('conflict','Scheduled execution is held or already attempted');
      effects.finish(id);
      if(!input.current(viewer))throw denied();
      return {input,history:previous?[...previous.history,previous.input]:[],deadline:previous?.deadline};
    },
    run(ctx,request,prepared) {
      const {input,history,deadline:inherited}=prepared as {input:ClockExecutionInput;history:ClockExecutionInput[];deadline?:number};
      if(request.previous)current(ctx.viewer,request.previous,true);
      if(!input.current(ctx.viewer))throw denied();
      prune();if(occupied()>=1024)throw new OperationError('unavailable','Scheduled execution is busy');
      const execution=randomUUID();
      if(request.previous)executions.delete(request.previous);
      // A successor retains native history, so it inherits its original chain's
      // absolute deadline. The shorter idle expiry only bounds admission.
      const deadline=inherited??ctx.now+30*60_000;
      executions.set(execution,{input,history,completed:false,expires:deadline,deadline});
      return {execution,historyKey:input.historyKey,job:input.job,assignment:input.assignment,binding:input.binding,
        batch:{conversation:input.binding.conversation,messages:[input.message]},ttl:5000 as const,lifetime:deadline-ctx.now};
    },
  }));
  operations.register(operation({name:'runtime.currentClockExecution',doors:['http','direct'],
    input:token,output:clockExecutionCurrent,
    may:v=>v.kind==='agent',run(ctx,i){current(ctx.viewer,i.execution);return {current:true as const,ttl:5000 as const};},
  }));
  operations.register(operation({name:'runtime.completeClockExecution',doors:['http','direct'],write:true,recheckPolicy:true,
    input:token.extend({idleMs:z.number().int().min(0).max(30_000).optional()}).strict(),output:clockExecutionCompletion,may:v=>v.kind==='agent',
    run(ctx,i){
      const e=current(ctx.viewer,i.execution);e.input.acknowledge(ctx);const more=e.input.more();e.completed=true;
      if(!more){
        if(i.idleMs && 'text' in e.input.message)e.expires=Math.min(e.expires,ctx.now+i.idleMs);
        else executions.delete(i.execution);
      }
      return {acknowledged:true as const,more};
    },
  }));
  operations.register(operation({name:'runtime.idleClockExecution',doors:['http','direct'],
    input:token,output:clockExecutionIdle,may:v=>v.kind==='agent',
    run(ctx,i){const e=current(ctx.viewer,i.execution,true);return {current:true as const,more:e.input.more(),ttl:5000 as const};},
  }));
}
