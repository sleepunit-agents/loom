/** Offline import. The CLI owns the stopped-daemon gate; source is always read-only. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { migrate, type Db } from '../../core/index.js';
import { readKey, wordsKey } from './crypto.js';
import {refsIn,MAX_REFS} from './refs.js';
import { schema } from './schema/001.js';
import { saveThread, type Thread, type MessageRow } from './store.js';
type Row=Record<string,unknown>;
const canonical=(value:unknown):string=> JSON.stringify(value);
const time=(v:unknown):number=>typeof v==='number'?v:Date.parse(String(v));
function read(db:Db,name:string):Row[] {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))return [];
 return db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Row[];
}
export async function importComms(db:Db,from:string,newHome:string,options:{interrupt?:()=>void}={},openSource:(path:string)=>Db=path=>new Database(path,{readonly:true,fileMustExist:true})) {
 const sourceHome=basename(from)==='comms.db'?dirname(from):from;
 if(realpathSync(sourceHome)===realpathSync(newHome))throw new Error('Comms source and destination must differ');
 const oldKey=readKey(join(sourceHome,'comms.key')),newKey=readKey(join(newHome,'comms.key'));
 // Snapshot callers supply a buffer reader; live-source CLI calls retain SQLite's WAL-aware reader.
 const source=openSource(join(sourceHome,'comms.db'));
 let household:Db|undefined;let threads:Row[],messages:Row[],asks:Row[],deleted:Row[],steps:Row[],references:Row[];
 try {
  // THREADS live in household.db on the old side, not comms.db.
  household=openSource(join(sourceHome,'household.db'));
  [threads,deleted,references]=household.transaction(()=>[read(household!,'comms_threads'),read(household!,'comms_deleted'),read(household!,'comms_refs')])();
  [messages,asks,steps]=source.transaction(()=>[read(source,'comms_messages'),read(source,'comms_asks'),read(source,'conversation_steps')])();
 }finally {source.close();household?.close();}
 const salt=existsSync(join(sourceHome,'comms.salt'))?readFileSync(join(sourceHome,'comms.salt')):undefined;
 if(salt&&salt.length!==32)throw new Error('Invalid source Comms salt');
 const checksum=createHash('sha256').update(canonical({threads,messages,asks,deleted,steps,references,key:oldKey,salt:salt?.toString('base64'),destinationKey:newKey})).digest('hex');
 db.pragma('secure_delete = ON');
 const haveMeta=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comms_meta'").get();
 const prior=haveMeta?db.prepare("SELECT value FROM comms_meta WHERE key='source-checksum'").get() as {value:string}|undefined:undefined;
 if(prior){if(prior.value!==checksum)throw new Error('A different Comms source was already imported');return {imported:false,checksum,threads:threads.length,messages:messages.length,asks:asks.length,steps:steps.length};}
 const opener=wordsKey(oldKey),sealer=wordsKey(newKey);
 const reseal=async(value:unknown)=>value===null||value===undefined?null:oldKey===newKey?Buffer.from(value as Uint8Array):sealer.seal(await opener.open(value as Uint8Array));
 const mentions:{thread:string;seq:number;at:number;refs:string[]}[]=[];
 const rows:MessageRow[]=[];const next=new Map<string,number>();
 for(const m of messages){
  const seq=Number(m.seq),place=String(m.thread);if(!Number.isSafeInteger(seq)||seq<1||!Number.isFinite(time(m.at)))throw new Error('Invalid source message');
  next.set(place,Math.max(next.get(place)??1,seq+1));
  if(m.text&&(m.kind==='message'||m.kind==='reply'))mentions.push({thread:place,seq,at:time(m.at),refs:refsIn(await opener.open(m.text as Uint8Array))});
  const metadata=typeof m.card_json==='string'?JSON.parse(m.card_json):null;
  rows.push({thread:place,seq,id:String(m.id),kind:String(m.kind),at:time(m.at),sender:String(m.sender),words:await reseal(m.text),hash:String(m.hash??''),record:JSON.stringify({encoding:'text',privateCipher:(await sealer.seal(JSON.stringify({card:metadata,run:m.run}))).toString('base64'),delivery:m.delivered===null?'sending':m.delivered?'delivered':'failed',stepCipher:m.step? (await reseal(m.step))!.toString('base64'):undefined,legacyHash:true})});
 }
 for(const a of asks){const place=String(a.thread),seq=next.get(place)??1;next.set(place,seq+1);rows.push({thread:place,seq,id:String(a.ref),kind:'ask',at:time(a.raised),sender:threads.find(t=>t.id===place)?.agent as string,words:await reseal(a.words),hash:'',record:JSON.stringify({encoding:'ask',ref:a.ref,approval:a.approval,seen:a.seen,privateCipher:(await sealer.seal(JSON.stringify({answer:a.answer_json?JSON.parse(String(a.answer_json)):null}))).toString('base64')})});}
 // Non-thread conversation labels have no member thread. Preserve routing only in
 // plaintext; seal run/id/tool/state separately so all work details expire together.
 const stepRows:{seq:number;conversation:string;at:number;words:Buffer|null;record:Buffer|null}[]=[];
 for(const step of steps){
  const seq=Number(step.seq),at=time(step.at);
  if(!Number.isSafeInteger(seq)||seq<1||!Number.isFinite(at)||typeof step.conversation!=='string'||!step.conversation)throw new Error('Invalid source conversation step');
  const metadata=canonical({run:step.run,id:step.id,tool:step.tool,state:step.state});
  const words=await reseal(step.words),record=words===null?null:await sealer.seal(metadata);
  if(words!==null&&(await opener.open(step.words as Uint8Array)!==await sealer.open(words)||await sealer.open(record!)!==metadata))throw new Error('Comms conversation step comparison failed');
  stepRows.push({seq,conversation:step.conversation,at,words,record});
 }
 const imported:Thread[]=threads.map(t=>{
  const opened=time(t.opened),last=time(t.last);if(!Number.isFinite(opened)||!Number.isFinite(last))throw new Error('Invalid source thread');
  // Legacy associations are raw ref:/page: pointers. Only their destination-key
  // fingerprint may survive in thread metadata; never spread the raw column.
  const {about_key:aboutKey,...metadata}=t;
  const association=typeof aboutKey==='string'&&aboutKey?{aboutHash:sealer.hash(`about\0${aboutKey}`)}:{};
  return {...metadata,...association,id:String(t.id),agent:String(t.agent),member:String(t.member),conversation:String(t.conversation),title:t.title as string|null,titledBy:t.titled_by as Thread['titledBy'],project:t.project?String(t.project):undefined,pinned:!!t.pinned,archived:t.archived?time(t.archived):null,opened,last,readSeq:Number(t.read_seq),nextSeq:next.get(String(t.id))??1,stop:!!t.stop,firstId:String(t.first_id),firstHash:String(t.first_hash),working:!!t.working_since};
 });
 // Compare plaintext only here, in memory. It is never returned or included in an error.
 for(let n=0;n<messages.length;n++){
  const m=messages[n],r=rows[n];
  if(m.text && await opener.open(m.text as Uint8Array)!==await sealer.open(r.words!))throw new Error('Comms content comparison failed');
  if(m.step && await opener.open(m.step as Uint8Array)!==await sealer.open(Buffer.from(JSON.parse(r.record).stepCipher,'base64')))throw new Error('Comms step comparison failed');
 }
 for(let n=0;n<asks.length;n++){const a=asks[n];if(a.words && await opener.open(a.words as Uint8Array)!==await sealer.open(rows[messages.length+n].words!))throw new Error('Comms ask comparison failed');}
 return db.transaction(()=>{
  migrate(db,'comms',schema);
  if(db.prepare('SELECT 1 FROM comms_threads UNION SELECT 1 FROM comms_messages UNION SELECT 1 FROM comms_deleted UNION SELECT 1 FROM comms_conversation_steps LIMIT 1').get())throw new Error('Comms destination must be empty');
  for(const t of imported)saveThread(db,t);
  for(const r of rows)db.prepare('INSERT INTO comms_messages VALUES (?,?,?,?,?,?,?,?,?)').run(r.thread,r.seq,r.id,r.kind,r.at,r.sender,r.words,r.hash,r.record);
  // Rebuild retained words once during import, then overlay the old word-free
  // index, including mentions whose message words have already expired.
  const keep=new Set(imported.map(t=>t.id));
  for(const ref of references){
   if(typeof ref.thread!=='string'||!keep.has(ref.thread)||typeof ref.ref!=='string'||refsIn(ref.ref.replace(/^github:/,'')).length!==1
    ||refsIn(ref.ref.replace(/^github:/,''))[0]!==ref.ref||!Number.isSafeInteger(ref.seq)||Number(ref.seq)<1
    ||!Number.isSafeInteger(ref.pos)||Number(ref.pos)<0||!Number.isFinite(time(ref.at)))throw new Error('Invalid source reference');
  }
  const expected=new Map<string,{thread:string;ref:string;seq:number;pos:number;at:number}>();
  const put=(thread:string,ref:string,seq:number,pos:number,at:number,replaceEqual=false)=>{
   const identity=JSON.stringify([thread,ref]),old=expected.get(identity);
   if(!old||seq>old.seq||replaceEqual&&seq===old.seq)expected.set(identity,{thread,ref,seq,pos,at});
  };
  for(const mention of mentions)mention.refs.forEach((ref,pos)=>put(mention.thread,ref,mention.seq,pos,mention.at));
  for(const ref of references)put(String(ref.thread),String(ref.ref),Number(ref.seq),Number(ref.pos),time(ref.at),true);
  const expectedRefs=imported.flatMap(t=>[...expected.values()].filter(r=>r.thread===t.id).sort((a,b)=>b.seq-a.seq||b.pos-a.pos||(a.ref<b.ref?-1:a.ref>b.ref?1:0)).slice(0,MAX_REFS))
   .sort((a,b)=>a.thread<b.thread?-1:a.thread>b.thread?1:a.ref<b.ref?-1:a.ref>b.ref?1:0);
  const insertRef=db.prepare('INSERT INTO comms_refs(thread,ref,seq,pos,at) VALUES (?,?,?,?,?)');
  for(const r of expectedRefs)insertRef.run(r.thread,r.ref,r.seq,r.pos,r.at);
  for(const step of stepRows)db.prepare('INSERT INTO comms_conversation_steps VALUES (?,?,?,?,?)').run(step.seq,step.conversation,step.at,step.words,step.record);
  for(const d of deleted)db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run(d.id,d.member,d.agent,d.conversation??'',time(d.at));
  options.interrupt?.();
  if(canonical(db.prepare('SELECT thread,ref,seq,pos,at FROM comms_refs ORDER BY thread,ref').all())!==canonical(expectedRefs))throw new Error('Comms reference comparison failed');
  const actualThreads=(db.prepare('SELECT record FROM comms_threads ORDER BY id').all() as {record:string}[]).map(r=>JSON.parse(r.record));
  if(canonical(actualThreads)!==canonical([...imported].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)) || canonical(db.prepare('SELECT * FROM comms_messages ORDER BY thread,seq').all())!==canonical([...rows].sort((a,b)=>(a.thread<b.thread?-1:a.thread>b.thread?1:0)||a.seq-b.seq)))throw new Error('Comms ids, counts or content comparison failed');
  if(canonical(db.prepare('SELECT * FROM comms_conversation_steps ORDER BY seq').all())!==canonical([...stepRows].sort((a,b)=>a.seq-b.seq)))throw new Error('Comms conversation step ids, counts or content comparison failed');
  if(salt)db.prepare("INSERT INTO comms_meta VALUES ('legacy-salt',?)").run(salt.toString('base64'));
  db.prepare("INSERT INTO comms_meta VALUES ('source-checksum',?)").run(checksum);
  return {imported:true,checksum,threads:threads.length,messages:messages.length,asks:asks.length,steps:steps.length,rekeyed:oldKey!==newKey};
 })();
}
