/** Retained private questions/answers without inventing a Comms thread. */
import {z} from 'zod';
import {and,eq,isNotNull,sql} from 'drizzle-orm';
import type {DataDatabase} from '../data/database.js';
import {inbox} from '../data/schema.js';
import type {WordsKey} from './words.js';
import {wordsDeadline} from './retention.js';
const prefix='loom:private-inbox:v1:';
const envelope=z.object({cipher:z.string().min(1).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),keepUntil:z.iso.datetime()}).strict();
const question=z.object({words:z.string(),why:z.string().nullish(),ifYes:z.string().nullish(),ifNo:z.string().nullish(),link:z.string().nullish()}).strict();
export const privateInboxQuestion=(words:string)=>question.parse(JSON.parse(words));
export const privateInboxWords=(words:string|null)=>!!words?.startsWith(prefix);
export function privateInboxEnvelope(words:string|null){return privateInboxWords(words)?envelope.parse(JSON.parse(words!.slice(prefix.length))):undefined;}
export function privateInboxDeadline(item:{words:string|null;at:string},days:number):number{
 try{const value=privateInboxEnvelope(item.words);if(!value||!Number.isInteger(days)||days<1||days>14)return -Infinity;const at=wordsDeadline({at:item.at,keepUntil:value.keepUntil},days);return Number.isFinite(at)?at:-Infinity;}catch{return -Infinity;}
}
export async function sealPrivateInbox(key:WordsKey,words:string,at:string,days:number){
 if(!Number.isInteger(days)||days<1||days>14)throw Error('Invalid keep time');
 return prefix+JSON.stringify({cipher:(await key.seal(words)).toString('base64'),keepUntil:new Date(Date.parse(at)+days*86400000).toISOString()});
}
export function privateInboxExpiries(db:DataDatabase,days:number){
 const json=sql`substr(${inbox.words},${prefix.length+1})`;
 return db.select({id:inbox.id,at:inbox.at,until:sql<unknown>`case when json_valid(${json}) then json_extract(${json},'$.keepUntil') else null end`}).from(inbox).where(and(isNotNull(inbox.words),sql`substr(${inbox.words},1,${prefix.length})=${prefix}`)).all().map(row=>{const until=typeof row.until==='string'&&Number.isInteger(days)&&days>=1&&days<=14?wordsDeadline({at:row.at,keepUntil:row.until},days):-Infinity;return {id:row.id,until:Number.isFinite(until)?until:-Infinity};});
}
/** Bind an answer to the recorded responder, exact conversation and labels. */
export function privateInboxAnswer(db:DataDatabase,q:typeof inbox.$inferSelect){
 if(q.thread||!q.member||!q.conversation||!q.agent||q.source!=='thread'||q.fromKind!=='agent'||q.fromId!==q.agent||q.toKind!=='person'||q.to!==q.member||q.state!=='answered'||!q.answers||!q.answer||!q.answeredBy||!q.answeredAt)return undefined;
 const row=db.select().from(inbox).where(and(eq(inbox.source,'answer'),eq(inbox.sourceId,q.id),eq(inbox.toKind,'agent'),eq(inbox.to,q.agent),eq(inbox.conversation,q.conversation))).get();
 return row&&!row.thread&&row.fromKind==='person'&&row.fromId===q.answeredBy&&row.member===q.member&&row.project===q.project&&row.agent===q.agent&&(row.words===null||privateInboxWords(row.words))?row:undefined;
}
