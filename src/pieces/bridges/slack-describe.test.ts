import { describe, expect, it, vi } from 'vitest';
import { slackDescribe, type SlackDescribePermit } from './slack-describe.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture as homeFixture, fixtureSharing } from '../../fixture.js';
import { installSecretServices, secretUseRole } from '../secrets/service.js';
import { venueSchema } from './model.js';
const venue = venueSchema.parse({id:'slack',platform:'slack',agent:'art',bot:'UBOT',workspace:'T1',tokenSecret:'slack'});
const human = (id:string) => ({id,team_id:'T1',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false});
function fixture(kind:'dm'|'group'='group') {
  // Explicit fake owning role. These are independent revocation facts, not
  // platform evidence used to fabricate authority or a production issuer.
  const facts={authenticated:true,setup:true,credential:true,policy:true,lifetime:true};
  let staged=false,active=false;
  const permit:SlackDescribePermit={agent:'art',venue:'slack',workspace:'T1',kind,place:kind==='dm'?'U1':'G1',current:()=>Object.values(facts).every(Boolean)};
  const use=vi.fn(async<T>(_name:string,cb:(token:string)=>Promise<T>)=>{
    active=true;try{return await cb('FIXTURE');}catch{throw Error('Secret use failed');}finally{active=false;}
  });
  const request=vi.fn<typeof fetch>(async(url,init)=>{
    expect(active).toBe(true);
    expect(init).toMatchObject({method:'POST',redirect:'error',headers:{Authorization:'Bearer FIXTURE'}});
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const method=String(url).split('/').at(-1), fields=new URLSearchParams(init?.body as URLSearchParams);
    if(method==='conversations.info')return Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false}});
    if(method==='conversations.members')return Response.json({ok:true,members:['UBOT','U2','U1'],response_metadata:{next_cursor:''}});
    expect(method).toBe('users.info');return Response.json({ok:true,user:human(fields.get('user')!)});
  });
  return {facts,permit,use,request,hold:()=>{staged=true;},api:()=>slackDescribe(venue,permit,{withValue:use},()=>!staged,request)};
}
describe('unregistered Slack describe evidence',()=>{
  it('reads a DM human without opening a conversation or returning policy/profile fields',async()=>{
    const f=fixture('dm');f.request.mockResolvedValueOnce(Response.json({ok:true,user:{...human('U1'),name:'PRIVATE',profile:{email:'PRIVATE'}}}));
    expect(await f.api().describe()).toEqual({kind:'dm',place:'U1',humans:['U1']});
    expect(f.request).toHaveBeenCalledOnce();expect(String(f.request.mock.calls[0][0])).toBe('https://slack.com/api/users.info');
  });
  it('returns all eligible humans, excluding bot, from complete fresh pages with per-request credentials',async()=>{
    const f=fixture();
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false}}))
      .mockResolvedValueOnce(Response.json({ok:true,members:['UBOT','U2'],response_metadata:{next_cursor:'next'}}))
      .mockResolvedValueOnce(Response.json({ok:true,members:['U1'],response_metadata:{next_cursor:''}}));
    expect(await f.api().describe()).toEqual({kind:'group',place:'G1',humans:['U1','U2']});
    expect(f.use.mock.calls.map(c=>c[0])).toEqual(Array(5).fill('slack'));
    expect(new URLSearchParams(f.request.mock.calls[2][1]?.body as URLSearchParams).get('cursor')).toBe('next');
    // Same object makes fresh calls; neither intake nor prior describe caches apply.
    const api=f.api();await api.describe();await api.describe();expect(f.request).toHaveBeenCalledTimes(13);
  });
  it.each(['deleted','is_bot','is_restricted','is_ultra_restricted','is_stranger'])('rejects ineligible %s without partial results',async flag=>{
    const f=fixture('dm');f.request.mockResolvedValueOnce(Response.json({ok:true,user:{...human('U1'),[flag]:true}}));
    await expect(f.api().describe()).rejects.toThrow(/^Bridge describe unavailable$/);
  });
  it.each([{id:'U2'},{team_id:'T2'},{deleted:undefined},{is_bot:'false'},{is_stranger:null}])('rejects incomplete or mismatched human evidence %j',async patch=>{
    const f=fixture('dm');f.request.mockResolvedValueOnce(Response.json({ok:true,user:{...human('U1'),...patch}}));
    await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');
  });
  it('fails the whole group if its last participant is ineligible',async()=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false}}))
      .mockResolvedValueOnce(Response.json({ok:true,members:['UBOT','U1','U2'],response_metadata:{next_cursor:''}}))
      .mockResolvedValueOnce(Response.json({ok:true,user:human('U1')}))
      .mockResolvedValueOnce(Response.json({ok:true,user:{...human('U2'),is_restricted:true}}));
    await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(f.request).toHaveBeenCalledTimes(4);
  });
  it.each([{id:'G2'},{is_mpim:false},{is_im:true},{is_im:undefined},{is_ext_shared:true},{is_org_shared:true}])('requires exact existing MPIM %j',async patch=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false,...patch}}));
    await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(f.request).toHaveBeenCalledOnce();
  });
  it.each([
    {members:['UBOT','U1']}, {members:['U1','U2','U3']}, {members:['UBOT','U1','U1']}, {members:['UBOT','U1','../U2']},
    {members:['UBOT','U1','U2'],response_metadata:undefined}, {members:['UBOT','U1','U2'],response_metadata:{next_cursor:5}},
    {members:['UBOT','U1','U2'],response_metadata:{next_cursor:'x'.repeat(2001)}},
  ])('rejects incomplete/ambiguous membership %j',async patch=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false}}))
      .mockResolvedValueOnce(Response.json({ok:true,response_metadata:{next_cursor:''},...patch}));
    await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('rejects duplicate members across pages and repeated cursors',async()=>{
    for(const duplicate of [true,false]){
      const f=fixture();f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false}}))
        .mockResolvedValueOnce(Response.json({ok:true,members:['UBOT','U1'],response_metadata:{next_cursor:'next'}}))
        .mockResolvedValueOnce(Response.json({ok:true,members:[duplicate?'U1':'U2'],response_metadata:{next_cursor:duplicate?'':'next'}}));
      await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(f.request).toHaveBeenCalledTimes(3);
    }
  });
  it('bounds empty advancing pagination and per-page membership',async()=>{
    const f=fixture();let n=0;f.request.mockImplementation(async url=>String(url).endsWith('conversations.info')
      ?Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false}})
      :Response.json({ok:true,members:[],response_metadata:{next_cursor:`next${++n}`}}));
    await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(f.request).toHaveBeenCalledTimes(51);
    const g=fixture();g.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false}}))
      .mockResolvedValueOnce(Response.json({ok:true,members:Array.from({length:201},(_,i)=>`U${i}`),response_metadata:{next_cursor:''}}));
    await expect(g.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(g.request).toHaveBeenCalledTimes(2);
  });
  it.each(['authenticated','setup','credential','policy','lifetime'] as const)('rechecks independent owner fact %s before and after async IO',async fact=>{
    const early=fixture();early.facts[fact]=false;await expect(early.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(early.use).not.toHaveBeenCalled();
    const delayed=fixture();delayed.use.mockImplementationOnce(async(_name,cb)=>{delayed.facts[fact]=false;return cb('FIXTURE');});
    await expect(delayed.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(delayed.request).not.toHaveBeenCalled();
    const late=fixture('dm');late.request.mockImplementationOnce(async()=>{late.facts[fact]=false;return Response.json({ok:true,user:human('U1')});});
    await expect(late.api().describe()).rejects.toThrow('Bridge describe unavailable');
  });
  it.each(['agent','venue','workspace','kind','place'] as const)('rejects mid-call proof field mutation %s even if current remains true',async field=>{
    const f=fixture('dm');const api=f.api();f.request.mockImplementationOnce(async()=>{
      Object.assign(f.permit,{[field]:'other'});return Response.json({ok:true,user:human('U1')});
    });await expect(api.describe()).rejects.toThrow('Bridge describe unavailable');
  });
  it('holds at staging before use and between pages',async()=>{
    const f=fixture();f.hold();await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(f.use).not.toHaveBeenCalled();
    const g=fixture();g.request.mockImplementationOnce(async()=>{g.hold();return Response.json({ok:true,channel:{id:'G1',is_mpim:true,is_im:false}});});
    await expect(g.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(g.request).toHaveBeenCalledOnce();
  });
  it.each(['../U1','UBOT','USLACKBOT','U1?x','G1'])('rejects invalid DM id %s without secrets',async place=>{
    const f=fixture('dm');Object.assign(f.permit,{place});await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(f.use).not.toHaveBeenCalled();
  });
  it.each([302,403,429,500])('sanitizes HTTP %s and cancels response',async status=>{
    const f=fixture('dm'),response=new Response('PRIVATE FIXTURE',{status}),cancel=vi.spyOn(response.body!,'cancel');f.request.mockResolvedValueOnce(response);
    await expect(f.api().describe()).rejects.toThrow(/^Bridge describe unavailable$/);expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['null','[]','SECRET PRIVATE','{"ok":false,"error":"SECRET PRIVATE"}'])('sanitizes malformed/platform failure %s',async body=>{
    const f=fixture('dm');f.request.mockResolvedValueOnce(new Response(body));await expect(f.api().describe()).rejects.toThrow(/^Bridge describe unavailable$/);
  });
  it('bounds streaming bytes and cancels a revoked read',async()=>{
    const f=fixture('dm'),cancel=vi.fn();f.request.mockResolvedValueOnce(new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(600_000));},cancel})));
    await expect(f.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(cancel).toHaveBeenCalledOnce();
    const g=fixture('dm'),stopped=vi.fn();g.request.mockResolvedValueOnce({ok:true,body:{getReader:()=>({read:async()=>{g.facts.policy=false;return {done:false,value:Buffer.from('{}')};},cancel:stopped})}} as unknown as Response);
    await expect(g.api().describe()).rejects.toThrow('Bridge describe unavailable');expect(stopped).toHaveBeenCalledOnce();
  });
  it.each(['headers','body'])('bounds stalled %s at fifteen seconds',async phase=>{
    vi.useFakeTimers();const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
    try{
      const f=fixture('dm'),cancel=vi.fn();let done=false;
      f.request.mockImplementationOnce(async(_url,init)=>{
        const stalled=new Promise<never>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('PRIVATE')),{once:true}));
        return phase==='headers'?stalled:{ok:true,body:{getReader:()=>({read:()=>stalled,cancel})}} as unknown as Response;
      });
      const pending=f.api().describe().catch(e=>{done=true;return e;});
      await vi.advanceTimersByTimeAsync(14_999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);
      expect((await pending).message).toBe('Bridge describe unavailable');if(phase==='body')expect(cancel).toHaveBeenCalledOnce();
    }finally{timeout.mockRestore();vi.useRealTimers();}
  });
});

it('uses actual next-mode service grants and erases holder buffers, with no reads after revocation',async()=>{
  const home=mkdtempSync(join(tmpdir(),'slack-describe-'));homeFixture(home);
  const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue'],operations:[]}}});
  const app=await startLoom({home,next:true,sharing,stdout:()=>{}});
  try{
    installSecretServices(app.db,app.operations,sharing);
    const f=fixture('dm'),buffers:Uint8Array[]=[],source={read:vi.fn(async()=>{const b=Buffer.from('FIXTURE');buffers.push(b);return b;})};
    const request=vi.fn<typeof fetch>(async(_url,init)=>{expect(init?.headers).toMatchObject({Authorization:'Bearer FIXTURE'});return Response.json({ok:true,user:human('U1')});});
    const api=slackDescribe(venue,f.permit,secretUseRole(app.db,source,sharing,{kind:'service',id:'bridges'},()=>app.operations.clock.now(),app.live),()=>true,request);
    await expect(api.describe()).rejects.toThrow('Bridge describe unavailable');expect(source.read).not.toHaveBeenCalled();
    const owner={kind:'member' as const,id:'jonathan'};
    expect(app.operations.call('direct',owner,'secrets.describe',{name:'slack',description:'Slack'},'describe').ok).toBe(true);
    expect(app.operations.call('direct',owner,'secrets.grantService',{name:'slack',service:'bridges'},'grant').ok).toBe(true);
    expect(await api.describe()).toEqual({kind:'dm',place:'U1',humans:['U1']});
    expect(buffers).toHaveLength(1);expect(buffers[0].every(b=>b===0)).toBe(true);
    expect(app.operations.call('direct',owner,'secrets.revokeService',{name:'slack',service:'bridges'},'revoke').ok).toBe(true);
    await expect(api.describe()).rejects.toThrow('Bridge describe unavailable');expect(source.read).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledOnce();
  }finally{await app.close();rmSync(home,{recursive:true,force:true});}
});
