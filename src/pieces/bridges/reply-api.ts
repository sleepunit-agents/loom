/** One already-authorized send part. The shared queue owns durable uncertainty;
 * this helper never retries and only accepts a confirmed matching receipt.
 * A failure before the request is made throws BridgeReplyNotSent; any failure
 * from the request onwards is uncertain. */
import { isDiscordId } from './discord-id.js';
import type { Clock } from '../../core/clock.js';
import type { SecretUse } from '../secrets/role.js';
import { BridgeReplyNotSent } from './outbound.js';
import type { SendFile } from './sends.js';
/** What a post by loom may ping on Discord, said once: a person or a bot whose mention the agent wrote
 * (`<@id>`), and nothing else. `@everyone`, `@here` and every role stay words; a post is never made as a
 * Discord reply, so nobody is pinged for being answered. A bot is woken only by a written mention
 * (incoming.ts), so this is also the one way an agent calls on another. Slack posts ping nobody: their
 * text is escaped below. */
export const DISCORD_PINGS={parse:['users'],replied_user:false} as const;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function bridgeReplyApi(input:{platform:'discord'|'slack';tokenSecret:string;secrets:SecretUse;clock:Clock;current():boolean;request?:typeof fetch}){
 return {async post(address:{channel:string;thread:string|null},text:string,files:readonly SendFile[]=[]):Promise<{id:string}>{
  const discord=input.platform==='discord';
  // Files are posted on Discord only (sends.ts refuses them for Slack when the post is queued).
  if(files.length&&!discord)throw new BridgeReplyNotSent(false);
  if(text.length===0||!(discord?isDiscordId(address.channel):/^[A-Z][A-Z0-9]{1,199}$/.test(address.channel))
   ||address.thread!==null&&(discord?address.thread!==address.channel:!/^\d{10,}\.\d{6}$/.test(address.thread)))throw new BridgeReplyNotSent(false);
  const end=input.clock.now()+15000,abort=new AbortController();let expired=false,requested=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const current=()=>!expired&&input.clock.now()<end&&input.current();
  const cancelBody=()=>{try{void reader?.cancel().catch(()=>{});}catch{}};
  let cancel!:()=>void;
  const deadline=new Promise<never>((_resolve,reject)=>{cancel=input.clock.at(end,()=>{expired=true;abort.abort();cancelBody();reject(Error('Bridge reply attempt uncertain'));});});
  // A post with files is Discord's multipart form: the same message as JSON in one field, and each file in its own.
  let form:FormData|undefined;
  if(files.length){
   form=new FormData();
   form.set('payload_json',JSON.stringify({content:text,allowed_mentions:DISCORD_PINGS,attachments:files.map((file,id)=>({id,filename:file.name}))}));
   files.forEach((file,id)=>form!.set(`files[${id}]`,new Blob([new Uint8Array(file.contents)]),file.name));
  }
  const send=()=>{if(!current())throw Error();return input.secrets.withValue(input.tokenSecret,async token=>{
   if(!current())throw Error();
   // From here the platform may have the post, whatever happens next.
   requested=true;
   const response=await (input.request??fetch)(discord?`https://discord.com/api/v10/channels/${address.channel}/messages`:'https://slack.com/api/chat.postMessage',{
    method:'POST',redirect:'error',signal:abort.signal,headers:{Authorization:discord?`Bot ${token}`:`Bearer ${token}`,...(form?{}:{'Content-Type':'application/json'})},
    body:form??JSON.stringify(discord?{content:text,allowed_mentions:DISCORD_PINGS}:{channel:address.channel,text:text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),mrkdwn:false,parse:'none',link_names:false,unfurl_links:false,unfurl_media:false,...(address.thread?{thread_ts:address.thread}:{})}),
   });
   try{
    reader=response.body?.getReader();if(!current()||!response.ok||response.redirected||!reader)throw Error();
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>1024*1024))throw Error();
    const chunks:Buffer[]=[];let size=0;
    for(;;){const part=await reader.read();if(!current())throw Error();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024)throw Error();chunks.push(Buffer.from(part.value));}
    const result:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!current()||!object(result))throw Error();
    if(discord){if(!isDiscordId(result.id)||result.channel_id!==address.channel)throw Error();return {id:result.id};}
    if(result.ok!==true||result.channel!==address.channel||typeof result.ts!=='string'||!/^\d{10,}\.\d{6}$/.test(result.ts))throw Error();return {id:result.ts};
   }finally{cancelBody();}
  });};
  try{const result=await Promise.race([Promise.resolve().then(send),deadline]);if(!current())throw Error();return result;}catch{throw requested?Error('Bridge reply attempt uncertain'):new BridgeReplyNotSent(true);}
  finally{expired=true;cancel();abort.abort();cancelBody();}
 }};
}
