/** Retained private questions/answers without inventing a Comms thread. */
import {z} from 'zod';
import {and,eq,isNotNull,isNull,inArray,sql} from 'drizzle-orm';
import type {DataDatabase} from '../data/database.js';
import {inbox} from '../data/schema.js';
import type {WordsKey} from './words.js';
import {ageLimit,keepUntilFor,validKeepDays,wordsDeadline} from './retention.js';
const prefix='loom:private-inbox:v1:';
const envelope=z.object({cipher:z.string().min(1).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),keepUntil:z.iso.datetime()}).strict();
const question=z.object({words:z.string(),why:z.string().nullish(),ifYes:z.string().nullish(),ifNo:z.string().nullish(),link:z.string().nullish()}).strict();
export const privateInboxQuestion=(words:string)=>question.parse(JSON.parse(words));
export const hasPrivateInboxWords=(words:string|null)=>!!words?.startsWith(prefix);
export function hasPrivateInboxPayload(db:DataDatabase,item:typeof inbox.$inferSelect):boolean{
 if(item.thread||!item.conversation||!item.member||!hasPrivateInboxWords(item.words))return false;
 if(item.source==='thread')return !!item.answers&&item.toKind==='person'&&item.to===item.member&&item.fromKind==='agent'&&item.fromId===item.agent;
 if(item.source!=='answer'||!item.sourceId)return false;
 const q=db.select().from(inbox).where(eq(inbox.id,item.sourceId)).get();
 return !!q&&isPrivateInboxQuestion(q)&&privateInboxAnswer(db,q)?.id===item.id;
}
export const isPrivateInboxQuestion=(item:Pick<typeof inbox.$inferSelect,'thread'|'conversation'|'member'|'source'>)=>!item.thread&&!!item.conversation&&!!item.member&&item.source==='thread';
export function privateInboxEnvelope(words:string|null){return hasPrivateInboxWords(words)?envelope.parse(JSON.parse(words!.slice(prefix.length))):undefined;}
export function privateInboxDeadline(item:{words:string|null;at:string},days:number):number{
 try{const value=privateInboxEnvelope(item.words);if(!value)return -Infinity;const at=wordsDeadline({at:item.at,keepUntil:value.keepUntil},days);return Number.isFinite(at)?at:-Infinity;}catch{return -Infinity;}
}
export async function sealPrivateInbox(key:WordsKey,words:string,at:string,days:number){
 if(!validKeepDays(days))throw Error('Invalid keep time');
 return prefix+JSON.stringify({cipher:(await key.seal(words)).toString('base64'),keepUntil:keepUntilFor(at,days)});
}
export function privateInboxExpiries(db:DataDatabase,days:number){
 const json=sql`substr(${inbox.words},${prefix.length+1})`;
 const rows=db.select({id:inbox.id,at:inbox.at,until:sql<unknown>`case when json_valid(${json}) then json_extract(${json},'$.keepUntil') else null end`})
  .from(inbox).where(and(isNotNull(inbox.words),isNotNull(inbox.member),isNotNull(inbox.conversation),isNull(inbox.thread),inArray(inbox.source,['thread','answer']),sql`substr(${inbox.words},1,${prefix.length})=${prefix}`,
   sql`((${inbox.source}='thread' and ${inbox.answers} is not null and ${inbox.toKind}='person' and ${inbox.to}=${inbox.member} and ${inbox.fromKind}='agent' and ${inbox.fromId}=${inbox.agent}) or (${inbox.source}='answer' and exists(select 1 from inbox q where q.id=${inbox.sourceId} and q.source='thread' and q.waits_on_kind is null and q.waits_on_id is null and q.thread is null and q.to_kind='person' and q."to"=q.member and q.answers is not null and q.answer is not null and q.answered_at is not null and q.state='answered' and q.from_kind='agent' and q.from_id=q.agent and q.agent=${inbox.agent} and q.member=${inbox.member} and q.project is ${inbox.project} and q.conversation=${inbox.conversation} and q.answered_by=${inbox.fromId} and ${inbox.toKind}='agent' and ${inbox.to}=q.agent and ${inbox.fromKind}='person')))`,
  )).all();
 return rows.map(row=>{
  const stored=typeof row.until==='string'?wordsDeadline({at:row.at,keepUntil:row.until},days):NaN;
  // Malformed private storage fails closed until its independently known age
  // cap. It is never silently discarded at creation as ordinary authored text.
  const until=Number.isFinite(stored)?stored:ageLimit(Date.parse(row.at),days);
  return {id:row.id,until:Number.isFinite(until)?until:-Infinity};
 });
}
/** Bind an answer to the recorded responder, exact conversation and labels. */
export function privateInboxAnswer(db:DataDatabase,q:typeof inbox.$inferSelect){
 if(q.thread||!q.member||!q.conversation||!q.agent||q.source!=='thread'||q.waitsOnKind||q.waitsOnId||q.fromKind!=='agent'||q.fromId!==q.agent||q.toKind!=='person'||q.to!==q.member||q.state!=='answered'||!q.answers||!q.answer||!q.answeredBy||!q.answeredAt)return undefined;
 const row=db.select().from(inbox).where(and(eq(inbox.source,'answer'),eq(inbox.sourceId,q.id),eq(inbox.toKind,'agent'),eq(inbox.to,q.agent),eq(inbox.conversation,q.conversation))).get();
 return row&&!row.thread&&row.fromKind==='person'&&row.fromId===q.answeredBy&&row.member===q.member&&row.project===q.project&&row.agent===q.agent&&(row.words===null||hasPrivateInboxWords(row.words))?row:undefined;
}
