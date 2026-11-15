/** Current-body client. The parent supplies its existing enrolled body bearer.
 * Words travel only through a bounded response and the body's acceptance sink;
 * outstanding confirmations retain IDs only and retry before any new input. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { clock as systemClock,type Clock } from '../core/clock.js';
import type { PrivateQuestion } from '../core/conversations/messages.js';
const unavailable=()=>new Error('Conversation body request failed; outcome may be uncertain');
const item=z.object({
 id:z.string().min(1),seq:z.number().int().positive(),source:z.enum(['thread','discord','slack','trigger','handoff','answer','task','approval','secret-request','notice']),sourceId:z.string().nullable(),
 fromKind:z.enum(['person','agent','schedule','unknown']),fromId:z.string().nullable(),at:z.iso.datetime({offset:true}),
 words:z.string().nullable(),keepUntil:z.iso.datetime({offset:true}).nullable(),verdict:z.enum(['yes','no']).nullable(),refs:z.array(z.string()),
}).strict();
const batch=z.object({job:z.string(),conversation:z.string(),items:z.array(item).max(100),stopRequested:z.boolean()}).strict();
export type BodyMail=Readonly<Omit<z.infer<typeof item>,'refs'>&{refs:readonly string[]}>;
type Turn={model?:string;outcome?:'answered'|'progressed'|'deferred'|'failed'|'none';latencyMs?:number};
type Reply=Turn&{clientId:string;words:string};
type Card=Reply&{tool:string;cardState:'running'|'done'|'failed'};
export type BodyDigest={summary:string;items?:{kind:'decision'|'ask'|'task'|'project';text:string}[];question?:PrivateQuestion&{to:string}};
export function bodyConversationClient(options:{url:string;token:string;job:string;conversation:string;signal:AbortSignal;fetch?:typeof fetch;clock?:Clock;timeoutMs?:number}){
 const clock=options.clock??systemClock,request=options.fetch??fetch,timeout=options.timeoutMs??15_000;
 let origin:URL;try{origin=new URL(options.url);}catch{throw unavailable();}
 if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))
  ||!options.token||/[\0\r\n]/.test(options.token)||!options.job||!options.conversation||!Number.isSafeInteger(timeout)||timeout<1||timeout>30_000)throw unavailable();
 const lifetimeAbort=new AbortController(),lifetime=AbortSignal.any([options.signal,lifetimeAbort.signal]);
 let closed=false,taking=false,pending:{id:string;items:string[]}|undefined;
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
    const body=JSON.stringify({input,...(id?{id}:{})});if(Buffer.byteLength(body)>1_048_576||!valid())throw unavailable();
    const flight=request(new URL('/api/'+namespace+'/'+name,origin),{method:'POST',redirect:'error',signal:abort.signal,headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body});
    void flight.then(value=>{if(!valid())void value.body?.cancel().catch(()=>{});},()=>{});
    response=await flight;
    if(!valid()||response.redirected||!response.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw unavailable();
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>16_777_216))throw unavailable();
    reader=response.body?.getReader();if(!reader)throw unavailable();let size=0;
    for(;;){const part=await reader.read();if(!valid()){part.value?.fill(0);throw unavailable();}if(part.done)break;size+=part.value.byteLength;if(size>16_777_216){part.value.fill(0);throw unavailable();}chunks.push(Buffer.from(part.value));part.value.fill(0);}
    joined=Buffer.concat(chunks);const parsed=z.object({ok:z.literal(true),value:schema}).strict().parse(JSON.parse(joined.toString('utf8')));if(!valid())throw unavailable();return parsed.value;
   })(),aborted]);
  }catch{throw unavailable();}
  finally{
   cancel();lifetime.removeEventListener('abort',stop);abort.signal.removeEventListener('abort',rejectAbort);controllers.delete(abort);abort.abort();joined?.fill(0);for(const chunk of chunks)chunk.fill(0);
   try{if(reader)void reader.cancel().catch(()=>{});else void response?.body?.cancel().catch(()=>{});}catch{}
  }
 }
 const saved=z.object({saved:z.literal(true)}).strict(),messageResult=z.object({saved:z.literal(true),seq:z.number().int()}).strict();
 async function confirmPending(){if(pending){await call('confirm',{items:pending.items},saved,pending.id);pending=undefined;}}
 return {
  async takeAndAccept(accept:(item:BodyMail,signal:AbortSignal)=>Promise<void>,limit=50):Promise<{accepted:number;stopRequested:boolean}>{
   if(taking||!current()||!Number.isInteger(limit)||limit<1||limit>100)throw unavailable();taking=true;
   try{
    await confirmPending();
    const input=await call('take',{limit},batch);
    if(input.job!==options.job||input.conversation!==options.conversation||input.items.length>limit||new Set(input.items.map(row=>row.id)).size!==input.items.length||input.items.some((row,i)=>i>0&&row.seq<=input.items[i-1].seq))throw unavailable();
    let accepted=0;
    for(const row of input.items){
     if(!current())throw unavailable();
     const deadline=row.keepUntil===null?Infinity:Date.parse(row.keepUntil);
     if(!Number.isFinite(deadline)&&row.keepUntil!==null)throw unavailable();
     const privateWords=row.words!==null&&clock.now()<deadline;
     const sinkAbort=new AbortController(),sinkSignal=AbortSignal.any([lifetime,sinkAbort.signal]);
     const cancelExpiry=privateWords&&Number.isFinite(deadline)?clock.at(deadline,()=>sinkAbort.abort()):undefined;
     let rejectStopped!:()=>void;
     const stopped=new Promise<never>((_resolve,reject)=>{rejectStopped=()=>reject(unavailable());sinkSignal.addEventListener('abort',rejectStopped,{once:true});});
     try {
      if(sinkSignal.aborted)throw unavailable();
      await Promise.race([accept(Object.freeze({...row,refs:Object.freeze([...row.refs]),words:privateWords?row.words:null}),sinkSignal),stopped]);
      if(!current()||privateWords&&clock.now()>=deadline){sinkAbort.abort();throw unavailable();}
     }catch{sinkAbort.abort();throw unavailable();}
     finally { cancelExpiry?.();sinkSignal.removeEventListener('abort',rejectStopped); }
     pending??={id:randomUUID(),items:[]};pending.items.push(row.id);accepted++;
    }
    await confirmPending();return {accepted,stopRequested:input.stopRequested};
   }catch{throw unavailable();}finally{taking=false;}
  },
  requestSecret(input:{id:string;secret:string;why:string;minutes:number;scope:'agent'|'job'}){return call('request',input,z.object({id:z.string(),state:z.enum(['pending','allowed','denied','cancelled','revoked'])}).strict(),input.id,'secrets');},
  secretRequestStatus(id:string){return call('requestStatus',{id},z.object({id:z.string(),state:z.enum(['pending','allowed','denied','cancelled','revoked'])}).strict(),undefined,'secrets');},
  bridgeReply(input:{incoming:string;text:string;model:string;outcome?:'answered'|'progressed'|'deferred'|'failed'|'none'},id=randomUUID()){return call('reply',{...input,id},saved,id,'bridges');},
  reply(input:Reply,id=randomUUID()){return call('message',{kind:'reply',...input},messageResult,id);},
  card(input:Card,id=randomUUID()){return call('message',{kind:'card',...input},messageResult,id);},
  title(title:string,id=randomUUID()){return call('title',{title},z.object({saved:z.literal(true),renamed:z.boolean()}).strict(),id);},
  cardState(clientId:string,cardState:'running'|'done'|'failed',id=randomUUID()){return call('cardState',{clientId,cardState},messageResult,id);},
  status(input:{state:'working'|'waiting'|'idle'|'offline';work:string;seenStop?:true},id=randomUUID()){return call('status',input,z.object({saved:z.literal(true),stopRequested:z.boolean()}).strict(),id);},
  turn(input:Turn&{kind:'reply'|'action'|'wake'|'note'|'refused'},id=randomUUID()){return call('turn',input,z.object({saved:z.literal(true),conversation:z.string(),seq:z.number().int()}).strict(),id);},
  finding(input:{turnSeq:number;measure:string;score:number;text:string},id:string=randomUUID()){return call('finding',input,z.object({saved:z.literal(true),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict(),id);},
  digest(input:BodyDigest,id=randomUUID()){return call('digest',input,z.object({saved:z.literal(true),digest:z.string(),revision:z.number().int(),item:z.string().nullable()}).strict(),id);},
  close(){closed=true;lifetimeAbort.abort();for(const controller of controllers)controller.abort();},
 };
}
