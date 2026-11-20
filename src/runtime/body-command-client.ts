import {noteUploadForm} from '../note-upload.js';
import {BodyJobEnded,bodyJobEnded} from './body-job-ended.js';
import {BodyContactExpired,BodyTransportFailure,retryBodyContact,temporaryStatus,temporaryUnavailableReply} from './body-contact.js';
/** Current-body consumer of ordinary Root HTTP commands and generated reads.
 * No transport/issuer, unreceipted writes, or caller-selected authority. */
import { z } from 'zod';
import { clock as systemClock,type Clock } from '../core/clock.js';
import { privateOrigin } from '../core/private-origin.js';
import { DOOR_REQUEST_BYTES } from '../core/data/door-limit.js';
import { BODY_REQUEST_MS,validBodyRequestMs } from './body-request-time.js';
const unavailable=()=>new Error('Body request failed; outcome may be uncertain');
const json=z.json();
const result=z.discriminatedUnion('ok',[
 z.object({ok:z.literal(true),value:json}).strict(),
 z.object({ok:z.literal(false),code:z.enum(['denied','not-found','invalid','conflict','unavailable']),message:z.string()}).strict(),
]);
const name=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/);
const receipt=z.string().min(1).max(200);
const query=z.object({query:z.string().min(1),variables:z.record(z.string(),json).nullable().optional(),operationName:z.string().min(1).nullable().optional()}).strict();
const queryError=z.object({message:z.string(),locations:z.array(z.object({line:z.number().int().positive(),column:z.number().int().positive()}).strict()).optional(),path:z.array(z.union([z.string(),z.number().int().nonnegative()])).optional(),extensions:z.record(z.string(),json).optional()}).strict();
const queryResult=z.object({data:z.record(z.string(),json).nullable().optional(),errors:z.array(queryError).min(1).optional(),extensions:z.record(z.string(),json).optional()}).strict().refine(value=>value.data!==undefined||!!value.errors?.length);
function echoesCredential(text:string,token:string):boolean{
 if(text.includes(token))return true;
 // Inspect every valid JSON string, including values discarded by duplicate keys.
 for(let i=0;i<text.length;i++){
  if(text[i]!=='"')continue;const start=i;
  for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"')break;}
  if((JSON.parse(text.slice(start,i+1))as string).includes(token))return true;
 }
 return false;
}
export function bodyCommandClient(options:{url:string;token:string;signal:AbortSignal;fetch?:typeof fetch;clock?:Clock;timeoutMs?:number;onJobEnded?:()=>void}){
 let origin:URL;try{origin=privateOrigin(options.url);}catch{throw unavailable();}
 const token=options.token,clock=options.clock??systemClock,request=options.fetch??fetch,timeout=options.timeoutMs??BODY_REQUEST_MS;
 if(!token||/[\s\u0000-\u001f\u007f]/u.test(token)||!validBodyRequestMs(timeout))throw unavailable();
 const lifetimeAbort=new AbortController(),lifetime=AbortSignal.any([options.signal,lifetimeAbort.signal]),active=new Set<AbortController>();
 let closed=false;const current=()=>!closed&&!lifetime.aborted;
 async function post(path:string,payload:unknown,replay=true,upload?:FormData){
  if(!current())throw unavailable();
  let body:string|FormData;
  if(upload)body=upload;
  else{
   try{body=JSON.stringify(payload);}catch{throw unavailable();}
   if(Buffer.byteLength(body)>DOOR_REQUEST_BYTES)throw unavailable();
  }
  const attempt=async(remaining:number)=>{
  const abort=new AbortController(),end=clock.now()+Math.min(timeout,remaining);active.add(abort);
  const stop=()=>abort.abort();lifetime.addEventListener('abort',stop,{once:true});
  const cancel=clock.at(end,stop),valid=()=>current()&&!abort.signal.aborted&&clock.now()<end;
  const chunks:Buffer[]=[];let joined:Buffer|undefined,response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,rejectStopped!:()=>void;
  const erase=()=>{joined?.fill(0);for(const chunk of chunks)chunk.fill(0);};
  const stopped=new Promise<never>((_resolve,reject)=>{rejectStopped=()=>{erase();reject(unavailable());};abort.signal.addEventListener('abort',rejectStopped,{once:true});});
  try{const reply=await Promise.race([(async()=>{
   if(!valid())throw unavailable();
   const flight=request(new URL(path,origin),{method:'POST',redirect:'error',signal:abort.signal,headers:{authorization:'Bearer '+token,...(upload?{}:{'content-type':'application/json'}),'accept-encoding':'identity'},body});
   void flight.then(value=>{if(!valid())void value.body?.cancel().catch(()=>{});},()=>{});
   response=await flight.catch(()=>{throw new BodyTransportFailure();});
   if(!response.redirected&&temporaryStatus(response.status)&&(response.status!==503||!/^application\/json/i.test(response.headers.get('content-type')??'')))throw new BodyTransportFailure();
   if(!valid()||response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw unavailable();
   const encoding=response.headers.get('content-encoding');if(encoding&&encoding.toLowerCase()!=='identity')throw unavailable();
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>16777216))throw unavailable();
   reader=response.body?.getReader();if(!reader)throw unavailable();let size=0;
   for(;;){const part=await reader.read().catch(()=>{throw new BodyTransportFailure();});if(!valid()){part.value?.fill(0);throw unavailable();}if(part.done)break;size+=part.value.byteLength;if(size>16777216){part.value.fill(0);throw unavailable();}chunks.push(Buffer.from(part.value));part.value.fill(0);}
   if(length!==null&&size!==Number(length))throw unavailable();
   joined=Buffer.concat(chunks);const text=new TextDecoder('utf-8',{fatal:true}).decode(joined),value=json.parse(JSON.parse(text));
   // Root credentials never become native tool output, including an echoed error.
   if(!valid()||echoesCredential(text,token))throw unavailable();
   if(response.status===503&&temporaryUnavailableReply(value))throw new BodyTransportFailure();
   return {status:response.status,value};
  })(),stopped]);if(!valid())throw unavailable();return reply;}catch(error){if(current()&&(clock.now()>=end||error instanceof BodyTransportFailure))throw new BodyTransportFailure();throw unavailable();}finally{
   cancel();lifetime.removeEventListener('abort',stop);abort.signal.removeEventListener('abort',rejectStopped);active.delete(abort);abort.abort();erase();
   try{if(reader)void reader.cancel().catch(()=>{});else void response?.body?.cancel().catch(()=>{});}catch{}
  }
  };
  if(replay)return retryBodyContact(clock,lifetime,unavailable,attempt);
  try{return await attempt(timeout);}catch{throw unavailable();}
 }
 return{
  async command(operation:string,input:z.infer<typeof json>,id:string){
   try{
    if(!name.safeParse(operation).success||!receipt.safeParse(id).success||!json.safeParse(input).success)throw unavailable();
    // Recall warms the memories it finds. It is registered as a read and keeps no receipt.
    const [piece,...rest]=operation.split('.'),reply=await post('/api/'+encodeURIComponent(piece)+'/'+encodeURIComponent(rest.join('.')),{input,id},operation!=='memory.recall',operation==='memory.noteAttach'?noteUploadForm(input,id):undefined);
    if(!current())throw unavailable();
    if(bodyJobEnded(reply.status,reply.value))throw new BodyJobEnded();
    const answer=result.parse(reply.value),status=answer.ok?200:({'denied':403,'not-found':404,'invalid':400,'conflict':409,'unavailable':503}as const)[answer.code];
    if(reply.status!==status)throw unavailable();return answer;
   }catch(error){if(error instanceof BodyJobEnded){options.onJobEnded?.();throw error;}if(error instanceof BodyContactExpired)throw error;throw unavailable();}
  },
  async query(input:z.infer<typeof query>){
   try{
    if(!query.safeParse(input).success)throw unavailable();const reply=await post('/graphql',input);
    if(current()&&bodyJobEnded(reply.status,reply.value,'query'))throw new BodyJobEnded();
    if(!current()||![200,400].includes(reply.status))throw unavailable();const answer=queryResult.parse(reply.value);if(reply.status===400&&(answer.data!==undefined||!answer.errors?.length))throw unavailable();return answer;
   }catch(error){if(error instanceof BodyJobEnded){options.onJobEnded?.();throw error;}if(error instanceof BodyContactExpired)throw error;throw unavailable();}
  },
  close(){closed=true;lifetimeAbort.abort();for(const abort of active)abort.abort();},
 };
}
