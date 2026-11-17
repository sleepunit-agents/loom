/** Current-body client. The parent supplies its existing enrolled body bearer.
 * Words travel only through a bounded response and the body's acceptance sink.
 * Mail gets two reports, both by id only. `accept` says the body has it, so its sender sees it delivered;
 * an outstanding one is sent again before any new input. `confirm` settles it, and is sent by settle()
 * only once the answer is recorded: mail a body dies holding stays with its job for the next attempt. */
import {DAY} from '../core/day.js';
import {BODY_INPUT_BYTES} from './body-input-limit.js';
import {BODY_REQUEST_MS,validBodyRequestMs} from './body-request-time.js';
import {DOOR_REQUEST_BYTES} from '../core/data/door-limit.js';
import {HISTORY_BYTES} from '../core/conversations/history-limit.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { privateOrigin } from '../core/private-origin.js';
import { clock as systemClock,type Clock } from '../core/clock.js';
import type { PrivateQuestion } from '../core/conversations/messages.js';
const unavailable=()=>new Error('Conversation body request failed; outcome may be uncertain');
class OversizedMailBatch extends Error{constructor(){super('Conversation body request failed; outcome may be uncertain');}}
const question=z.object({words:z.string(),why:z.string().nullable(),ifYes:z.string().nullable(),ifNo:z.string().nullable(),link:z.string().nullable()}).strict();
const historyLine=z.object({seq:z.number().int().positive(),kind:z.enum(['message','reply']),sender:z.string().min(1),at:z.iso.datetime({offset:true}),words:z.string(),keepUntil:z.iso.datetime({offset:true}).nullable()}).strict();
const item=z.object({
 history:z.array(historyLine).max(100).refine(lines=>Buffer.byteLength(JSON.stringify(lines))<=HISTORY_BYTES).optional().default([]),
 id:z.string().min(1),seq:z.number().int().positive(),source:z.enum(['thread','discord','slack','trigger','handoff','answer','task','approval','secret-request','notice']),sourceId:z.string().nullable(),
 fromKind:z.enum(['person','agent','schedule','unknown']),fromId:z.string().nullable(),at:z.iso.datetime({offset:true}),
 question:question.nullable().optional().default(null),questionKeepUntil:z.iso.datetime({offset:true}).nullable().optional().default(null),words:z.string().nullable(),keepUntil:z.iso.datetime({offset:true}).nullable(),verdict:z.enum(['yes','no']).nullable(),refs:z.array(z.string()),
}).strict().refine(row=>!!row.question===!!row.questionKeepUntil,'Question context needs its deadline');
const batch=z.object({job:z.string(),conversation:z.string(),items:z.array(item).max(100),stopRequested:z.boolean()}).strict();
export type BodyMail=Readonly<Omit<z.infer<typeof item>,'refs'|'question'|'history'>&{refs:readonly string[];history:readonly Readonly<z.infer<typeof historyLine>>[];question:Readonly<z.infer<typeof question>>|null}>;
export function bodyMailContext(item:BodyMail):string|null{
 if(item.words===null)return null;
 const input=item.question?{question:item.question,answer:item.words,verdict:item.verdict}:item.words;
 return item.history.length?JSON.stringify({history:item.history,input}):typeof input==='string'?input:JSON.stringify(input);
}
type Turn={model?:string;outcome?:'answered'|'progressed'|'deferred'|'failed'|'none';latencyMs?:number};
type Reply=Turn&{clientId:string;words:string};
type Card=Reply&{tool:string;cardState:'running'|'done'|'failed'};
export type BodyDigest={summary:string;ifAbsent?:boolean;items?:{kind:'decision'|'ask'|'task'|'project';text:string}[];question?:PrivateQuestion&{to:string}};
export function bodyConversationClient(options:{url:string;token:string;job:string;conversation:string;signal:AbortSignal;fetch?:typeof fetch;clock?:Clock;timeoutMs?:number}){
 const clock=options.clock??systemClock,request=options.fetch??fetch,timeout=options.timeoutMs??BODY_REQUEST_MS;
 let origin:URL;try{origin=privateOrigin(options.url);}catch{throw unavailable();}
 if(!options.token||/[\0\r\n]/.test(options.token)||!options.job||!options.conversation||!validBodyRequestMs(timeout))throw unavailable();
 const lifetimeAbort=new AbortController(),lifetime=AbortSignal.any([options.signal,lifetimeAbort.signal]);
 let closed=false,taking=false,received:{id:string;items:string[]}|undefined,settling:{id:string;items:string[]}|undefined;
 const unsettled:string[]=[];
 const controllers=new Set<AbortController>();
 const current=()=>!closed&&!lifetime.aborted;
 async function call<T>(name:string,input:unknown,schema:z.ZodType<T>,id?:string,namespace:'conversation'|'bridges'|'secrets'='conversation'):Promise<T>{
  if(!current())throw unavailable();
  const abort=new AbortController(),end=clock.now()+timeout;controllers.add(abort);
  const stop=()=>abort.abort();lifetime.addEventListener('abort',stop,{once:true});
  const cancel=clock.at(end,stop),valid=()=>current()&&!abort.signal.aborted&&clock.now()<end;
  let rejectAbort!:()=>void,response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const chunks:Buffer[]=[];let joined:Buffer|undefined;
  const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=()=>reject(unavailable());abort.signal.addEventListener('abort',rejectAbort,{once:true});});
  try{
   return await Promise.race([(async()=>{
    const body=JSON.stringify({input,...(id?{id}:{})});if(Buffer.byteLength(body)>DOOR_REQUEST_BYTES||!valid())throw unavailable();
    const flight=request(new URL('/api/'+namespace+'/'+name,origin),{method:'POST',redirect:'error',signal:abort.signal,headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body});
    void flight.then(value=>{if(!valid())void value.body?.cancel().catch(()=>{});},()=>{});
    response=await flight;
    if(!valid()||response.redirected||!response.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw unavailable();
    const length=response.headers.get('content-length');if(length!==null){if(!/^\d+$/.test(length))throw unavailable();if(Number(length)>BODY_INPUT_BYTES)throw new OversizedMailBatch();}
    reader=response.body?.getReader();if(!reader)throw unavailable();let size=0;
    for(;;){const part=await reader.read();if(!valid()){part.value?.fill(0);throw unavailable();}if(part.done)break;size+=part.value.byteLength;if(size>BODY_INPUT_BYTES){part.value.fill(0);throw new OversizedMailBatch();}chunks.push(Buffer.from(part.value));part.value.fill(0);}
    joined=Buffer.concat(chunks);const parsed=z.object({ok:z.literal(true),value:schema}).strict().parse(JSON.parse(joined.toString('utf8')));if(!valid())throw unavailable();return parsed.value;
   })(),aborted]);
  }catch(error){if(error instanceof OversizedMailBatch&&namespace==='conversation'&&name==='take')throw error;throw unavailable();}
  finally{
   cancel();lifetime.removeEventListener('abort',stop);abort.signal.removeEventListener('abort',rejectAbort);controllers.delete(abort);abort.abort();joined?.fill(0);for(const chunk of chunks)chunk.fill(0);
   try{if(reader)void reader.cancel().catch(()=>{});else void response?.body?.cancel().catch(()=>{});}catch{}
  }
 }
 const saved=z.object({saved:z.literal(true)}).strict(),messageResult=z.object({saved:z.literal(true),seq:z.number().int()}).strict();
 // Each report keeps its operation id until loom has answered it, so a repeat after a lost answer is the same write.
 async function reportReceived(){if(received){await call('accept',{items:received.items},saved,received.id);received=undefined;}}
 return {
  async takeAndAccept(accept:(item:BodyMail,signal:AbortSignal)=>Promise<void>,limit=50):Promise<{accepted:number;stopRequested:boolean}>{
   if(taking||!current()||!Number.isInteger(limit)||limit<1||limit>100)throw unavailable();taking=true;
   try{
    await reportReceived();
    let requested=limit,input:z.infer<typeof batch>;
    for(;;){try{input=await call('take',{limit:requested},batch);break;}catch(error){if(!(error instanceof OversizedMailBatch)||requested===1)throw unavailable();requested=Math.max(1,Math.floor(requested/2));}}
    const multipleHistories=input.items.filter(row=>row.history.length>0).length>1;
    const malformedRows=input.items.some((row,index)=>
     (row.history.length>0&&row.source!=='thread'&&row.source!=='discord'&&row.source!=='slack')||
     (index>0&&row.seq<=input.items[index-1].seq)||
     row.history.some((line,previous)=>previous>0&&line.seq<=row.history[previous-1].seq));
    if(input.job!==options.job||input.conversation!==options.conversation||input.items.length>requested||
     new Set(input.items.map(row=>row.id)).size!==input.items.length||multipleHistories||malformedRows)throw unavailable();
    let accepted=0;
    for(const row of input.items){
     if(!current())throw unavailable();
     // loom hands back mail this job still holds unsettled; what the sink already has is not given to it twice.
     if(unsettled.includes(row.id)||settling?.items.includes(row.id))continue;
     const answerDeadline=row.keepUntil===null?Infinity:Date.parse(row.keepUntil),questionDeadline=row.questionKeepUntil===null?Infinity:Date.parse(row.questionKeepUntil);
     if(!Number.isFinite(answerDeadline)&&row.keepUntil!==null||!Number.isFinite(questionDeadline)&&row.questionKeepUntil!==null)throw unavailable();
     const privateWords=row.words!==null&&clock.now()<answerDeadline,questionCurrent=privateWords&&row.question!==null&&clock.now()<questionDeadline;
     const history=privateWords?row.history.filter(line=>line.keepUntil===null||clock.now()<Date.parse(line.keepUntil)):[];
     const deadline=Math.min(questionCurrent?Math.min(answerDeadline,questionDeadline):answerDeadline,...history.flatMap(line=>line.keepUntil===null?[]:[Date.parse(line.keepUntil)]));
     const sinkAbort=new AbortController(),sinkSignal=AbortSignal.any([lifetime,sinkAbort.signal]);
     const cancelExpiry=privateWords&&Number.isFinite(deadline)?clock.at(deadline,()=>sinkAbort.abort()):undefined;
     if(sinkSignal.aborted||privateWords&&clock.now()>=deadline){cancelExpiry?.();sinkAbort.abort();throw unavailable();}
     let rejectStopped!:()=>void;
     const stopped=new Promise<never>((_resolve,reject)=>{rejectStopped=()=>reject(unavailable());sinkSignal.addEventListener('abort',rejectStopped,{once:true});});
     try {
      await Promise.race([accept(Object.freeze({...row,history:Object.freeze(history.map(line=>Object.freeze({...line}))),refs:Object.freeze([...row.refs]),words:privateWords?row.words:null,question:questionCurrent&&row.question?Object.freeze({...row.question}):null,questionKeepUntil:questionCurrent?row.questionKeepUntil:null}),sinkSignal),stopped]);
      if(!current()||privateWords&&clock.now()>=deadline){sinkAbort.abort();throw unavailable();}
     }catch{sinkAbort.abort();throw unavailable();}
     finally { cancelExpiry?.();sinkSignal.removeEventListener('abort',rejectStopped); }
     received??={id:randomUUID(),items:[]};received.items.push(row.id);unsettled.push(row.id);accepted++;
    }
    await reportReceived();return {accepted,stopRequested:input.stopRequested};
   }catch{throw unavailable();}finally{taking=false;}
  },
  /** Settle every item accepted so far. Call once its answer is recorded, or when it needs none. */
  async settle():Promise<void>{
   if(!settling&&unsettled.length)settling={id:randomUUID(),items:unsettled.splice(0)};
   if(settling){await call('confirm',{items:settling.items},saved,settling.id);settling=undefined;}
  },
  requestSecret(input:{id:string;secret:string;why:string;minutes:number;scope:'agent'|'job'}){return call('request',input,z.object({id:z.string(),state:z.enum(['pending','allowed','denied','cancelled','revoked'])}).strict(),input.id,'secrets');},
  secretRequestStatus(id:string){return call('requestStatus',{id},z.object({id:z.string(),state:z.enum(['pending','allowed','denied','cancelled','revoked'])}).strict(),undefined,'secrets');},
  bridgeReply(input:{incoming:string;text:string;model:string;outcome?:'answered'|'progressed'|'deferred'|'failed'|'none'},id=randomUUID()){return call('reply',{...input,id},saved,id,'bridges');},
  reply(input:Reply,id=randomUUID()){return call('message',{kind:'reply',...input},messageResult,id);},
  card(input:Card,id=randomUUID()){return call('message',{kind:'card',...input},messageResult,id);},
  title(title:string,id=randomUUID()){return call('title',{title},z.object({saved:z.literal(true),renamed:z.boolean()}).strict(),id);},
  cardState(clientId:string,cardState:'running'|'done'|'failed',id=randomUUID()){return call('cardState',{clientId,cardState},messageResult,id);},
  status(input:{state:'working'|'waiting'|'idle'|'offline';work:string},id=randomUUID()){return call('status',input,z.object({saved:z.literal(true),stopRequested:z.boolean()}).strict(),id);},
  turn(input:Turn&{kind:'reply'|'action'|'wake'|'note'|'refused'},id=randomUUID()){return call('turn',input,z.object({saved:z.literal(true),conversation:z.string(),seq:z.number().int()}).strict(),id);},
  finding(input:{turnSeq:number;measure:string;score:number;text:string},id:string=randomUUID()){return call('finding',input,z.object({saved:z.literal(true),day:z.string().regex(DAY)}).strict(),id);},
  digest(input:BodyDigest,id=randomUUID()){return call('digest',input,z.object({saved:z.literal(true),digest:z.string(),revision:z.number().int(),item:z.string().nullable()}).strict(),id);},
  close(){closed=true;lifetimeAbort.abort();for(const controller of controllers)controller.abort();},
 };
}
