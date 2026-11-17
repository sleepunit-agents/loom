import { createHash } from 'node:crypto';
import { liveDiscordReceipts } from './discord-receipts.js';
import { slackFiles, type SlackFilesPermit } from './slack-files.js';
import { BridgeSends } from './sends.js';
import { bridgeReplyApi } from './reply-api.js';
import { BridgeReplyNotSent } from './outbound.js';
/** Shared-model bridge composition. Socket receipt precedes platform ACK; bounded
 * asynchronous metadata/drain work follows separately. Installed parts share the
 * database directly; all outside permissions live at their respective doors. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeIncoming, bridgeFiles, inbox, inboxRefs, secretChanges } from '../../core/data/schema.js';
import type { DataWrites } from '../../core/data/writes.js';
import type { SecretValueSource } from '../secrets/role.js';
import type { HolderGeneration } from '../secrets/role.js';
import { bridgeCredentials } from './credentials.js';
import { sharedBridgeSecretUse } from './shared-secret-use.js';
import { BridgeChannels } from './channels.js';
import { BridgeReceiver } from './receiver.js';
import { bridgeAuthentication } from './authentication.js';
import { bridgeChannelApi } from './channel-api.js';
import { discordGateway } from './discord-gateway.js';
import { bridgeSlackSocket } from './slack-socket.js';
import { BridgeFiles } from './files.js';
type Connection=typeof bridgeConnections.$inferSelect;
export interface SharedBridgeOptions {
 db:DataDatabase;clock:Clock;writes:DataWrites;
 source:SecretValueSource&HolderGeneration;
 effectsAllowed():boolean;
 changed():void;
 inboxCommitted?(ids:readonly string[]):void;
 reportError(error:Error):void;
 request?:typeof fetch;
 discord?:typeof discordGateway;
 slack?:typeof bridgeSlackSocket;
}
type Life={connection:Connection;key:string;generation:string;stamp:number;active:boolean;authenticated:boolean;
 secrets:ReturnType<typeof sharedBridgeSecretUse>;channels?:ReturnType<BridgeChannels['bind']>;
 transport?:{close():Promise<void>};pumping?:Promise<void>;retry?:()=>void;again?:boolean};
const configuration=(row:Connection)=>JSON.stringify([row.id,row.platform,row.workspace,row.botUser,row.agent,row.tokenSecret,row.appSecret,row.enabled]);
export class SharedBridges {
 private closed=false;
 private readonly channels=new BridgeChannels();
 private readonly receiver:BridgeReceiver;
 readonly files:BridgeFiles;
 readonly sends:BridgeSends;
 private readonly credentials;
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
  this.sends=new BridgeSends(options.db,{ready:row=>!!sender(row),post:async(row,address,text)=>{
   // No lifetime to send through: nothing has left, so the reply waits for the next one.
   const life=sender(row);if(!life)throw new BridgeReplyNotSent(true);
   return bridgeReplyApi({platform:row.platform,tokenSecret:row.tokenSecret,secrets:life.secrets,clock:options.clock,current:()=>this.current(life),request:options.request}).post(address,text);
  }},()=>new Date(options.clock.now()).toISOString(),()=>{},write=>{
   const result=options.writes.run(write);for(const _error of result.notificationErrors)this.report();return result.value;
  });
  // What is given up on after a day was never delivered. Nothing can bring it back, so it is at least reported.
  this.receiver=new BridgeReceiver(options.db,options.clock,this.channels,lost=>{
   try{options.reportError(new Error(`${lost.events} received bridge event(s) were never read and have expired; ${lost.held} held message(s) could no longer be delivered and were dropped`));}catch{ /* reporting never retries effects */ }
   if(lost.held)this.notify();
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
  life.active=false;life.retry?.();life.channels?.close();life.secrets.close();
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
    if(old){this.pump(old);continue;}
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
   // Each pass also retries replies that were claimed but could not be sent.
   if(!this.closed)this.track(this.sends.flush());
  }).catch(()=>this.report()).finally(()=>{
   this.syncing=undefined;
   if(!this.closed)this.cancelRetry=this.options.clock.at(this.options.clock.now()+5000,()=>{void this.reconcile();});
  }));
  return this.syncing;
 }
 private async connect(life:Life){
  const row=life.connection,current=()=>this.current(life);
  try{
   const proof=await bridgeAuthentication({platform:row.platform,bot:row.botUser,workspace:row.workspace,tokenSecret:row.tokenSecret,
    secrets:life.secrets,clock:this.options.clock,current,request:this.options.request}).authenticate();
   if(!current()||!proof)throw Error();
   life.channels=this.channels.bind(row.id,{platform:row.platform,workspace:row.workspace});
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
     commit:async(_event,checkpoint,raw)=>{if(!current())throw Error();receipts.retain(raw,checkpoint);if(!current())throw Error();this.queuePump(life);},
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
    // Details this code cannot classify leave that one channel's events waiting. They must not stop the
    // pass: every other channel of the connection is still to be drained.
    try{if(evidence)life.channels!.put(id,evidence);}catch{const key=JSON.stringify([row.id,id]);if(!this.unclassified.has(key)){this.unclassified.add(key);this.report();}}
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
    const missing=descriptors.filter((file:{id:unknown})=>typeof file.id!=='string'||!this.options.db.select({file:bridgeFiles.file}).from(bridgeFiles).where(and(eq(bridgeFiles.connection,row.id),eq(bridgeFiles.file,file.id))).get());
    if(!missing.length)return;
    pendingFiles.set(incoming.id,missing);return false;
   })===64;}finally{
    // Drain owns its per-event transactions; even a later malformed receipt may
    // follow earlier successful commits. Publish and signal only committed ids.
    // An empty drain has no new publication. Publishing after every ordinary
    // body write would revoke its still-streaming guarded mail response.
    if(changes()!==beforeChanges)this.notify();
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
