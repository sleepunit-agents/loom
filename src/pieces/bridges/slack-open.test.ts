import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { fixture as homeFixture, fixtureSharing } from '../../fixture.js';
import { installSecretServices, secretUseRole } from '../secrets/service.js';
import { venueSchema } from './model.js';
import { slackOpen, type SlackRecipient } from './slack-open.js';
const uncertain='Bridge DM open attempt uncertain';
const human={id:'U2',team_id:'T1',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false};
const channel={id:'D2',is_im:true,user:'U2',is_org_shared:false};
function fixture() {
  const venue=venueSchema.parse({id:'v',agent:'art',platform:'slack',workspace:'T1',bot:'U1',tokenSecret:'bot'});
  let live=true,released=true,active=false;
  // Explicit FAKE authenticated recipient owner. No installed Runtime issuer.
  const recipient:SlackRecipient={agent:'art',venue:'v',workspace:'T1',user:'U2',current:()=>live};
  const credential=async<T>(_name:string,cb:(token:string)=>Promise<T>)=>{
    active=true;try{return await cb('FIXTURE-TOKEN');}finally{active=false;}
  };
  const use=vi.fn(credential);
  const request=vi.fn<typeof fetch>(async(url,init)=>{
    expect(active).toBe(true);expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(String(url).endsWith('users.info')?{ok:true,user:human}:{ok:true,channel});
  });
  const create=()=>slackOpen(venue,recipient,{withValue:use},()=>released,request);
  return {venue,recipient,use,credential,request,create,open:create().open,live:(v:boolean)=>{live=v;},released:(v:boolean)=>{released=v;}};
}
describe('unregistered Slack first DM open with explicit fake recipient owner',()=>{
  it('checks a fresh same-workspace human, opens one DM without prior intake and returns only its id',async()=>{
    const f=fixture();expect(await f.open()).toEqual({channel:'D2'});
    expect(f.request.mock.calls.map(([u,i])=>[String(u),i?.method,String(i?.body),i?.redirect])).toEqual([
      ['https://slack.com/api/users.info','POST','user=U2','error'],
      ['https://slack.com/api/conversations.open','POST','users=U2&return_im=true','error'],
    ]);
    expect(f.use.mock.calls.map(c=>c[0])).toEqual(['bot','bot']);
    for(const [,i] of f.request.mock.calls)expect(i?.headers).toEqual({Authorization:'Bearer FIXTURE-TOKEN','Content-Type':'application/x-www-form-urlencoded'});
    // No synthetic inbound message, post, database receipt or recipient words.
  });
  it('reacquires credentials and platform evidence on every invocation, including already-open DM',async()=>{
    const f=fixture();f.request.mockImplementation(async url=>Response.json(String(url).endsWith('users.info')?{ok:true,user:human}:{ok:true,already_open:true,no_op:true,channel}));
    for(const token of ['ONE','TWO','THREE','FOUR'])f.use.mockImplementationOnce(async(_n,cb)=>cb(token));
    await f.open();await f.open();expect(f.use).toHaveBeenCalledTimes(4);
    expect(f.request.mock.calls.map(([,i])=>(i?.headers as Record<string,string>).Authorization)).toEqual(['Bearer ONE','Bearer TWO','Bearer THREE','Bearer FOUR']);
  });
  it.each(['lifetime','staging'] as const)('holds before credentials and after each acquisition when %s changes',async which=>{
    for(const stage of [0,1,2]){
      const f=fixture(),hold=()=>which==='lifetime'?f.live(false):f.released(false);
      if(stage===0)hold();else {
        if(stage===2)f.use.mockImplementationOnce(f.credential);
        f.use.mockImplementationOnce(async(_n,cb)=>{hold();return cb('NEVER-SEND');});
      }
      await expect(f.open()).rejects.toEqual(Error(uncertain));
      expect(f.request).toHaveBeenCalledTimes(Math.max(0,stage-1));
      expect(f.use).toHaveBeenCalledTimes(stage);
    }
  });
  it.each(['agent','venue','workspace','user'] as const)('rechecks exact recipient %s before and after each acquisition',async key=>{
    for(const stage of [0,1,2]){
      const f=fixture(),change=()=>Object.assign(f.recipient,{[key]:'OTHER'});
      if(stage===0)change();else {
        if(stage===2)f.use.mockImplementationOnce(f.credential);
        f.use.mockImplementationOnce(async(_n,cb)=>{change();return cb('NEVER-SEND');});
      }
      await expect(f.open()).rejects.toEqual(Error(uncertain));expect(f.request).toHaveBeenCalledTimes(Math.max(0,stage-1));
    }
  });
  it.each([{enabled:false},{platform:'discord' as const},{id:'other'},{agent:'other'},{workspace:'T2'},{bot:'../U1'}])('refuses incompatible venue %j',async patch=>{
    const f=fixture(),open=slackOpen({...f.venue,...patch},f.recipient,{withValue:f.use},()=>true,f.request);
    await expect(open.open()).rejects.toEqual(Error(uncertain));expect(f.use).not.toHaveBeenCalled();
  });
  it.each(['U1','USLACKBOT','U2,U3','../U2','B2','D2',''])('refuses recipient %s before credentials',async user=>{
    const f=fixture();Object.assign(f.recipient,{user});
    await expect(f.create().open()).rejects.toEqual(Error(uncertain));expect(f.use).not.toHaveBeenCalled();
  });
  it.each([{id:'U3'},{team_id:'T2'},{deleted:true},{is_bot:true},{is_restricted:true},{is_ultra_restricted:true},{is_stranger:true},{is_bot:undefined}, {is_stranger:'false'}])('does not open for ineligible or malformed human %j',async patch=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json({ok:true,user:{...human,...patch}}));
    await expect(f.open()).rejects.toEqual(Error(uncertain));expect(f.request).toHaveBeenCalledOnce();
  });
  it.each([null,[],{}, {id:'D2'}, {...channel,id:'G2'}, {...channel,user:'U3'}, {...channel,is_im:false}, {...channel,is_mpim:true}, {...channel,is_org_shared:true}, {...channel,is_ext_shared:true}])('never returns wrong or incomplete DM evidence %j',async value=>{
    const f=fixture();f.request.mockImplementation(async url=>Response.json(String(url).endsWith('users.info')?{ok:true,user:human}:{ok:true,channel:value}));
    await expect(f.open()).rejects.toEqual(Error(uncertain));expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each(['lifetime','staging','recipient'] as const)('does not expose late successful open after %s changes',async which=>{
    const f=fixture();f.request.mockImplementation(async url=>{
      if(String(url).endsWith('users.info'))return Response.json({ok:true,user:human});
      if(which==='lifetime')f.live(false);else if(which==='staging')f.released(false);else Object.assign(f.recipient,{user:'U3'});
      return Response.json({ok:true,channel});
    });
    await expect(f.open()).rejects.toEqual(Error(uncertain));expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([{},[],{ok:'true'},{ok:false,error:'invalid_auth'},{ok:false,error:'ratelimited'}])('sanitizes failure %j without retrying',async reply=>{
    const f=fixture();f.request.mockResolvedValueOnce(Response.json(reply));
    await expect(f.open()).rejects.toEqual(Error(uncertain));expect(f.request).toHaveBeenCalledOnce();
  });
  it('bounds responses, cancels readers and sanitizes credential/HTTP/parser failures',async()=>{
    const f=fixture(),cancel=vi.fn(async()=>{});
    f.use.mockRejectedValueOnce(Error('PRIVATE FIXTURE-TOKEN'));
    await expect(f.open()).rejects.toEqual(Error(uncertain));
    f.request.mockRejectedValueOnce(Error('PRIVATE FIXTURE-TOKEN'));
    await expect(f.open()).rejects.toEqual(Error(uncertain));
    f.request.mockResolvedValueOnce(new Response('PRIVATE FIXTURE-TOKEN',{status:403}));
    await expect(f.open()).rejects.toEqual(Error(uncertain));
    f.request.mockResolvedValueOnce(new Response('PRIVATE FIXTURE-TOKEN'));
    await expect(f.open()).rejects.toEqual(Error(uncertain));
    f.request.mockResolvedValueOnce({ok:true,body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(1024*1024+1)}),cancel})}} as unknown as Response);
    await expect(f.open()).rejects.toEqual(Error(uncertain));expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['headers','body'] as const)('terminates stalled %s at 15 seconds',async phase=>{
    vi.useFakeTimers();const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{
      const controller=new AbortController();setTimeout(()=>controller.abort(),ms);return controller.signal;
    });
    try {
      const f=fixture(),cancel=vi.fn(async()=>{});let done=false;
      f.request.mockImplementationOnce(async(_url,init)=>{
        const stalled=new Promise<never>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('PRIVATE FIXTURE-TOKEN')),{once:true}));
        return phase==='headers'?stalled:{ok:true,body:{getReader:()=>({read:()=>stalled,cancel})}} as unknown as Response;
      });
      const pending=f.open().catch(e=>{done=true;return e;});
      await vi.advanceTimersByTimeAsync(14_999);expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);expect(await pending).toEqual(Error(uncertain));
      expect(timeout).toHaveBeenCalledWith(15_000);if(phase==='body')expect(cancel).toHaveBeenCalledOnce();
    }finally{timeout.mockRestore();vi.useRealTimers();}
  });
  it('uses actual next Secrets service grants and erases holder buffers, with denial before/after grant',async()=>{
    const home=mkdtempSync(join(tmpdir(),'slack-open-'));homeFixture(home);
    const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue'],operations:[]}}});
    const clock=new FakeClock(100_000),app=await startLoom({home,next:true,clock,sharing,stdout:()=>{}});
    try {
      installSecretServices(app.db,app.operations,sharing);
      const f=fixture(),owner={kind:'member' as const,id:'jonathan'},buffers:Uint8Array[]=[];
      const source={read:vi.fn(async()=>{const b=Buffer.from('FIXTURE-CREDENTIAL');buffers.push(b);return b;})};
      const transport=slackOpen(f.venue,f.recipient,secretUseRole(app.db,source,sharing,{kind:'service',id:'bridges'},()=>clock.now(),app.live),()=>true,f.request);
      f.request.mockImplementation(async(url,init)=>{
        expect((init?.headers as Record<string,string>).Authorization).toBe('Bearer FIXTURE-CREDENTIAL');
        return Response.json(String(url).endsWith('users.info')?{ok:true,user:human}:{ok:true,channel});
      });
      await expect(transport.open()).rejects.toEqual(Error(uncertain));expect(source.read).not.toHaveBeenCalled();
      expect(app.operations.call('direct',owner,'secrets.describe',{name:'bot',description:'Bot'},'describe').ok).toBe(true);
      expect(app.operations.call('direct',owner,'secrets.grantService',{service:'bridges',name:'bot'},'grant').ok).toBe(true);
      expect(await transport.open()).toEqual({channel:'D2'});
      expect(buffers).toHaveLength(2);expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
      expect(app.operations.call('direct',owner,'secrets.revokeService',{service:'bridges',name:'bot'},'revoke').ok).toBe(true);
      await expect(transport.open()).rejects.toEqual(Error(uncertain));expect(f.request).toHaveBeenCalledTimes(2);
    }finally{await app.close();rmSync(home,{recursive:true,force:true});}
  });
});
