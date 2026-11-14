/** Word-free, bounded write-time references. Never read message history on a view. */
import type {Db} from '../../core/index.js';
export const MAX_REFS=200;
export { refsIn } from '../../core/conversations/refs.js';
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
 (SELECT ref FROM comms_refs WHERE thread=? ORDER BY seq DESC,pos DESC,ref ASC LIMIT ?)`).run(thread,thread,MAX_REFS);
}
