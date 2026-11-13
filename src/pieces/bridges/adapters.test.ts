import {expect,it,vi} from 'vitest';
import {venueAdapters} from './adapters.js';
import {venueSchema,type Message} from './model.js';
import type {SecretUse} from '../secrets/role.js';
const v=(platform:'discord'|'slack')=>venueSchema.parse({id:platform,platform,agent:'art',workspace:platform==='discord'?'1':'T1',bot:platform==='discord'?'100':'U1',tokenSecret:'BOT'});
const m=(platform:'discord'|'slack'):Message=>({id:'event',channel:platform==='discord'?'300':'D1',user:platform==='discord'?'200':'U2',dm:platform==='slack',text:'hello',mentions:[]});
function fixture(platform:'discord'|'slack') {
  let marker:string|undefined='first',held=false;
  const use=vi.fn<SecretUse['withValue']>(async(_name,callback)=>callback('PRIVATE'));
  const request=vi.fn<typeof fetch>(async(url,init)=>{
    const path=String(url).split('/').at(-1)!;
    if(path==='@me')return Response.json({id:'100',bot:true});
    if(path==='1')return Response.json({id:'1'});
    if(path==='300')return Response.json({id:'300',type:0,guild_id:'1'});
    if(path==='auth.test')return Response.json({ok:true,team_id:'T1',user_id:'U1',bot_id:'B1'});
    if(path==='bots.info')return Response.json({ok:true,bot:{id:'B1',user_id:'U1',deleted:false,app_id:'A1'}});
    if(path==='conversations.info')return Response.json({ok:true,channel:{id:'D1',is_im:true,is_mpim:false,user:'U2'}});
    if(path==='users.info')return Response.json({ok:true,user:{id:'U2',team_id:'T1',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}});
    const body=JSON.parse(String(init?.body));
    return Response.json(platform==='discord'?{id:'400',channel_id:'300'}:{ok:true,channel:body.channel,ts:'1794503533.000001'});
  });
  const adapter=venueAdapters({withValue:use},{lifetime:()=>marker,beforeRead:()=>!held,request}).find(a=>a.platform===platform)!;
  return {adapter,use,request,rotate:()=>{marker='second';},lose:()=>{marker=undefined;},hold:()=>{held=true;}};
}
it.each(['discord','slack'] as const)('%s authenticates and inspects fresh metadata before allowing',async platform=>{
  const f=fixture(platform);expect(await f.adapter.inspect(v(platform),m(platform))).toEqual(platform==='discord'?'allow':{kind:'allow',members:['U1','U2']});
  const calls=f.request.mock.calls.length;expect(calls).toBeGreaterThan(2);
  await f.adapter.inspect(v(platform),m(platform));expect(f.request).toHaveBeenCalledTimes(calls*2);
  f.hold();expect(await f.adapter.inspect(v(platform),m(platform))).toBe('wait');expect(f.request).toHaveBeenCalledTimes(calls*2);
});
it.each(['discord','slack'] as const)('%s sends sequential chunks with scoped values, bound receipts, threads and disabled mentions',async platform=>{
  const f=fixture(platform),authorize=vi.fn(async()=>true),text='<@200> & <!everyone> '+ 'x'.repeat(4000);
  const result=await f.adapter.send(v(platform),{channel:m(platform).channel,dm:platform==='slack',thread:platform==='discord'?'300':'1794503533.000000'},text,'reply',authorize);
  expect(result.id).toBe(platform==='discord'?'400':'1794503533.000001');expect(authorize).toHaveBeenCalledTimes(platform==='discord'?6:4);
  const bodies=f.request.mock.calls.map(([,init])=>{
    expect(init).toMatchObject({method:'POST',redirect:'error'});expect(init?.headers).toMatchObject({Authorization:platform==='discord'?'Bot PRIVATE':'Bearer PRIVATE'});return JSON.parse(String(init?.body));
  });
  expect(f.use).toHaveBeenCalledTimes(bodies.length);
  if(platform==='discord') {expect(bodies.every(b=>JSON.stringify(b.allowed_mentions)===JSON.stringify({parse:[],replied_user:false}))).toBe(true);expect(bodies.map(b=>b.content).join('')).toBe(text);}
  else {expect(bodies.every(b=>b.thread_ts==='1794503533.000000' && b.mrkdwn===false && b.parse==='none' && b.link_names===false && b.unfurl_links===false)).toBe(true);expect(bodies.map(b=>b.text).join('')).toContain('&lt;@200&gt; &amp; &lt;!everyone&gt;');}
});
it.each(['discord','slack'] as const)('%s refuses stale/held values after deferred acquisition and metadata',async platform=>{
  for(const phase of ['holder','metadata'] as const) {
    const f=fixture(platform),started=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
    if(phase==='holder')f.use.mockImplementationOnce(async(_n,callback)=>{started.resolve();await finish.promise;return callback('PRIVATE');});
    else f.request.mockImplementationOnce(async()=>{started.resolve();await finish.promise;return Response.json(platform==='discord'?{id:'100',bot:true}:{ok:true,team_id:'T1',user_id:'U1',bot_id:'B1'});});
    const pending=f.adapter.inspect(v(platform),m(platform));await started.promise;f.rotate();finish.resolve();expect(await pending).toBe('wait');expect(f.request).toHaveBeenCalledTimes(phase==='holder'?0:1);
  }
});
it.each(['discord','slack'] as const)('%s stops after one partial post on revoked authorization or lifetime, and sanitizes ambiguity',async platform=>{
  for(const failure of ['authority','lifetime','receipt'] as const) {
    const f=fixture(platform),authorize=vi.fn(async()=>true);
    if(failure==='authority')authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async(...args)=>{const r=await original(...args);if(failure==='lifetime')f.rotate();return failure==='receipt'?Response.json({error:'PRIVATE',id:'invalid'}):r;});
    await expect(f.adapter.send(v(platform),{channel:m(platform).channel,dm:false},'x'.repeat(8000),'reply',authorize)).rejects.toThrow(/^Bridge reply attempt uncertain$/);
    expect(f.request).toHaveBeenCalledOnce();
  }
});
it.each(['discord','slack'] as const)('%s holds before any acquisition and never posts if authorization fails',async platform=>{
  const f=fixture(platform);f.hold();await expect(f.adapter.send(v(platform),{channel:m(platform).channel,dm:false},'hello','reply',async()=>true)).rejects.toThrow();expect(f.use).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
});

it.each(['discord','slack'] as const)('%s reauthorizes after a pending holder before posting',async platform=>{
  const f=fixture(platform),started=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let allowed=true;
  f.use.mockImplementationOnce(async(_name,callback)=>{started.resolve();await finish.promise;return callback('PRIVATE');});
  const pending=f.adapter.send(v(platform),{channel:m(platform).channel,dm:false},'hello','reply',async()=>allowed);
  const result=expect(pending).rejects.toThrow(/^Bridge reply attempt uncertain$/);
  await started.promise;allowed=false;finish.resolve();await result;expect(f.request).not.toHaveBeenCalled();
});
