/** What a body, and a member reading over its shoulder, may do with one bridge
 * message: reply to it and read its attachments. The external body door
 * supplies the actual job; trusted modules use the shared queue directly.
 * A reply cannot choose another job's conversation or another job's mail. */
import { createHash } from 'node:crypto';
import { and,asc,desc,eq,getTableColumns,gte,inArray,isNull } from 'drizzle-orm';
import { channelPlace,isBridgeVenue,jobHeld,jobWord,placeAddress,placeClosed,ruleChannel } from './shared-place-mail.js';
import { channelTarget } from './core/conversations/channel-target.js';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { bridgeChannels,bridgeIncoming,bridgeConnections,bridgeFileMessages,bridgeFiles,bridgeSends,inbox,inboxRefs,turns } from './core/data/schema.js';
import { householdOwners,sharedSharing } from './shared-sharing.js';
import { membersWithAgent } from './policy.js';
import { bridgeSecretsVisibility } from './core/data/bridge-secrets-visibility.js';
import type { conversationBodyScope } from './core/conversations/body-scope.js';
import type { Conversations } from './core/conversations/index.js';
import { followBridgeReply } from './pieces/bridges/presence.js';
import { SEND_FILES,SEND_FILES_BYTES } from './pieces/bridges/send-file-limit.js';
import type { SharedBridges } from './pieces/bridges/shared-daemon.js';
import { BODY_ATTACHMENTS, BODY_ATTACHMENT_BYTES, discordFileOutcome } from './pieces/bridges/attachment-limits.js';
import { HANDED_FILE_BYTES } from './pieces/bridges/files.js';
import { OperationError,type Operations } from './core/operations/index.js';
import { MESSAGE_WORDS_MAX } from './core/conversations/words.js';
/** The most posts loom makes for the mail one job took: what the body says during its run and its reply. */
export const BRIDGE_POSTS_PER_JOB=20;
/** Why a post from a job on anybody else's word carries no file. */
export const NO_FILES_REFUSAL='This job is not working for the agent\'s owners: it runs with loom\'s tools only, and its posts carry no files.';
export function registerSharedBridgeReply(operations:Operations,db:DataDatabase,daemon:Pick<SharedBridges,'sends'|'prepareDiscordFile'|'files'>,
 conversations:Conversations,current:ReturnType<typeof conversationBodyScope>,effectsAllowed:()=>boolean){
 const sends=daemon.sends;
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
 /** A job whose mail in its bridge conversation is not a message from the bridge (a trigger's firing, a note
  * from another body of the agent) answers by a post in the conversation itself: there is no message to
  * answer. Where that is comes from the conversation's place (shared-place-mail.ts), and whether anything may
  * be posted there now from the rules a message arriving there is admitted by (placeClosed): `closed` says why not. */
 const placed=(viewer:Viewer)=>{
  const found=current(viewer);if(!found||viewer.kind!=='agent'||viewer.id!==found.cv.agent||!isBridgeVenue(found.cv.venue))return;
  const mail=db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.toKind,'agent'),eq(inbox.to,found.cv.agent),eq(inbox.conversation,found.cv.id),eq(inbox.job,found.job.id),inArray(inbox.state,['taken','done']),inArray(inbox.source,['trigger','handoff']))).all();
  const at=mail.length?placeAddress(db,found.cv):undefined;
  return at?{agent:found.cv.agent,job:found.job.id,conversation:found.cv.id,at:{conversation:found.cv.id,connection:at.connection,channel:at.channel,thread:at.thread},since:found.job.claimedAt??found.job.queuedAt,closed:placeClosed(db,found.cv)}:undefined;
 };
 /** Everything posted for what a job took: answers to its messages, and its posts in the conversation since it was claimed. */
 const posted=(took:readonly string[],place?:{conversation:string;since:string})=>[
  ...(took.length?db.select({id:bridgeSends.id}).from(bridgeSends).where(inArray(bridgeSends.incoming,[...took])).all():[]),
  ...(place?db.select({id:bridgeSends.id}).from(bridgeSends).where(and(isNull(bridgeSends.incoming),eq(bridgeSends.conversation,place.conversation),gte(bridgeSends.createdAt,place.since))).all():[])];
 const replyJobs=new WeakMap<object,string>();
 operations.register({name:'bridges.reply',input:z.object({id:z.uuid(),incoming:z.string().min(1).max(400).optional(),text:z.string().min(1).max(MESSAGE_WORDS_MAX),model:z.string().min(1).max(200),outcome:z.enum(turns.outcome.enumValues).optional()}).strict(),output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:(viewer,input)=>!!(input.incoming?target(viewer,input.incoming):placed(viewer)),
  inputHash:(canonical,{actor,input})=>createHash('sha256').update('loom-shared-bridge-reply-receipt-v1\0').update(JSON.stringify([input.incoming?target(actor,input.incoming)??null:placed(actor)?.job??null,canonical])).digest('hex'),
  run(ctx,input){
   const place=input.incoming?undefined:placed(ctx.viewer),bound=input.incoming?target(ctx.viewer,input.incoming):place;if(!bound)throw new OperationError('denied','Current bridge body required');
   if(place?.closed)throw new OperationError('invalid',`Nothing can be posted there: ${place.closed}`);
   const existing=db.select({id:bridgeSends.id}).from(bridgeSends).where(eq(bridgeSends.id,input.id)).get();
   try{sends.queue({id:input.id,text:input.text,held:!effectsAllowed(),...(input.incoming?{incoming:input.incoming}:{at:place!.at})});}catch{throw new OperationError('invalid','Bridge reply could not be queued');}
   // The reply is the answer to everything this job took in the conversation before it, as a thread reply
   // is (ConversationMail.settle). Settling that mail here, with the reply, means a body that dies before
   // its own confirmation cannot leave answered mail waiting for a second body. Mail that arrived since
   // is still waiting and is not touched.
   for(const item of db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.conversation,bound.conversation),eq(inbox.job,bound.job),eq(inbox.state,'taken'))).all()){
    conversations.confirm(item.id,bound.job);ctx.changed('inbox',item.id);
   }
   if(!existing){const turn=conversations.turn({conversation:bound.conversation,kind:'reply',fromKind:'agent',fromId:bound.agent,run:bound.job,model:input.model,outcome:input.outcome});ctx.changed('turns',`${bound.conversation}:${turn.seq}`);ctx.changed('conversations',bound.conversation);}
   if(current(ctx.viewer)?.cv.venue==='discord')replyJobs.set(input,bound.job);
   ctx.changed('bridge-send',input.id);return {saved:true as const};
  },
  after:(input)=>{const job=replyJobs.get(input);if(job)followBridgeReply(db,input.id,job);},
 });
 // The brief the channel's rule names for the bodies of its conversations (settings.ts): the name of a role
 // page of the agent's. The body reads the page from its own Memory. The rule is found as every rule about
 // a place is, by the conversation's place and its ruleChannel (shared-place-mail.ts), so a conversation
 // nobody has spoken in (a note or a firing opened it) has its channel's brief too. A direct conversation,
 // and a channel with no rule or no brief, has none.
 const briefOf=(viewer:Viewer)=>{
  const found=current(viewer);if(!found||viewer.kind!=='agent'||viewer.id!==found.cv.agent||!isBridgeVenue(found.cv.venue))return;
  const at=placeAddress(db,found.cv);
  if(!at)return{agent:found.cv.agent,brief:null,channel:null};
  const channel=ruleChannel(db,found.cv,at.channel),platform=found.cv.venue;
  const rule=at.direct?undefined:db.select({brief:bridgeChannels.brief}).from(bridgeChannels).where(and(eq(bridgeChannels.platform,platform),eq(bridgeChannels.workspace,at.workspace),eq(bridgeChannels.channel,channel))).get();
  return{agent:found.cv.agent,brief:rule?.brief??null,channel,platform,workspace:at.workspace};
 };
 operations.register({name:'bridges.brief',write:false,doors:['http'],input:z.object({}).strict(),output:z.object({brief:z.string().nullable()}).strict(),
  may:viewer=>!!briefOf(viewer),
  run(ctx){const found=briefOf(ctx.viewer);if(!found)throw new OperationError('denied','Current bridge body required');return{brief:found.brief};},
 });
 // The body found no such page. The work goes on without the brief; the agent's owners are told, once for
 // a channel and brief, so a rule that names a page nobody wrote does not stay unnoticed.
 operations.register({name:'bridges.briefMissing',write:true,recheckPolicy:true,doors:['http'],input:z.object({}).strict(),output:z.object({saved:z.literal(true)}).strict(),
  may:viewer=>!!briefOf(viewer)?.brief,
  run(ctx){
   const found=briefOf(ctx.viewer);if(!found?.brief)throw new OperationError('denied','Current bridge body with a brief required');
   const key=`brief-missing:${JSON.stringify([found.agent,found.platform,found.workspace,found.channel,found.brief])}`;
   let to=membersWithAgent(found.agent,sharedSharing(db));if(!to.length)to=householdOwners(db);
   for(const member of to){
    if(db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.toKind,'person'),eq(inbox.to,member),eq(inbox.source,'notice'),eq(inbox.sourceId,key))).get())continue;
    const item=conversations.send({toKind:'person',to:member,member,source:'notice',sourceId:key,fromKind:'unknown',
     words:`The rule for ${found.platform} channel ${found.channel} names the brief "${found.brief}", and ${found.agent} has no role page of that name. Its work there goes on without it.`,refs:[found.agent]});
    ctx.changed('inbox',item.id);
   }
   return{saved:true as const};
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
  // With no message from the bridge among its mail, the job speaks where its reply will go: in the conversation itself.
  const place=placed(viewer);
  if(!latest)return place?{job:place.job,incoming:undefined,at:place.at,took:[] as string[],place}:undefined;
  return connection?.agent===found.cv.agent&&connection.platform===found.cv.venue?{job:found.job.id,incoming:latest.incoming,at:undefined,took:taken.map(row=>row.incoming),place}:undefined;
 };
 // A post may carry files, on Discord: their bytes are kept with the post until it is settled and go out with
 // its last part. The body program reads them from the body's own working area (runtime/body-files.ts);
 // what arrives here is a name and bytes, bounded by SEND_FILES and SEND_FILES_BYTES.
 operations.register({name:'bridges.say',input:z.object({id:z.uuid(),text:z.string().min(1).max(MESSAGE_WORDS_MAX),
   files:z.array(z.object({name:z.string().min(1).max(200),contents:z.base64().min(1)}).strict()).min(1).max(SEND_FILES).optional()}).strict(),output:z.object({saved:z.literal(true)}).strict(),write:true,recheckPolicy:true,
  may:viewer=>!!speaking(viewer),
  inputHash:(canonical,{actor})=>createHash('sha256').update('loom-shared-bridge-say-receipt-v1\0').update(JSON.stringify([speaking(actor)?.job??null,canonical])).digest('hex'),
  run(ctx,input){
   const bound=speaking(ctx.viewer);if(!bound)throw new OperationError('denied','Current bridge body required');
   if(!bound.incoming&&bound.place?.closed)throw new OperationError('invalid',`Nothing can be posted there: ${bound.place.closed}`);
   // A job on anybody else's word has no file tools (policy.ts, loomToolsOnly; runtime/harness-traits.ts, hasFileTools),
   // so its body program reads no file for a post. The door says the same, for a body program that sent bytes anyway.
   if(input.files){const found=current(ctx.viewer);if(!found||jobHeld(db,found.job))throw new OperationError('denied',NO_FILES_REFUSAL);}
   // Counted over everything posted for what this job took, the reply included, so a body that loops cannot flood a channel.
   const said=posted(bound.took,bound.place&&{conversation:bound.place.conversation,since:bound.place.since});
   if(!said.some(send=>send.id===input.id)&&said.length>=BRIDGE_POSTS_PER_JOB)throw new OperationError('conflict',`A job posts at most ${BRIDGE_POSTS_PER_JOB} messages for the mail it took`);
   const files=(input.files??[]).map(file=>({name:file.name,contents:Buffer.from(file.contents,'base64')}));
   try{sends.queue({id:input.id,text:input.text,held:!effectsAllowed(),...(files.length?{files}:{}),...(bound.incoming?{incoming:bound.incoming}:{at:bound.at!})});}catch{throw new OperationError('invalid',files.length?`Bridge message could not be queued: files are posted on Discord only, at most ${SEND_FILES} and ${SEND_FILES_BYTES} bytes together`:'Bridge message could not be queued');}
   finally{for(const file of files)file.contents.fill(0);}
   ctx.changed('bridge-send',input.id);return {saved:true as const};
  },
 });
 // The agent's own work (a lane: a job with no person behind any of its mail, shared-place-mail.ts jobWord)
 // posts a finished text straight to a channel the agent has a rule for, with no second body run: the
 // daily post. Through the same queue, so it is split, receipted, held while effects are off and reviewed
 // like every post; the agent's turn is written in the conversation there. A job with anybody behind it
 // hands a note instead (conversation.handoff), and the body there says it.
 const ownWork=(viewer:Viewer)=>{const found=current(viewer);return found&&viewer.kind==='agent'&&viewer.id===found.cv.agent&&jobWord(db,found.job).woke==='own'?found:undefined;};
 operations.register({name:'bridges.post',input:z.object({id:z.uuid(),to:channelTarget,
   text:z.string().min(1).max(MESSAGE_WORDS_MAX),model:z.string().min(1).max(200)}).strict(),output:z.object({saved:z.literal(true),conversation:z.string()}).strict(),write:true,recheckPolicy:true,
  may:viewer=>!!ownWork(viewer),
  inputHash:(canonical,{actor})=>createHash('sha256').update('loom-shared-bridge-post-receipt-v1\0').update(JSON.stringify([ownWork(actor)?.job.id??null,canonical])).digest('hex'),
  run(ctx,input){
   const found=ownWork(ctx.viewer);if(!found)throw new OperationError('denied','Only an agent\'s own work posts straight to a channel');
   const agent=found.cv.agent;
   const {place}=channelPlace(db,agent,input.to,'post');
   const cv=conversations.open({agent,venue:input.to.platform,place,label:input.to.thread??input.to.channel}),at=placeAddress(db,cv)!;
   const existing=db.select({id:bridgeSends.id}).from(bridgeSends).where(eq(bridgeSends.id,input.id)).get();
   // Its own posts there: each wrote a reply turn of this job's in that conversation.
   const said=db.select({seq:turns.seq}).from(turns).where(and(eq(turns.conversation,cv.id),eq(turns.run,found.job.id),eq(turns.kind,'reply'))).all();
   if(!existing&&said.length>=BRIDGE_POSTS_PER_JOB)throw new OperationError('conflict',`A job posts at most ${BRIDGE_POSTS_PER_JOB} messages to one place`);
   try{sends.queue({id:input.id,text:input.text,held:!effectsAllowed(),at:{conversation:cv.id,connection:at.connection,channel:at.channel,thread:at.thread}});}catch{throw new OperationError('invalid','Bridge message could not be queued');}
   if(!existing){const turn=conversations.turn({conversation:cv.id,kind:'reply',fromKind:'agent',fromId:agent,run:found.job.id,model:input.model,outcome:'progressed'});ctx.changed('turns',`${cv.id}:${turn.seq}`);ctx.changed('conversations',cv.id);}
   ctx.changed('bridge-send',input.id);return {saved:true as const,conversation:cv.id};
  },
 });
 // Bridge attachments, kept fourteen days. Without a file id this lists what a message carried; with
 // one it returns that file. One rule with the message they hang off: a member who may read the
 // message row may read its files. Discord bodies additionally need an unrestricted job.
 const messageRow=getTableColumns(bridgeIncoming);
 const fileBody=(viewer:Viewer,incoming:string)=>{
  const found=inConversation(viewer,incoming);
  return found&&(found.cv.venue!=='discord'||!jobHeld(db,found.job))?found:undefined;
 };
 const canPrepare=(viewer:Viewer,incoming:string)=>fileBody(viewer,incoming)?.cv.venue==='discord'&&!!target(viewer,incoming)&&effectsAllowed();
 operations.register({name:'bridges.prepareFile',write:true,doors:['http'],
  input:z.object({incoming:z.string().min(1).max(400),index:z.int().min(0).max(BODY_ATTACHMENTS-1),maxBytes:z.int().nonnegative().max(BODY_ATTACHMENT_BYTES)}).strict(),
  output:discordFileOutcome,
  may:(viewer,input)=>canPrepare(viewer,input.incoming),
  prepare:(input,{viewer})=>daemon.prepareDiscordFile(input.incoming,()=>canPrepare(viewer,input.incoming),input.index,input.maxBytes),
  run:(_ctx,_input,prepared)=>(prepared as Awaited<ReturnType<SharedBridges['prepareDiscordFile']>>)(),
  after:(_input,result)=>{if(result.ok)daemon.files.published();},
 });
 const readable=(viewer:Viewer,incoming:string)=>viewer.kind==='agent'?!!fileBody(viewer,incoming)
  :!!db.select({id:bridgeIncoming.id}).from(bridgeIncoming).where(and(eq(bridgeIncoming.id,incoming),bridgeSecretsVisibility(viewer).bridgeIncoming!(messageRow))).get();
 const MAX=HANDED_FILE_BYTES;
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
