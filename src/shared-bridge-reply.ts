/** The external body door supplies the actual job; trusted modules use the
 * shared queue directly. A reply cannot choose another job's conversation. */
import { createHash } from 'node:crypto';
import { and,eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { jobs,bridgeIncoming,bridgeConnections } from './core/data/schema.js';
import type { BridgeSends } from './pieces/bridges/sends.js';
import { OperationError,type Operations } from './core/operations/index.js';
export function registerSharedBridgeReply(operations:Operations,db:DataDatabase,sends:BridgeSends,
 body:(viewer:Viewer)=>Readonly<{agent:string;job:string}>|undefined,effectsAllowed:()=>boolean){
 const target=(viewer:Viewer,incoming:string)=>{
  const bound=body(viewer);if(!bound||viewer.kind!=='agent'||viewer.id!==bound.agent)return;
  const job=db.select({conversation:jobs.conversation}).from(jobs).where(and(eq(jobs.id,bound.job),eq(jobs.agent,bound.agent))).get();
  const source=db.select({conversation:bridgeIncoming.conversation,agent:bridgeConnections.agent,state:bridgeIncoming.state}).from(bridgeIncoming).innerJoin(bridgeConnections,eq(bridgeIncoming.connection,bridgeConnections.id)).where(eq(bridgeIncoming.id,incoming)).get();
  return job?.conversation&&source?.conversation===job.conversation&&source.agent===bound.agent&&source.state==='delivered'?{...bound,conversation:job.conversation}:undefined;
 };
 operations.register({name:'bridges.reply',input:z.object({id:z.uuid(),incoming:z.string().min(1).max(400),text:z.string().min(1).max(100000)}).strict(),output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:(viewer,input)=>!!target(viewer,input.incoming),
  inputHash:(canonical,{actor,input})=>createHash('sha256').update('loom-shared-bridge-reply-receipt-v1\0').update(JSON.stringify([target(actor,input.incoming)??null,canonical])).digest('hex'),
  run(ctx,input){try{sends.queue({...input,held:!effectsAllowed()});}catch{throw new OperationError('invalid','Bridge reply could not be queued');}ctx.changed('bridge-send',input.id);return {saved:true as const};},
 });
}
