/** Credential-owning HTTP adapters. Daemons own sockets; the durable engine owns
 * retry/uncertainty and authorizes every chunk. No credential enters the engine. */
import type { SecretUseAuthority } from '../secrets/role.js';
import type { Venue, Message } from './model.js';
import type { VenueAdapter, Inspection } from './role.js';
import { discordApi } from './discord-api.js';
import { slackApi } from './slack-api.js';
import { postReply } from './outbound.js';
const snowflake=(id:string)=>/^[1-9]\d{0,19}$/.test(id) && BigInt(id)<=18446744073709551615n;
const slackId=(id:string)=>/^[A-Z][A-Z0-9]{1,199}$/.test(id);
const object=(x:unknown):x is Record<string,unknown>=>!!x && typeof x==='object' && !Array.isArray(x);
async function json(response:Response) {
  if(!response.ok) {await response.body?.cancel();throw Error('Bridge unavailable');}
  const reader=response.body?.getReader();if(!reader) throw Error('Bridge unavailable');
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>1024*1024)throw Error('Bridge unavailable');chunks.push(r.value);}}
  finally {await reader.cancel();}
  const data:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!object(data))throw Error('Bridge unavailable');return data;
}
export function venueAdapters(secrets:SecretUseAuthority, options:{
  /** Public holder generation + setup/authority lifetime; undefined always refuses IO. */
  lifetime(venue:Venue):string|undefined;
  /** Staging gate for reads. Called before acquisition and after every await. */
  beforeRead(venue:Venue):boolean;
  request?:typeof fetch;
}):VenueAdapter[] {
  const request=options.request??fetch;
  function lease(v:Venue) {
    const marker=options.lifetime(v);
    return ()=>marker!==undefined && marker===options.lifetime(v) && secrets.mayUse(v.tokenSecret) && options.beforeRead(v);
  }
  async function inspect(input:Venue,inputMessage:Message):Promise<Inspection> {
    const v=structuredClone(input),m=structuredClone(inputMessage),current=lease(v);
    if(!current())return 'wait';
    if(v.platform==='slack') {
      const api=slackApi(secrets,current,request);
      if(await api.authenticate(v)==='wait'||!current())return 'wait';
      const result=await api.inspect(v,m);return current()?result:'wait';
    }
    const api=discordApi(secrets,current,request);
    if(await api.authenticate(v)==='wait'||!current())return 'wait';
    const place=await api.channel(v,{channel:m.channel,user:m.user,dm:m.dm});
    if(!current())return 'wait';
    if(place==='wait'||place==='drop')return place;
    if(place.kind==='thread' ? m.parent!==place.parent || m.thread!==place.id : m.parent!==undefined || m.thread!==undefined) return 'drop';
    return 'allow';
  }
  return (['discord','slack'] as const).map(platform=>({
    platform, current:lease,
    // No second receiver: installDiscordDaemon/installSlackDaemon own connections.
    async connect(){return {close(){}};},
    inspect,
    async send(input,address,text,_operationId,authorize) {
      const v=structuredClone(input),target={...address},current=lease(v);
      if(v.platform!==platform || !v.enabled || !(platform==='discord'?snowflake(target.channel):slackId(target.channel))) throw Error('Bridge reply attempt uncertain');
      if(target.thread!==undefined && !(platform==='discord'?target.thread===target.channel:/^\d{10,}\.\d{6}$/.test(target.thread))) throw Error('Bridge reply attempt uncertain');
      return postReply(platform,text,async part=>{
        if(!current() || !await authorize() || !current())throw Error('Bridge reply attempt uncertain');
        return secrets.withValue(v.tokenSecret,async token=>{
          if(!current() || !await authorize() || !current() || !secrets.mayUse(v.tokenSecret))throw Error('Bridge reply attempt uncertain');
          const slackText=part.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const response=await request(platform==='discord'?`https://discord.com/api/v10/channels/${target.channel}/messages`:'https://slack.com/api/chat.postMessage',{
            method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
            headers:{Authorization:platform==='discord'?`Bot ${token}`:`Bearer ${token}`,'Content-Type':'application/json'},
            body:JSON.stringify(platform==='discord'?{content:part,allowed_mentions:{parse:[],replied_user:false}}:
              {channel:target.channel,text:slackText,mrkdwn:false,parse:'none',link_names:false,unfurl_links:false,unfurl_media:false,...(target.thread?{thread_ts:target.thread}:{})}),
          });
          const result=await json(response);
          // The post may already have happened. Any ambiguous receipt is uncertain.
          if(!current())throw Error('Bridge reply attempt uncertain');
          if(platform==='discord') {
            if(typeof result.id!=='string'||!snowflake(result.id)||result.channel_id!==target.channel)throw Error('Bridge reply attempt uncertain');
            return {id:result.id};
          }
          if(result.ok!==true||result.channel!==target.channel||typeof result.ts!=='string'||!/^\d{10,}\.\d{6}$/.test(result.ts))throw Error('Bridge reply attempt uncertain');
          return {id:result.ts};
        });
      });
    },
  }));
}
