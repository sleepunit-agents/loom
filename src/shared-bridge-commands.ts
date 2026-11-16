import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { members, bridgeConnections, bridgeFiles, bridgeIncoming } from './core/data/schema.js';
import type { DataDatabase } from './core/data/database.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { BridgeSettings, bridgeSetting } from './pieces/bridges/settings.js';
export function registerSharedBridgeCommands(operations:Operations,db:DataDatabase,settings:BridgeSettings){
 operations.register({name:'bridges.command',input:bridgeSetting,output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:viewer=>viewer.kind==='member'&&db.select({role:members.role}).from(members).where(eq(members.id,viewer.id)).get()?.role==='owner',
  run(ctx,input){try{settings.change(input);}catch(error){throw new OperationError('invalid',error instanceof Error&&!('code' in error)&&error.message.length>0&&error.message.length<=200?error.message:'Bridge change could not complete');}ctx.changed('bridges','settings');return {saved:true as const};},
 });
 // Slack attachments, kept fourteen days. Without a file id this lists what a
 // message carried; with one it returns that file. Readers: the agent the
 // connection speaks for, and household owners.
 const readable=(viewer:{kind:string;id:string},incoming:string)=>{
  const source=db.select({agent:bridgeConnections.agent}).from(bridgeIncoming).innerJoin(bridgeConnections,eq(bridgeIncoming.connection,bridgeConnections.id)).where(eq(bridgeIncoming.id,incoming)).get();
  return !!source&&(viewer.kind==='agent'?viewer.id===source.agent:viewer.kind==='member'&&db.select({role:members.role}).from(members).where(eq(members.id,viewer.id)).get()?.role==='owner');
 };
 const MAX=8*1024*1024;
 operations.register({name:'bridges.file',write:false,doors:['http'],
  input:z.object({incoming:z.string().min(1).max(400),file:z.string().min(1).max(400).optional()}).strict(),
  output:z.object({files:z.array(z.object({file:z.string(),name:z.string(),bytes:z.number(),fetchedAt:z.string(),contents:z.string().optional()}).strict())}).strict(),
  may:(viewer,input)=>readable(viewer,input.incoming),
  run(_ctx,input){
   const rows=db.select().from(bridgeFiles).where(input.file?and(eq(bridgeFiles.incoming,input.incoming),eq(bridgeFiles.file,input.file)):eq(bridgeFiles.incoming,input.incoming)).orderBy(asc(bridgeFiles.file)).all();
   if(input.file&&!rows.length)throw new OperationError('not-found','That attachment is not kept');
   if(input.file&&rows[0].contents.byteLength>MAX)throw new OperationError('invalid','That attachment is too large to return');
   return{files:rows.map(row=>({file:row.file,name:row.name,bytes:row.contents.byteLength,fetchedAt:row.fetchedAt,...(input.file?{contents:row.contents.toString('base64')}:{})}))};
  },
 });
}
