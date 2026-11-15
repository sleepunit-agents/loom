/** Versioned encrypted briefs in the existing Inbox words cell. No new word store. */
import {z} from 'zod';
import {and,eq,isNotNull,sql} from 'drizzle-orm';
import type {DataDatabase} from '../data/database.js';
import {inbox} from '../data/schema.js';
import type {WordsKey} from './words.js';
import {wordsDeadline} from './retention.js';
const prefix='loom:handoff:v1:';
const envelope=z.object({cipher:z.string().min(1).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),keepUntil:z.iso.datetime()}).strict();
export function handoffEnvelope(words:string|null){
 if(!words?.startsWith(prefix))return undefined;
 return envelope.parse(JSON.parse(words.slice(prefix.length)));
}
function deadline(at:string,keepUntil:unknown,days:number):number{
 if(!Number.isInteger(days)||days<1||days>14||typeof keepUntil!=='string')return -Infinity;
 const value=wordsDeadline({at,keepUntil},days);return Number.isFinite(value)?value:-Infinity;
}
export function handoffDeadline(item:{words:string|null;at:string},days:number):number{
 let value:ReturnType<typeof handoffEnvelope>;try{value=handoffEnvelope(item.words);}catch{return -Infinity;}
 return deadline(item.at,value?.keepUntil,days);
}
/** Timer scheduling needs only deadline metadata, never the large ciphertext. */
export function handoffExpiries(db:DataDatabase,days:number){
 const json=sql`substr(${inbox.words},${prefix.length+1})`;
 return db.select({id:inbox.id,at:inbox.at,until:sql<unknown>`case when substr(${inbox.words},1,${prefix.length})=${prefix} and json_valid(${json}) then json_extract(${json},'$.keepUntil') else null end`}).from(inbox).where(and(eq(inbox.source,'handoff'),isNotNull(inbox.words))).all().map(row=>({id:row.id,until:deadline(row.at,row.until,days)}));
}
export async function sealHandoff(key:WordsKey,words:string,at:string,days:number):Promise<string>{
 if(!Number.isInteger(days)||days<1||days>14)throw Error('Invalid keep time');
 const keepUntil=new Date(Date.parse(at)+days*86400000).toISOString();
 return prefix+JSON.stringify({cipher:(await key.seal(words)).toString('base64'),keepUntil});
}
