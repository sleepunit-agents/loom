/** What a body, and a member reading over its shoulder, may do with one bridge
 * message: reply to it and read its attachments. The external body door
 * supplies the actual job; trusted modules use the shared queue directly.
 * A reply cannot choose another job's conversation or another job's mail. */
import { createHash } from 'node:crypto';
import { and,asc,eq,getTableColumns } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { bridgeIncoming,bridgeConnections,bridgeFiles,bridgeSends,inbox,inboxRefs } from './core/data/schema.js';
import { bridgeSecretsVisibility } from './core/data/bridge-secrets-visibility.js';
import type { conversationBodyScope } from './core/conversations/body-scope.js';
import type { Conversations } from './core/conversations/index.js';
import type { BridgeSends } from './pieces/bridges/sends.js';
import { OperationError,type Operations } from './core/operations/index.js';
export function registerSharedBridgeReply(operations:Operations,db:DataDatabase,sends:BridgeSends,
 conversations:Conversations,current:ReturnType<typeof conversationBodyScope>,effectsAllowed:()=>boolean){
 const source=(incoming:string)=>db.select({conversation:bridgeIncoming.conversation,agent:bridgeConnections.agent,platform:bridgeConnections.platform,state:bridgeIncoming.state}).from(bridgeIncoming).innerJoin(bridgeConnections,eq(bridgeIncoming.connection,bridgeConnections.id)).where(eq(bridgeIncoming.id,incoming)).get();
 /** The current body's own conversation holds this delivered message. */
 const inConversation=(viewer:Viewer,incoming:string)=>{
  const found=current(viewer);if(!found||viewer.kind!=='agent'||viewer.id!==found.cv.agent)return;
  const message=source(incoming);
  return message?.conversation===found.cv.id&&message.platform===found.cv.venue&&message.agent===found.cv.agent&&message.state==='delivered'?found:undefined;
 };
 /** A reply answers mail this job took. Mail still waiting, or held by another job, is not this body's to answer. */
 const target=(viewer:Viewer,incoming:string)=>{
  const found=inConversation(viewer,incoming);if(!found)return;
  const mail=db.select({id:inbox.id,job:inbox.job,state:inbox.state}).from(inboxRefs).innerJoin(inbox,eq(inbox.id,inboxRefs.item))
   .where(and(eq(inboxRefs.ref,incoming),eq(inbox.toKind,'agent'),eq(inbox.to,found.cv.agent),eq(inbox.conversation,found.cv.id),eq(inbox.source,found.cv.venue as 'discord'|'slack'))).get();
  return mail?.job===found.job.id&&(mail.state==='taken'||mail.state==='done')?{agent:found.cv.agent,job:found.job.id,conversation:found.cv.id,mail:mail.id}:undefined;
 };
 operations.register({name:'bridges.reply',input:z.object({id:z.uuid(),incoming:z.string().min(1).max(400),text:z.string().min(1).max(100000),model:z.string().min(1).max(200),outcome:z.enum(['answered','progressed','deferred','failed','none']).optional()}).strict(),output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:(viewer,input)=>!!target(viewer,input.incoming),
  inputHash:(canonical,{actor,input})=>createHash('sha256').update('loom-shared-bridge-reply-receipt-v1\0').update(JSON.stringify([target(actor,input.incoming)??null,canonical])).digest('hex'),
  run(ctx,input){
   const bound=target(ctx.viewer,input.incoming);if(!bound)throw new OperationError('denied','Current bridge body required');
   const existing=db.select({id:bridgeSends.id}).from(bridgeSends).where(eq(bridgeSends.id,input.id)).get();
   try{sends.queue({...input,held:!effectsAllowed()});}catch{throw new OperationError('invalid','Bridge reply could not be queued');}
   // The reply is the answer to everything this job took in the conversation before it, as a thread reply
   // is (ConversationMail.settle). Settling that mail here, with the reply, means a body that dies before
   // its own confirmation cannot leave answered mail waiting for a second body. Mail that arrived since
   // is still waiting and is not touched.
   for(const item of db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.conversation,bound.conversation),eq(inbox.job,bound.job),eq(inbox.state,'taken'))).all()){
    conversations.confirm(item.id,bound.job);ctx.changed('inbox',item.id);
   }
   if(!existing){const turn=conversations.turn({conversation:bound.conversation,kind:'reply',fromKind:'agent',fromId:bound.agent,run:bound.job,model:input.model,outcome:input.outcome});ctx.changed('turns',`${bound.conversation}:${turn.seq}`);ctx.changed('conversations',bound.conversation);}
   ctx.changed('bridge-send',input.id);return {saved:true as const};
  },
 });
 // Slack attachments, kept fourteen days. Without a file id this lists what a message carried; with
 // one it returns that file. One rule with the message they hang off: a member who may read the
 // message row may read its files, and an agent reads them only as the current body of that conversation.
 const messageRow=getTableColumns(bridgeIncoming);
 const readable=(viewer:Viewer,incoming:string)=>viewer.kind==='agent'?!!inConversation(viewer,incoming)
  :!!db.select({id:bridgeIncoming.id}).from(bridgeIncoming).where(and(eq(bridgeIncoming.id,incoming),bridgeSecretsVisibility(viewer).bridgeIncoming!(messageRow))).get();
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
