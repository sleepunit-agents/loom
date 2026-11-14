/** Internal orchestration, never registered. Only Runtime may issue a delivered
 * permit. The fetch callback must be the bounded transport with service/staging
 * fences; this module creates neither that authority nor a public read. */
import { statSync } from 'node:fs';
import type { Db } from '../../core/index.js';
import { bridgeFileStore, type BridgeFileSavePermit } from './file-store.js';
import type { FetchedSlackFile } from './slack-files.js';
const memoryQueues=new WeakMap<Db,Map<string,Promise<void>>>();
const fileQueues=new Map<string,Map<string,Promise<void>>>();
const held=()=>Error('Bridge file unavailable');
/** Serialize exact storage scopes, including independent callers. A successful
 * durable save is the restart cache; failures leave no cached success. An abrupt
 * stop before save may repeat GET on restart. No network exactly-once claim. */
export async function bridgeFilesOnce(db:Db,now:()=>number,permit:BridgeFileSavePermit,
 fetch:(permit:BridgeFileSavePermit)=>Promise<FetchedSlackFile[]>):Promise<void> {
 let fetched:FetchedSlackFile[]=[],cached:((FetchedSlackFile & {expiresAt:number})|undefined)[]=[];
 let cachedExpiry=Infinity;
 let release:(()=>void)|undefined,queue:Map<string,Promise<void>>|undefined,key:string|undefined,tail:Promise<void>|undefined,fileKey:string|undefined;
 try {
  // Snapshot before waiting. A queued caller never inherits another's proof.
  const snapshot={agent:permit.agent,venue:permit.venue,workspace:permit.workspace,channel:permit.channel,delivery:permit.delivery,
   deliveredAt:permit.deliveredAt,files:structuredClone(permit.files)};
  const frozen=JSON.stringify(snapshot),proof=permit.current;
  const current=()=>permit.current===proof&&proof.call(permit)&&now()<cachedExpiry&&JSON.stringify({agent:permit.agent,venue:permit.venue,workspace:permit.workspace,channel:permit.channel,
   delivery:permit.delivery,deliveredAt:permit.deliveredAt,files:permit.files})===frozen;
  if(!current())throw held();
  key=JSON.stringify([snapshot.agent,snapshot.venue,snapshot.workspace,snapshot.channel]);
  if(db.memory){
   queue=memoryQueues.get(db);if(!queue){queue=new Map();memoryQueues.set(db,queue);}
  }else{
   // Physical identity also covers aliases and separately opened connections
   // within this owning daemon. No cross-process network lease is claimed.
   const stat=statSync(db.name,{bigint:true});fileKey=`${stat.dev}:${stat.ino}`;
   queue=fileQueues.get(fileKey);if(!queue){queue=new Map();fileQueues.set(fileKey,queue);}
  }
  const previous=queue.get(key);
  tail=new Promise<void>(resolve=>{release=resolve;});queue.set(key,tail);
  await previous;
  const trusted={...snapshot,current};
  const store=bridgeFileStore(db,now);cached=store.cached(trusted);
  cachedExpiry=Math.min(...cached.map(f=>f?.expiresAt??Infinity));
  const missing=snapshot.files.slice(0,5).filter((_,i)=>!cached[i]);
  if(missing.length)fetched=await fetch({...trusted,files:missing});
  // Save validates the full original manifest and current proof atomically.
  if(fetched.length!==missing.length)throw held();
  let i=0;
  store.save(trusted,cached.map(f=>f??fetched[i++]));
 }catch{throw held();}
 finally {
  for(const file of [...cached,...fetched])if(Buffer.isBuffer(file?.bytes))file.bytes.fill(0);
  release?.();if(queue&&key&&queue.get(key)===tail)queue.delete(key);
  if(fileKey&&queue?.size===0&&fileQueues.get(fileKey)===queue)fileQueues.delete(fileKey);
 }
}
