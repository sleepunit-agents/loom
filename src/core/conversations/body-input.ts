/** Body-only ephemeral mail. No operation receipt, job brief or shared cache ever
 * carries words. Confirming acceptance is a separate acknowledgement write. */
import { sameRequestOrigin } from '../data/origin.js';
import { z } from 'zod';
import { and,eq,inArray } from 'drizzle-orm';
import type { Authentication } from '../live/index.js';
import { failure } from '../operations/index.js';
import type { DataWrites } from '../data/writes.js';
import { guardedResponse } from '../data/guarded-response.js';
import { household,inboxRefs,messages,threads } from '../data/schema.js';
import { wordsDeadline } from './retention.js';
import type { CommsMessages } from './messages.js';
import { ConversationMail } from './mail.js';
import type { conversationBodyScope } from './body-scope.js';
const input=z.object({input:z.object({limit:z.number().int().min(1).max(100).default(50)}).strict()}).strict();
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
 const active=()=>{
  if(!options.admitted()||!auth.valid()||!options.admitted())return false;
  const current=options.scope(auth.viewer);
  return options.admitted()&&!!current&&current.job.id===before.job.id&&['id','agent','project','member','venue','place'].every(key=>current.cv[key as keyof typeof current.cv]===before.cv[key as keyof typeof before.cv]);
 };
 try {
  const {db}=options.service,mail=new ConversationMail(options.service),cvs=options.service.threads.conversations;
  // Validate the exact pending prefix before opening any private ciphertext.
  const prefix=cvs.pending(before.cv.id,before.job.id).slice(0,parsed.input.limit);
  if(prefix.some(item=>!sameMailScope(item,before.cv)))return refuse(403,'Mail scope differs');
  if(!active())return refuse(403,'Authentication ended');
  const prepared=await mail.prepareTake(before.cv.id,before.job.id,parsed.input.limit);
  if(!active())return refuse(403,'Authentication ended');
  // This outer claim publishes exactly one shared epoch. Any reentrant
  // postcommit mutation invalidates the prepared words before byte release.
  const expected=options.version()+1;
  const committed=options.writes.run(prepared),deliveries=committed.value;
  for(const _error of committed.notificationErrors){try{options.reportError(new Error('Body input notification failed'));}catch{}}
  if(!active()||options.version()!==expected)return refuse(503,'Mail changed; take it again');
  // The HTTP response projection stays next to its publication lease so every
  // private output field contributes its deadline before any bytes are released.
  // ConversationMail remains reusable by trusted in-process callers.
  const refs=deliveries.length?db.select().from(inboxRefs).where(inArray(inboxRefs.item,deliveries.map(row=>row.item.id))).all():[];
  const days=db.select({days:household.commsDays}).from(household).get()?.days??14;
  let until=Infinity;
  const items=deliveries.map(({item,words,answerContext,history})=>{
   let keepUntil:string|null=null,verdict:string|null=null;
   if(item.thread&&item.messageSeq!==null){
    const message=db.select().from(messages).where(and(eq(messages.thread,item.thread),eq(messages.seq,item.messageSeq),eq(messages.inboxItem,item.id))).get();
    if(!message)throw Error('Mail reference changed');verdict=message.verdict;
    if(words!==null){const deadline=wordsDeadline(message,days);until=Math.min(until,deadline);keepUntil=Number.isFinite(deadline)?new Date(deadline).toISOString():null;}
   }
   if(answerContext){if(!Number.isFinite(answerContext.until))throw Error('Question context needs its deadline');until=Math.min(until,answerContext.until);}
   for(const line of history??[])until=Math.min(until,Date.parse(line.keepUntil));
   return {...(history?.length?{history}:{}),...(answerContext?{question:answerContext.question,questionKeepUntil:new Date(answerContext.until).toISOString()}:{}),id:item.id,seq:item.seq,source:item.source,sourceId:item.sourceId,fromKind:item.fromKind,fromId:item.fromId,at:item.at,words,keepUntil,verdict,refs:refs.filter(ref=>ref.item===item.id).map(ref=>ref.ref)};
  });
  const thread=db.select({stop:threads.stopRequested}).from(threads).where(eq(threads.conversation,before.cv.id)).get();
  const payload=JSON.stringify({ok:true,value:{job:before.job.id,conversation:before.cv.id,items,stopRequested:thread?.stop??false}});
  const available=()=>active()&&options.version()===expected&&options.now()<until&&options.admitted();
  if(!available())return refuse(503,'Mail changed; take it again');
  return guardedResponse(payload,{status:200,headers:{'content-type':'application/json','cache-control':'no-store'}},available);
 }catch{if(options.admitted()){try{options.reportError(new Error('Body input could not complete'));}catch{}}return refuse(503,'Body input could not complete');}
}
