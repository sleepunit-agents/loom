/** An enrolled machine's owner controls hosting; enrollment stays with Sign-in. */
import { and, eq, ne, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { agents, boxes, boxAgents, boxFacts } from './core/data/schema.js';
import { membersWithAgent } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { machineFacts } from './runtime/machine-facts.js';
import { machineName } from './core/line-name.js';
export const boxSettingsInput=z.object({box:z.string().min(1).max(200),name:machineName,hostsAny:z.boolean(),reportOnly:z.boolean(),alwaysOn:z.boolean(),
   readers:z.array(z.string().min(1).max(200)).max(128).optional(),
   agents:z.array(z.object({agent:z.string().min(1).max(200),lent:z.boolean()}).strict()).max(128).refine(values=>new Set(values.map(value=>value.agent)).size===values.length),facts:machineFacts}).strict();

/** Trusted setting application; callers authorize against the current machine. */
export function validateBoxSettings(db:DataDatabase,input:z.infer<typeof boxSettingsInput>){
   const box=db.select().from(boxes).where(eq(boxes.id,input.box)).get();
   if(!box||box.revokedAt)throw new OperationError('denied','Available machine required');
   const sharing=sharedSharing(db);
   for(const reader of input.readers ?? []) if(!sharing.agents?.includes(reader))throw new OperationError('invalid','Choose existing agents');
   for(const value of input.agents){
    if(!db.select({id:agents.id}).from(agents).where(eq(agents.id,value.agent)).get())throw new OperationError('invalid','Choose existing agents');
    // Who has an agent is policy.ts's reading (membersWithAgent), the one placement goes by.
    const owned=membersWithAgent(value.agent,sharing).includes(box.owner);
    if(value.lent===owned)throw new OperationError('invalid','Lending must match current agent ownership');
   }
   if(db.select({id:boxes.id}).from(boxes).where(and(ne(boxes.id,input.box),eq(boxes.name,input.name),isNull(boxes.revokedAt))).get())throw new OperationError('conflict','Machine name is already in use');
}
export function applyBoxSettings(db:DataDatabase,input:z.infer<typeof boxSettingsInput>){
   validateBoxSettings(db,input);
   db.update(boxes).set({readers:input.readers,name:input.name,hostsAny:input.hostsAny,reportOnly:input.reportOnly,alwaysOn:input.alwaysOn}).where(eq(boxes.id,input.box)).run();
   db.delete(boxAgents).where(eq(boxAgents.box,input.box)).run();
   if(input.agents.length)db.insert(boxAgents).values(input.agents.map(value=>({box:input.box,...value}))).run();
   db.delete(boxFacts).where(and(eq(boxFacts.box,input.box),eq(boxFacts.fromOwner,true))).run();
   for(const fact of input.facts)db.insert(boxFacts).values({box:input.box,fact,fromOwner:true}).onConflictDoUpdate({target:[boxFacts.box,boxFacts.fact],set:{fromOwner:true}}).run();
}


export function validateMachineReader(db: DataDatabase, owner: string, input: {box: string; agent: string; allow: boolean}) {
  const {box, agent, allow} = input;
  const machine = db.select().from(boxes).where(and(eq(boxes.id, box), isNull(boxes.revokedAt))).get();
  if (!machine || machine.owner !== owner) throw new OperationError('denied', 'Only the machine owner may change explicit readers');
  const readers = machine.readers ?? [];
  if (allow && (!sharedSharing(db).agents?.includes(agent) || readers.length >= 128))
    throw new OperationError('invalid', 'Reader unavailable or limit reached');
  if (allow === readers.includes(agent)) throw new OperationError('conflict', 'That is how it already is');
  return readers;
}

export function applyMachineReader(db: DataDatabase, owner: string, input: {box: string; agent: string; allow: boolean}) {
  const readers = validateMachineReader(db, owner, input);
  const next = input.allow ? [...readers, input.agent].sort() : readers.filter(id => id !== input.agent);
  db.update(boxes).set({readers:next}).where(eq(boxes.id, input.box)).run();
}
