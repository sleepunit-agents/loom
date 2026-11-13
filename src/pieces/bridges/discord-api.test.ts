import { describe, expect, it, vi } from 'vitest';
import { discordApi, type DiscordPlace } from './discord-api.js';
import { venueSchema } from './model.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture as homeFixture, fixtureSharing } from '../../fixture.js';
import { installSecretServices, secretUseRole } from '../secrets/service.js';
const venue = venueSchema.parse({id:'art',platform:'discord',agent:'art',bot:'100',workspace:'1',tokenSecret:'discord'});
const place: DiscordPlace = {channel:'300',user:'200',dm:false};
function fixture() {
  let open = true, active = false;
  // Model the actual holder's exception sanitization and callback lifetime.
  const use = vi.fn(async <T>(_name: string, callback: (token: string) => Promise<T>) => {
    active = true;
    try { return await callback('TEST-TOKEN'); } catch { throw Error('Secret use failed'); } finally { active=false; }
  });
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(active).toBe(true);
    expect(String(url)).toMatch(/^https:\/\/discord\.com\/api\/v10\/(users\/@me|guilds\/[1-9]\d*|channels\/[1-9]\d*)$/);
    expect(init).toMatchObject({method:'GET',redirect:'error',headers:{Authorization:'Bot TEST-TOKEN'}});
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const path = String(url).split('/').at(-1);
    return Response.json(path === '@me' ? {id:'100',bot:true} : path === '1' ? {id:'1'} : {id:'300',guild_id:'1',type:0,name:'general'});
  });
  return {use,request,api:discordApi({withValue:use},()=>open,request as typeof fetch),hold:()=>{open=false;}};
}
describe('Discord fresh service metadata',()=>{
  it('authenticates configured bot and guild with independent service uses',async()=>{
    const f=fixture();
    expect(await f.api.authenticate(venue)).toEqual({bot:'100',workspace:'1'});
    expect(f.use.mock.calls.map(c=>c[0])).toEqual(['discord','discord']);
    expect(f.request.mock.calls.map(c=>String(c[0]))).toEqual(['https://discord.com/api/v10/users/@me','https://discord.com/api/v10/guilds/1']);
    f.request.mockResolvedValueOnce(Response.json({id:'101',bot:true}));
    expect(await f.api.authenticate(venue)).toBe('wait');
    expect(f.request).toHaveBeenCalledTimes(3); // No identity cache.
  });
  it.each([{id:'101',bot:true},{id:'100',bot:false},{id:'100'},{}])('waits for unsafe bot evidence %j',async user=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json(user));
    expect(await f.api.authenticate(venue)).toBe('wait');expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([{id:'2'},{},{id:'1',unavailable:true}])('waits for unsafe guild evidence %j',async guild=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'100',bot:true})).mockResolvedValueOnce(Response.json(guild));
    expect(await f.api.authenticate(venue)).toBe('wait');
  });
  it.each([0,5])('reads fresh text/announcement channel type %s',async type=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type,name:'general'}));
    expect(await f.api.channel(venue,place)).toEqual({id:'300',kind:'channel',name:'general'});
    f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'2',type}));
    expect(await f.api.channel(venue,place)).toBe('drop');expect(f.use).toHaveBeenCalledTimes(2);
  });
  it.each([10,11,12])('resolves thread type %s through fresh parent without starter words',async type=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type,parent_id:'400',name:'PRIVATE STARTER'}))
      .mockResolvedValueOnce(Response.json({id:'400',guild_id:'1',type:15,name:'forum'}));
    expect(await f.api.channel(venue,place)).toEqual({id:'300',kind:'thread',parent:'400',parentName:'forum'});
    expect(f.use).toHaveBeenCalledTimes(2);expect(String(f.request.mock.calls[1][0])).toBe('https://discord.com/api/v10/channels/400');
  });
  it.each([0,5,15,16])('accepts supported thread parent type %s',async type=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:11,parent_id:'400'}))
      .mockResolvedValueOnce(Response.json({id:'400',guild_id:'1',type}));
    expect(await f.api.channel(venue,place)).toEqual({id:'300',kind:'thread',parent:'400'});
  });
  it.each([
    [{id:'999',guild_id:'1',type:0},'wait'],[{id:'300',type:0},'wait'],[{id:'300',guild_id:'1'},'wait'],
    [{id:'300',guild_id:'1',type:2},'drop'],[{id:'300',guild_id:'1',type:3},'drop'],
    [{id:'300',guild_id:'1',type:11},'wait'],[{id:'300',guild_id:'1',type:11,parent_id:'300'},'wait'],
    [{id:'300',guild_id:'1',type:11,parent_id:'../400'},'wait'],
  ])('fails closed on channel %j',async(ch,result)=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json(ch));expect(await f.api.channel(venue,place)).toBe(result);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{id:'401',guild_id:'1',type:0},'wait'],[{id:'400',type:0},'wait'],
    [{id:'400',guild_id:'2',type:0},'drop'],[{id:'400',guild_id:'1',type:11},'drop'],
  ])('fails closed on parent %j',async(parent,result)=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:11,parent_id:'400'})).mockResolvedValueOnce(Response.json(parent));
    expect(await f.api.channel(venue,place)).toBe(result);
  });
  it('requires the fresh DM recipient to match the event sender',async()=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',type:1,recipients:[{id:'200',username:'IGNORED'}]}));
    expect(await f.api.channel(venue,{...place,dm:true})).toEqual({id:'300',kind:'dm'});
  });
  it.each([
    [{id:'300',type:1,recipients:[{id:'201'}]},'drop'],[{id:'300',type:3,recipients:[{id:'200'}]},'drop'],
    [{id:'300',type:1,guild_id:'1',recipients:[{id:'200'}]},'drop'],[{id:'300',type:1},'wait'],
    [{id:'300',type:1,recipients:[]},'wait'],[{id:'300',type:1,recipients:[{id:'200'},{id:'201'}]},'wait'],
    [{id:'300',type:1,recipients:[{id:'0200'}]},'wait'],
    [{id:'300',type:1,guild_id:{},recipients:[{id:'200'}]},'wait'],
    [{id:'300',type:1,guild_id:'01',recipients:[{id:'200'}]},'wait'],
  ])('fails closed on DM %j',async(ch,result)=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json(ch));expect(await f.api.channel(venue,{...place,dm:true})).toBe(result);
  });
  it.each([403,404,401,429,500,302])('classifies HTTP %s without leaking response words',async status=>{
    const f=fixture();f.request.mockResolvedValueOnce(new Response('TEST-TOKEN PRIVATE',{status}));
    expect(await f.api.channel(venue,place)).toBe([403,404].includes(status)?'drop':'wait');
    f.request.mockResolvedValueOnce(new Response('TEST-TOKEN PRIVATE',{status}));
    expect(await f.api.authenticate(venue)).toBe('wait');
  });
  it('holds before acquisition, after a delayed holder, between reads and after metadata',async()=>{
    const held=fixture();held.hold();expect(await held.api.channel(venue,place)).toBe('wait');expect(held.use).not.toHaveBeenCalled();
    const delayed=fixture();delayed.use.mockImplementationOnce(async(_name,callback)=>{delayed.hold();return callback('TEST-TOKEN');});
    expect(await delayed.api.authenticate(venue)).toBe('wait');expect(delayed.request).not.toHaveBeenCalled();
    const between=fixture();between.request.mockImplementationOnce(async()=>{between.hold();return Response.json({id:'100',bot:true});});
    expect(await between.api.authenticate(venue)).toBe('wait');expect(between.request).toHaveBeenCalledTimes(1);
    const late=fixture();late.request.mockImplementationOnce(async()=>{late.hold();return Response.json({id:'300',guild_id:'1',type:0});});
    expect(await late.api.channel(venue,place)).toBe('wait');
  });
  it('rechecks staging and secret authority between thread and parent requests',async()=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({id:'300',guild_id:'1',type:11,parent_id:'400'}));
    f.use.mockImplementationOnce(async(_name,callback)=>callback('TEST-TOKEN')).mockRejectedValueOnce(Error('TEST-TOKEN'));
    expect(await f.api.channel(venue,place)).toBe('wait');expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(['0','01','18446744073709551616','300/../400','300?x=1'])('rejects unsafe path id %s without acquiring secrets',async id=>{
    const f=fixture();expect(await f.api.channel(venue,{...place,channel:id})).toBe('wait');
    expect(await f.api.channel(venue,{...place,user:id})).toBe('wait');expect(await f.api.authenticate({...venue,workspace:id})).toBe('wait');
    expect(f.use).not.toHaveBeenCalled();
  });
  it.each([{enabled:false},{platform:'slack' as const},{bot:'01'}])('refuses invalid setup %j',async patch=>{
    const f=fixture();expect(await f.api.authenticate({...venue,...patch})).toBe('wait');expect(await f.api.channel({...venue,...patch},place)).toBe('wait');expect(f.use).not.toHaveBeenCalled();
  });
  it.each(['null','[]','PRIVATE TEST-TOKEN','{"id":'])('sanitizes malformed JSON %s',async body=>{
    const f=fixture();f.request.mockResolvedValueOnce(new Response(body));expect(await f.api.channel(venue,place)).toBe('wait');
  });
  it('bounds streamed replies and cancels oversized bodies',async()=>{
    const f=fixture(),cancel=vi.fn();let n=0;
    f.request.mockResolvedValueOnce(new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(600_000));n++;},cancel})));
    expect(await f.api.channel(venue,place)).toBe('wait');expect(cancel).toHaveBeenCalledOnce();expect(n).toBeLessThanOrEqual(3);
  });
  it('uses an immutable venue snapshot across asynchronous authentication',async()=>{
    const f=fixture(),v=structuredClone(venue);
    f.request.mockImplementationOnce(async()=>{v.bot='999';v.workspace='2';v.tokenSecret='other';return Response.json({id:'100',bot:true});});
    expect(await f.api.authenticate(v)).toEqual({bot:'100',workspace:'1'});
    expect(f.use.mock.calls.map(c=>c[0])).toEqual(['discord','discord']);
  });
  it('expires a stalled request at 15 seconds and returns only wait',async()=>{
    vi.useFakeTimers();
    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{
      const controller=new AbortController();setTimeout(()=>controller.abort(Error('PRIVATE')),ms);return controller.signal;
    });
    try {
      const f=fixture();let done=false;
      f.request.mockImplementationOnce(async(_url,init)=>new Promise((_resolve,reject)=>{
        init!.signal!.addEventListener('abort',()=>reject(Error('PRIVATE TEST-TOKEN')),{once:true});
      }));
      const waiting=f.api.channel(venue,place).then(value=>{done=true;return value;});
      await vi.advanceTimersByTimeAsync(14_999);expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);expect(await waiting).toBe('wait');expect(timeout).toHaveBeenCalledWith(15_000);
    } finally {timeout.mockRestore();vi.useRealTimers();}
  });
  it('uses each new callback token rather than retaining the preceding credential',async()=>{
    const f=fixture();
    f.use.mockImplementationOnce(async(_name,callback)=>callback('FIRST')).mockImplementationOnce(async(_name,callback)=>callback('SECOND'));
    f.request.mockImplementation(async(url,init)=>{
      const me=String(url).endsWith('@me');expect(init?.headers).toEqual({Authorization:`Bot ${me?'FIRST':'SECOND'}`});
      return Response.json(me?{id:'100',bot:true}:{id:'1'});
    });
    expect(await f.api.authenticate(venue)).toEqual({bot:'100',workspace:'1'});expect(f.use).toHaveBeenCalledTimes(2);
  });
  it('uses real service grants in a next-mode fixture, zeroes holder buffers and observes revocation',async()=>{
    const home=mkdtempSync(join(tmpdir(),'discord-api-'));homeFixture(home);
    const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue'],operations:[]}}});
    const app=await startLoom({home,next:true,sharing,stdout:()=>{}});
    try {
      installSecretServices(app.db,app.operations,sharing);
      const owner={kind:'member' as const,id:'jonathan'},buffers:Uint8Array[]=[];
      const source={read:vi.fn(async()=>{const bytes=Buffer.from('FIXTURE-CREDENTIAL');buffers.push(bytes);return bytes;})};
      const request=vi.fn<typeof fetch>(async(url,init)=>{
        expect(init?.headers).toEqual({Authorization:'Bot FIXTURE-CREDENTIAL'});
        return Response.json(String(url).endsWith('@me')?{id:'100',bot:true}:{id:'1'});
      });
      const api=discordApi(secretUseRole(app.db,source,sharing,{kind:'service',id:'bridges'},()=>app.operations.clock.now(),app.live),()=>true,request);
      expect(await api.authenticate(venue)).toBe('wait');expect(source.read).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
      expect(app.operations.call('direct',owner,'secrets.describe',{name:'discord',description:'Bot'},'describe').ok).toBe(true);
      expect(app.operations.call('direct',owner,'secrets.grantService',{service:'bridges',name:'discord'},'grant').ok).toBe(true);
      expect(await api.authenticate(venue)).toEqual({bot:'100',workspace:'1'});
      expect(buffers).toHaveLength(2);expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
      expect(app.operations.call('direct',owner,'secrets.revokeService',{service:'bridges',name:'discord'},'revoke').ok).toBe(true);
      expect(await api.authenticate(venue)).toBe('wait');expect(request).toHaveBeenCalledTimes(2);expect(source.read).toHaveBeenCalledTimes(2);
    } finally {await app.close();rmSync(home,{recursive:true,force:true});}
  });
});
