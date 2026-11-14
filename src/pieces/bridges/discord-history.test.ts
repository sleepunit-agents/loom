import {afterEach,expect,it,vi} from 'vitest';
import {discordApi} from './discord-api.js';
import type {DiscordHistoryPermit} from './discord-history.js';
import {venueSchema} from './model.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLoom} from '../../foundation.js';
import {fixture as homeFixture,fixtureSharing} from '../../fixture.js';
import {installSecretServices,secretUseRole} from '../secrets/service.js';
const venue=venueSchema.parse({id:'art',platform:'discord',agent:'art',bot:'100',workspace:'1',tokenSecret:'discord'});
const msg=(id='101')=>({id,channel_id:'300',guild_id:'1',type:0,author:{id:'200'},content:'original words',timestamp:'2026-11-02T12:00:00.123456+00:00'});
function fixture(){
 let allowed=true,open=true,active=false;
 // Missing owning Runtime permit issuer is explicit; no permissive installed override.
 const permit:DiscordHistoryPermit={agent:'art',workspace:'1',channel:'300',kind:'channel',current:()=>allowed};
 const use=vi.fn(async<T>(_name:string,callback:(value:string)=>Promise<T>)=>{active=true;try{return await callback('TEST-TOKEN');}finally{active=false;}});
 const request=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
  expect(active).toBe(true);expect(init).toMatchObject({method:'GET',redirect:'error',headers:{Authorization:'Bot TEST-TOKEN'}});
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  return Response.json(String(url).includes('/messages?')?[msg()]:{id:'300',guild_id:'1',type:0});
 });
 return {permit,use,request,api:discordApi({withValue:use},()=>open,request as typeof fetch),revoke:()=>{allowed=false;},hold:()=>{open=false;}};
}
afterEach(()=>vi.restoreAllMocks());
it('reads initial latest one and preserves original time, author, system/bot provenance and text without routing',async()=>{
 const f=fixture();expect(await f.api.history(venue,{channel:'300',kind:'channel'},f.permit)).toEqual({messages:[{id:'101',at:'2026-11-02T12:00:00.123Z',user:'200',bot:false,type:0,text:'original words'}]});
 expect(f.request.mock.calls.map(c=>String(c[0]))).toEqual(['https://discord.com/api/v10/channels/300','https://discord.com/api/v10/channels/300/messages?limit=1']);
 expect(f.use.mock.calls.map(c=>c[0])).toEqual(['discord','discord']);
});
it('reads after an exact ID oldest first, including bots, own messages, webhooks and attachments',async()=>{
 const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockResolvedValueOnce(Response.json([
  {...msg('106'),author:{id:'100',bot:true}}, {...msg('103'),author:{id:'201',bot:true}},
  {...msg('105'),type:7}, {...msg('104'),webhook_id:'999'}, {...msg('102'),attachments:[{filename:'file.txt',url:'https://example.test/file'}]},msg('101'),
 ]));
 const result=await f.api.history(venue,{channel:'300',kind:'channel',after:'100'},f.permit);
 expect(result).toEqual({messages:[
  {id:'101',at:'2026-11-02T12:00:00.123Z',user:'200',bot:false,type:0,text:'original words'},
  expect.objectContaining({id:'102',text:'original words [attachment: file.txt https://example.test/file]'}),
  expect.objectContaining({id:'103',user:'201',bot:true}),expect.objectContaining({id:'104',webhook:'999'}),
  expect.objectContaining({id:'105',type:7}),expect.objectContaining({id:'106',user:'100',bot:true}),
 ]});
 expect(String(f.request.mock.calls[1][0])).toBe('https://discord.com/api/v10/channels/300/messages?after=100&limit=100');
 expect(JSON.stringify(result)).not.toMatch(/TEST-TOKEN|may_wake|from/); // Policy labels must come from Runtime.
});
it('honors explicit bounded limits and thread kind without returning thread starter names',async()=>{
 const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:11,parent_id:'400',name:'PRIVATE STARTER'}));
 const result=await f.api.history(venue,{channel:'300',kind:'thread',limit:2},{...f.permit,kind:'thread'});
 expect(result).toEqual({messages:[expect.objectContaining({id:'101'})]});expect(JSON.stringify(result)).not.toContain('PRIVATE STARTER');
 expect(String(f.request.mock.calls[1][0])).toBe('https://discord.com/api/v10/channels/300/messages?limit=2');
});
it.each([{limit:0},{limit:101},{limit:1.5},{after:'01'},{after:'0'},{after:'18446744073709551616'},{after:'1&limit=999'},{channel:'300/../400'},{kind:'dm'},{unknown:true}])('rejects unsafe read query %j before holder IO',async patch=>{
 const f=fixture();expect(await f.api.history(venue,{channel:'300',kind:'channel',...patch},f.permit)).toBe('wait');expect(f.use).not.toHaveBeenCalled();
});
it.each([{agent:'mark'},{workspace:'2'},{channel:'301'},{kind:'thread' as const}])('requires the exact owning permit binding %j',async patch=>{
 const f=fixture();expect(await f.api.history(venue,{channel:'300',kind:'channel'},{...f.permit,...patch})).toBe('wait');expect(f.use).not.toHaveBeenCalled();
});
it('holds before acquisition and rechecks permit/staging after delayed holder and between requests',async()=>{
 for(const change of ['revoke','hold'] as const){
  const before=fixture();before[change]();expect(await before.api.history(venue,{channel:'300',kind:'channel'},before.permit)).toBe('wait');expect(before.use).not.toHaveBeenCalled();
  const delayed=fixture();delayed.use.mockImplementationOnce(async(_name,callback)=>{delayed[change]();return callback('TEST-TOKEN');});
  expect(await delayed.api.history(venue,{channel:'300',kind:'channel'},delayed.permit)).toBe('wait');expect(delayed.request).not.toHaveBeenCalled();
  const between=fixture();between.request.mockImplementationOnce(async()=>{between[change]();return Response.json({id:'300',guild_id:'1',type:0});});
  expect(await between.api.history(venue,{channel:'300',kind:'channel'},between.permit)).toBe('wait');expect(between.request).toHaveBeenCalledTimes(1);
 }
});
it('rechecks the permit after metadata and history response streaming before returning words',async()=>{
 const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockImplementationOnce(async()=>{f.revoke();return Response.json([msg()]);});
 expect(await f.api.history(venue,{channel:'300',kind:'channel'},f.permit)).toBe('wait');expect(f.request).toHaveBeenCalledTimes(2);
});
it.each([[{id:'301',guild_id:'1',type:0},'wait'],[{id:'300',type:0},'wait'],[{id:'300',guild_id:'2',type:0},'drop'],[{id:'300',guild_id:'1',type:1},'drop'],[{id:'300',guild_id:'1',type:11},'drop'],[{id:'300',guild_id:'1'},'wait'],[{id:'300',guild_id:'1',type:'0'},'wait']])('refuses wrong fresh place evidence %j without reading history',async(channel,expected)=>{
 const f=fixture();f.request.mockResolvedValueOnce(Response.json(channel));expect(await f.api.history(venue,{channel:'300',kind:'channel'},f.permit)).toBe(expected);expect(f.request).toHaveBeenCalledTimes(1);
});
it.each([[{...msg(),channel_id:'301'}],[{...msg(),guild_id:'2'}],[{...msg(),id:'01'}],[{...msg(),author:{id:'200',bot:'yes'}}],[msg(),msg()],{},'PRIVATE TEST-TOKEN'])('fails closed on malformed or misbound history %j',async messages=>{
 const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockResolvedValueOnce(Response.json(messages));
 expect(await f.api.history(venue,{channel:'300',kind:'channel',limit:100},f.permit)).toBe('wait');
});
it('refuses oversized pages and messages at/before the requested cursor',async()=>{
 for(const [query,messages]of [[{limit:1},[msg('101'),msg('102')]],[{after:'101'},[msg('101')]]] as const){
  const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockResolvedValueOnce(Response.json(messages));
  expect(await f.api.history(venue,{channel:'300',kind:'channel',...query},f.permit)).toBe('wait');
 }
});
it.each([403,404,401,429,500,302])('sanitizes history HTTP%s and never posts or retries',async status=>{
 const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockResolvedValueOnce(new Response('PRIVATE TEST-TOKEN',{status}));
 expect(await f.api.history(venue,{channel:'300',kind:'channel'},f.permit)).toBe([403,404].includes(status)?'drop':'wait');expect(f.request).toHaveBeenCalledTimes(2);
});
it.each([undefined,null,123,true,{},'not a time','1','2026-02-30T00:00:00Z'])('uses the original snowflake time if timestamp is invalid %s',async timestamp=>{
 const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockResolvedValueOnce(Response.json([{...msg(),timestamp}]));
 expect(await f.api.history(venue,{channel:'300',kind:'channel'},f.permit)).toEqual({messages:[expect.objectContaining({at:'2015-01-01T00:00:00.000Z'})]});
});

it('uses installed service authority for history and refuses revocation before the second credential acquisition',async()=>{
 const home=mkdtempSync(join(tmpdir(),'discord-history-'));homeFixture(home);
 const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue'],operations:[]}}});
 const app=await startLoom({home,next:true,sharing,stdout:()=>{}});
 try{
  installSecretServices(app.db,app.operations,sharing);
  const owner={kind:'member' as const,id:'jonathan'},buffers:Uint8Array[]=[];
  const source={read:vi.fn(async()=>{const bytes=Buffer.from('HISTORY-CREDENTIAL');buffers.push(bytes);return bytes;})};
  let revoke=false;
  const request=vi.fn<typeof fetch>(async(url,init)=>{
   expect(init?.headers).toEqual({Authorization:'Bot HISTORY-CREDENTIAL'});
   if(revoke)expect(app.operations.call('direct',owner,'secrets.revokeService',{service:'bridges',name:'discord'},'revoke').ok).toBe(true);
   return Response.json(String(url).includes('/messages?')?[msg()]:{id:'300',guild_id:'1',type:0});
  });
  const f=fixture(),api=discordApi(secretUseRole(app.db,source,sharing,{kind:'service',id:'bridges'},()=>app.operations.clock.now(),app.live),()=>true,request);
  expect(await api.history(venue,{channel:'300',kind:'channel'},f.permit)).toBe('wait');expect(source.read).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
  expect(app.operations.call('direct',owner,'secrets.describe',{name:'discord',description:'Bot'},'describe').ok).toBe(true);
  expect(app.operations.call('direct',owner,'secrets.grantService',{service:'bridges',name:'discord'},'grant').ok).toBe(true);
  expect(await api.history(venue,{channel:'300',kind:'channel'},f.permit)).toEqual({messages:[expect.objectContaining({id:'101'})]});
  expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
  revoke=true;
  expect(await api.history(venue,{channel:'300',kind:'channel'},f.permit)).toBe('wait');expect(request).toHaveBeenCalledTimes(3);expect(source.read).toHaveBeenCalledTimes(3);
  expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
 }finally{await app.close();rmSync(home,{recursive:true,force:true});}
});
it('bounds history response materialization and cancels the oversized body',async()=>{
 const f=fixture(),cancel=vi.fn();let pulls=0;
 f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockResolvedValueOnce(new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(600_000));},cancel})));
 expect(await f.api.history(venue,{channel:'300',kind:'channel'},f.permit)).toBe('wait');expect(cancel).toHaveBeenCalledOnce();expect(pulls).toBeLessThanOrEqual(3);
});
it.each(['headers','body'])('expires stalled history %s at the request deadline',async phase=>{
 vi.useFakeTimers();const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();setTimeout(()=>controller.abort(Error('PRIVATE')),ms);return controller.signal;});
 try{
  const f=fixture(),cancel=vi.fn(async()=>{});let done=false;
  f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockImplementationOnce(async(_url,init)=>{
   const stalled=new Promise<never>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('PRIVATE TEST-TOKEN')),{once:true});});
   return phase==='headers'?stalled:{ok:true,body:{getReader:()=>({read:()=>stalled,cancel})}} as unknown as Response;
  });
  const waiting=f.api.history(venue,{channel:'300',kind:'channel'},f.permit).then(value=>{done=true;return value;});
  await vi.advanceTimersByTimeAsync(14_999);expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);expect(await waiting).toBe('wait');expect(timeout).toHaveBeenCalledWith(15_000);
  if(phase==='body')expect(cancel).toHaveBeenCalledOnce();
 }finally{timeout.mockRestore();vi.useRealTimers();}
});

it.each([['agent','mark'],['workspace','2'],['channel','301'],['kind','thread']] as const)('rechecks a changed permit %s while proof stays true',async(field,value)=>{
 for(const phase of ['holder','network']){
  const f=fixture(),permit={...f.permit};expect(permit.current()).toBe(true);
  if(phase==='holder')f.use.mockImplementationOnce(async(_name,callback)=>{Object.assign(permit,{[field]:value});return callback('TEST-TOKEN');});
  else f.request.mockImplementationOnce(async()=>{Object.assign(permit,{[field]:value});return Response.json({id:'300',guild_id:'1',type:0});});
  expect(await f.api.history(venue,{channel:'300',kind:'channel'},permit)).toBe('wait');
  expect(permit.current()).toBe(true);expect(f.request).toHaveBeenCalledTimes(phase==='holder'?0:1);
 }
});
it.each(['revoke','hold'] as const)('stops body consumption when %s happens at a network await',async change=>{
 for(const phase of ['headers','stream']){
  const f=fixture(),cancel=vi.fn(async()=>{}),read=vi.fn(async()=>{f[change]();return {done:false,value:Buffer.from(JSON.stringify([msg()]))};});
  const getReader=vi.fn(()=>({read,cancel}));
  f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:0})).mockImplementationOnce(async()=>{
   if(phase==='headers')f[change]();
   return {ok:true,body:{cancel,getReader}} as unknown as Response;
  });
  expect(await f.api.history(venue,{channel:'300',kind:'channel'},f.permit)).toBe('wait');
  expect(cancel).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledTimes(phase==='headers'?0:1);expect(getReader).toHaveBeenCalledTimes(phase==='headers'?0:1);
 }
});
