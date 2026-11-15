import { slackFiles, type SlackFilesPermit } from './slack-files.js';
import { BridgeSends } from './sends.js';
import { bridgeReplyApi } from './reply-api.js';
/** Shared-model bridge composition. Socket receipt precedes platform ACK; bounded
 * asynchronous metadata/drain work follows separately. Installed parts share the
 * database directly; all outside permissions live at their respective doors. */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Clock } from '../../core/clock.js';
import type { DataDatabase } from '../../core/data/database.js';
import { bridgeConnections, bridgeIncoming, bridgeFiles, inbox, inboxRefs } from '../../core/data/schema.js';
import type { DataWrites } from '../../core/data/writes.js';
import type { SecretValueSource } from '../secrets/role.js';
import type { HolderGeneration } from '../secrets/role.js';
import { bridgeCredentials } from './credentials.js';
import { sharedBridgeSecretUse } from './shared-secret-use.js';
import { BridgeChannels } from './channels.js';
import { BridgeReceiver } from './receiver.js';
import { bridgeAuthentication } from './authentication.js';
import { bridgeChannelApi } from './channel-api.js';
import { discordGateway, type DiscordCheckpoint } from './discord-gateway.js';
import { bridgeSlackSocket } from './slack-socket.js';
import { BridgeFiles } from './files.js';
type Connection=typeof bridgeConnections.$inferSelect;
/** The concrete private resume carrier binds the cursor to this exact config +
 * holder generation. It MUST atomically retain raw frame/cursor/binding before
 * returning. No unbound resume default; caller input never supplies a binding. */
export interface BoundDiscordReceipts {
 checkpoint():DiscordCheckpoint|undefined;
 retain(raw:Buffer,checkpoint:DiscordCheckpoint):void;
 reset():void;
}
export interface SharedBridgeOptions {
 db:DataDatabase;clock:Clock;writes:DataWrites;
 source:SecretValueSource&HolderGeneration;
 effectsAllowed():boolean;
 resume(connection:Connection,binding:string,receiver:BridgeReceiver):BoundDiscordReceipts;
 changed():void;
 inboxCommitted?(ids:readonly string[]):void;
 reportError(error:Error):void;
 request?:typeof fetch;
 discord?:typeof discordGateway;
 slack?:typeof bridgeSlackSocket;
}
type Life={connection:Connection;key:string;generation:string;active:boolean;
 secrets:ReturnType<typeof sharedBridgeSecretUse>;channels?:ReturnType<BridgeChannels['bind']>;
 transport?:{close():Promise<void>};pumping?:Promise<void>;retry?:()=>void;again?:boolean};
const configuration=(row:Connection)=>JSON.stringify([row.id,row.platform,row.workspace,row.botUser,row.agent,row.tokenSecret,row.appSecret,row.enabled]);
export function bridgeCredentialBinding(row:Connection,generation:string):string{
 return createHash('sha256').update('loom-shared-bridge-resume-v1\0').update(JSON.stringify([row.id,row.platform,row.workspace,row.botUser,row.agent,row.tokenSecret,row.appSecret,generation])).digest('hex');
}
export class SharedBridges {
 private closed=false;
 private readonly channels=new BridgeChannels();
 private readonly receiver:BridgeReceiver;
 readonly files:BridgeFiles;
 readonly sends:BridgeSends;
 private readonly credentials;
 private readonly lives=new Map<string,Life>();
 private readonly active=new Set<Promise<unknown>>();
 private syncing?:Promise<void>;
 private cancelRetry?:()=>void;
 private readonly unobserve:()=>void;
 private closing?:Promise<void>;
 constructor(private readonly options:SharedBridgeOptions){
  this.sends=new BridgeSends(options.db,{post:async(row,address,text)=>{
   const life=this.lives.get(row.id);if(!life||!this.current(life)||configuration(row)!==life.key)throw Error('Bridge reply attempt uncertain');
   return bridgeReplyApi({platform:row.platform,tokenSecret:row.tokenSecret,secrets:life.secrets,clock:options.clock,current:()=>this.current(life),request:options.request}).post(address,text);
  }},()=>new Date(options.clock.now()).toISOString(),()=>{},write=>{
   const result=options.writes.run(write);for(const _error of result.notificationErrors)this.report();return result.value;
  });
  this.receiver=new BridgeReceiver(options.db,options.clock,this.channels);
  this.files=new BridgeFiles(options.db,options.clock,()=>this.notify());
  this.credentials=bridgeCredentials(options.source,options.clock);
  this.unobserve=this.credentials.observe(()=>{void this.reconcile();});
 }
 private report(){try{this.options.reportError(new Error('Bridge processing unavailable'));}catch{ /* reporting never retries effects */ }}
 private track<T>(work:Promise<T>):Promise<T>{this.active.add(work);void work.finally(()=>this.active.delete(work)).catch(()=>{});return work;}
 private notify(){if(this.closed)return;try{this.options.changed();}catch{this.report();}}
 private current(life:Life):boolean{
  if(this.closed||!life.active||!this.options.effectsAllowed()||this.credentials.current()!==life.generation)return false;
  const row=this.options.db.select().from(bridgeConnections).where(eq(bridgeConnections.id,life.connection.id)).get();
  return !!row&&row.enabled&&configuration(row)===life.key;
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
 /** Root invokes after committed config/rule/link edits. Known value writes may
  * retire credentials immediately, without waiting for the metadata poll. */
 changed(credentials=false){
  if(this.closed)return;
  for(const life of this.lives.values())if(credentials||!this.current(life))this.retire(life);
  void this.reconcile();this.track(this.sends.flush());
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
   const rows=this.options.db.select().from(bridgeConnections).all();
   for(const row of rows){
    if(!row.enabled||!generation||!this.options.effectsAllowed()){
     this.state(row.id,row.enabled?'backoff':'disconnected');continue;
    }
    const old=this.lives.get(row.id);
    if(old){this.pump(old);continue;}
    const life={} as Life;
    Object.assign(life,{connection:row,key:configuration(row),generation,active:true,
     secrets:sharedBridgeSecretUse({source:this.options.source,clock:this.options.clock,generation,
      names:[row.tokenSecret,...(row.appSecret?[row.appSecret]:[])],current:()=>this.current(life),
      invalidate:()=>{const valid=this.current(life);this.retire(life);if(valid){try{this.state(row.id,'backoff');}catch{this.report();}}}})});
    this.lives.set(row.id,life);this.state(row.id,'connecting');
    this.track(this.connect(life));
   }
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
   const state=(value:Connection['state'])=>{if(current()){this.state(row.id,value);if(value==='connected')this.track(this.sends.flush());}};
   if(row.platform==='discord'){
    const receipts=this.options.resume(row,bridgeCredentialBinding(row,life.generation),this.receiver);
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
  if(life.pumping||!this.current(life))return;
  life.retry?.();life.retry=undefined;life.again=false;let more=false;
  life.pumping=this.track(Promise.resolve().then(async()=>{
   const row=life.connection,current=()=>this.current(life);
   const api=bridgeChannelApi({platform:row.platform,workspace:row.workspace,tokenSecret:row.tokenSecret,secrets:life.secrets,clock:this.options.clock,current,request:this.options.request});
   for(const id of this.receiver.missingChannels(row.id,64,true)){
    if(!current())return;const evidence=await api.channel(id);if(!current())return;
    if(evidence)life.channels!.put(id,evidence);
   }
   if(!current())return;
   const pendingFiles=new Map<string,SlackFilesPermit['files']>();
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
    this.notify();
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
    const permit:SlackFilesPermit={agent:row.agent,venue:row.id,workspace:row.workspace,channel:message.channel,delivery:incoming,files,current};
    const fetched=await slackFiles({id:row.id,platform:'slack',agent:row.agent,workspace:row.workspace,bot:row.botUser,tokenSecret:row.tokenSecret,appSecret:row.appSecret??undefined,enabled:row.enabled,only:[],ignore:[],botRoles:[]},permit,life.secrets,current,this.options.request).fetch();
    try{
     if(!current())return;
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
