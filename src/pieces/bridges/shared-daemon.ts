import { createHash } from 'node:crypto';
import { liveDiscordReceipts } from './discord-receipts.js';
import { slackFiles, type SlackFilesPermit } from './slack-files.js';
import { BridgeSends, STOPPED_LINE, type SendTransport } from './sends.js';
import { bridgeReplyApi } from './reply-api.js';
import { BridgeReplyNotSent } from './outbound.js';
/** Shared-model bridge composition. Socket receipt precedes platform ACK; bounded
 * asynchronous metadata/drain work follows separately. Installed parts share the
 * database directly; all outside permissions live at their respective doors. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { refreshConversationLabel } from '../../core/conversations/index.js';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeIncoming, inbox, inboxRefs, jobs, secretChanges } from '../../core/data/schema.js';
import type { DataWrites } from '../../core/data/writes.js';
import type { SecretValueSource } from '../secrets/role.js';
import type { HolderGeneration } from '../secrets/role.js';
import { bridgeCredentials } from './credentials.js';
import { sharedBridgeSecretUse } from './shared-secret-use.js';
import { conversationPlace, discordPlace } from './place.js';
import { BridgeChannels } from './channels.js';
import { BridgeReceiver } from './receiver.js';
import { STOP_WORD, type StopJob } from './incoming.js';
import { BridgePresence, bridgePresenceApi } from './presence.js';
import { bridgeAuthentication } from './authentication.js';
import { bridgeChannelApi } from './channel-api.js';
import { discordGateway } from './discord-gateway.js';
import { bridgeSlackSocket } from './slack-socket.js';
import { BridgeFiles } from './files.js';
import { discordFiles, fetchDiscordFiles, DISCORD_FILES_PER_MESSAGE } from './discord-files.js';
import { parseIncomingId } from './keys.js';
import { originalDiscordAttachments } from './normalize.js';
import type { DiscordFileOutcome } from './attachment-limits.js';
import { bridgeFiles } from '../../core/data/schema.js';
type Connection=typeof bridgeConnections.$inferSelect;
export interface SharedBridgeOptions {
 db:DataDatabase;clock:Clock;writes:DataWrites;
 source:SecretValueSource&HolderGeneration;
 effectsAllowed():boolean;
 directAllowed?:SendTransport['directAllowed'];
 changed():void;
 inboxCommitted?(ids:readonly string[]):void;
 /** The runtime's Stop, for the stop word (incoming.ts): ends the job, on that member's word, in the
  * caller's transaction. Without it the stop word is an ordinary message. */
 stopJob?:StopJob;
 /** Told of the jobs a stop word ended, after the pass that ended them has committed. */
 jobsEnded?(ids:readonly string[]):void;
 reportError(error:Error):void;
 request?:typeof fetch;
 discord?:typeof discordGateway;
 slack?:typeof bridgeSlackSocket;
}
type Life={connection:Connection;key:string;generation:string;stamp:number;active:boolean;authenticated:boolean;
 secrets:ReturnType<typeof sharedBridgeSecretUse>;presence?:ReturnType<typeof bridgePresenceApi>;channels?:ReturnType<BridgeChannels['bind']>;
 rolesAt?:number;roleRevision?:number;parentLookups?:Map<string, Promise<string | undefined>>;transport?:{close():Promise<void>};pumping?:Promise<void>;retry?:()=>void;again?:boolean};
const configuration=(row:Connection)=>JSON.stringify([row.id,row.platform,row.workspace,row.botUser,row.agent,row.tokenSecret,row.appSecret,row.enabled]);
export class SharedBridges {
 private closed=false;
 private readonly channels=new BridgeChannels();
 private readonly receiver:BridgeReceiver;
 readonly files:BridgeFiles;
 readonly sends:BridgeSends;
 private readonly credentials;
 /** A reaction on a taken Discord message and typing while its job works (presence.ts). Best effort. */
 private readonly presence:BridgePresence;
 private readonly lives=new Map<string,Life>();
 /** Channels whose details could not be classified, so each is reported once. */
 private readonly unclassified=new Set<string>();
 private readonly active=new Set<Promise<unknown>>();
 private syncing?:Promise<void>;
 private settingsKey='';
 private cancelRetry?:()=>void;
 private readonly unobserve:()=>void;
 private closing?:Promise<void>;
 constructor(private readonly options:SharedBridgeOptions){
  const sender=(row:Connection)=>{const life=this.lives.get(row.id);return life&&this.current(life)&&configuration(row)===life.key?life:undefined;};
  this.sends=new BridgeSends(options.db,{ready:row=>!!sender(row),directAllowed:options.directAllowed,post:async(row,address,text,files,permitted)=>{
   // No lifetime to send through: nothing has left, so the reply waits for the next one.
   const life=sender(row);if(!life)throw new BridgeReplyNotSent(true);
   return bridgeReplyApi({platform:row.platform,tokenSecret:row.tokenSecret,secrets:life.secrets,clock:options.clock,current:()=>this.current(life)&&(!permitted||permitted()),request:options.request}).post(address,text,files);
  }},()=>new Date(options.clock.now()).toISOString(),()=>{},write=>{
   const result=options.writes.run(write);for(const _error of result.notificationErrors)this.report();return result.value;
  });
  // What is given up on after a day was never delivered. Nothing can bring it back, so it is at least reported.
  this.receiver=new BridgeReceiver(options.db,options.clock,this.channels,lost=>{
   try{options.reportError(new Error(`${lost.events} received bridge event(s) were never read and have expired; ${lost.held} held message(s) could no longer be delivered and were dropped`));}catch{ /* reporting never retries effects */ }
   if(lost.held)this.notify();
  },options.stopJob);
  this.presence=new BridgePresence(options.db,options.clock,id=>{
   const life=this.lives.get(id);
   if(!life||!life.authenticated||!this.current(life))return undefined;
   return life.presence??=bridgePresenceApi({resume:()=>this.track(this.presence.show()),clock:options.clock,tokenSecret:life.connection.tokenSecret,secrets:life.secrets,current:()=>this.current(life),request:options.request});
  });
  this.files=new BridgeFiles(options.db,options.clock,()=>this.notify());
  this.credentials=bridgeCredentials(options.source,options.clock);
  this.unobserve=this.credentials.observe(()=>{void this.reconcile();});
 }
 private report(){try{this.options.reportError(new Error('Bridge processing unavailable'));}catch{ /* reporting never retries effects */ }}
 private track<T>(work:Promise<T>):Promise<T>{this.active.add(work);void work.finally(()=>this.active.delete(work)).catch(()=>{});return work;}
 private notify(){if(this.closed)return;try{this.options.changed();}catch{this.report();}}
 private current(life:Life):boolean{
  if(this.closed||!life.active||!this.options.effectsAllowed())return false;
  const generation=this.credentials.current();
  // Its own secrets must be as they were when it started; then it follows the holder to whatever generation it is on.
  if(!generation||!this.accept(life,generation))return false;
  const row=this.options.db.select().from(bridgeConnections).where(eq(bridgeConnections.id,life.connection.id)).get();
  return !!row&&row.enabled&&configuration(row)===life.key;
 }
 /** The newest change to any of the secrets a connection uses. The holder has one generation for every
  * secret, so it moves when any secret is written; this says whether one of ours was. */
 private stamp(row:Connection):number{
  const names=[row.tokenSecret,...(row.appSecret?[row.appSecret]:[])];
  return this.options.db.select({id:sql<number>`coalesce(max(rowid),0)`}).from(secretChanges).where(inArray(secretChanges.secret,names)).get()!.id;
 }
 /** Carry a lifetime over to another holder generation when none of its own secrets changed. */
 private accept(life:Life,generation:string):boolean{
  if(this.stamp(life.connection)!==life.stamp)return false;
  life.generation=generation;return true;
 }
 private state(id:string,state:Connection['state']){
  if(this.closed)return;
  const before=this.options.db.select({state:bridgeConnections.state}).from(bridgeConnections).where(eq(bridgeConnections.id,id)).get();
  if(!before||before.state===state)return;
  const result=this.options.writes.run(()=>this.options.db.update(bridgeConnections)
   .set({state,stateAt:new Date(this.options.clock.now()).toISOString()})
   .where(and(eq(bridgeConnections.id,id),sql`${bridgeConnections.state} <> ${state}`)).run());
  for(const _error of result.notificationErrors)this.report();
 }
 private retire(life:Life){
  life.active=false;life.presence?.close();life.retry?.();life.channels?.close();life.secrets.close();
  if(this.lives.get(life.connection.id)===life)this.lives.delete(life.connection.id);
  if(life.transport)this.track(Promise.resolve().then(()=>life.transport!.close()));
 }
 private configurationSnapshot(){
  const rows=this.options.db.select().from(bridgeConnections).orderBy(asc(bridgeConnections.id)).all();
  return{rows,key:JSON.stringify(rows.map(configuration))};
 }
 /** Root invokes after committed config/rule/link edits. Known value writes may
  * retire credentials immediately, without waiting for the metadata poll. */
 changed(credentials=false){
  if(this.closed)return;
  let retired=false;
  // A secret write retires only the connections that use that secret: current() compares each one's own stamp.
  for(const life of this.lives.values())if(!this.current(life)){this.retire(life);retired=true;}
  // State publications reenter Root's write observer. Only changed input
  // settings or credentials may restart reconciliation; retrying our own
  // backoff state would starve the generation poll with microtasks.
  const {key}=this.configurationSnapshot();
  if(credentials||retired||key!==this.settingsKey)void this.reconcile();
  else for(const life of this.lives.values())this.pump(life);
  this.track(this.sends.flush());
  // A body taking mail, a reply settling it and a job ending are all committed writes.
  this.track(this.presence.show());
 }
 async ready(){await this.credentials.ready();await this.reconcile();}
 reconcile():Promise<void>{
  if(this.closed)return Promise.resolve();
  if(this.syncing)return this.syncing;
  this.cancelRetry?.();
  this.syncing=this.track(Promise.resolve().then(async()=>{
   if(this.closed)return;
   for(const life of this.lives.values())if(!this.current(life))this.retire(life);
   const generation=this.credentials.current();
   const {rows,key}=this.configurationSnapshot();
   this.settingsKey=key;
   for(const row of rows){
    if(!row.enabled||!generation||!this.options.effectsAllowed()){
     this.state(row.id,row.enabled?'backoff':'disconnected');continue;
    }
    const old=this.lives.get(row.id);
    if(old){this.pump(old);if(old.authenticated&&old.rolesAt!==undefined&&old.rolesAt<=this.options.clock.now())this.track(this.readRoles(old));continue;}
    const life={} as Life;
    // The generation and stamp are set first: the secret reader reads them as it is made.
    Object.assign(life,{connection:row,key:configuration(row),generation,stamp:this.stamp(row),active:true,authenticated:false});
    Object.assign(life,{
     secrets:sharedBridgeSecretUse({source:this.options.source,clock:this.options.clock,generation:()=>life.generation,accept:live=>life.active&&this.accept(life,live),
      names:[row.tokenSecret,...(row.appSecret?[row.appSecret]:[])],current:()=>this.current(life),
      invalidate:()=>{const valid=this.current(life);this.retire(life);if(valid){try{this.state(row.id,'backoff');}catch{this.report();}}}})});
    this.lives.set(row.id,life);this.state(row.id,'connecting');
    this.track(this.connect(life));
   }
   // Each pass also retries replies that were claimed but could not be sent, and keeps typing showing.
   if(!this.closed){this.track(this.sends.flush());this.track(this.presence.show());}
  }).catch(()=>this.report()).finally(()=>{
   this.syncing=undefined;
   if(!this.closed)this.cancelRetry=this.options.clock.at(this.options.clock.now()+5000,()=>{void this.reconcile();});
  }));
  return this.syncing;
 }
 private async readRoles(life:Life){
  const row=life.connection,current=()=>this.current(life),revision=life.roleRevision;
  life.rolesAt=undefined;
  const roles=await bridgeChannelApi({platform:row.platform,workspace:row.workspace,tokenSecret:row.tokenSecret,secrets:life.secrets,clock:this.options.clock,current,request:this.options.request}).roles();
  if(!current())return;
  if(roles&&revision===life.roleRevision){try{life.channels!.roles(roles);if(life.authenticated)this.queuePump(life);return;}catch{this.report();}}
  life.rolesAt=this.options.clock.now()+5000;
 }
 private async connect(life:Life){
  const row=life.connection,current=()=>this.current(life);
  try{
   const proof=await bridgeAuthentication({platform:row.platform,bot:row.botUser,workspace:row.workspace,tokenSecret:row.tokenSecret,
    secrets:life.secrets,clock:this.options.clock,current,request:this.options.request}).authenticate();
   if(!current()||!proof)throw Error();
   life.channels=this.channels.bind(row.id,{platform:row.platform,workspace:row.workspace});
   if(row.platform==='discord')await this.readRoles(life);
   if(!current())throw Error();
   life.authenticated=true;
   const state=(value:Connection['state'])=>{if(current()){this.state(row.id,value);if(value==='connected')this.track(this.sends.flush());}};
   if(row.platform==='discord'){
    // A resume cursor outlives a restart, a pause and a lost socket, but not the credential it was made
    // under: the cursor is stored under this identity and a lifetime with another finds none.
    const identity=createHash('sha256').update(JSON.stringify([row.id,row.platform,row.workspace,row.agent,row.botUser,row.tokenSecret,String(life.stamp)])).digest('hex');
    const receipts=liveDiscordReceipts(this.receiver,row.id,identity,current);
    if(!current())throw Error();
    life.transport=(this.options.discord??discordGateway)({bot:row.botUser,tokenSecret:row.tokenSecret,secrets:life.secrets,clock:this.options.clock,beforeConnect:current,state,
     load:()=>{if(!current())throw Error();return receipts.checkpoint();},
     reset:async()=>{if(!current())throw Error();receipts.reset();},
     commit:async(event,checkpoint,raw)=>{if(!current())throw Error();receipts.retain(raw,checkpoint);if(!current())throw Error();
      if(event.type==='GUILD_CREATE'&&life.channels!.guildRoles(event.data)){life.roleRevision=(life.roleRevision??0)+1;life.rolesAt=undefined;}
      if(event.type.startsWith('GUILD_ROLE_')){life.roleRevision=(life.roleRevision??0)+1;life.channels!.roleEvent(event.type,event.data);}
      this.queuePump(life);},
    });
   }else{
    if(!row.appSecret||!proof.app)throw Error();
    life.transport=(this.options.slack??bridgeSlackSocket)({app:proof.app,appSecret:row.appSecret,secrets:life.secrets,clock:this.options.clock,beforeConnect:current,state,request:this.options.request,
     receive:async(_payload,raw)=>{if(!current())throw Error();this.receiver.slack(row.id,raw);if(!current())throw Error();this.queuePump(life);},
    });
   }
   if(!current()){await life.transport.close();return;}
   this.pump(life);
  }catch{const owned=this.lives.get(row.id)===life;this.retire(life);if(owned&&!this.closed){try{this.state(row.id,'backoff');}catch{ /* report fixed error below */ }this.report();}}
 }
 /** The caller supplies a server-resolved recipient and rechecks the job and link
  * while the provider resolves the one-to-one channel. No message is posted here. */
 openDirect(connection:string,user:string,permitted:()=>boolean):Promise<string|undefined>{
  const life=this.lives.get(connection);
  if(!life?.authenticated)return Promise.resolve(undefined);
  const current=()=>this.current(life)&&permitted();
  if(!current())return Promise.resolve(undefined);
  const api=bridgeChannelApi({platform:life.connection.platform,workspace:life.connection.workspace,
   tokenSecret:life.connection.tokenSecret,secrets:life.secrets,clock:this.options.clock,current,request:this.options.request});
  return this.track(api.directChannel(user));
 }
 /** Called only while the job that took this message may use files. Read the exact message again for
  * fresh signed URLs. Nothing in the text (including a pasted attachment line) supplies a descriptor. */
 prepareDiscordFile(incoming:string, permitted:()=>boolean, index:number, maxBytes:number){
  return this.track(this.readDiscordFile(incoming,permitted,index,maxBytes));
 }
 private async readDiscordFile(incoming:string, permitted:()=>boolean, index:number, maxBytes:number):Promise<()=>DiscordFileOutcome>{
  const db=this.options.db;
  const result=(state:DiscordFileOutcome['state'],count=0,bytes=0)=>()=>({state,count,bytes});
  const message=db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id,incoming)).get();
  if(!message||!message.text||!permitted())return result('unavailable');
  const life=this.lives.get(message.connection),id=parseIncomingId(incoming,message.connection);
  if(!life?.authenticated||!id||life.connection.platform!=='discord')return result('unavailable');
  // The body waits 15 seconds for one command. Keep this entire metadata + file read within that window.
  const deadline=this.options.clock.now()+12_000;
  const current=()=>this.options.clock.now()<deadline&&this.current(life)&&permitted()&&db.select({text:bridgeIncoming.text}).from(bridgeIncoming).where(eq(bridgeIncoming.id,incoming)).get()?.text===message.text;
  const api=bridgeChannelApi({platform:'discord',workspace:life.connection.workspace,tokenSecret:life.connection.tokenSecret,secrets:life.secrets,clock:this.options.clock,current,request:this.options.request});
  const fresh=await api.messageFiles(message.channel,id,message.user,12_000);
  if(!current()||!fresh)return result('unavailable');
  if(fresh.edited||!originalDiscordAttachments(message.text,fresh.content,fresh.attachments))return result('changed');
  const count=Math.min(fresh.attachments.length,DISCORD_FILES_PER_MESSAGE),raw=fresh.attachments[index];
  if(index>=count)return result('absent',count);
  const file=discordFiles({attachments:[raw]})[0];
  if(!file)return result('too-large',count);
  const cached=db.select({size:sql<number>`length(${bridgeFiles.contents})`}).from(bridgeFiles).where(and(eq(bridgeFiles.connection,message.connection),eq(bridgeFiles.file,file.id))).get();
  const size=file.size;
  const incomplete=!!cached&&cached.size!==size;
  const failed=(state:DiscordFileOutcome['state'],bytes:number)=>()=>{
   if(incomplete&&current())this.files.repairIncomplete(message.connection,file.id,size);
   return {state,count,bytes};
  };
  if(size>maxBytes)return failed('limit',0);
  if(cached&&!incomplete)return ()=>{
   if(!current()||this.files.carry({connection:message.connection,incoming,files:[file.id]},false).length)return {state:'unavailable',count,bytes:0};
   return {state:'saved',count,bytes:size};
  };
  const [got]=await fetchDiscordFiles([file],current,this.options.request,size,Math.max(1,deadline-this.options.clock.now()));
  if(!got)return failed('unavailable',size);
  if(got.bytes.length!==size){got.bytes.fill(0);return failed('unavailable',size);}
  return ()=>{
   try{
    if(!current())return {state:'unavailable',count,bytes:size};
    if(incomplete)this.files.repairIncomplete(message.connection,file.id,size,got.bytes);
    this.files.store({connection:message.connection,incoming,file:file.id,name:file.name,contents:got.bytes},false);
    return {state:'saved',count,bytes:got.bytes.length};
   }finally{got.bytes.fill(0);}
  };
 }
 private queuePump(life:Life){
  if(!this.current(life))return;
  if(life.pumping){life.again=true;return;}
  life.retry?.();life.retry=this.options.clock.at(this.options.clock.now(),()=>{life.retry=undefined;this.pump(life);});
 }
 async idle(){for(;;){const active=[...this.active];if(!active.length)return;await Promise.allSettled(active);}}
 private pump(life:Life){
  if(life.pumping||!life.authenticated||!life.channels||!this.current(life))return;
  life.retry?.();life.retry=undefined;life.again=false;let more=false;
  life.pumping=this.track(Promise.resolve().then(async()=>{
   const row=life.connection,current=()=>this.current(life);
   const api=bridgeChannelApi({platform:row.platform,workspace:row.workspace,tokenSecret:row.tokenSecret,secrets:life.secrets,clock:this.options.clock,current,request:this.options.request});
   for(const id of this.receiver.missingChannels(row.id,64,true)){
    if(!current())return;const evidence=await api.channel(id);if(!current())return;
    // A thread made from a message has that message's id. Who wrote it says whose message the thread hangs
    // under; a thread with no such message, or one that cannot be read, hangs under nobody's.
    const starter=row.platform==='discord'&&evidence&&(evidence.type===10||evidence.type===11)&&typeof evidence.parent_id==='string'?await api.starter(evidence.parent_id,id):undefined;
    if(!current())return;
    const parentId=row.platform==='discord'&&evidence&&[10,11,12].includes(Number(evidence.type))&&evidence.guild_id===row.workspace&&typeof evidence.parent_id==='string'?evidence.parent_id:undefined;
    const parentName=parentId?this.channels.discord(row.id,parentId)?.name:undefined;
    // Details this code cannot classify leave that one channel's events waiting. They must not stop the
    // pass: every other channel of the connection is still to be drained.
    try{if(evidence)life.channels!.put(id,evidence,starter,parentName);}catch{const key=JSON.stringify([row.id,id]);if(!this.unclassified.has(key)){this.unclassified.add(key);this.report();}}
    if(parentId&&!parentName&&evidence&&this.channels.discord(row.id,id)?.kind==='thread'){
     const pending=life.parentLookups??=new Map<string,Promise<string | undefined>>();
     let lookup=pending.get(parentId);
     if(!lookup&&pending.size<4){
      lookup=api.channel(parentId).then(parent=>parent?.id===parentId&&parent.guild_id===row.workspace&&typeof parent.name==='string'?parent.name:undefined).finally(()=>pending.delete(parentId));
      pending.set(parentId,lookup);
     }
     if(lookup)this.track(lookup.then(name=>{
      if(!name||!current())return;
      const thread=this.channels.discord(row.id,id);
      if(thread?.parent!==parentId)return;
      life.channels!.put(id,evidence,starter,name);
      const message={channel:id,thread:id,parent:parentId,channelName:thread.name,user:'',isDm:false};
      const place=conversationPlace(row.workspace,message,null);
      const changed = refreshConversationLabel(this.options.db, {
        agent: row.agent, venue: 'discord', place, label: discordPlace(message, null),
      }, discordPlace({...message, parentName: name}, null));
      if (changed) this.notify();
     }).catch(()=>this.report()));
    }
   }
   if(!current())return;
   const pendingFiles=new Map<string,SlackFilesPermit['files']>();
   const changes=()=> (this.options.db.$client.prepare('SELECT total_changes() AS n').get() as {n:number}).n;
   const beforeChanges=changes();
   const before=this.options.db.select({row:sql<number>`coalesce(max(rowid),0)`}).from(inbox).get()!.row;
   try{more=this.receiver.drain(row.id,64,(incoming,raw)=>{
    if(row.platform!=='slack')return;
    const event=JSON.parse(raw.toString('utf8')).payload?.event;
    if(!Array.isArray(event?.files)||!event.files.length)return;
    const descriptors=event.files.slice(0,5).map((file:Record<string,unknown>)=>({id:file?.id,name:file?.name,size:file?.size,url:file?.url_private_download??file?.url_private}));
    // Parsing/URL validation remains in the existing pure file transport. Only
    // descriptors from this authenticated durable frame enter the trusted seam.
    // A file already kept (the same Slack file shared in an earlier message) is listed under this message
    // too and not fetched again; the rest are fetched below.
    const ids=descriptors.flatMap((file:{id:unknown})=>typeof file.id==='string'?[file.id]:[]);
    const unkept=new Set(this.files.carry({connection:row.id,incoming:incoming.id,files:ids}));
    const missing=descriptors.filter((file:{id:unknown})=>typeof file.id!=='string'||unkept.has(file.id));
    if(!missing.length)return;
    pendingFiles.set(incoming.id,missing);return false;
   })===64;}finally{
    // Drain owns its per-event transactions; even a later malformed receipt may
    // follow earlier successful commits. Publish and signal only committed ids.
    // An empty drain has no new publication. Publishing after every ordinary
    // body write would revoke its still-streaming guarded mail response.
    if(changes()!==beforeChanges)this.notify();
    // Noted while the pass was writing, so asked again of what was committed: a pass that was rolled back
    // stopped nothing and says nothing.
    const stopped=this.receiver.takeStopped().filter(stop=>
     this.options.db.select({state:jobs.state}).from(jobs).where(eq(jobs.id,stop.job)).get()?.state==='stopped'
     &&this.options.db.select({reason:bridgeIncoming.reason}).from(bridgeIncoming).where(eq(bridgeIncoming.id,stop.incoming)).get()?.reason===STOP_WORD);
    if(stopped.length){
     try{this.options.jobsEnded?.(stopped.map(stop=>stop.job));}catch{this.report();}
     // One short line where it was said, through the queue every post goes through. Not saying it is no
     // reason to undo the stop, so a line that cannot be queued is reported and dropped.
     for(const stop of stopped){try{this.sends.queue({id:'stopped:'+stop.incoming,incoming:stop.incoming,text:STOPPED_LINE,held:!this.options.effectsAllowed(),stopped:true});}catch{this.report();}}
     this.track(this.sends.flush());
    }
    if(!this.closed){
     const ids=this.options.db.selectDistinct({id:inbox.id}).from(inbox)
      .innerJoin(inboxRefs,eq(inboxRefs.item,inbox.id)).innerJoin(bridgeIncoming,eq(bridgeIncoming.id,inboxRefs.ref))
      .where(and(sql`${inbox}.rowid > ${before}`,eq(bridgeIncoming.connection,row.id))).all().map(item=>item.id);
     if(ids.length){try{this.options.inboxCommitted?.(ids);}catch{this.report();}}
    }
   }
   // Frame and Inbox delivery have committed. Keep the original raw receipt
   // until cached files exist, so a restart can retry without a second spool.
   for(const [incoming,files] of pendingFiles){
    if(!current())return;
    const message=this.options.db.select().from(bridgeIncoming).where(and(eq(bridgeIncoming.id,incoming),eq(bridgeIncoming.connection,row.id),eq(bridgeIncoming.state,'delivered'))).get();
    if(!message)continue;
    const fileCurrent=()=>current()&&JSON.stringify(this.options.db.select().from(bridgeIncoming).where(eq(bridgeIncoming.id,incoming)).get())===JSON.stringify(message);
    const permit:SlackFilesPermit={agent:row.agent,venue:row.id,workspace:row.workspace,channel:message.channel,delivery:incoming,files,current:fileCurrent};
    const fetched=await slackFiles({id:row.id,platform:'slack',agent:row.agent,workspace:row.workspace,bot:row.botUser,tokenSecret:row.tokenSecret,appSecret:row.appSecret??undefined,enabled:row.enabled,only:[],ignore:[],botRoles:[]},permit,life.secrets,fileCurrent,this.options.request).fetch();
    try{
     if(!fileCurrent())return;
     for(const file of fetched)this.files.store({connection:row.id,file:file.id,incoming,name:file.name,contents:file.bytes});
     life.again=true;
    }finally{for(const file of fetched)file.bytes.fill(0);}
   }
  }).catch(()=>this.report()).finally(()=>{
   life.pumping=undefined;
   if(this.current(life))life.retry=this.options.clock.at(this.options.clock.now()+(more||life.again?1:5000),()=>this.pump(life));
  }));
 }
 /** Wait on tracked platform work before the caller closes the shared database. */
 close():Promise<void>{
  if(this.closing)return this.closing;
  let done!:()=>void;this.closing=new Promise<void>(resolve=>{done=resolve;});
  this.closed=true;this.track(this.sends.close());this.cancelRetry?.();this.unobserve();this.credentials.close();
  for(const life of this.lives.values())this.retire(life);
  this.receiver.close();this.files.close();this.channels.close();
  void Promise.allSettled([...this.active]).then(done);return this.closing;
 }
}
