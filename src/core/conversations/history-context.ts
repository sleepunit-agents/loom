/** Retained dialogue for a fresh receiving body, never a second stored copy. */
import {and,desc,eq,lt} from 'drizzle-orm';
import {household,messages,threads} from '../data/schema.js';
import type {CommsMessages} from './messages.js';
import {wordsDeadline} from './retention.js';
export type HistoryLine={seq:number;kind:typeof messages.$inferSelect.kind;sender:string;at:string;words:string;keepUntil:string};
export async function prepareHistoryContext(comms:CommsMessages,conversation:string,beforeSeq:number,answerQuestions:ReadonlySet<string>):Promise<()=>HistoryLine[]>{
 const {db}=comms,thread=db.select().from(threads).where(eq(threads.conversation,conversation)).get();
 if(!thread)return()=>[];
 const days=()=>db.select({days:household.commsDays}).from(household).get()?.days??14;
 const deadline=(row:typeof messages.$inferSelect)=>{const count=days();return Number.isInteger(count)&&count>=1&&count<=14?wordsDeadline(row,count):NaN;};
 const rows=db.select().from(messages).where(and(eq(messages.thread,thread.id),lt(messages.seq,beforeSeq))).orderBy(desc(messages.seq)).limit(100).all();
 const prepared:{before:typeof messages.$inferSelect;words:string}[]=[];let bytes=0;
 for(const row of rows){
  // Current answer questions use their separately validated context path.
  if(row.inboxItem&&answerQuestions.has(row.inboxItem)||!row.words||!(deadline(row)>Date.parse(comms.now())))continue;
  let words:string|null;try{words=await comms.words(row.thread,row.seq);}catch{continue;}
  if(words===null||!(deadline(row)>Date.parse(comms.now())))continue;
  // Bound the complete serialized context, including Unicode and metadata.
  const size=Buffer.byteLength(JSON.stringify({seq:row.seq,kind:row.kind,sender:row.sender,at:row.at,words,keepUntil:new Date(deadline(row)).toISOString()}))+1;
  if(bytes+size>1_048_576)break;
  bytes+=size;prepared.push({before:row,words});
 }
 return()=>{
  const currentThread=db.select().from(threads).where(eq(threads.id,thread.id)).get();
  if(currentThread?.conversation!==conversation)throw Error('Dialogue changed; take again');
  return prepared.flatMap(({before,words})=>{
   const current=db.select().from(messages).where(and(eq(messages.thread,before.thread),eq(messages.seq,before.seq))).get();
   if(!current?.words||!(deadline(current)>Date.parse(comms.now())))return[];
   if(JSON.stringify(current)!==JSON.stringify(before))throw Error('Dialogue changed; take again');
   return[{seq:current.seq,kind:current.kind,sender:current.sender,at:current.at,words,keepUntil:new Date(deadline(current)).toISOString()}];
  }).reverse();
 };
}
