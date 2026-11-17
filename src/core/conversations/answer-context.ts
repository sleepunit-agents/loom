/** Ephemeral context for an answer to this conversation's own plain question.
 * No words are copied into a new message, Inbox row, job or receipt. */
import {and,eq} from 'drizzle-orm';
import {inbox,messages,threads} from '../data/schema.js';
import type {CommsMessages} from './messages.js';
import {wordsDeadline} from './retention.js';
import {privateInboxAnswer,privateInboxDeadline,privateInboxEnvelope,privateInboxQuestion,hasPrivateInboxPayload} from './private-inbox-words.js';
import { commsKeepDays } from '../data/comms-days.js';
type Item=typeof inbox.$inferSelect;
export type AnswerQuestion={words:string;why:string|null;ifYes:string|null;ifNo:string|null;link:string|null};
export type AnswerContext={question:AnswerQuestion;until:number};
export async function prepareAnswerContext(comms:CommsMessages,answer:Item):Promise<()=>AnswerContext|null>{
 const {db}=comms;
 if(answer.source==='answer'&&!answer.thread&&answer.sourceId&&hasPrivateInboxPayload(db,answer)){
  const snapshot=()=>{const q=db.select().from(inbox).where(eq(inbox.id,answer.sourceId!)).get();return q&&privateInboxAnswer(db,q)?.id===answer.id?q:undefined;};
  const before=snapshot(),days=()=>commsKeepDays(db);
  if(!before||privateInboxDeadline(before,days())<=Date.parse(comms.now()))return()=>null;
  const envelope=privateInboxEnvelope(before.words);if(!envelope)return()=>null;
  const value=privateInboxQuestion(await comms.key.open(Buffer.from(envelope.cipher,'base64')));
  const question:AnswerQuestion={words:value.words,why:value.why??null,ifYes:value.ifYes??null,ifNo:value.ifNo??null,link:value.link??null};
  return()=>{const after=snapshot();if(!after||privateInboxDeadline(after,days())<=Date.parse(comms.now()))return null;if(JSON.stringify(after)!==JSON.stringify(before))throw Error('Question context changed; prepare again');return {question,until:privateInboxDeadline(after,days())};};
 }
 if(answer.source!=='answer'||!answer.thread||answer.messageSeq===null||!answer.sourceId||answer.fromKind!=='person'||!answer.fromId)return()=>null;
 const snapshot=()=>{
  const q=db.select().from(inbox).where(eq(inbox.id,answer.sourceId!)).get();
  if(!q||q.source!=='thread'||q.waitsOnKind||q.waitsOnId||q.toKind!=='person'||q.to!==answer.fromId||q.fromKind!=='agent'||q.fromId!==answer.to
   ||q.state!=='answered'||q.answeredBy!==answer.fromId||!q.answer||!q.answers||q.thread!==answer.thread
   ||(['conversation','agent','member','project'] as const).some(field=>q[field]!==answer[field]))return;
  if(!q.thread)return;
  const row=db.select({message:messages,conversation:threads.conversation}).from(messages).innerJoin(threads,eq(threads.id,messages.thread))
   .where(and(eq(messages.thread,q.thread),eq(messages.seq,q.messageSeq??-1),eq(messages.inboxItem,q.id))).get();
  if(!row||row.conversation!==answer.conversation||row.message.kind!=='ask'||row.message.sender!==answer.to)return;
  const reply=db.select().from(messages).where(and(eq(messages.thread,answer.thread!),eq(messages.seq,answer.messageSeq!),eq(messages.inboxItem,answer.id))).get();
  if(!reply||reply.kind!=='answer'||reply.sender!==answer.fromId||(['yes','no'].includes(q.answer??'')&&reply.verdict!==q.answer))return;
  return {q,message:row.message,reply};
 };
 const before=snapshot();if(!before)return()=>null;
 const deadline=(state:NonNullable<ReturnType<typeof snapshot>>)=>{
  const days=commsKeepDays(db);
  return Number.isInteger(days)&&days>=1&&days<=14?wordsDeadline(state.message,days):NaN;
 };
 if(!(deadline(before)>Date.parse(comms.now())))return()=>null;
 let text:string|null;
 try{text=await comms.words(before.message.thread,before.message.seq);}catch{return()=>null;}
 if(text===null)return()=>null;
 let question:AnswerQuestion;
 try{
  const value:unknown=JSON.parse(text);
  if(!value||typeof value!=='object'||!('words'in value)||typeof value.words!=='string')return()=>null;
  question={words:value.words,why:null,ifYes:null,ifNo:null,link:null};
  for(const field of ['why','ifYes','ifNo','link'] as const){
   const text=(value as Record<string,unknown>)[field];
   if(text!==null&&text!==undefined&&typeof text!=='string')return()=>null;
   question[field]=typeof text==='string'?text:null;
  }
 }catch{return()=>null;}
 return()=>{
  const after=snapshot();
  if(!after||!after.message.words)return null;
  const until=deadline(after);
  if(!(until>Date.parse(comms.now())))return null;
  if(JSON.stringify(after)!==JSON.stringify(before))throw Error('Question context changed; prepare again');
  return until>Date.parse(comms.now())?{question,until}:null;
 };
}
