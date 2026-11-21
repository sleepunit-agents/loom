import { discordBodyWords } from '../../pieces/bridges/discord-link.js';
import {handoffPeersAssigned} from './handoff-access.js';
import {handoffDeadline} from './handoff-words.js';
import {hasPrivateInboxPayload,privateInboxDeadline,privateInboxAnswer} from './private-inbox-words.js';
/** Body-only ephemeral mail. No operation receipt, job brief or shared cache ever
 * carries words. Confirming acceptance is a separate acknowledgement write.
 * This is a route of its own and not a registered operation, on purpose: an
 * operation keeps its result as a retry receipt, and this result is the mail's
 * decrypted words. The checks it makes in an operation's place are listed in
 * docs/accepted-tradeoffs.md ("Taking mail is a route, not an operation"). */
import { sameRequestOrigin } from '../data/origin.js';
import { z } from 'zod';
import { and,eq,inArray } from 'drizzle-orm';
import type { Authentication } from '../live/index.js';
import { failure } from '../operations/index.js';
import type { DataWrites } from '../data/writes.js';
import { guardedResponse } from '../data/guarded-response.js';
import { bridgeIncoming, inbox, inboxRefs, messages, threads } from '../data/schema.js';
import {constrainJobSession} from './sessions.js';
import { ageCutoff, ageLimit, wordsDeadline } from './retention.js';
import type { CommsMessages } from './messages.js';
import { ConversationMail } from './mail.js';
import type { conversationBodyScope } from './body-scope.js';
import { commsKeepDays } from '../data/comms-days.js';
const input=z.object({input:z.object({historyKeys:z.literal(true).optional(),limit:z.number().int().min(1).max(100).default(50)}).strict()}).strict();
export function sameMailScope(item:{agent:string|null;member:string|null;project:string|null},cv:{agent:string;member:string|null;project:string|null}):boolean {
 return item.agent===cv.agent&&item.member===cv.member&&item.project===cv.project;
}
export async function takeBodyInput(options:{request:Request;service:CommsMessages;scope:ReturnType<typeof conversationBodyScope>;authenticate(request:Request):Authentication|undefined;admitted():boolean;version():number;writes:DataWrites;now():number;publicOrigin?:string;reportError(error:unknown):void}):Promise<Response>{
 const refuse=(status:number,message:string)=>Response.json(failure(status===400?'invalid':status===403?'denied':'unavailable',message),{status,headers:{'cache-control':'no-store'}});
 if(!options.admitted())return refuse(503,'Loom is closing');
 const request=options.request;
 if(!sameRequestOrigin(request,options.publicOrigin))return refuse(403,'Cross-origin request refused');
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return refuse(400,'Use application/json');
 const auth=options.authenticate(request);if(!auth||!auth.valid()||!options.admitted())return refuse(403,'Current body required');
 let parsed:z.infer<typeof input>;try{parsed=input.parse(await request.json());}catch{return refuse(400,'Expected ephemeral input without an operation id');}
 if(!options.admitted()||!auth.valid()||!options.admitted())return refuse(403,'Authentication ended');
 const before=options.scope(auth.viewer);if(!before||!options.admitted())return refuse(403,'Current conversation body required');
 let mailAccess=()=>true;
 const active=()=>{
  if(!options.admitted()||!auth.valid()||!options.admitted())return false;
  const current=options.scope(auth.viewer);
  return options.admitted()&&mailAccess()&&!!current&&current.job.id===before.job.id&&['id','agent','project','member','venue','place','direct'].every(key=>current.cv[key as keyof typeof current.cv]===before.cv[key as keyof typeof before.cv]);
 };
 try {
  const {db}=options.service,mail=new ConversationMail(options.service),cvs=options.service.threads.conversations;
  // Validate the exact pending prefix before opening any private ciphertext.
  const prefix=cvs.pending(before.cv.id,before.job.id).slice(0,parsed.input.limit);
  mailAccess=()=>before.cv.member!==null||prefix.every(item=>item.source!=='handoff'||item.fromKind==='agent'&&item.fromId!==null&&
   // A note from another body of this same agent (handoff.ts, `to`) is its own mail: there is no peer to be assigned with.
   (item.fromId===before.cv.agent||handoffPeersAssigned(db,item.fromId,before.cv.agent,before.cv.project)));
  if(prefix.some(item=>!sameMailScope(item,before.cv)))return refuse(403,'Mail scope differs');
  if(!active())return refuse(403,'Authentication ended');
  const prepared=await mail.prepareTake(before.cv.id,before.job.id,parsed.input.limit,parsed.input.historyKeys);
  if(!active())return refuse(403,'Authentication ended');
  // This outer claim publishes exactly one shared epoch, or none when it wrote
  // no row (nothing waited, or the same prefix is taken again). Any reentrant
  // postcommit mutation invalidates the prepared words before byte release.
  const base=options.version();
  const committed=options.writes.run(()=>{
   const deliveries=prepared();
   const refs=deliveries.length?db.select().from(inboxRefs).where(inArray(inboxRefs.item,deliveries.map(row=>row.item.id))).all():[];
   const privateBridge=(before.cv.member!==null||before.cv.direct)&&(before.cv.venue==='slack'||before.cv.venue==='discord');
   const received=new Map<string,number>();
   if(privateBridge && refs.length){
    const arrivals=db.select({id:bridgeIncoming.id,at:bridgeIncoming.receivedAt}).from(bridgeIncoming)
     .where(and(eq(bridgeIncoming.conversation,before.cv.id),eq(bridgeIncoming.state,'delivered'),inArray(bridgeIncoming.id,refs.map(ref=>ref.ref)))).all();
    for(const row of arrivals)received.set(row.id,Date.parse(row.at));
   }
   const days=commsKeepDays(db);
   let until=Infinity, since=Infinity;
   const items=deliveries.map(({item,words,answerContext,history})=>{
    if(before.cv.venue==='discord'){
     if(item.source==='discord'&&words!==null)words=discordBodyWords(words);
     if(history)history=history.map(line=>({...line,words:discordBodyWords(line.words)}));
    }
    const itemRefs=refs.filter(ref=>ref.item===item.id).map(ref=>ref.ref);
    let keepUntil:string|null=null,verdict:string|null=null;
    if(privateBridge && item.source===before.cv.venue && words!==null){
     // A held DM can be received before its Inbox copy is created. The transcript
     // contains the same words, so it inherits the earlier of those two limits.
     const first=Math.min(Date.parse(item.at),...itemRefs.map(ref=>received.get(ref)??Infinity));
     const deadline=ageLimit(first,days);
     if(deadline>options.now()){
      since=Math.min(since,first);until=Math.min(until,deadline);keepUntil=new Date(deadline).toISOString();
     }else words=null;
    }
    if(item.thread&&item.messageSeq!==null){
     const message=db.select().from(messages).where(and(eq(messages.thread,item.thread),eq(messages.seq,item.messageSeq),eq(messages.inboxItem,item.id))).get();
     if(!message)throw Error('Mail reference changed');verdict=message.verdict;
     if(words!==null)since=Math.min(since,Date.parse(message.at));
     if(words!==null){const deadline=wordsDeadline(message,days);until=Math.min(until,deadline);keepUntil=Number.isFinite(deadline)?new Date(deadline).toISOString():null;}
    }
    if(!item.thread&&item.source==='handoff'&&words!==null){const deadline=handoffDeadline(item,days);until=Math.min(until,deadline);if(Number.isFinite(deadline))keepUntil=new Date(deadline).toISOString();}
    if(hasPrivateInboxPayload(db,item)&&words!==null){const deadline=privateInboxDeadline(item,days);until=Math.min(until,deadline);if(Number.isFinite(deadline))keepUntil=new Date(deadline).toISOString();
    }
    if(item.source==='answer'&&item.sourceId&&item.member&&!item.thread){const q=db.select().from(inbox).where(eq(inbox.id,item.sourceId)).get();if(q?.source==='thread'&&q.state==='answered'&&!q.waitsOnKind&&!q.waitsOnId){if(privateInboxAnswer(db,q)?.id!==item.id)throw Error('Answer reference changed');verdict=q.answer==='yes'||q.answer==='no'?q.answer:null;}}
    if(keepUntil!==null)since=Math.min(since,Date.parse(item.at));
    if(answerContext){since=Math.min(since,Date.parse(answerContext.at));if(!Number.isFinite(answerContext.until))throw Error('Question context needs its deadline');until=Math.min(until,answerContext.until);}
    for(const line of history??[])if(line.keepUntil!==null){
     until=Math.min(until,Date.parse(line.keepUntil));
     // Bridge history displays the provider's posted time. Its deadline is dated
     // by Loom's receipt (or send) and the keep period in this same transaction.
     const dated=privateBridge?ageCutoff(line.keepUntil,days):line.at;
     since=Math.min(since,Date.parse(dated));
    }
    return {...(history?.length?{history}:{}),...(answerContext?{question:answerContext.question,questionKeepUntil:new Date(answerContext.until).toISOString()}:{}),id:item.id,seq:item.seq,source:item.source,sourceId:item.sourceId,fromKind:item.fromKind,fromId:item.fromId,at:item.at,words,keepUntil,verdict,refs:itemRefs};
   });
   if(Number.isFinite(until))constrainJobSession(db,before.job.id,since,until);
   return {items,until};
  });
  for(const _error of committed.notificationErrors){try{options.reportError(new Error('Body input notification failed'));}catch{}}
  const expected=options.version();
  if(!active()||expected>base+1)return refuse(503,'Mail changed; take it again');
  const {items,until}=committed.value;
  const thread=db.select({stop:threads.stopRequested}).from(threads).where(eq(threads.conversation,before.cv.id)).get();
  const payload=JSON.stringify({ok:true,value:{job:before.job.id,conversation:before.cv.id,items,stopRequested:thread?.stop??false}});
  const available=()=>active()&&options.version()===expected&&options.now()<until&&options.admitted();
  if(!available())return refuse(503,'Mail changed; take it again');
  return guardedResponse(payload,{status:200,headers:{'content-type':'application/json','cache-control':'no-store'}},available);
 }catch{if(options.admitted()){try{options.reportError(new Error('Body input could not complete'));}catch{}}return refuse(503,'Body input could not complete');}
}
