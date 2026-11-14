/** Internal orchestration, never registered. Only Runtime may issue a delivered
 * permit. The fetch callback must be the bounded transport with service/staging
 * fences; this module creates neither that authority nor a public read. */
import type { Db } from '../../core/index.js';
import { bridgeFileStore, type BridgeFileSavePermit } from './file-store.js';
import type { FetchedSlackFile } from './slack-files.js';
const queues=new WeakMap<Db,Map<string,Promise<void>>>();
const held=()=>Error('Bridge file unavailable');
/** Serialize exact storage scopes, including independent callers. A successful
 * durable save is the restart cache; failures leave no cached success. An abrupt
 * stop before save may repeat GET on restart. No network exactly-once claim. */
export async function bridgeFilesOnce(db:Db,now:()=>number,permit:BridgeFileSavePermit,
 fetch:(permit:BridgeFileSavePermit)=>Promise<FetchedSlackFile[]>):Promise<void> {
 let fetched:FetchedSlackFile[]=[],cached:(FetchedSlackFile|undefined)[]=[];
 let release:(()=>void)|undefined,queue:Map<string,Promise<void>>|undefined,key:string|undefined,tail:Promise<void>|undefined;
 try {
  // Snapshot before waiting. A queued caller never inherits another's proof.
  const snapshot={agent:permit.agent,venue:permit.venue,workspace:permit.workspace,channel:permit.channel,delivery:permit.delivery,
   deliveredAt:permit.deliveredAt,files:structuredClone(permit.files)};
  const frozen=JSON.stringify(snapshot);
  const current=()=>permit.current()&&JSON.stringify({agent:permit.agent,venue:permit.venue,workspace:permit.workspace,channel:permit.channel,
   delivery:permit.delivery,deliveredAt:permit.deliveredAt,files:permit.files})===frozen;
  if(!current())throw held();
  key=JSON.stringify([snapshot.agent,snapshot.venue,snapshot.workspace,snapshot.channel]);
  queue=queues.get(db);if(!queue){queue=new Map();queues.set(db,queue);}
  const previous=queue.get(key);
  tail=new Promise<void>(resolve=>{release=resolve;});queue.set(key,tail);
  await previous;
  const trusted={...snapshot,current};
  const store=bridgeFileStore(db,now);cached=store.cached(trusted);
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
 }
}
