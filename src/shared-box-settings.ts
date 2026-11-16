/** An enrolled machine's owner controls hosting; enrollment stays with Sign-in. */
import { and, eq, ne, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { agents, boxes, boxAgents, boxFacts, memberAgents } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { machineFacts } from './runtime/machine-facts.js';
export const boxSettingsInput=z.object({box:z.string().min(1).max(200),name:z.string().trim().min(1).max(200).refine(value=>!/[\0\r\n]/.test(value)),hostsAny:z.boolean(),reportOnly:z.boolean(),alwaysOn:z.boolean(),
   agents:z.array(z.object({agent:z.string().min(1).max(200),lent:z.boolean()}).strict()).max(128).refine(values=>new Set(values.map(value=>value.agent)).size===values.length),facts:machineFacts}).strict();

/** Trusted setting application; callers authorize against the current machine. */
export function validateBoxSettings(db:DataDatabase,input:z.infer<typeof boxSettingsInput>){
   const box=db.select().from(boxes).where(eq(boxes.id,input.box)).get();
   if(!box||box.revokedAt)throw new OperationError('denied','Available machine required');
   for(const value of input.agents){
    if(!db.select({id:agents.id}).from(agents).where(eq(agents.id,value.agent)).get())throw new OperationError('invalid','Choose existing agents');
    const owned=db.select().from(memberAgents).where(and(eq(memberAgents.member,box.owner),eq(memberAgents.agent,value.agent))).get();
    if(value.lent===!!owned)throw new OperationError('invalid','Lending must match current agent ownership');
   }
   if(db.select({id:boxes.id}).from(boxes).where(and(ne(boxes.id,input.box),eq(boxes.name,input.name),isNull(boxes.revokedAt))).get())throw new OperationError('conflict','Machine name is already in use');
}
export function applyBoxSettings(db:DataDatabase,input:z.infer<typeof boxSettingsInput>){
   validateBoxSettings(db,input);
   db.update(boxes).set({name:input.name,hostsAny:input.hostsAny,reportOnly:input.reportOnly,alwaysOn:input.alwaysOn}).where(eq(boxes.id,input.box)).run();
   db.delete(boxAgents).where(eq(boxAgents.box,input.box)).run();
   if(input.agents.length)db.insert(boxAgents).values(input.agents.map(value=>({box:input.box,...value}))).run();
   db.delete(boxFacts).where(and(eq(boxFacts.box,input.box),eq(boxFacts.fromOwner,true))).run();
   for(const fact of input.facts)db.insert(boxFacts).values({box:input.box,fact,fromOwner:true}).onConflictDoUpdate({target:[boxFacts.box,boxFacts.fact],set:{fromOwner:true}}).run();
}

export function mayChangeBoxSettings(db:DataDatabase,viewer:Viewer,id:string){
 const box=db.select().from(boxes).where(eq(boxes.id,id)).get();
 return !!box&&!box.revokedAt&&viewer.kind==='member'&&mayAct(viewer,{type:'runtime.box',member:box.owner},sharedSharing(db));
}
