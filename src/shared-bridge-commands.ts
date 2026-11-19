import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { holds, rules, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { bridgeConnections, bridgeIncoming, bridgeSends, conversations } from './core/data/schema.js';
import type { DataDatabase } from './core/data/database.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { BridgeSettings, bridgeReview } from './pieces/bridges/settings.js';
// Connections, channels and person links are changed by a proposal. What stays here is a person's
// answer about one reply: release it or dismiss it. Who may give it is policy.ts's (rules.reviewsReply).
/** May this viewer review this reply? Asked of the stored reply and what it answers. An unknown reply is nobody's. */
export function mayReviewReply(db:DataDatabase,viewer:Viewer,id:string):boolean{
 const send=db.select().from(bridgeSends).where(eq(bridgeSends.id,id)).get();
 return !!send&&holds(rules.reviewsReply,viewer,send,sharedSharing(db),(table,parent)=>
  table==='bridgeIncoming'?db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id,parent)).get()
  :table==='conversations'?db.select().from(conversations).where(eq(conversations.id,parent)).get()
  :table==='bridgeConnections'?db.select().from(bridgeConnections).where(eq(bridgeConnections.id,parent)).get():undefined);
}
export function registerSharedBridgeCommands(operations:Operations,db:DataDatabase,settings:BridgeSettings){
 operations.register({name:'bridges.command',input:bridgeReview,output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:(viewer,input)=>mayReviewReply(db,viewer,input.id),
  run(ctx,input){try{settings.change(input);}catch(error){throw new OperationError('invalid',error instanceof Error&&!('code' in error)&&error.message.length>0&&error.message.length<=200?error.message:'Bridge change could not complete');}ctx.changed('bridges','settings');return {saved:true as const};},
 });
}
