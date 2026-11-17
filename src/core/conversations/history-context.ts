/** Retained ordinary dialogue, never a second store or a way around delivery volume. */
import {and,desc,eq,lt} from 'drizzle-orm';
import {conversations,inbox,messages,threads} from '../data/schema.js';
import type {CommsMessages} from './messages.js';
import {wordsDeadline} from './retention.js';
import { commsKeepDays } from '../data/comms-days.js';
import { HISTORY_BYTES, HISTORY_LINES } from './history-limit.js';
/** `keepUntil` is when the words will be erased; null for words kept without limit (a bridge room's). */
export type HistoryLine={seq:number;kind:'message'|'reply';sender:string;at:string;words:string;keepUntil:string|null};
export async function prepareHistoryContext(comms:CommsMessages,conversation:string,beforeSeq:number):Promise<()=>HistoryLine[]>{
 const {db}=comms,thread=db.select().from(threads).where(eq(threads.conversation,conversation)).get();
 const cv=db.select().from(conversations).where(eq(conversations.id,conversation)).get();
 if(!thread||!cv)return()=>[];
 const days=()=>commsKeepDays(db);
 const deadline=(row:typeof messages.$inferSelect)=>wordsDeadline(row,days());
 // Questions and answers belong exclusively to the validated answer-context path.
 // Person words may recur only after an earlier body accepted their Full delivery.
 const deliveryFingerprint=(row:typeof messages.$inferSelect)=>{
  if(row.kind==='reply'&&row.sender===cv.agent&&!row.inboxItem)return 'reply';
  if(row.kind!=='message'||row.sender!==cv.member||!row.inboxItem)return null;
  const item=db.select().from(inbox).where(eq(inbox.id,row.inboxItem)).get();
  return item&&item.conversation===conversation&&item.thread===row.thread&&item.messageSeq===row.seq&&item.source==='thread'
   &&item.toKind==='agent'&&item.to===cv.agent&&item.fromKind==='person'&&item.fromId===row.sender
   &&item.state==='done'&&item.volume==='full'&&item.takenVolume==='full'?JSON.stringify(item):null;
 };
 const rows=db.select().from(messages).where(and(eq(messages.thread,thread.id),lt(messages.seq,beforeSeq))).orderBy(desc(messages.seq)).limit(HISTORY_LINES).all();
 const prepared:{snapshot:typeof messages.$inferSelect;delivery:string;words:string}[]=[];let bytes=2;
 for(const row of rows){
  const acceptedFingerprint=deliveryFingerprint(row);
  if(!acceptedFingerprint||!row.words||!(deadline(row)>Date.parse(comms.now())))continue;
  let words:string|null;try{words=await comms.words(row.thread,row.seq);}catch{continue;}
  if(words===null||!(deadline(row)>Date.parse(comms.now())))continue;
  const line={seq:row.seq,kind:row.kind,sender:row.sender,at:row.at,words,keepUntil:new Date(deadline(row)).toISOString()};
  const size=Buffer.byteLength(JSON.stringify(line))+(prepared.length?1:0);
  if(bytes+size>HISTORY_BYTES)break;
  bytes+=size;prepared.push({snapshot:row,delivery:acceptedFingerprint,words});
 }
 return()=>{
  const currentThread=db.select().from(threads).where(eq(threads.id,thread.id)).get();
  if(currentThread?.conversation!==conversation)throw Error('Dialogue changed; take again');
  return prepared.flatMap(({snapshot,delivery:acceptedFingerprint,words})=>{
   const current=db.select().from(messages).where(and(eq(messages.thread,snapshot.thread),eq(messages.seq,snapshot.seq))).get();
   // Optional old context that moved during preparation is omitted; the independently
   // retained current input can still proceed. Never publish the stale snapshot.
   if(!current?.words||!(deadline(current)>Date.parse(comms.now()))||JSON.stringify(current)!==JSON.stringify(snapshot)||deliveryFingerprint(current)!==acceptedFingerprint)return[];
   if(current.kind!=='message'&&current.kind!=='reply')return[];
   return[{seq:current.seq,kind:current.kind,sender:current.sender,at:current.at,words,keepUntil:new Date(deadline(current)).toISOString()}];
  }).reverse();
 };
}
