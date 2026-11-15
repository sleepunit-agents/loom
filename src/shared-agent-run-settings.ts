/** Agent owners configure houses; only workers execute them. */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct, maySee, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { agentBoxes, agentHousePorts, agentRunSettings, boxes, boxAgents } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
const text=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value));
const repository=text(2048).refine(value=>{
 if(/[?#]/.test(value)||/^[^/@\s]+:[^/@\s]+@/.test(value))return false;
 try{const url=new URL(value,'https://repository.invalid/');return !url.password&&!url.search&&!url.hash&&(!url.username||url.protocol==='ssh:');}catch{return false;}
},'Use a repository reference without credentials');
export const agentRunSettingsInput=z.object({agent:text(200),houseRepository:repository,houseFile:text(512).refine(value=>!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').includes('..')),
   houseBranch:text(200).refine(value=>!value.startsWith('-')),nestedContainers:z.boolean(),gpu:z.boolean(),
   boxes:z.array(text(200)).max(128).refine(values=>new Set(values).size===values.length),
   ports:z.array(z.object({address:z.ipv4().or(z.ipv6()).transform(value=>value.includes(':')?new URL('http://['+value+']/').hostname.slice(1,-1):value),port:z.number().int().min(1).max(65535)}).strict()).max(128).refine(values=>new Set(values.map(value=>JSON.stringify([value.address,value.port]))).size===values.length),
  }).strict();

/** Trusted typed application, shared by direct owner edits and approved cards. */
export function validateAgentRunSettings(db:DataDatabase,viewer:Viewer,input:z.infer<typeof agentRunSettingsInput>){
   if(!mayAct(viewer,{type:'runtime.agent-run-settings',agent:input.agent},sharedSharing(db),'agent-setup'))throw new OperationError('denied','Current agent owner required');
   const sharing=sharedSharing(db);
   for(const id of input.boxes){
    const box=db.select().from(boxes).where(eq(boxes.id,id)).get();
    const lent=db.select().from(boxAgents).where(and(eq(boxAgents.box,id),eq(boxAgents.agent,input.agent))).get();
    if(!box||box.revokedAt||!lent?.lent&&!maySee(viewer,{type:'runtime.box',member:box.owner},sharing))throw new OperationError('invalid','Choose an available machine');
   }
}
export function applyAgentRunSettings(db:DataDatabase,viewer:Viewer,input:z.infer<typeof agentRunSettingsInput>){
   validateAgentRunSettings(db,viewer,input);
   const {agent,houseRepository,houseFile,houseBranch,nestedContainers,gpu}=input;
   // Secret references are owned by Secrets; an ordinary house edit preserves them.
   const settings={houseRepository,houseFile,houseBranch,nestedContainers,gpu};
   db.insert(agentRunSettings).values({agent,...settings}).onConflictDoUpdate({target:agentRunSettings.agent,set:settings}).run();
   db.delete(agentBoxes).where(eq(agentBoxes.agent,agent)).run();
   if(input.boxes.length)db.insert(agentBoxes).values(input.boxes.map((box,position)=>({agent,box,position}))).run();
   db.delete(agentHousePorts).where(eq(agentHousePorts.agent,agent)).run();
   if(input.ports.length)db.insert(agentHousePorts).values(input.ports.map(port=>({agent,...port}))).run();
}

export function registerAgentRunSettings(operations:Operations,db:DataDatabase,changed:()=>void){
 const applied=new WeakSet<object>();
 operations.register({name:'runtime.agentRunSettingsSet',write:true,recheckPolicy:true,doors:['http'],
  input:agentRunSettingsInput,output:z.object({saved:z.literal(true)}).strict(),
  may:(viewer,input)=>mayAct(viewer,{type:'runtime.agent-run-settings',agent:input.agent},sharedSharing(db),'agent-setup'),
  run(ctx,input){
   applyAgentRunSettings(db,ctx.viewer,input);
   applied.add(input);for(const type of ['agentRunSettings','agentBoxes','agentHousePorts'])ctx.changed(type,input.agent);return{saved:true as const};
  },after(input){if(applied.delete(input))changed();},
 });
}
