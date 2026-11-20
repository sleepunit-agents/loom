/** Agent owners configure houses; only workers execute them. */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct, maySee, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { agentBoxes, agentHousePorts, agentRunSettings, boxes, boxAgents } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { hasControlCharacter } from './core/line-name.js';
import { machineFacts } from './runtime/machine-facts.js';
const text=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!hasControlCharacter(value));
const repository=text(2048).refine(value=>{
 if(/[?#]/.test(value)||/^[^/@\s]+:[^/@\s]+@/.test(value))return false;
 try{const url=new URL(value,'https://repository.invalid/');return !url.password&&!url.search&&!url.hash&&(!url.username||url.protocol==='ssh:');}catch{return false;}
},'Use a repository reference without credentials');
/** The Housefile's path inside the repository. Empty is a house with no Housefile of its own: the core
 * house loom provides, with the repository copied in (docs/runtime/worker.md, "The core house"). */
// The same rule a worker holds a Housefile's path to (houseFile in runtime/house-source.ts): no part that is empty, `.` or `..`.
const houseFile=z.string().trim().max(512).refine(value=>!hasControlCharacter(value)).refine(value=>value===''||!value.includes('\\')&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'));
export const agentRunSettingsInput=z.object({agent:text(200),houseRepository:repository,houseFile:houseFile,
   houseBranch:text(200).refine(value=>!value.startsWith('-')),nestedContainers:z.boolean(),gpu:z.boolean(),prefers:machineFacts.optional(),
   boxes:z.array(text(200)).max(128).refine(values=>new Set(values).size===values.length),
   ports:z.array(z.object({address:z.ipv4().or(z.ipv6()).transform(value=>value.includes(':')?new URL('http://['+value+']/').hostname.slice(1,-1):value),port:z.number().int().min(1).max(65535)}).strict()).max(128).refine(values=>new Set(values.map(value=>JSON.stringify([value.address,value.port]))).size===values.length),
  }).strict();

export function mayChangeAgentRunSettings(db:DataDatabase,viewer:Viewer,agent:string){
 return mayAct(viewer,{type:'runtime.agent-run-settings',agent},sharedSharing(db),'agent-setup');
}
/** Validate current owner authority and selected machines without writing. */
export function validateAgentRunSettings(db:DataDatabase,viewer:Viewer,input:z.infer<typeof agentRunSettingsInput>){
   if(!mayChangeAgentRunSettings(db,viewer,input.agent))throw new OperationError('denied','Current agent owner required');
   const sharing=sharedSharing(db);
   for(const id of input.boxes){
    const box=db.select().from(boxes).where(eq(boxes.id,id)).get();
    const lent=db.select().from(boxAgents).where(and(eq(boxAgents.box,id),eq(boxAgents.agent,input.agent))).get();
    if(!box||box.revokedAt||!lent?.lent&&!maySee(viewer,{type:'runtime.box',member:box.owner},sharing))throw new OperationError('invalid','Choose an available machine');
   }
}
/** Apply the typed edit, preserving separately governed Secret references. */
export function applyAgentRunSettings(db:DataDatabase,viewer:Viewer,input:z.infer<typeof agentRunSettingsInput>){
   validateAgentRunSettings(db,viewer,input);
   const {agent,houseRepository,houseFile,houseBranch,nestedContainers,gpu}=input;
   // Secret references are owned by Secrets; an ordinary house edit preserves them.
   const settings={houseRepository,houseFile,houseBranch,nestedContainers,gpu,...(input.prefers === undefined ? {} : {prefers:input.prefers})};
   db.insert(agentRunSettings).values({agent,...settings}).onConflictDoUpdate({target:agentRunSettings.agent,set:settings}).run();
   db.delete(agentBoxes).where(eq(agentBoxes.agent,agent)).run();
   if(input.boxes.length)db.insert(agentBoxes).values(input.boxes.map((box,position)=>({agent,box,position}))).run();
   db.delete(agentHousePorts).where(eq(agentHousePorts.agent,agent)).run();
   if(input.ports.length)db.insert(agentHousePorts).values(input.ports.map(port=>({agent,...port}))).run();
}
