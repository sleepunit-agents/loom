import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { fixture as homeFixture, fixtureSharing } from '../../fixture.js';
import { installSecretServices, secretUseRole } from '../secrets/service.js';
import type { SecretUsage } from '../secrets/usage.js';
import { venueSchema } from './model.js';
import { presenceTransport, type PresencePlace } from './presence-transport.js';
import { presence, type PresenceSnapshot } from './presence.js';
const uncertain = 'Bridge presence attempt uncertain';
function fixture(slack = false) {
  const venue = venueSchema.parse({id:'venue',agent:'art',platform:slack?'slack':'discord',workspace:slack?'T1':'1',bot:slack?'U1':'100',tokenSecret:'bot'});
  let live = true, released = true, owed = true, active = false;
  // Explicit FAKE owning role. No actual Runtime venue lifecycle exists yet.
  const place: PresencePlace = {agent:'art',venue:'venue',platform:venue.platform,workspace:venue.workspace,channel:slack?'D1':'300',current:()=>live};
  const use = vi.fn(async <T>(_name:string, callback:(token:string)=>Promise<T>) => {
    active=true; try { return await callback('FIXTURE-TOKEN'); } finally {active=false;}
  });
  const request = vi.fn<typeof fetch>(async(_url,init)=>{
    expect(active).toBe(true); expect(init).toMatchObject({redirect:'error'});
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return slack ? Response.json({ok:true}) : new Response(null,{status:204});
  });
  return {venue,place,use,request,effects:presenceTransport(venue,place,{withValue:use},()=>released,request),
    facts:()=>owed,live:(v:boolean)=>{live=v;},released:(v:boolean)=>{released=v;},owed:(v:boolean)=>{owed=v;}};
}
/** Real Secrets accounting; fake exact-place owner, source and platform IO. */
async function accountingFixture(slack:boolean) {
  const home=mkdtempSync(join(tmpdir(),'presence-accounting-'));homeFixture(home);
  const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue'],operations:[]}}});
  const clock=new FakeClock(100_000),app=await startLoom({home,next:true,clock,sharing,stdout:()=>{}});
  installSecretServices(app.db,app.operations,sharing);
  const f=fixture(slack),owner={kind:'member' as const,id:'jonathan'},buffers:Uint8Array[]=[];
  const source={read:vi.fn(async(_name:string)=>{const bytes=Buffer.from('FIXTURE-CREDENTIAL');buffers.push(bytes);return bytes;})};
  let seq=0;
  const call=(name:string,input:unknown)=>app.operations.call('direct',owner,`secrets.${name}`,input,`presence-${++seq}`);
  const usage=(name='bot')=>{
    const result=call('usage',{name});expect(result.ok).toBe(true);
    if(!result.ok)throw Error(result.message);
    return result.value as {events:SecretUsage[];count:number;lastUsedAt:number|null};
  };
  const secrets=secretUseRole(app.db,source,sharing,{kind:'service',id:'bridges'},()=>clock.now(),app.live);
  const effects=(name='bot')=>presenceTransport({...f.venue,tokenSecret:name},f.place,secrets,()=>f.facts(),f.request);
  return {app,clock,f,buffers,source,call,usage,effects,async close(){await app.close();rmSync(home,{recursive:true,force:true});}};
}
describe('unregistered service presence transport with fake owning place',()=>{
  it('uses exact Discord own-eyes routes and typing, reacquiring service credentials for each call',async()=>{
    const f=fixture();
    await f.effects.reaction('101',true,f.facts); await f.effects.reaction('101',false,f.facts); await f.effects.typing!(f.facts);
    expect(f.use.mock.calls.map(c=>c[0])).toEqual(['bot','bot','bot']);
    expect(f.request.mock.calls.map(([u,i])=>[String(u),i?.method])).toEqual([
      ['https://discord.com/api/v10/channels/300/messages/101/reactions/%F0%9F%91%80/@me','PUT'],
      ['https://discord.com/api/v10/channels/300/messages/101/reactions/%F0%9F%91%80/@me','DELETE'],
      ['https://discord.com/api/v10/channels/300/typing','POST'],
    ]);
    for(const [,i] of f.request.mock.calls) {expect(i?.headers).toEqual({Authorization:'Bot FIXTURE-TOKEN'});expect(i?.body).toBeUndefined();}
  });
  it('uses Slack message timestamps and eyes with no typing; only matching idempotent errors acknowledge',async()=>{
    const f=fixture(true);expect(f.effects.typing).toBeUndefined();
    f.request.mockResolvedValueOnce(Response.json({ok:false,error:'already_reacted'})).mockResolvedValueOnce(Response.json({ok:false,error:'no_reaction'}));
    await f.effects.reaction('1700000000.000001',true,f.facts);await f.effects.reaction('1700000000.000001',false,f.facts);
    expect(f.request.mock.calls.map(([u,i])=>[String(u),i?.method,String(i?.body)])).toEqual([
      ['https://slack.com/api/reactions.add','POST','channel=D1&timestamp=1700000000.000001&name=eyes'],
      ['https://slack.com/api/reactions.remove','POST','channel=D1&timestamp=1700000000.000001&name=eyes'],
    ]);
    expect(f.request.mock.calls[0][1]?.headers).toEqual({Authorization:'Bearer FIXTURE-TOKEN','Content-Type':'application/x-www-form-urlencoded'});
    for(const add of [true,false]) {
      f.request.mockResolvedValueOnce(Response.json({ok:false,error:add?'no_reaction':'already_reacted'}));
      await expect(f.effects.reaction('1700000000.000001',add,f.facts)).rejects.toEqual(Error(uncertain));
    }
  });
  it.each(['lifetime','staging','facts'] as const)('holds before credentials and after acquisition for lost %s',async which=>{
    const f=fixture(),hold=()=>which==='lifetime'?f.live(false):which==='staging'?f.released(false):f.owed(false);
    hold();await expect(f.effects.reaction('101',true,f.facts)).rejects.toEqual(Error(uncertain));
    expect(f.use).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
    f.live(true);f.released(true);f.owed(true);
    f.use.mockImplementationOnce(async(_name,callback)=>{hold();return callback('DO-NOT-SEND');});
    await expect(f.effects.typing!(f.facts)).rejects.toEqual(Error(uncertain));expect(f.request).not.toHaveBeenCalled();
  });
  it.each([{enabled:false},{workspace:'2'},{agent:'other'},{id:'other'},{bot:'../100'}])('holds invalid initial setup %j',async patch=>{
    const f=fixture(),effects=presenceTransport({...f.venue,...patch},f.place,{withValue:f.use},()=>true,f.request);
    await expect(effects.reaction('101',true,f.facts)).rejects.toEqual(Error(uncertain));expect(f.use).not.toHaveBeenCalled();
  });
  it('does not retain a previous callback token',async()=>{
    const f=fixture();
    f.request.mockImplementation(async()=>new Response(null,{status:204}));
    f.use.mockImplementationOnce(async(_n,cb)=>cb('FIRST')).mockImplementationOnce(async(_n,cb)=>cb('SECOND'));
    await f.effects.reaction('101',true,f.facts);await f.effects.reaction('101',false,f.facts);
    expect(f.request.mock.calls.map(([,i])=>i?.headers)).toEqual([{Authorization:'Bot FIRST'},{Authorization:'Bot SECOND'}]);
  });
  it.each(['agent','venue','platform','workspace','channel'] as const)('rejects changed exact-place %s',async key=>{
    const f=fixture();Object.assign(f.place,{[key]:'other'});
    await expect(f.effects.reaction('101',true,f.facts)).rejects.toEqual(Error(uncertain));expect(f.use).not.toHaveBeenCalled();
  });
  it.each(['agent','venue','platform','workspace','channel'] as const)('rechecks exact-place %s after credential acquisition',async key=>{
    const f=fixture();f.use.mockImplementationOnce(async(_n,cb)=>{Object.assign(f.place,{[key]:'other'});return cb('DO-NOT-SEND');});
    await expect(f.effects.reaction('101',true,f.facts)).rejects.toEqual(Error(uncertain));expect(f.request).not.toHaveBeenCalled();
  });
  it('preserves old-format Slack timestamps accepted by intake',async()=>{
    const f=fixture(true);await f.effects.reaction('1.000100',true,f.facts);
    expect(String(f.request.mock.calls[0][1]?.body)).toBe('channel=D1&timestamp=1.000100&name=eyes');
  });
  it.each(['../101','01','0','18446744073709551616','101/other',''])('rejects malformed Discord id %s before a secret use',async id=>{
    const f=fixture();await expect(f.effects.reaction(id,true,f.facts)).rejects.toEqual(Error(uncertain));expect(f.use).not.toHaveBeenCalled();
  });
  it.each(['1700000000','1e3.1','9999999999999.1','../1700000000.000001','1700000000.000001&channel=D2'])('rejects malformed Slack timestamp %s',async id=>{
    const f=fixture(true);await expect(f.effects.reaction(id,true,f.facts)).rejects.toEqual(Error(uncertain));expect(f.use).not.toHaveBeenCalled();
  });
  it.each([200,403,404,429,500])('keeps Discord status %s uncertain with no retries or private response words',async status=>{
    const f=fixture(),cancel=vi.fn(async()=>{});
    f.request.mockResolvedValueOnce({status,body:{cancel}} as unknown as Response);
    await expect(f.effects.reaction('101',false,f.facts)).rejects.toEqual(Error(uncertain));expect(cancel).toHaveBeenCalledOnce();expect(f.request).toHaveBeenCalledOnce();
  });
  it.each([{},[],{ok:'true'},{ok:false,error:'invalid_auth'},{ok:false,error:'ratelimited'}])('rejects malformed/failed Slack reply %j',async body=>{
    const f=fixture(true);f.request.mockResolvedValueOnce(Response.json(body));
    await expect(f.effects.reaction('1700000000.000001',true,f.facts)).rejects.toEqual(Error(uncertain));
  });
  it('bounds Slack responses and cancels failed readers',async()=>{
    const f=fixture(true),cancel=vi.fn(async()=>{});
    f.request.mockResolvedValueOnce({ok:true,body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(4097)}),cancel})}} as unknown as Response);
    await expect(f.effects.reaction('1700000000.000001',true,f.facts)).rejects.toEqual(Error(uncertain));expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['headers','body'] as const)('terminates a stalled Slack %s at the request deadline',async phase=>{
    vi.useFakeTimers();
    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(milliseconds=>{
      const controller=new AbortController();setTimeout(()=>controller.abort(),milliseconds);return controller.signal;
    });
    try {
      const f=fixture(true),cancel=vi.fn(async()=>{});let done=false;
      f.request.mockImplementationOnce(async(_u,init)=>{
        const stalled=new Promise<never>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('PRIVATE FIXTURE-TOKEN')),{once:true});});
        return phase==='headers'?stalled:{ok:true,body:{getReader:()=>({read:()=>stalled,cancel})}} as unknown as Response;
      });
      const pending=f.effects.reaction('1.000100',true,f.facts).catch(error=>{done=true;return error;});
      await vi.advanceTimersByTimeAsync(14_999);expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);expect(await pending).toEqual(Error(uncertain));expect(timeout).toHaveBeenCalledWith(15_000);
      if(phase==='body')expect(cancel).toHaveBeenCalledOnce();
    } finally {timeout.mockRestore();vi.useRealTimers();}
  });
  it('sanitizes credential, transport and body failures',async()=>{
    const f=fixture();f.use.mockRejectedValueOnce(Error('PRIVATE FIXTURE-TOKEN'));
    await expect(f.effects.reaction('101',true,f.facts)).rejects.toEqual(Error(uncertain));
    f.request.mockRejectedValueOnce(Error('PRIVATE FIXTURE-TOKEN'));
    await expect(f.effects.typing!(f.facts)).rejects.toEqual(Error(uncertain));
    expect(f.request).toHaveBeenCalledOnce();
  });
  it.each([false,true])('acknowledges a late successful add and the controller removes it before typing (Slack=%s)',async slack=>{
    const f=fixture(slack),clock=new FakeClock(100_000),id=slack?'1700000000.000001':'101';
    let snapshot:PresenceSnapshot|undefined={working:true,heartbeat:clock.now(),taken:[{id,at:clock.now()}]};
    const controller=presence({clock,source:{snapshot:()=>snapshot},effects:f.effects,current:()=>true,beforeEffect:()=>true});
    f.request.mockImplementationOnce(async()=>{snapshot=undefined;return slack?Response.json({ok:true}):new Response(null,{status:204});});
    try {await controller.flush();expect(f.request.mock.calls.map(([u,i])=>slack?String(u).split('/').at(-1):i?.method)).toEqual(slack?['reactions.add','reactions.remove']:['PUT','DELETE']);}
    finally {await controller.close();}
  });
  it.each([false,true])('accounts each real service acquisition through presence, independently of HTTP success (Slack=%s)',async slack=>{
    const setup=await accountingFixture(slack);
    const {clock,f,buffers,source,call,usage}=setup,effects=setup.effects();
    try {
      const id=slack?'1700000000.000001':'101';
      f.request.mockImplementation(async(_u,i)=>{
        expect(i?.headers).toMatchObject({Authorization:`${slack?'Bearer':'Bot'} FIXTURE-CREDENTIAL`});
        return slack?Response.json({ok:true}):new Response(null,{status:204});
      });
      await expect(effects.reaction(id,true,()=>true)).rejects.toEqual(Error(uncertain));
      expect(source.read).not.toHaveBeenCalled();expect(usage()).toEqual({events:[],count:0,lastUsedAt:null});
      expect(call('describe',{name:'bot',description:'Bot'}).ok).toBe(true);
      expect(call('grantService',{service:'bridges',name:'bot'}).ok).toBe(true);
      // Fake composition gate only: production presence is still unregistered.
      f.owed(false);
      await expect(effects.reaction(id,true,()=>true)).rejects.toEqual(Error(uncertain));
      expect(source.read).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
      expect(usage()).toEqual({events:[],count:0,lastUsedAt:null});
      f.owed(true);clock.advance(5000);
      const times=[clock.now()];await effects.reaction(id,true,()=>true);
      clock.advance(5000);times.push(clock.now());await effects.reaction(id,false,()=>true);
      clock.advance(5000);times.push(clock.now());
      f.request.mockRejectedValueOnce(Error('FIXTURE-CREDENTIAL upstream failure'));
      await expect(effects.reaction(id,true,()=>true)).rejects.toEqual(Error(uncertain));
      if(!slack){clock.advance(5000);times.push(clock.now());await effects.typing!(()=>true);}
      // Callback failure cannot erase confirmed credential delivery.
      const accounted=usage();
      expect(accounted).toEqual({count:times.length,lastUsedAt:clock.now(),events:times.map(at=>({
        id:expect.stringMatching(/^use-/),name:'bot',action:'service-use',by:{kind:'service',id:'bridges'},at,state:'released',
      }))});
      expect(new Set(accounted.events.map(event=>event.id)).size).toBe(times.length);
      expect(source.read.mock.calls).toEqual(times.map(()=>['bot']));
      expect(buffers).toHaveLength(times.length);expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
      // A second presence credential must not inflate the first name's history.
      expect(call('describe',{name:'other-bot',description:'Second bot'}).ok).toBe(true);
      expect(call('grantService',{service:'bridges',name:'other-bot'}).ok).toBe(true);
      clock.advance(5000);await setup.effects('other-bot').reaction(id,true,()=>true);
      expect(usage('other-bot')).toEqual({count:1,lastUsedAt:clock.now(),events:[{
        id:expect.stringMatching(/^use-/),name:'other-bot',action:'service-use',by:{kind:'service',id:'bridges'},at:clock.now(),state:'released',
      }]});
      expect(usage()).toEqual(accounted);
      expect(source.read.mock.calls).toEqual([...times.map(()=>['bot']),['other-bot']]);
      expect(buffers).toHaveLength(times.length+1);expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
      expect(call('revokeService',{service:'bridges',name:'bot'}).ok).toBe(true);
      await expect(effects.reaction(id,false,()=>true)).rejects.toEqual(Error(uncertain));
      expect(f.request).toHaveBeenCalledTimes(times.length+1);expect(source.read).toHaveBeenCalledTimes(times.length+1);
      expect(usage()).toEqual(accounted);
    } finally {await setup.close();}
  });
  it.each([
    {slack:false,phase:'admission'},{slack:true,phase:'admission'},
    {slack:false,phase:'settlement'},{slack:true,phase:'settlement'},
  ] as const)('holds presence before HTTP on durable audit $phase failure (Slack=$slack)',async({slack,phase})=>{
    const setup=await accountingFixture(slack);
    const {app,clock,f,buffers,source,call,usage}=setup;
    try {
      expect(call('describe',{name:'bot',description:'Bot'}).ok).toBe(true);
      expect(call('grantService',{service:'bridges',name:'bot'}).ok).toBe(true);
      app.db.exec(`CREATE TRIGGER fail_presence_audit BEFORE ${phase==='admission'?'INSERT':'UPDATE'} ON secrets_uses BEGIN SELECT RAISE(ABORT,'fixture'); END`);
      const effects=setup.effects();
      clock.advance(5000);
      await expect(effects.reaction(slack?'1700000000.000001':'101',true,()=>true)).rejects.toEqual(Error(uncertain));
      expect(f.request).not.toHaveBeenCalled();expect(source.read).toHaveBeenCalledTimes(phase==='admission'?0:1);
      expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
      expect(usage()).toEqual({
        events:phase==='admission'?[]:[{id:expect.stringMatching(/^use-/),name:'bot',action:'service-use',by:{kind:'service',id:'bridges'},at:clock.now(),state:'started'}],
        count:0,lastUsedAt:null,
      });
    } finally {await setup.close();}
  });
});
