/** Versioned encrypted briefs in the existing Inbox words cell. No new word store. */
import {z} from 'zod';
import type {WordsKey} from './words.js';
import {wordsDeadline} from './retention.js';
const prefix='loom:handoff:v1:';
const envelope=z.object({cipher:z.string().min(1).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),keepUntil:z.iso.datetime()}).strict();
export function handoffEnvelope(words:string|null){
 if(!words?.startsWith(prefix))return undefined;
 return envelope.parse(JSON.parse(words.slice(prefix.length)));
}
export function handoffDeadline(item:{words:string|null;at:string},days:number):number{
 if(!Number.isInteger(days)||days<1||days>14)return -Infinity;
 let value:ReturnType<typeof handoffEnvelope>;try{value=handoffEnvelope(item.words);}catch{return -Infinity;}
 return value?wordsDeadline({at:item.at,keepUntil:value.keepUntil},days):Infinity;
}
export async function sealHandoff(key:WordsKey,words:string,at:string,days:number):Promise<string>{
 if(!Number.isInteger(days)||days<1||days>14)throw Error('Invalid keep time');
 const keepUntil=new Date(Date.parse(at)+days*86400000).toISOString();
 return prefix+JSON.stringify({cipher:(await key.seal(words)).toString('base64'),keepUntil});
}
