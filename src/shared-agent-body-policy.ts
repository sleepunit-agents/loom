/** Owner-configured interaction tiers and native tool denials, not identity. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { agentDeniedTools, agentPeople, agents } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
const text=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim().length>0).refine(value=>!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value));
const outsidePerson=z.object({platform:z.enum(['discord','slack']),workspace:text(200),user:text(200),tier:z.union([z.literal(1),z.literal(2),z.literal(3)])}).strict();
const key=(person:z.infer<typeof outsidePerson>)=>JSON.stringify([person.platform,person.workspace,person.user]);
export const agentBodyPolicyInput=z.object({agent:text(200),people:z.array(outsidePerson).max(128).refine(values=>new Set(values.map(key)).size===values.length),
   deniedTools:z.array(z.object({pattern:text(512).refine(value=>!value.trimStart().startsWith('-')),guestsOnly:z.boolean()}).strict()).max(128).refine(values=>new Set(values.map(value=>JSON.stringify([value.pattern,value.guestsOnly]))).size===values.length),
  }).strict();
type BodyPolicy=z.infer<typeof agentBodyPolicyInput>;
/** The policy as stored, in the command's own shape and a stable order. */
export function readAgentBodyPolicy(db:DataDatabase,agent:string):BodyPolicy{
 const people=db.select().from(agentPeople).where(eq(agentPeople.agent,agent)).all().map(row=>{const [platform,workspace,user]=JSON.parse(row.person) as [BodyPolicy['people'][number]['platform'],string,string];return{platform,workspace,user,tier:row.tier as 1|2|3};});
 const deniedTools=db.select().from(agentDeniedTools).where(eq(agentDeniedTools.agent,agent)).all().map(row=>({pattern:row.pattern,guestsOnly:row.guestsOnly}));
 const order=(a:unknown,b:unknown)=>JSON.stringify(a)<JSON.stringify(b)?-1:1;
 return{agent,people:people.sort(order),deniedTools:deniedTools.sort(order)};
}
export function saveAgentBodyPolicy(db:DataDatabase,input:BodyPolicy){
 if(!db.select({id:agents.id}).from(agents).where(eq(agents.id,input.agent)).get())throw new OperationError('invalid','Unknown agent');
 db.delete(agentPeople).where(eq(agentPeople.agent,input.agent)).run();
 if(input.people.length)db.insert(agentPeople).values(input.people.map(person=>({agent:input.agent,person:key(person),tier:person.tier}))).run();
 db.delete(agentDeniedTools).where(eq(agentDeniedTools.agent,input.agent)).run();
 if(input.deniedTools.length)db.insert(agentDeniedTools).values(input.deniedTools.map(rule=>({agent:input.agent,...rule}))).run();
}
