/** Startup only: retained words become pointers once, never on a view. */
import {mayUseThread, type Db, type Clock, type Sharing} from '../../core/index.js';
import type {WordsKey} from './crypto.js';
import {thread, type Thread, type MessageRow} from './store.js';
import {indexRefs, refsIn} from './refs.js';
interface Options {db:Db;clock:Clock;key:WordsKey;days:number;sharing():Sharing;closed():boolean;changed(id:string):void}
export async function backfillRefs(o:Options):Promise<boolean> {
 const {db,clock}=o;
 if(o.closed())return false;
 if(db.prepare("SELECT 1 FROM comms_meta WHERE key='refs_backfilled'").get())return true;
 const owned=(id:string,original?:Thread)=>{
  if(o.closed())return;
  const t=thread(db,id);
  if(!t||!mayUseThread({kind:'member',id:t.member},t,o.sharing()))return;
  const columns=db.prepare('SELECT member,agent,project FROM comms_threads WHERE id=?').get(id) as {member:string;agent:string;project:string|null};
  if(columns.member!==t.member||columns.agent!==t.agent||(columns.project??undefined)!==t.project)return;
  if(original&&(t.member!==original.member||t.agent!==original.agent||t.conversation!==original.conversation||t.project!==original.project))return;
  return t;
 };
 // Capture ids only. Concurrent appends already index themselves.
 const ids=db.prepare("SELECT thread,seq FROM comms_messages WHERE kind IN ('message','reply') AND words IS NOT NULL AND at>? ORDER BY thread,seq").all(clock.now()-o.days*86400_000) as {thread:string;seq:number}[];
 const get=db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?');
 for(const id of ids){
  if(o.closed())return false;
  const original=owned(id.thread);if(!original)continue;
  const row=get.get(id.thread,id.seq) as MessageRow|undefined;
  if(!row?.words||row.at+o.days*86400_000<=clock.now()||!['message','reply'].includes(row.kind))continue;
  const plain=await o.key.open(row.words);
  if(!owned(id.thread,original))continue;
  const encoding=JSON.parse(row.record).encoding;
  const text=encoding==='text'?plain:JSON.parse(plain).text;
  if(text!==null&&text!==undefined&&typeof text!=='string')throw new Error('Invalid Comms message text');
  db.transaction(()=>{
   if(!owned(id.thread,original))return;
   const current=get.get(id.thread,id.seq) as MessageRow|undefined;
   if(!current?.words||current.at+o.days*86400_000<=clock.now()||current.id!==row.id||current.kind!==row.kind||current.at!==row.at||current.sender!==row.sender||current.hash!==row.hash||!current.words.equals(row.words!)||JSON.parse(current.record).encoding!==encoding)return;
   if(typeof text==='string')indexRefs(db,id.thread,row.seq,row.at,refsIn(text));
  })();
 }
 if(o.closed())return false;
 db.prepare("INSERT INTO comms_meta(key,value) VALUES ('refs_backfilled',?) ON CONFLICT(key) DO NOTHING").run(String(clock.now()));
 for(const id of new Set(ids.map(row=>row.thread)))if(owned(id))o.changed(id);
 return true;
}
