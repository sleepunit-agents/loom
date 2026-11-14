/** Unregistered fetch transport. Runtime must issue the delivered-message proof;
 * no public caller may supply one. This module stores nothing and grants no reads. */
import { z } from 'zod';
import type { SecretUse } from '../secrets/role.js';
import { venueSchema, type Venue } from './model.js';

export const SLACK_FILE_BYTES = 25 * 1024 * 1024;
export const SLACK_FILES_PER_MESSAGE = 5;
const file = z.object({
  id:z.string().regex(/^F[A-Z0-9]{2,30}$/), name:z.string().max(4096),
  size:z.number().int().min(0).max(SLACK_FILE_BYTES), url:z.string().max(8192),
}).strict();
/** Trusted exact delivered-message scope. current includes authenticated bot,
 * credential generation, Runtime admission and delivery ownership. It is not a
 * body retrieval capability. Production must not substitute a fake issuer. */
export interface SlackFilesPermit {
  readonly agent:string;
  readonly venue:string;
  readonly workspace:string;
  readonly channel:string;
  readonly delivery:string;
  readonly files:readonly z.infer<typeof file>[];
  current():boolean;
}
export interface FetchedSlackFile {
  id:string; name:string; bytes:Buffer;
}
const held = () => Error('Bridge file fetch held');
function fileUrl(value:string) {
  // Refuse alternate URL spellings before WHATWG normalization hides them.
  if (!value.startsWith('https://files.slack.com/') || /[\\\s\x00-\x1f\x7f]/.test(value)) throw held();
  const rawPath=value.slice('https://files.slack.com'.length).split(/[?#]/,1)[0];
  const decodedPath=decodeURIComponent(rawPath);
  // Check before URL normalization removes dot segments. Nested escapes and
  // encoded backslashes refuse rather than depend on a server's decoding order.
  if(/(^|\/)\.{1,2}(\/|$)/.test(decodedPath)||decodedPath.includes('\\')||/%[0-9a-f]{2}/i.test(decodedPath))throw held();
  const u=new URL(value);
  if(u.origin!=='https://files.slack.com'||u.username||u.password||u.hash)throw held();
  return u.href;
}
const safeName=(value:string)=>value.replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,80).replace(/^[._]+/,'')||'file';

/** One batch (first five attachments), no retry or cache. Returned bytes belong
 * only to this proof's delivery; the caller must persist them privately and
 * implement Runtime-bound retrieval and fourteen-day retention before wiring. */
export function slackFiles(input:Venue, permit:SlackFilesPermit, secrets:SecretUse,
  beforeRead:()=>boolean, request:typeof fetch=fetch) {
  let binding: {venue:Venue;scope:Pick<SlackFilesPermit,'agent'|'venue'|'workspace'|'channel'|'delivery'>;source:string}|undefined;
  try {
    binding={venue:venueSchema.parse(structuredClone(input)),
      scope:{agent:permit.agent,venue:permit.venue,workspace:permit.workspace,channel:permit.channel,delivery:permit.delivery},
      source:JSON.stringify(permit.files)};
  }catch{ /* Invalid internal evidence fails with the same fixed error on fetch. */ }
  return {async fetch():Promise<FetchedSlackFile[]> {
    const completed:FetchedSlackFile[]=[], owned:Buffer[]=[];
    try {
      if(!binding)throw held();
      const {venue,scope,source}=binding;
      const descriptors:unknown=JSON.parse(source);
      if(!Array.isArray(descriptors))throw held();
      const selected=z.array(file).max(SLACK_FILES_PER_MESSAGE).parse(descriptors.slice(0,SLACK_FILES_PER_MESSAGE));
      const files=selected.map(f=>({...f,url:fileUrl(f.url)}));
      if(!venue.enabled||venue.platform!=='slack'||venue.agent!==scope.agent||venue.id!==scope.venue
        ||venue.workspace!==scope.workspace||!/^T[A-Z0-9]{1,199}$/.test(scope.workspace)
        ||!/^U[A-Z0-9]{1,199}$/.test(venue.bot)||! /^[CDG][A-Z0-9]{1,199}$/.test(scope.channel)||!scope.delivery)throw held();
      const current=()=>Object.entries(scope).every(([k,v])=>permit[k as keyof typeof scope]===v)
        &&JSON.stringify(permit.files)===source&&permit.current()&&beforeRead();
      if(!current())throw held();
      for(const f of files){
        if(!current())throw held();
        const bytes=await secrets.withValue(venue.tokenSecret,async token=>{
          if(!current())throw held();
          const abort=new AbortController();
          const timer=setTimeout(()=>abort.abort(),15_000);
          let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
          const chunks:Buffer[]=[];
          // Also bounds an injected HTTP implementation that ignores signal.
          const bounded=<T>(work:Promise<T>)=>new Promise<T>((resolve,reject)=>{
            const stop=()=>reject(held());
            if(abort.signal.aborted){stop();return;}
            abort.signal.addEventListener('abort',stop,{once:true});
            work.then(resolve,reject).finally(()=>abort.signal.removeEventListener('abort',stop));
          });
          try{
            const pending=request(f.url,{method:'GET',redirect:'error',signal:abort.signal,headers:{Authorization:`Bearer ${token}`}});
            void pending.then(r=>{if(abort.signal.aborted)void r.body?.cancel().catch(()=>{});},()=>{});
            const response=await bounded(pending);
            reader=response.body?.getReader();
            const content=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
            const length=response.headers.get('content-length');
            if(!current()||response.status!==200||response.redirected||content==='text/html'||content==='application/xhtml+xml'
              ||length!==null&&(!/^\d+$/.test(length)||Number(length)>SLACK_FILE_BYTES)||!reader)throw held();
            let size=0;
            while(true){
              if(!current())throw held();
              const next=await bounded(reader.read());
              if(!current())throw held();
              if(next.done)break;
              size+=next.value.byteLength;
              if(size>SLACK_FILE_BYTES)throw held();
              chunks.push(Buffer.from(next.value));
            }
            if(!current())throw held();
            const bytes=Buffer.concat(chunks);owned.push(bytes);return bytes;
          }finally{
            clearTimeout(timer);abort.abort();
            void reader?.cancel().catch(()=>{});
            for(const chunk of chunks)chunk.fill(0);
          }
        });
        if(!current()){bytes.fill(0);throw held();}
        completed.push({id:f.id,name:safeName(f.name),bytes});
      }
      if(!current())throw held();
      return completed;
    }catch{
      for(const bytes of owned)bytes.fill(0);
      throw held();
    }
  }};
}
