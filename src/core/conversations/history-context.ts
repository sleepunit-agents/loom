import {workNotice,readableWorkNotice} from './work-discussion.js';
/** Retained ordinary dialogue, never a second store or a way around delivery volume. */
import {standaloneFyi} from './inbox-discussion.js';
import {and,desc,eq,lt} from 'drizzle-orm';
import {conversations,inbox,messages,threads} from '../data/schema.js';
import type {CommsMessages} from './messages.js';
import {wordsDeadline} from './retention.js';
import { commsKeepDays } from '../data/comms-days.js';
import { HISTORY_BYTES, HISTORY_LINES } from './history-limit.js';
/** `keepUntil` is when the words will be erased; null for words kept without limit (a bridge room's).
 * `sourceKey`, given when the body asks for keys (`identify`), names what a line is of, so that a body continuing a
 * kept harness session is told only the lines that session does not hold (runtime/body-program.ts): a member's
 * message by the mail it was delivered as, everything one job said by that job (`threadRunKey`), anything else by
 * its place in the thread. */
export const threadRunKey=(job:string)=>'run:'+job;
export type HistoryLine={sourceKey?:string;seq:number;kind:'message'|'reply'|'notice';sender:string;at:string;words:string;keepUntil:string|null};
export async function prepareHistoryContext(comms:CommsMessages,conversation:string,beforeSeq:number,identify=false):Promise<()=>HistoryLine[]>{
 const {db}=comms,thread=db.select().from(threads).where(eq(threads.conversation,conversation)).get();
 const cv=db.select().from(conversations).where(eq(conversations.id,conversation)).get();
 if(!thread||!cv)return()=>[];
 const days=()=>commsKeepDays(db);
 const deadline=(row:typeof messages.$inferSelect)=>wordsDeadline(row,days());
 // Questions and answers belong exclusively to the validated answer-context path.
 // Person words may recur only after an earlier body accepted their Full delivery.
 const deliveryFingerprint=(row:typeof messages.$inferSelect)=>{
  if(workNotice(row) && cv.venue==='loom' && cv.member && !row.inboxItem)return 'work.subject';
  if(row.kind==='notice' && row.sender==='loom' && row.seq===1 && row.inboxItem) {
   const source=db.select().from(inbox).where(eq(inbox.id,row.inboxItem)).get();
   return cv.venue==='loom' && !cv.project && source && standaloneFyi(source,cv.member) ? source.id : null;
  }
  if(row.kind==='reply'&&row.sender===cv.agent&&!row.inboxItem)return 'reply';
  if(row.kind!=='message'||row.sender!==cv.member||!row.inboxItem)return null;
  const item=db.select().from(inbox).where(eq(inbox.id,row.inboxItem)).get();
  return item&&item.conversation===conversation&&item.thread===row.thread&&item.messageSeq===row.seq&&item.source==='thread'
   &&item.toKind==='agent'&&item.to===cv.agent&&item.fromKind==='person'&&item.fromId===row.sender
   &&item.state==='done'&&item.volume==='full'&&item.takenVolume==='full'?JSON.stringify(item):null;
 };
 const keyed=(row:typeof messages.$inferSelect)=>identify?{sourceKey:row.kind==='message'&&row.inboxItem?row.inboxItem:row.kind==='reply'&&row.run?threadRunKey(row.run):row.thread+'#'+row.seq}:{};
 const rows=db.select().from(messages).where(and(eq(messages.thread,thread.id),lt(messages.seq,beforeSeq))).orderBy(desc(messages.seq)).limit(HISTORY_LINES).all();
 // Keep the original work reference available in a busy discussion while its words are retained.
 if(thread.id.startsWith('th:work-') && rows.length===HISTORY_LINES && rows.at(-1)?.seq!==1) {
   const first=db.select().from(messages).where(and(eq(messages.thread,thread.id),eq(messages.seq,1))).get();
   if(first && workNotice(first) && first.words && deadline(first)>Date.parse(comms.now())) {
     rows.pop(); rows.unshift(first);
   }
 }
 const prepared:{snapshot:typeof messages.$inferSelect;delivery:string;words:string}[]=[];let bytes=2;
 for(const row of rows){
  const acceptedFingerprint=deliveryFingerprint(row);
  if(!acceptedFingerprint||!row.words||!(deadline(row)>Date.parse(comms.now())))continue;
  let words:string|null;try{words=await comms.words(row.thread,row.seq);}catch{continue;}
  if(words===null||!(deadline(row)>Date.parse(comms.now())))continue;
  const line={...keyed(row),seq:row.seq,kind:row.kind,sender:row.sender,at:row.at,words,keepUntil:new Date(deadline(row)).toISOString()};
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
   if(workNotice(current) && (!cv.member || !readableWorkNotice(db,{kind:'member',id:cv.member},words)
     || !readableWorkNotice(db,{kind:'agent',id:cv.agent,workingFor:cv.member},words)))return[];
   if(current.kind!=='message'&&current.kind!=='reply'&&current.kind!=='notice')return[];
   return[{...keyed(current),seq:current.seq,kind:current.kind,sender:current.sender,at:current.at,words,keepUntil:new Date(deadline(current)).toISOString()}];
  }).sort((a,b)=>a.seq-b.seq);
 };
}
