/** Owning Runtime admission for one native Clock input. No worker paths,
 * harness handles or credentials are accepted from a request. */
import { buildIdentity } from './records.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, type Context, type Viewer } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import type { OutsideEffects } from '../../core/effects.js';

export const clockExecutionAssignment=z.object({runner:z.string().min(1),box:z.string().min(1),claimedAt:z.number().int(),house:buildIdentity}).strict();
export interface ClockExecutionInput {
  assignment:z.infer<typeof clockExecutionAssignment>;
  job:string;
  binding:{agent:string;conversation:string;venue:'wake';place:string};
  message:{seq:number;id:string;kind:'wake';text:string};
  current(viewer:Viewer):boolean;
  acknowledge(ctx:Context):void;
}
const denied=()=>new OperationError('denied','Scheduled execution authority ended');
const token=z.object({execution:z.uuid()}).strict();
export function installClockExecution(app:Foundation,effects:OutsideEffects,
  prepare:(viewer:Viewer)=>ClockExecutionInput) {
  const {operations}=app;
  const executions=new Map<string,{input:ClockExecutionInput;expires:number}>();
  const prune=()=>{for(const [id,e] of executions)if(e.expires<=operations.clock.now())executions.delete(id);};
  const current=(viewer:Viewer,id:string)=>{
    prune();const e=executions.get(id);
    if(!e||!e.input.current(viewer)){executions.delete(id);throw denied();}
    return e;
  };
  app.onClose(()=>executions.clear());
  operations.register(operation({name:'runtime.beginClockExecution',doors:['http','direct'],
    input:z.object({}).strict(),output:z.object({execution:z.uuid(),job:z.string(),assignment:clockExecutionAssignment,
      binding:z.object({agent:z.string(),conversation:z.string(),venue:z.literal('wake'),place:z.string()}),
      batch:z.object({conversation:z.string(),messages:z.array(z.object({seq:z.number(),id:z.string(),kind:z.literal('wake'),text:z.string()})).length(1)}),
      ttl:z.literal(5000)}),
    may:v=>v.kind==='agent',
    async prepare(_input,{viewer}) {
      prune();if(executions.size>=1024)throw new OperationError('unavailable','Scheduled execution is busy');
      const input=prepare(viewer);
      if(!input.current(viewer))throw denied();
      // One durable effect PER SOURCE, not per batch/worker/receipt. A lost
      // response, crash or later join can never release this source twice.
      const id=`runtime:clock-native:${input.message.id}`;
      if(!effects.beforeOutside({id,kind:'body-start',title:'Execute scheduled input on its worker'}))
        throw new OperationError('conflict','Scheduled execution is held or already attempted');
      effects.finish(id);
      if(!input.current(viewer))throw denied();
      return input;
    },
    run(ctx,_input,prepared) {
      const input=prepared as ClockExecutionInput;
      if(!input.current(ctx.viewer))throw denied();
      prune();if(executions.size>=1024)throw new OperationError('unavailable','Scheduled execution is busy');
      const execution=randomUUID();
      executions.set(execution,{input,expires:ctx.now+30*60_000});
      return {execution,job:input.job,assignment:input.assignment,binding:input.binding,
        batch:{conversation:input.binding.conversation,messages:[input.message]},ttl:5000 as const};
    },
  }));
  operations.register(operation({name:'runtime.currentClockExecution',doors:['http','direct'],
    input:token,output:z.object({current:z.literal(true),ttl:z.literal(5000)}),
    may:v=>v.kind==='agent',run(ctx,i){current(ctx.viewer,i.execution);return {current:true as const,ttl:5000 as const};},
  }));
  operations.register(operation({name:'runtime.completeClockExecution',doors:['http','direct'],write:true,recheckPolicy:true,
    input:token,output:z.object({acknowledged:z.literal(true)}),may:v=>v.kind==='agent',
    run(ctx,i){const e=current(ctx.viewer,i.execution);e.input.acknowledge(ctx);executions.delete(i.execution);return {acknowledged:true as const};},
  }));
}
