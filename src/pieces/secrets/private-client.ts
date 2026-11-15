/** Worker/body recipient. Binary values bypass common operation envelopes.
 * One read and one metadata ACK; uncertainty erases bytes instead of replaying. */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {clock as systemClock,type Clock} from '../../core/clock.js';
class PendingRepository extends Error {}
const unavailable=()=>new Error('Private secret input unavailable');
const aliases=z.object({aliases:z.array(z.object({alias:z.string().min(1).max(200)}).strict()).max(128)}).strict();
export function privateSecretClient(options:{url:string;token:string;signal:AbortSignal;clock?:Clock;fetch?:typeof fetch;timeoutMs?:number}){
 let origin:URL;try{origin=new URL(options.url);}catch{throw unavailable();}
 const clock=options.clock??systemClock,request=options.fetch??fetch;
 if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'
  ||origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname))
  ||!options.token||/[\0\r\n]/.test(options.token))throw unavailable();
 const timeout=options.timeoutMs??15000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>15000)throw unavailable();
 let closed=false;const controllers=new Set<AbortController>(),owned=new Set<Uint8Array>(),batches=new Set<Map<string,Buffer>>();
 const cancelAll=()=>{for(const controller of controllers)controller.abort();for(const bytes of owned)bytes.fill(0);for(const batch of batches){for(const bytes of batch.values())bytes.fill(0);batch.clear();}};
 options.signal.addEventListener('abort',cancelAll,{once:true});
 async function attempt<T>(work:(current:()=>boolean,signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(closed||options.signal.aborted)throw unavailable();
  const abort=new AbortController(),end=clock.now()+timeout;controllers.add(abort);
  const stop=()=>abort.abort();options.signal.addEventListener('abort',stop,{once:true});
  const cancel=clock.at(end,stop),current=()=>!closed&&!abort.signal.aborted&&!options.signal.aborted&&clock.now()<end;
  let stopped!:()=>void;
  const cancelled=new Promise<never>((_resolve,reject)=>{stopped=()=>reject(unavailable());abort.signal.addEventListener('abort',stopped,{once:true});});
  try{const value=await Promise.race([work(current,abort.signal),cancelled]);if(!current())throw unavailable();return value;}
  catch(error){if(error instanceof PendingRepository)throw error;throw unavailable();}
  finally{cancel();abort.signal.removeEventListener('abort',stopped);options.signal.removeEventListener('abort',stop);controllers.delete(abort);abort.abort();}
 }
 async function post(path:string,input:object,current:()=>boolean,signal:AbortSignal,limit:number):Promise<{bytes:Buffer;response:Response}>{
  if(!current())throw unavailable();
  const pending=request(new URL('/api/secrets/private/'+path,origin),{method:'POST',redirect:'error',signal,headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body:JSON.stringify(input)});
  void pending.then(response=>{if(!current())void response.body?.cancel().catch(()=>{});},()=>{});
  const response=await pending;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;const chunks:Buffer[]=[];
  const cleanup=()=>{for(const chunk of chunks)chunk.fill(0);try{if(reader)void reader.cancel().catch(()=>{});else void response.body?.cancel().catch(()=>{});}catch{}};
  signal.addEventListener('abort',cleanup,{once:true});
  try{
   if(current()&&!response.redirected&&response.status===423&&path==='read'&&(input as {kind?:string}).kind==='repository')throw new PendingRepository();
   if(!current()||response.redirected||!response.ok)throw unavailable();
   if(response.status===204)return {bytes:Buffer.alloc(0),response};
   reader=response.body?.getReader();if(!reader)throw unavailable();
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw unavailable();
   let size=0;
   for(;;){if(!current())throw unavailable();const part=await reader.read();if(!current()){part.value?.fill(0);throw unavailable();}if(part.done)break;size+=part.value.byteLength;if(size>limit){part.value.fill(0);throw unavailable();}chunks.push(Buffer.from(part.value));part.value.fill(0);}
   if(!current())throw unavailable();return {bytes:Buffer.concat(chunks),response};
  }finally{signal.removeEventListener('abort',cleanup);cleanup();}
 }
 async function read(input:object,job?:string,optional=false):Promise<Buffer|undefined>{
  let value:Buffer|undefined;
  try{return await attempt(async(current,signal)=>{
   const received=await post('read',input,current,signal,65536);value=received.bytes;owned.add(value);
   if(optional&&received.response.status===204){value.fill(0);owned.delete(value);return undefined;}
   const use=received.response.headers.get('x-loom-secret-use');
   if(received.response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream'||!use||!/^use-input-[a-f0-9]{64}$/.test(use)||!value.length)throw unavailable();
   const ack=await post('confirm',{use,...(job?{job}:{})},current,signal,4096);
   try{if(!z.object({confirmed:z.literal(true)}).strict().safeParse(JSON.parse(ack.bytes.toString('utf8'))).success||!current())throw unavailable();}finally{ack.bytes.fill(0);}
   owned.delete(value);return value;
  });}catch(error){value?.fill(0);if(value)owned.delete(value);if(error instanceof PendingRepository)throw error;throw unavailable();}
 }
 return {
  granted(secret:string,id=randomUUID()){return read({kind:'request',secret,id}) as Promise<Buffer>;},
  async repository(job:string):Promise<Buffer|undefined>{
   for(;;){try{return await read({kind:'repository',job},job,true);}catch(error){
    if(!(error instanceof PendingRepository))throw error;
    // Only an authenticated metadata-pending response is retryable. No value
    // attempt has started; a lost read or confirmation is never retried.
    await attempt(async(current,signal)=>{
     let cancel!:()=>void;const stop=()=>cancel();
     try{await new Promise<void>(resolve=>{cancel=clock.at(clock.now()+Math.min(1000,Math.max(1,Math.floor(timeout/2))),resolve);signal.addEventListener('abort',stop,{once:true});});if(!current())throw unavailable();}
     finally{cancel();signal.removeEventListener('abort',stop);}
    });
   }}
  },
  async startup():Promise<Map<string,Buffer>>{
   const result=new Map<string,Buffer>();batches.add(result);let total=0;
   try{
    const plan=await attempt(async(current,signal)=>{const response=await post('startup',{},current,signal,131072);try{return aliases.parse(JSON.parse(response.bytes.toString('utf8')));}finally{response.bytes.fill(0);}});
    for(const {alias} of plan.aliases){if(result.has(alias))throw unavailable();const value=await read({kind:'startup',alias});if(!value)throw unavailable();result.set(alias,value);total+=value.length;if(total>1048576)throw unavailable();}
    if(closed||options.signal.aborted)throw unavailable();batches.delete(result);return result;
   }catch{for(const bytes of result.values())bytes.fill(0);result.clear();batches.delete(result);throw unavailable();}
  },
  close(){closed=true;options.signal.removeEventListener('abort',cancelAll);cancelAll();owned.clear();batches.clear();},
 };
}
