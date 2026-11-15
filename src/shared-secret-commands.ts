/** One outside command surface; installed code calls the services directly. */
import { createHmac, createSecretKey } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { members, household, secretGrants } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { secretName, secretAgent } from './pieces/secrets/input.js';
import { SecretRequests } from './pieces/secrets/requests.js';
import type { SecretValues } from './pieces/secrets/shared-values.js';
const id = z.string().min(1).max(200);
const minutes = z.number().int().min(1).max(525600);
const answer = z.enum(['ask','auto','never']);
const command = z.discriminatedUnion('action', [
  z.object({action:z.literal('answer'),id,allow:z.boolean(),always:z.boolean()}).strict(),
  z.object({action:z.literal('cancel'),id}).strict(),
  z.object({action:z.literal('revoke'),id}).strict(),
  z.object({action:z.literal('rule'),secret:secretName,answer,minutes,
    agents:z.array(z.object({agent:secretAgent,when:z.enum(['on_request','at_start'])}).strict()).max(1000)}).strict(),
  z.object({action:z.literal('default'),answer}).strict(),
]);
const setInput=z.object({id:z.uuid(),name:secretName,mode:z.enum(['add','replace']),description:z.string().max(4000).optional(),value:z.string().refine(value=>Buffer.byteLength(value)>0&&Buffer.byteLength(value)<=65536)}).strict();
const removeInput=z.object({id:z.uuid(),name:secretName}).strict();
const acknowledgement=z.object({saved:z.literal(true)}).strict();
export function registerSharedSecretCommands(operations:Operations, db:DataDatabase, requests:SecretRequests,
  writes?:{values:SecretValues;fingerprintKey:Uint8Array}) {
  const owner=(viewer:Parameters<Operations['call']>[1])=>viewer.kind==='member'&&db.select().from(members).where(eq(members.id,viewer.id)).get()?.role==='owner';
  operations.register({name:'secrets.command',input:command,output:acknowledgement,write:true,recheckPolicy:true,may:owner,
    run(ctx,input){
      if(ctx.viewer.kind!=='member')throw new OperationError('denied','A household owner is required');
      try {
        switch(input.action){
          case 'answer':requests.answer(input.id,ctx.viewer.id,input.allow,input.always);break;
          case 'cancel':requests.cancel(input.id);break;
          case 'revoke':{
            const grant=db.select().from(secretGrants).where(eq(secretGrants.id,input.id)).get();
            if(!grant)throw Error('Unknown grant');
            if(grant.request)requests.revoke(grant.request);
            else db.delete(secretGrants).where(eq(secretGrants.id,input.id)).run();
            break;
          }
          case 'rule':requests.setRule({secret:input.secret,answer:input.answer,minutes:input.minutes,agents:input.agents});break;
          case 'default':db.insert(household).values({secretsDefault:input.answer}).onConflictDoUpdate({target:household.singleton,set:{secretsDefault:input.answer}}).run();break;
        }
      }catch{throw new OperationError('invalid','Secret change could not complete');}
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
      try{await writes.values.set({...input,member:viewer.id});}catch{throw new OperationError('unavailable','Secret write awaits recovery');}
      return true;
    },run(ctx,input,prepared){if(prepared!==true)throw new OperationError('unavailable','Secret write awaits recovery');ctx.changed('secrets',input.name);return {saved:true as const};},
  });
  operations.register({name:'secrets.remove',input:removeInput,output:acknowledgement,write:true,recheckPolicy:true,may:owner,inputHash,
    async prepare(input,{viewer}){
      if(viewer.kind!=='member')throw new OperationError('denied','A household owner is required');
      try{await writes.values.remove({...input,member:viewer.id});}catch{throw new OperationError('unavailable','Secret write awaits recovery');}
      return true;
    },run(ctx,input,prepared){if(prepared!==true)throw new OperationError('unavailable','Secret write awaits recovery');ctx.changed('secrets',input.name);return {saved:true as const};},
  });
}
