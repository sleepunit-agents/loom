import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { members } from './core/data/schema.js';
import type { DataDatabase } from './core/data/database.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { BridgeSettings, bridgeSetting } from './pieces/bridges/settings.js';
export function registerSharedBridgeCommands(operations:Operations,db:DataDatabase,settings:BridgeSettings){
 operations.register({name:'bridges.command',input:bridgeSetting,output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:viewer=>viewer.kind==='member'&&db.select({role:members.role}).from(members).where(eq(members.id,viewer.id)).get()?.role==='owner',
  run(ctx,input){try{settings.change(input);}catch{throw new OperationError('invalid','Bridge change could not complete');}ctx.changed('bridges','settings');return {saved:true as const};},
 });
}
