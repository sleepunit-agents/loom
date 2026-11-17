/** What a body, and a member reading over its shoulder, may do with one bridge
 * message: reply to it and read its attachments. The external body door
 * supplies the actual job; trusted modules use the shared queue directly.
 * A reply cannot choose another job's conversation or another job's mail. */
import { createHash } from 'node:crypto';
import { and,asc,desc,eq,getTableColumns,inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { bridgeIncoming,bridgeConnections,bridgeFileMessages,bridgeFiles,bridgeSends,inbox,inboxRefs,turns } from './core/data/schema.js';
import { bridgeSecretsVisibility } from './core/data/bridge-secrets-visibility.js';
import type { conversationBodyScope } from './core/conversations/body-scope.js';
import type { Conversations } from './core/conversations/index.js';
import type { BridgeSends } from './pieces/bridges/sends.js';
import { OperationError,type Operations } from './core/operations/index.js';
import { MESSAGE_WORDS_MAX } from './core/conversations/words.js';
/** The most posts loom makes for the mail one job took: what the body says during its run and its reply. */
export const BRIDGE_POSTS_PER_JOB=20;
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
 operations.register({name:'bridges.reply',input:z.object({id:z.uuid(),incoming:z.string().min(1).max(400),text:z.string().min(1).max(MESSAGE_WORDS_MAX),model:z.string().min(1).max(200),outcome:z.enum(turns.outcome.enumValues).optional()}).strict(),output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
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
 // One more message from the body during its run, to the place of the latest bridge message its job took:
 // where its reply will go. It is queued like the reply (sends.ts), so it is split, receipted, held while
 // effects are off and reviewed the same way. It answers nothing: no mail is settled and no reply turn is
 // written, and the body's final answer is still posted as the reply. The body's own step is recorded as
 // an action by the body program, as every tool call is.
 const speaking=(viewer:Viewer)=>{
  const found=current(viewer);if(!found||viewer.kind!=='agent'||viewer.id!==found.cv.agent||(found.cv.venue!=='discord'&&found.cv.venue!=='slack'))return;
  const taken=db.select({incoming:bridgeIncoming.id,connection:bridgeIncoming.connection}).from(inbox).innerJoin(inboxRefs,eq(inboxRefs.item,inbox.id)).innerJoin(bridgeIncoming,eq(bridgeIncoming.id,inboxRefs.ref))
   .where(and(eq(inbox.toKind,'agent'),eq(inbox.to,found.cv.agent),eq(inbox.conversation,found.cv.id),eq(inbox.job,found.job.id),inArray(inbox.state,['taken','done']),eq(inbox.source,found.cv.venue),
    eq(bridgeIncoming.conversation,found.cv.id),eq(bridgeIncoming.state,'delivered'))).orderBy(desc(inbox.seq)).all();
  const latest=taken[0],connection=latest&&db.select({agent:bridgeConnections.agent,platform:bridgeConnections.platform}).from(bridgeConnections).where(eq(bridgeConnections.id,latest.connection)).get();
  return latest&&connection?.agent===found.cv.agent&&connection.platform===found.cv.venue?{job:found.job.id,incoming:latest.incoming,took:taken.map(row=>row.incoming)}:undefined;
 };
 operations.register({name:'bridges.say',input:z.object({id:z.uuid(),text:z.string().min(1).max(MESSAGE_WORDS_MAX)}).strict(),output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:viewer=>!!speaking(viewer),
  inputHash:(canonical,{actor})=>createHash('sha256').update('loom-shared-bridge-say-receipt-v1\0').update(JSON.stringify([speaking(actor)?.job??null,canonical])).digest('hex'),
  run(ctx,input){
   const bound=speaking(ctx.viewer);if(!bound)throw new OperationError('denied','Current bridge body required');
   // Counted over everything posted for what this job took, the reply included, so a body that loops cannot flood a channel.
   const said=db.select({id:bridgeSends.id}).from(bridgeSends).where(inArray(bridgeSends.incoming,bound.took)).all();
   if(!said.some(send=>send.id===input.id)&&said.length>=BRIDGE_POSTS_PER_JOB)throw new OperationError('conflict',`A job posts at most ${BRIDGE_POSTS_PER_JOB} messages for the mail it took`);
   try{sends.queue({id:input.id,incoming:bound.incoming,text:input.text,held:!effectsAllowed()});}catch{throw new OperationError('invalid','Bridge message could not be queued');}
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
   // By the message's links: a file shared in two messages is kept once and listed under both.
   const rows=db.select(getTableColumns(bridgeFiles)).from(bridgeFiles)
    .innerJoin(bridgeFileMessages,and(eq(bridgeFileMessages.connection,bridgeFiles.connection),eq(bridgeFileMessages.file,bridgeFiles.file)))
    .where(and(eq(bridgeFileMessages.incoming,input.incoming),input.file?eq(bridgeFiles.file,input.file):undefined)).orderBy(asc(bridgeFiles.file)).all();
   if(input.file&&!rows.length)throw new OperationError('not-found','That attachment is not kept');
   if(input.file&&rows[0].contents.byteLength>MAX)throw new OperationError('invalid','That attachment is too large to return');
   return{files:rows.map(row=>({file:row.file,name:row.name,bytes:row.contents.byteLength,fetchedAt:row.fetchedAt,...(input.file?{contents:row.contents.toString('base64')}:{})}))};
  },
 });
}
