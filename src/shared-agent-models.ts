/** Agent model choices are setup, governed by the existing ownership rule. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { agentModels } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import type { ModelRole } from './runtime/placement.js';
export function registerAgentModels(operations:Operations,db:DataDatabase,roles:()=>readonly ModelRole[],changed:()=>void){
 const applied=new WeakSet<object>();
 operations.register({name:'runtime.agentModelsSet',write:true,recheckPolicy:true,doors:['http'],
  input:z.object({agent:z.string().min(1).max(200),models:z.array(z.string().min(1).max(200)).min(1).max(64).refine(models=>new Set(models).size===models.length)}).strict(),
  output:z.object({saved:z.literal(true)}).strict(),
  may:(viewer,input)=>mayAct(viewer,{type:'runtime.agent-models',agent:input.agent},sharedSharing(db),'agent-setup'),
  run(ctx,input){
   const configured=new Set(roles().map(role=>role.model));
   if(input.models.some(model=>!configured.has(model)))throw new OperationError('invalid','Choose configured models');
   db.delete(agentModels).where(eq(agentModels.agent,input.agent)).run();
   db.insert(agentModels).values(input.models.map((model,position)=>({agent:input.agent,model,position}))).run();
   applied.add(input);ctx.changed('agentModels',input.agent);return{saved:true as const};
  },
  after(input){if(applied.delete(input))changed();},
 });
}
