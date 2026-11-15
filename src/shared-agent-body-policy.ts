/** Owner-configured interaction tiers and native tool denials, not identity. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { agentDeniedTools, agentPeople } from './core/data/schema.js';
import type { Operations } from './core/operations/index.js';
const text=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim().length>0).refine(value=>!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value));
const outsidePerson=z.object({platform:z.enum(['discord','slack']),workspace:text(200),user:text(200),tier:z.union([z.literal(1),z.literal(2),z.literal(3)])}).strict();
const key=(person:z.infer<typeof outsidePerson>)=>JSON.stringify([person.platform,person.workspace,person.user]);
export function registerAgentBodyPolicy(operations:Operations,db:DataDatabase){
 operations.register({name:'runtime.agentBodyPolicySet',write:true,recheckPolicy:true,doors:['http'],
  input:z.object({agent:text(200),people:z.array(outsidePerson).max(128).refine(values=>new Set(values.map(key)).size===values.length),
   deniedTools:z.array(z.object({pattern:text(512).refine(value=>!value.trimStart().startsWith('-')),guestsOnly:z.boolean()}).strict()).max(128).refine(values=>new Set(values.map(value=>JSON.stringify([value.pattern,value.guestsOnly]))).size===values.length),
  }).strict(),output:z.object({saved:z.literal(true)}).strict(),
  may:(viewer,input)=>mayAct(viewer,{type:'runtime.agent-body-policy',agent:input.agent},sharedSharing(db),'agent-setup'),
  run(ctx,input){
   db.delete(agentPeople).where(eq(agentPeople.agent,input.agent)).run();
   if(input.people.length)db.insert(agentPeople).values(input.people.map(person=>({agent:input.agent,person:key(person),tier:person.tier}))).run();
   db.delete(agentDeniedTools).where(eq(agentDeniedTools.agent,input.agent)).run();
   if(input.deniedTools.length)db.insert(agentDeniedTools).values(input.deniedTools.map(rule=>({agent:input.agent,...rule}))).run();
   ctx.changed('agentPeople',input.agent);ctx.changed('agentDeniedTools',input.agent);return{saved:true as const};
  },
 });
}
