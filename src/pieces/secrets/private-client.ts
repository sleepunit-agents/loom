import {bodyJobEnded} from '../../runtime/body-job-ended.js';
import {BodyContactExpired,BodyTransportFailure,retryBodyContact,temporaryStatus} from '../../runtime/body-contact.js';
/** Worker/body recipient. Binary values bypass common operation envelopes.
 * One read and one metadata ACK; uncertainty erases bytes instead of replaying. */
import {SECRET_USE_ID} from './use-id.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {houseSecretAlias,SECRET_VALUE_BYTES} from './input.js';
import {connectionRefused,privateOrigin} from '../../core/private-origin.js';
import {clock as systemClock,type Clock} from '../../core/clock.js';
class PendingRepository extends Error {}
const unavailable=()=>new Error('Private secret input unavailable');
/** The longest one private read may take, and how long it is given when nobody says. A caller with a longer
 * deadline of its own (the worker) is cut down to this. */
export const PRIVATE_SECRET_TIMEOUT_MS=15_000;
const aliases=z.object({aliases:z.array(z.object({alias:houseSecretAlias}).strict()).max(128),pending:z.literal(true).optional()}).strict();
export function privateSecretClient(options:{url:string;token:string;signal:AbortSignal;clock?:Clock;fetch?:typeof fetch;timeoutMs?:number;onJobEnded?:()=>void}){
 let origin:URL;try{origin=privateOrigin(options.url);}catch{throw unavailable();}
 const clock=options.clock??systemClock,request=options.fetch??fetch;
 if(!options.token||/[\0\r\n]/.test(options.token))throw unavailable();
 const timeout=options.timeoutMs??PRIVATE_SECRET_TIMEOUT_MS;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>PRIVATE_SECRET_TIMEOUT_MS)throw unavailable();
 const stopped=new AbortController(),lifetime=AbortSignal.any([options.signal,stopped.signal]);
 let closed=false;const controllers=new Set<AbortController>(),owned=new Set<Uint8Array>(),batches=new Set<Map<string,Buffer>>();
 const cancelAll=()=>{for(const controller of controllers)controller.abort();for(const bytes of owned)bytes.fill(0);for(const batch of batches){for(const bytes of batch.values())bytes.fill(0);batch.clear();}};
 options.signal.addEventListener('abort',cancelAll,{once:true});
 async function attempt<T>(work:(current:()=>boolean,signal:AbortSignal)=>Promise<T>,remaining:number,replayTimeout=false):Promise<T>{
  if(closed||options.signal.aborted)throw unavailable();
  const abort=new AbortController(),end=clock.now()+Math.min(timeout,remaining);controllers.add(abort);
  const stop=()=>abort.abort();options.signal.addEventListener('abort',stop,{once:true});
  const cancel=clock.at(end,stop),current=()=>!closed&&!abort.signal.aborted&&!options.signal.aborted&&clock.now()<end;
  let stopped!:()=>void;
  const cancelled=new Promise<never>((_resolve,reject)=>{stopped=()=>reject(unavailable());abort.signal.addEventListener('abort',stopped,{once:true});});
  try{const value=await Promise.race([work(current,abort.signal),cancelled]);if(!current())throw unavailable();return value;}
  catch(error){if(!lifetime.aborted&&((replayTimeout&&clock.now()>=end)||error instanceof BodyTransportFailure))throw new BodyTransportFailure();if(error instanceof PendingRepository)throw error;throw unavailable();}
  finally{cancel();abort.signal.removeEventListener('abort',stopped);options.signal.removeEventListener('abort',stop);controllers.delete(abort);abort.abort();}
 }
 async function post(path:string,input:object,current:()=>boolean,signal:AbortSignal,limit:number):Promise<{bytes:Buffer;response:Response}>{
  if(!current())throw unavailable();
  const pending=request(new URL('/api/secrets/private/'+path,origin),{method:'POST',redirect:'error',signal,headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body:JSON.stringify(input)});
  void pending.then(response=>{if(!current())void response.body?.cancel().catch(()=>{});},()=>{});
  const response=await pending.catch(error=>{
   // Only a refused connection proves that the value request never arrived.
   if(path==='startup'||(path==='read'&&current()&&connectionRefused(error)))throw new BodyTransportFailure();
   throw unavailable();
  });let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;const chunks:Buffer[]=[];
  const cleanup=()=>{for(const chunk of chunks)chunk.fill(0);try{if(reader)void reader.cancel().catch(()=>{});else void response.body?.cancel().catch(()=>{});}catch{}};
  signal.addEventListener('abort',cleanup,{once:true});
  try{
   if(path==='startup'&&current()&&!response.redirected&&temporaryStatus(response.status))throw new BodyTransportFailure();
   if(current()&&!response.redirected&&response.status===423&&path==='read'&&(input as {kind?:string}).kind==='repository')throw new PendingRepository();
   const checkDenial=!!options.onJobEnded&&(response.status===401||response.status===403)&&/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'');
   if(!current()||response.redirected||(!response.ok&&!checkDenial))throw unavailable();
   if(response.status===204)return {bytes:Buffer.alloc(0),response};
   reader=response.body?.getReader();if(!reader)throw unavailable();
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw unavailable();
   let size=0;
   for(;;){if(!current())throw unavailable();const part=await reader.read().catch(()=>{if(path==='startup')throw new BodyTransportFailure();throw unavailable();});if(!current()){part.value?.fill(0);throw unavailable();}if(part.done)break;size+=part.value.byteLength;if(size>limit){part.value.fill(0);throw unavailable();}chunks.push(Buffer.from(part.value));part.value.fill(0);}
   if(!current())throw unavailable();
   const bytes=Buffer.concat(chunks);
   if(checkDenial){
    try{if((length===null||size===Number(length))&&bodyJobEnded(response.status,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))))options.onJobEnded?.();}
    finally{bytes.fill(0);}
    throw unavailable();
   }
   return {bytes,response};
  }finally{signal.removeEventListener('abort',cleanup);cleanup();}
 }
 async function read(input:object,job?:string,optional=false):Promise<Buffer|undefined>{
  let value:Buffer|undefined;
  try{return await retryBodyContact(clock,lifetime,unavailable,remaining=>attempt(async(current,signal)=>{
   const received=await post('read',input,current,signal,SECRET_VALUE_BYTES);value=received.bytes;owned.add(value);
   if(optional&&received.response.status===204){value.fill(0);owned.delete(value);return undefined;}
   const use=received.response.headers.get('x-loom-secret-use');
   if(received.response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream'||!use||!SECRET_USE_ID.test(use)||!value.length)throw unavailable();
   const ack=await post('confirm',{use,...(job?{job}:{})},current,signal,4096);
   try{if(!z.object({confirmed:z.literal(true)}).strict().safeParse(JSON.parse(ack.bytes.toString('utf8'))).success||!current())throw unavailable();}finally{ack.bytes.fill(0);}
   owned.delete(value);return value;
  },remaining));}catch(error){value?.fill(0);if(value)owned.delete(value);if(error instanceof PendingRepository||error instanceof BodyContactExpired)throw error;throw unavailable();}
 }
 async function waitForConsent(){
    if(closed||options.signal.aborted)throw unavailable();
    const waiting=new AbortController();controllers.add(waiting);
    let cancel!:()=>void,stop!:()=>void;
    try{await new Promise<void>((resolve,reject)=>{
     stop=()=>reject(unavailable());waiting.signal.addEventListener('abort',stop,{once:true});
     cancel=clock.at(clock.now()+1000,resolve);
    });if(closed||options.signal.aborted||waiting.signal.aborted)throw unavailable();}
    finally{cancel();waiting.signal.removeEventListener('abort',stop);controllers.delete(waiting);}

 }

 return {
  granted(secret:string,id:string=randomUUID()){return read({kind:'request',secret,id}) as Promise<Buffer>;},
  async repository(job:string):Promise<Buffer|undefined>{
   for(;;){try{return await read({kind:'repository',job},job,true);}catch(error){
    if(!(error instanceof PendingRepository))throw error;
    // Authenticated consent polling has its own lifetime.
    await waitForConsent();
   }}
  },
  async startup():Promise<Map<string,Buffer>>{
   const result=new Map<string,Buffer>();batches.add(result);let total=0;
   try{
    let plan:z.infer<typeof aliases>;
    // This metadata call keys its consent requests by job and secret. A value read or acknowledgement
    // below has stricter retry rules once delivery is possible.
    for(;;){
     plan=await retryBodyContact(clock,lifetime,unavailable,remaining=>attempt(async(current,signal)=>{
      const response=await post('startup',{},current,signal,131072);
      try{return aliases.parse(JSON.parse(response.bytes.toString('utf8')));}finally{response.bytes.fill(0);}
     },remaining,true));
     if(!plan.pending)break;
     await waitForConsent();
    }
    for(const {alias} of plan.aliases){if(result.has(alias))throw unavailable();const value=await read({kind:'startup',alias});if(!value)throw unavailable();result.set(alias,value);total+=value.length;if(total>1048576)throw unavailable();}
    if(closed||options.signal.aborted)throw unavailable();batches.delete(result);return result;
   }catch(error){for(const bytes of result.values())bytes.fill(0);result.clear();batches.delete(result);if(error instanceof BodyContactExpired)throw error;throw unavailable();}
  },
  close(){closed=true;stopped.abort();options.signal.removeEventListener('abort',cancelAll);cancelAll();owned.clear();batches.clear();},
 };
}
