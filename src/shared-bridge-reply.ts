/** The external body door supplies the actual job; trusted modules use the
 * shared queue directly. A reply cannot choose another job's conversation. */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { bridgeIncoming,bridgeConnections,bridgeSends } from './core/data/schema.js';
import type { conversationBodyScope } from './core/conversations/body-scope.js';
import type { Conversations } from './core/conversations/index.js';
import type { BridgeSends } from './pieces/bridges/sends.js';
import { OperationError,type Operations } from './core/operations/index.js';
export function registerSharedBridgeReply(operations:Operations,db:DataDatabase,sends:BridgeSends,
 conversations:Conversations,current:ReturnType<typeof conversationBodyScope>,effectsAllowed:()=>boolean){
 const target=(viewer:Viewer,incoming:string)=>{
  const found=current(viewer);if(!found||viewer.kind!=='agent'||viewer.id!==found.cv.agent)return;
  const bound={agent:found.cv.agent,job:found.job.id};
  const source=db.select({conversation:bridgeIncoming.conversation,agent:bridgeConnections.agent,platform:bridgeConnections.platform,state:bridgeIncoming.state}).from(bridgeIncoming).innerJoin(bridgeConnections,eq(bridgeIncoming.connection,bridgeConnections.id)).where(eq(bridgeIncoming.id,incoming)).get();
  return source?.conversation===found.cv.id&&source.platform===found.cv.venue&&source.agent===bound.agent&&source.state==='delivered'?{...bound,conversation:found.cv.id}:undefined;
 };
 operations.register({name:'bridges.reply',input:z.object({id:z.uuid(),incoming:z.string().min(1).max(400),text:z.string().min(1).max(100000),model:z.string().min(1).max(200).optional(),outcome:z.enum(['answered','progressed','deferred','failed','none']).optional()}).strict(),output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:(viewer,input)=>!!target(viewer,input.incoming),
  inputHash:(canonical,{actor,input})=>createHash('sha256').update('loom-shared-bridge-reply-receipt-v1\0').update(JSON.stringify([target(actor,input.incoming)??null,canonical])).digest('hex'),
  run(ctx,input){
   const bound=target(ctx.viewer,input.incoming);if(!bound)throw new OperationError('denied','Current bridge body required');
   const existing=db.select({id:bridgeSends.id}).from(bridgeSends).where(eq(bridgeSends.id,input.id)).get();
   try{sends.queue({...input,held:!effectsAllowed()});}catch{throw new OperationError('invalid','Bridge reply could not be queued');}
   if(!existing&&input.model){const turn=conversations.turn({conversation:bound.conversation,kind:'reply',fromKind:'agent',fromId:bound.agent,run:bound.job,model:input.model,outcome:input.outcome});ctx.changed('turns',`${bound.conversation}:${turn.seq}`);ctx.changed('conversations',bound.conversation);}
   ctx.changed('bridge-send',input.id);return {saved:true as const};
  },
 });
}
