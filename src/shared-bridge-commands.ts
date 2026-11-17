import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { members } from './core/data/schema.js';
import type { DataDatabase } from './core/data/database.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { BridgeSettings } from './pieces/bridges/settings.js';
// Connections, channels and person links are changed by a proposal. What stays here is an owner's
// answer about one reply: release it or dismiss it.
const review=z.object({action:z.literal('review'),id:z.string().min(1).max(200),decision:z.enum(['release','dismiss'])}).strict();
export function registerSharedBridgeCommands(operations:Operations,db:DataDatabase,settings:BridgeSettings){
 operations.register({name:'bridges.command',input:review,output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:viewer=>viewer.kind==='member'&&db.select({role:members.role}).from(members).where(eq(members.id,viewer.id)).get()?.role==='owner',
  run(ctx,input){try{settings.change(input);}catch(error){throw new OperationError('invalid',error instanceof Error&&!('code' in error)&&error.message.length>0&&error.message.length<=200?error.message:'Bridge change could not complete');}ctx.changed('bridges','settings');return {saved:true as const};},
 });
}
