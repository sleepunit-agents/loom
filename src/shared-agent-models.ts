/** Agent model choices are setup, governed by the existing ownership rule. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { agentModels, agents } from './core/data/schema.js';
import { OperationError } from './core/operations/index.js';
import type { ModelRole } from './runtime/placement.js';
export const agentModelList=z.array(z.string().min(1).max(200)).max(64).refine(models=>new Set(models).size===models.length);
export const agentModelsInput=z.object({agent:z.string().min(1).max(200),models:agentModelList.min(1)}).strict();
export function validateAgentModels(models:readonly string[],roles:readonly ModelRole[]){
 const configured=new Set(roles.map(role=>role.model));
 if(models.some(model=>!configured.has(model)))throw new OperationError('invalid','Choose configured models');
}
export function applyAgentModels(db:DataDatabase,input:z.infer<typeof agentModelsInput>,roles:readonly ModelRole[]){
 validateAgentModels(input.models,roles);
 if(!db.select({id:agents.id}).from(agents).where(eq(agents.id,input.agent)).get())throw new OperationError('invalid','Unknown agent');
 db.delete(agentModels).where(eq(agentModels.agent,input.agent)).run();
 db.insert(agentModels).values(input.models.map((model,position)=>({agent:input.agent,model,position}))).run();
}
