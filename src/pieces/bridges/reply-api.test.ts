import {expect,it,vi} from 'vitest';
import {FakeClock} from '../../core/clock.js';
import type {SecretUse} from '../secrets/role.js';
import {bridgeReplyApi,DISCORD_PINGS} from './reply-api.js';
import {BridgeReplyNotSent} from './outbound.js';
function fixture(platform:'discord'|'slack'='discord'){
 const clock=new FakeClock();let live=true;const channel=platform==='discord'?'123':'CROOM';
 const request=vi.fn<typeof fetch>(async()=>Response.json(platform==='discord'?{id:'456',channel_id:channel}:{ok:true,channel,ts:'1794432000.000001'}));
 const secrets:SecretUse={withValue:vi.fn(async(_name,use)=>use('synthetic-token'))};
 const api=bridgeReplyApi({platform,tokenSecret:'TOKEN',secrets,clock,current:()=>live,request});return {api,request,secrets,clock,channel,stop:()=>{live=false;}};
}
it.each(['discord','slack'] as const)('posts one %s part, pinging on Discord only the users whose mention was written, and confirms its matching receipt',async platform=>{
 const f=fixture(platform),address={channel:f.channel,thread:platform==='slack'?'1794432000.000000':null};
 expect(await f.api.post(address,'Hi <@everyone> & here')).toEqual({id:platform==='discord'?'456':'1794432000.000001'});
 expect(f.request).toHaveBeenCalledOnce();const [url,options]=f.request.mock.calls[0];expect(url).toBe(platform==='discord'?'https://discord.com/api/v10/channels/123/messages':'https://slack.com/api/chat.postMessage');expect(options).toMatchObject({method:'POST',redirect:'error',headers:{Authorization:platform==='discord'?'Bot synthetic-token':'Bearer synthetic-token'}});
 const body=JSON.parse(String(options?.body));expect(body).toEqual(platform==='discord'?{content:'Hi <@everyone> & here',allowed_mentions:{parse:['users'],replied_user:false}}:{channel:'CROOM',text:'Hi &lt;@everyone&gt; &amp; here',mrkdwn:false,parse:'none',link_names:false,unfurl_links:false,unfurl_media:false,thread_ts:'1794432000.000000'});
});
it('says not sent, never uncertain, when the secret holder fails before any request',async()=>{
 const f=fixture();vi.mocked(f.secrets.withValue).mockRejectedValueOnce(Error('holder away'));
 await expect(f.api.post({channel:f.channel,thread:null},'Hi')).rejects.toMatchObject({again:true});expect(f.request).not.toHaveBeenCalled();
 // Once the request is made, a failure is uncertain however early it comes.
 f.request.mockRejectedValueOnce(Error('socket hang up'));await expect(f.api.post({channel:f.channel,thread:null},'Hi')).rejects.toThrow('uncertain');
});
it('rejects unsafe addresses and dead lifetimes before acquiring a token',async()=>{
 const f=fixture();for(const channel of ['../token','https://evil.test','123?x=y'])await expect(f.api.post({channel,thread:null},'Hi')).rejects.toMatchObject({again:false});f.stop();await expect(f.api.post({channel:'123',thread:null},'Hi')).rejects.toBeInstanceOf(BridgeReplyNotSent);expect(f.secrets.withValue).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
});
it.each(['headers','body','holder return'] as const)('refuses an acknowledgement invalidated at %s',async phase=>{
 const f=fixture();let cancelled=false;
 if(phase==='headers')f.request.mockImplementation(async()=>{f.stop();return new Response(new ReadableStream({cancel(){cancelled=true;}}));});
 if(phase==='body')f.request.mockImplementation(async()=>new Response(new ReadableStream({pull(c){f.stop();c.enqueue(Buffer.from('{}'));},cancel(){cancelled=true;}})));
 if(phase==='holder return')f.secrets.withValue=async(_name,use)=>{const result=await use('synthetic');f.stop();return result;};
 await expect(f.api.post({channel:'123',thread:null},'Hi')).rejects.toThrow('uncertain');if(phase!=='holder return')expect(cancelled).toBe(true);expect(f.request).toHaveBeenCalledOnce();
});
it('bounds the whole attempt by the injected absolute deadline and never retries a late post',async()=>{
 const f=fixture();let release!:(response:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.request.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});
 const attempt=f.api.post({channel:'123',thread:null},'Hi'),rejected=expect(attempt).rejects.toThrow('uncertain');await started;f.clock.advance(15000);await rejected;let cancelled=false;
 release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise<void>(resolve=>queueMicrotask(resolve));expect(cancelled).toBe(true);expect(f.request).toHaveBeenCalledOnce();
});
it.each([{id:'456',channel_id:'other'},{id:'not-a-receipt',channel_id:'123'},{ok:false,error:'PRIVATE token echo'}])('refuses malformed or mismatched receipt without upstream diagnostics',async body=>{
 const f=fixture();f.request.mockResolvedValue(Response.json(body));await expect(f.api.post({channel:'123',thread:null},'Hi')).rejects.toThrow(/^Bridge reply attempt uncertain$/);expect(f.request).toHaveBeenCalledOnce();
});
it('attempts whitespace chunks of a nonempty whole reply without dropping text',async()=>{
 const f=fixture();await f.api.post({channel:'123',thread:null},'\n'.repeat(2000));expect(JSON.parse(String(f.request.mock.calls[0][1]?.body)).content).toBe('\n'.repeat(2000));
});
it.each(['declared','streamed'] as const)('refuses oversized %s response bodies',async mode=>{
 const f=fixture();f.request.mockResolvedValue(mode==='declared'?new Response('{}',{headers:{'content-length':String(1024*1024+1)}}):new Response(Buffer.alloc(1024*1024+1,65)));await expect(f.api.post({channel:'123',thread:null},'Hi')).rejects.toThrow(/^Bridge reply attempt uncertain$/);
});
it('aborts and cancels a pending response body at the absolute deadline',async()=>{
 const f=fixture();let entered!:()=>void,cancelled=false;const started=new Promise<void>(resolve=>{entered=resolve;});f.request.mockResolvedValue(new Response(new ReadableStream({pull(){entered();return new Promise<void>(()=>{});},cancel(){cancelled=true;}})));
 const pending=f.api.post({channel:'123',thread:null},'Hi'),refused=expect(pending).rejects.toThrow('uncertain');await started;f.clock.advance(15000);await refused;expect(f.request.mock.calls[0][1]?.signal?.aborted).toBe(true);expect(cancelled).toBe(true);
});
it.each([{status:503,body:{ok:true,channel:'CROOM',ts:'1794432000.000001'}},{status:200,body:{ok:false,channel:'CROOM',ts:'1794432000.000001'}},{status:200,body:{ok:true,channel:'OTHER',ts:'1794432000.000001'}},{status:200,body:{ok:true,channel:'CROOM',ts:'not-a-message'}}])('requires successful matching Slack confirmation: %j',async input=>{
 const f=fixture('slack');f.request.mockResolvedValue(Response.json(input.body,{status:input.status}));await expect(f.api.post({channel:'CROOM',thread:null},'Hi')).rejects.toThrow(/^Bridge reply attempt uncertain$/);expect(f.request).toHaveBeenCalledOnce();
});
it.each([{platform:'slack' as const,channel:'https://evil.test',thread:null},{platform:'slack' as const,channel:'CROOM',thread:'../token'},{platform:'discord' as const,channel:'123',thread:'456'}])('refuses invalid platform address/thread before credentials: %j',async input=>{
 const f=fixture(input.platform);await expect(f.api.post(input,'Hi')).rejects.toMatchObject({again:false});expect(f.secrets.withValue).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
});
it('lets a Discord post ping users and nothing else',()=>{
 // One statement of the rule: no `everyone`, no `roles`, and no ping for being replied to.
 expect(DISCORD_PINGS).toEqual({parse:['users'],replied_user:false});
});
it('posts files on Discord as a multipart form with the same message and pings, and refuses them for Slack before any request',async()=>{
 const f=fixture('discord');
 expect(await f.api.post({channel:f.channel,thread:null},'Here <@42>',[{name:'plot.png',contents:Buffer.from('PNG')},{name:'data.csv',contents:Buffer.from('1,2')}])).toEqual({id:'456'});
 const [,options]=f.request.mock.calls[0],form=options?.body as FormData;
 expect(form).toBeInstanceOf(FormData);
 // No JSON content type: the form sets its own, with its boundary.
 expect(new Headers(options?.headers).get('content-type')).toBeNull();expect(new Headers(options?.headers).get('authorization')).toBe('Bot synthetic-token');
 expect(JSON.parse(String(form.get('payload_json')))).toEqual({content:'Here <@42>',allowed_mentions:{parse:['users'],replied_user:false},attachments:[{id:0,filename:'plot.png'},{id:1,filename:'data.csv'}]});
 const first=form.get('files[0]') as File,second=form.get('files[1]') as File;
 expect([first.name,await first.text(),second.name,await second.text()]).toEqual(['plot.png','PNG','data.csv','1,2']);
 const slack=fixture('slack');
 await expect(slack.api.post({channel:slack.channel,thread:null},'Here',[{name:'plot.png',contents:Buffer.from('PNG')}])).rejects.toMatchObject({again:false});
 expect(slack.request).not.toHaveBeenCalled();
});
