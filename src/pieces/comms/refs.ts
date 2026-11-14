/** Word-free, bounded write-time references. Never read message history on a view. */
import type {Db} from '../../core/index.js';
export function refsIn(text:string):string[] {
 const out=new Set<string>();
 const re=/\b(t-\d{1,9})\b|(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d{1,10})\b|(?:^|\s)note:([\w./-]+)/g;
 for(let m;(m=re.exec(text));){
  if(m[1])out.add(m[1]);
  else if(m[4])out.add(`github:${m[2]}/${m[3]}#${m[4]}`);
  else {const path=m[5].replace(/[./]+$/,'');if(path&&!path.split('/').includes('..'))out.add(`note:${path}`);}
 }
 return [...out].filter(ref=>ref.length<=200);
}
export interface ThreadRef {ref:string;seq:number;pos:number;at:number}
export function refsOf(db:Db,thread:string):ThreadRef[] {
 return db.prepare('SELECT ref,seq,pos,at FROM comms_refs WHERE thread=? ORDER BY seq DESC,pos DESC').all(thread) as ThreadRef[];
}
/** Caller owns the same transaction as the message append. Older imports cannot
 * replace a newer mention. No title, status or message words are stored here. */
export function indexRefs(db:Db,thread:string,seq:number,at:number,refs:readonly string[]) {
 const up=db.prepare(`INSERT INTO comms_refs(thread,ref,seq,pos,at) VALUES (?,?,?,?,?)
 ON CONFLICT(thread,ref) DO UPDATE SET seq=excluded.seq,pos=excluded.pos,at=excluded.at WHERE excluded.seq>comms_refs.seq`);
 [...new Set(refs)].filter(ref=>ref.length<=200).forEach((ref,pos)=>up.run(thread,ref,seq,pos,at));
 db.prepare(`DELETE FROM comms_refs WHERE thread=? AND ref NOT IN
 (SELECT ref FROM comms_refs WHERE thread=? ORDER BY seq DESC,pos DESC,ref ASC LIMIT 200)`).run(thread,thread);
}
