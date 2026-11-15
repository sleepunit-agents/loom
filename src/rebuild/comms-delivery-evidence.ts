/** Inspect only the walkthrough's disposable store after a real browser Send. */
import type Database from 'better-sqlite3';
interface InboxRow {id:string;conversation:string;to_kind:string;to:string;source:string}
export function commsDeliveryEvidence(db:Pick<Database.Database,'prepare'>,expected:{thread:string;conversation:string;agent:string},receipt:{thread:string;seq:number;item:string}):{ok:boolean;count:number}{
 const rows=db.prepare('SELECT id,conversation,to_kind,"to",source FROM inbox WHERE thread=? AND message_seq=?').all(receipt.thread,receipt.seq) as InboxRow[];
 const row=rows[0];
 return {count:rows.length,ok:receipt.thread===expected.thread&&rows.length===1&&row.id===receipt.item&&row.conversation===expected.conversation&&row.to_kind==='agent'&&row.to===expected.agent&&row.source==='thread'};
}
