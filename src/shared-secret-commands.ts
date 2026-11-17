/** One outside command surface; installed code calls the services directly. */
import { createHmac, createSecretKey } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { secrets, agents, agentRunSettings, agentHouseSecrets } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { secretName, secretAgent, secretDescription } from './pieces/secrets/input.js';
import { SecretRequests } from './pieces/secrets/requests.js';
import { householdOwner } from './shared-sharing.js';
import type { SecretValues } from './pieces/secrets/shared-values.js';
const id = z.string().min(1).max(200);
export const houseSecretsInput=z.object({agent:secretAgent,repository:secretName.nullable(),
  secrets:z.array(z.object({alias:z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/),secret:secretName}).strict()).max(128)
    .refine(values=>new Set(values.map(value=>value.alias)).size===values.length,'An alias names one secret')}).strict();
const command = z.discriminatedUnion('action', [
  z.object({action:z.literal('answer'),id,allow:z.boolean(),always:z.boolean()}).strict(),
  z.object({action:z.literal('cancel'),id}).strict(),
  z.object({action:z.literal('revoke'),id}).strict(),
]);
const setInput=z.object({id:z.uuid(),name:secretName,mode:z.enum(['add','replace']),description:secretDescription.optional(),value:z.string().refine(value=>Buffer.byteLength(value)>0&&Buffer.byteLength(value)<=65536)}).strict();
const removeInput=z.object({id:z.uuid(),name:secretName}).strict();
const acknowledgement=z.object({saved:z.literal(true)}).strict();
/** A service's own refusal, in its own words. Storage faults and anything unexpected stay behind one fixed line. */
const refusal=(error:unknown,fallback:string)=>error instanceof Error&&!('code' in error)&&error.message.length>0&&error.message.length<=200?error.message:fallback;
const writeRefusals:Record<string,'conflict'|'not-found'|'denied'>={'Secret value already exists':'conflict','Unknown secret value':'not-found','Unknown secret writer':'denied'};
/** A value write refused before it reached the key holder is an answer, not an outage. */
const writeFailure=(error:unknown)=>{const message=error instanceof Error?error.message:'';const code=writeRefusals[message];return code?new OperationError(code,message):new OperationError('unavailable','Secret write awaits recovery');};
/** What an agent's house is handed when it starts: the secret that fetches its
 * repository, and named secrets under the alias the house knows each by. */
export function setHouseSecrets(db:DataDatabase,input:z.infer<typeof houseSecretsInput>){
  if(!db.select().from(agents).where(eq(agents.id,input.agent)).get())throw Error('Unknown agent');
  for(const name of [input.repository,...input.secrets.map(value=>value.secret)])if(name!==null&&!db.select().from(secrets).where(eq(secrets.name,name)).get())throw Error('Unknown secret');
  const settings=db.select().from(agentRunSettings).where(eq(agentRunSettings.agent,input.agent)).get();
  // The repository secret is a column of the run settings; those must exist first.
  if(!settings&&input.repository!==null)throw Error('Agent has no run settings');
  if(settings)db.update(agentRunSettings).set({repositorySecret:input.repository}).where(eq(agentRunSettings.agent,input.agent)).run();
  db.delete(agentHouseSecrets).where(eq(agentHouseSecrets.agent,input.agent)).run();
  if(input.secrets.length)db.insert(agentHouseSecrets).values(input.secrets.map(value=>({agent:input.agent,...value}))).run();
}
export function readHouseSecrets(db:DataDatabase,agent:string){
  return {agent,repository:db.select().from(agentRunSettings).where(eq(agentRunSettings.agent,agent)).get()?.repositorySecret??null,
    secrets:db.select({alias:agentHouseSecrets.alias,secret:agentHouseSecrets.secret}).from(agentHouseSecrets).where(eq(agentHouseSecrets.agent,agent)).all().sort((a,b)=>a.alias<b.alias?-1:1)};
}
export function registerSharedSecretCommands(operations:Operations, db:DataDatabase, requests:SecretRequests,
  writes?:{values:SecretValues;fingerprintKey:Uint8Array}) {
  const owner=(viewer:Parameters<Operations['call']>[1])=>householdOwner(db,viewer);
  operations.register({name:'secrets.command',input:command,output:acknowledgement,write:true,recheckPolicy:true,may:owner,
    run(ctx,input){
      if(ctx.viewer.kind!=='member')throw new OperationError('denied','A household owner is required');
      try {
        switch(input.action){
          case 'answer':requests.answer(input.id,ctx.viewer.id,input.allow,input.always);break;
          case 'cancel':requests.cancel(input.id);break;
          case 'revoke':requests.revokeGrant(input.id);break;
        }
      }catch(error){throw new OperationError('invalid',refusal(error,'Secret change could not complete'));}
      ctx.changed('secrets','metadata');return {saved:true as const};
    },
  });
  if(!writes)return;
  if(writes.fingerprintKey.byteLength!==32)throw Error('Invalid secret retry key');
  const key=createSecretKey(writes.fingerprintKey);
  const inputHash=(canonical:string)=>createHmac('sha256',key).update('loom-shared-secret-operation-v1\0').update(canonical).digest('hex');
  operations.register({name:'secrets.set',input:setInput,output:acknowledgement,write:true,recheckPolicy:true,may:owner,inputHash,
    async prepare(input,{viewer}){
      if(viewer.kind!=='member')throw new OperationError('denied','A household owner is required');
      try{await writes.values.set({...input,member:viewer.id});}catch(error){throw writeFailure(error);}
      return true;
    },run(ctx,input,prepared){if(prepared!==true)throw new OperationError('unavailable','Secret write awaits recovery');ctx.changed('secrets',input.name);return {saved:true as const};},
  });
  operations.register({name:'secrets.remove',input:removeInput,output:acknowledgement,write:true,recheckPolicy:true,may:owner,inputHash,
    async prepare(input,{viewer}){
      if(viewer.kind!=='member')throw new OperationError('denied','A household owner is required');
      try{await writes.values.remove({...input,member:viewer.id});}catch(error){throw writeFailure(error);}
      return true;
    },run(ctx,input,prepared){if(prepared!==true)throw new OperationError('unavailable','Secret write awaits recovery');ctx.changed('secrets',input.name);return {saved:true as const};},
  });
}
