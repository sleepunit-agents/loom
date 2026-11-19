import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { conversationBodyScope } from './core/conversations/body-scope.js';
import type { DataDatabase } from './core/data/database.js';
import { boxAgents, boxes, machineReads } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { mayInspectMachine, type Viewer } from './policy.js';
import { MachineReadBroker } from './runtime/machine-read-broker.js';
import { machineReadKinds, machineReadOutputBytes, parseMachineRead } from './runtime/machine-read-catalog.js';
import { jobWord } from './shared-place-mail.js';
import { sharedSharing } from './shared-sharing.js';
import { liveWorker } from './shared-worker.js';

const name=z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const args=z.record(z.string().max(20),z.union([z.number(),z.string().max(255)]));
const read=z.enum(machineReadKinds);
export const machineReadInput=z.object({machine:name,read,args}).strict();
const ticket=z.object({id:z.uuid(),read,args}).strict();
const answer=z.union([z.object({refusal:z.string()}),z.object({source:z.literal('machine'),machine:name,read,lines:z.array(z.string())})]);

export function registerMachineReads(operations:Operations,db:DataDatabase,now:()=>string,
  body:ReturnType<typeof conversationBodyScope>, runner:(viewer:Viewer)=>{box:string}|undefined){
  const broker=new MachineReadBroker();
  db.update(machineReads).set({outcome:'Machine read interrupted'}).where(eq(machineReads.outcome,'waiting')).run();
  const offered=new Map<string,{at:number;reads:Set<string>}>();
  const worker=(viewer:Viewer)=>liveWorker(db,viewer,runner(viewer));
  const box=(id:string)=>db.select().from(boxes).where(eq(boxes.id,id)).get();
  const mayInspect=(viewer:Viewer,id:string)=>{
    const work=body(viewer),machine=box(id);
    if(!work||!machine||machine.revokedAt)return false;
    const agent=work.job.agent,sharing=sharedSharing(db);
    const entry=db.select().from(boxAgents).where(and(eq(boxAgents.box,id),eq(boxAgents.agent,agent))).get();
    return mayInspectMachine(machine,entry,agent,sharing,jobWord(db,work.job).woke);
  };
  operations.register({name:'runtime.machineReadNext',doors:['http'],input:z.object({reads:z.array(read).max(32)}).strict(),output:ticket.nullable(),
    may:viewer=>!!worker(viewer),run(ctx,input){
      offered.set(ctx.viewer.id,{at:Date.now(),reads:new Set(input.reads)});
      return broker.next(ctx.viewer.id);
    }});
  operations.register({name:'runtime.machineReadDone',doors:['http'],input:z.object({id:z.uuid(),ok:z.boolean(),output:z.string().max(machineReadOutputBytes)}).strict(),output:z.boolean(),
    may:viewer=>!!worker(viewer),run(ctx,input){return broker.finish(ctx.viewer.id,input.id,input.output,input.ok);}});
  operations.register({name:'machine.read',doors:['http'],input:machineReadInput,output:answer,
    may:viewer=>!!body(viewer),
    async prepare(input,{viewer,signal}){
      const work=body(viewer);
      if(!work)throw new OperationError('denied','Current conversation body required');
      const id=randomUUID(),word=jobWord(db,work.job),kind=input.read;
      let parameters:Record<string,string|number>|undefined;
      if(!Object.hasOwn(input.args,'kind')){
        try { const {kind:_kind,...values}=parseMachineRead({...input.args,kind}); parameters=values; }
        catch { /* Never keep an invalid argument, which can contain arbitrary private text. */ }
      }
      const permitted=mayInspect(viewer,input.machine);
      db.insert(machineReads).values({id,machine:input.machine,agent:work.job.agent,job:work.job.id,conversation:work.cv.id,
        word:word.woke,person:word.person?.id,read:kind,args:JSON.stringify(parameters ?? {}),askedAt:now(),bytes:0,outcome:!permitted?'Machine read refused':parameters?'waiting':'Invalid arguments'}).run();
      if(!parameters)throw new OperationError('invalid','Invalid machine read arguments');
      const available=()=>{const offer=offered.get(input.machine);return !!offer && Date.now()-offer.at<15000 && offer.reads.has(kind);};
      const result= !permitted?{refusal:'Machine read refused'}:
        !available()?{refusal:'Machine is away or does not offer this read'}:
        await broker.ask(input.machine,kind,parameters,()=>mayInspect(viewer,input.machine)&&available(),signal);
      db.update(machineReads).set({bytes:0,outcome:'refusal' in result?result.refusal:'Machine answer withheld'}).where(eq(machineReads.id,id)).run();
      return {id,result};
    },
    run(ctx,input,prepared){
      if(!prepared)throw new OperationError('unavailable','Machine read requires an asynchronous request');
      const {id,result}=prepared as {id:string;result:import('./runtime/machine-read-broker.js').ReadAnswer};
      if (!mayInspect(ctx.viewer,input.machine)) {
        db.update(machineReads).set({bytes:0,outcome:'Machine read refused'}).where(eq(machineReads.id,id)).run();
        return {refusal:'Machine read refused'};
      }
      if('refusal' in result)return result;
      db.update(machineReads).set({outcome:'answered',bytes:Buffer.byteLength(result.lines.join('\n'))}).where(eq(machineReads.id,id)).run();
      return {source:'machine',machine:input.machine,read:input.read,lines:result.lines};
    }});
  operations.register({name:'machine.history',doors:['http'],input:z.object({machine:name}).strict(),output:z.array(z.unknown()),
    may:(viewer,input)=>viewer.kind==='member'&&box(input.machine)?.owner===viewer.id,
    run(_ctx,input){return db.select().from(machineReads).where(eq(machineReads.machine,input.machine)).orderBy(desc(machineReads.askedAt)).limit(100).all().map(row=>
      row.outcome==='Machine read refused' || row.outcome==='Invalid arguments'
        ? {...row, agent:'withheld',job:'withheld',conversation:null,word:'withheld',person:null,args:'{}'} : row);}});
  return ()=>broker.close();
}
