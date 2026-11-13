/** Offline import. The CLI owns the stopped-daemon gate; source is always read-only. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { migrate, type Db } from '../../core/index.js';
import { readKey, wordsKey } from './crypto.js';
import { schema } from './schema/001.js';
import { saveThread, type Thread, type MessageRow } from './store.js';
type Row=Record<string,unknown>;
const canonical=(value:unknown):string=> JSON.stringify(value);
const time=(v:unknown):number=>typeof v==='number'?v:Date.parse(String(v));
function read(db:Db,name:string):Row[] {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))return [];
 return db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Row[];
}
export async function importComms(db:Db,from:string,newHome:string,options:{interrupt?:()=>void}={}) {
 const sourceHome=basename(from)==='comms.db'?dirname(from):from;
 const oldKey=readKey(join(sourceHome,'comms.key')),newKey=readKey(join(newHome,'comms.key'));
 const source=new Database(join(sourceHome,'comms.db'),{readonly:true,fileMustExist:true});
 let household:Db|undefined;let threads:Row[],messages:Row[],asks:Row[],deleted:Row[];
 try {
  // THREADS live in household.db on the old side, not comms.db.
  household=new Database(join(sourceHome,'household.db'),{readonly:true,fileMustExist:true});
  [threads,deleted]=household.transaction(()=>[read(household!,'comms_threads'),read(household!,'comms_deleted')])();
  [messages,asks]=source.transaction(()=>[read(source,'comms_messages'),read(source,'comms_asks')])();
 }finally {source.close();household?.close();}
 const checksum=createHash('sha256').update(canonical({threads,messages,asks,deleted,key:oldKey})).digest('hex');
 migrate(db,'comms',schema);db.pragma('secure_delete = ON');
 const prior=db.prepare("SELECT value FROM comms_meta WHERE key='source-checksum'").get() as {value:string}|undefined;
 if(prior){if(prior.value!==checksum)throw new Error('A different Comms source was already imported');return {imported:false,checksum,threads:threads.length,messages:messages.length,asks:asks.length};}
 const opener=wordsKey(oldKey),sealer=wordsKey(newKey);
 const reseal=async(value:unknown)=>value===null||value===undefined?null:oldKey===newKey?Buffer.from(value as Uint8Array):sealer.seal(await opener.open(value as Uint8Array));
 const rows:MessageRow[]=[];const next=new Map<string,number>();
 for(const m of messages){
  const seq=Number(m.seq),place=String(m.thread);if(!Number.isSafeInteger(seq)||seq<1||!Number.isFinite(time(m.at)))throw new Error('Invalid source message');
  next.set(place,Math.max(next.get(place)??1,seq+1));
  const metadata=typeof m.card_json==='string'?JSON.parse(m.card_json):null;
  rows.push({thread:place,seq,id:String(m.id),kind:String(m.kind),at:time(m.at),sender:String(m.sender),words:await reseal(m.text),hash:String(m.hash??''),record:JSON.stringify({encoding:'text',card:metadata,run:m.run,delivery:m.delivered===null?'sending':m.delivered?'delivered':'failed',stepCipher:m.step? (await reseal(m.step))!.toString('base64'):undefined,legacyHash:true})});
 }
 for(const a of asks){const place=String(a.thread),seq=next.get(place)??1;next.set(place,seq+1);rows.push({thread:place,seq,id:String(a.ref),kind:'ask',at:time(a.raised),sender:threads.find(t=>t.id===place)?.agent as string,words:await reseal(a.words),hash:'',record:JSON.stringify({encoding:'ask',ref:a.ref,approval:a.approval,answer:a.answer_json?JSON.parse(String(a.answer_json)):null})});}
 const imported:Thread[]=threads.map(t=>{
  const opened=time(t.opened),last=time(t.last);if(!Number.isFinite(opened)||!Number.isFinite(last))throw new Error('Invalid source thread');
  return {...t,id:String(t.id),agent:String(t.agent),member:String(t.member),conversation:String(t.conversation),title:t.title as string|null,titledBy:t.titled_by as Thread['titledBy'],project:t.project?String(t.project):undefined,pinned:!!t.pinned,archived:t.archived?time(t.archived):null,opened,last,readSeq:Number(t.read_seq),nextSeq:next.get(String(t.id))??1,stop:!!t.stop,firstId:String(t.first_id),firstHash:String(t.first_hash),working:!!t.working_since};
 });
 // Compare plaintext only here, in memory. It is never returned or included in an error.
 for(let n=0;n<messages.length;n++){
  const m=messages[n],r=rows[n];
  if(m.text && await opener.open(m.text as Uint8Array)!==await sealer.open(r.words!))throw new Error('Comms content comparison failed');
  if(m.step && await opener.open(m.step as Uint8Array)!==await sealer.open(Buffer.from(JSON.parse(r.record).stepCipher,'base64')))throw new Error('Comms step comparison failed');
 }
 for(let n=0;n<asks.length;n++){const a=asks[n];if(a.words && await opener.open(a.words as Uint8Array)!==await sealer.open(rows[messages.length+n].words!))throw new Error('Comms ask comparison failed');}
 return db.transaction(()=>{
  if(db.prepare('SELECT 1 FROM comms_threads UNION SELECT 1 FROM comms_messages UNION SELECT 1 FROM comms_deleted LIMIT 1').get())throw new Error('Comms destination must be empty');
  for(const t of imported)saveThread(db,t);
  for(const r of rows)db.prepare('INSERT INTO comms_messages VALUES (?,?,?,?,?,?,?,?,?)').run(r.thread,r.seq,r.id,r.kind,r.at,r.sender,r.words,r.hash,r.record);
  for(const d of deleted)db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run(d.id,d.member,d.agent,d.conversation??'',time(d.at));
  options.interrupt?.();
  const actualThreads=(db.prepare('SELECT record FROM comms_threads ORDER BY id').all() as {record:string}[]).map(r=>JSON.parse(r.record));
  if(canonical(actualThreads)!==canonical([...imported].sort((a,b)=>a.id.localeCompare(b.id))) || canonical(db.prepare('SELECT * FROM comms_messages ORDER BY thread,seq').all())!==canonical([...rows].sort((a,b)=>a.thread.localeCompare(b.thread)||a.seq-b.seq)))throw new Error('Comms ids, counts or content comparison failed');
  db.prepare("INSERT INTO comms_meta VALUES ('source-checksum',?)").run(checksum);
  return {imported:true,checksum,threads:threads.length,messages:messages.length,asks:asks.length,rekeyed:oldKey!==newKey};
 })();
}
