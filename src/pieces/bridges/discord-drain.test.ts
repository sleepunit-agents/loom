import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { fixture as homeFixture, fixtureSharing } from '../../fixture.js';
import { venueSchema } from './model.js';
import { put } from './store.js';
import { discordInbox } from './discord-inbox.js';
import { discordDrain, type DiscordDrainOptions } from './discord-drain.js';
import { discordApi } from './discord-api.js';
import { Bridges } from './engine.js';
import type { Incoming } from './role.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home,{recursive:true,force:true}); });
const venue = venueSchema.parse({id:'discord',platform:'discord',agent:'art',workspace:'100',bot:'200',tokenSecret:'bot'});
const payload=(id='300',patch:Record<string,unknown>={})=>({id,channel_id:'400',guild_id:'100',type:0,content:'hello <@200>',author:{id:'500'},mentions:[{id:'200'}],mention_roles:[],...patch});
const cursor=(seq:number)=>({session:'SESSION',url:'wss://gateway.discord.gg/?v=10&encoding=json',seq});
async function fixture(existing?:string) {
 const home=existing??mkdtempSync(join(tmpdir(),'discord-drain-'));if(!existing)homes.push(home);
 if(!existing)homeFixture(home);
 const clock=new FakeClock(1000);const app=await startLoom({home,next:true,clock,sharing:fixtureSharing,stdout:()=>{}});
 let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};closes.push(close);
 if(!existing) {put(app.db,'venues',venue);put(app.db,'links',{id:'jonathan',platform:'discord',workspace:'100',user:'500',person:'jonathan'});put(app.db,'routes',{id:'primary',platform:'discord',workspace:'100',channel:'400',primary:'art'});}
 let epoch='one';const currentEpoch=()=>epoch;
 const inbox=discordInbox(app.db,clock,{venue,credentialEpoch:'one'},currentEpoch);
 let seq=inbox.load()?.seq??0;
 async function add(id='300',patch:Record<string,unknown>={}) {if(seq===0)await inbox.commit({type:'READY',seq:++seq,data:{user:{id:'200'},session_id:'SESSION'}},cursor(seq));await inbox.commit({type:'MESSAGE_CREATE',seq:++seq,data:payload(id,patch)},cursor(seq));}
 const channel=vi.fn<DiscordDrainOptions['channel']>(async(_v,p)=>({id:p.channel,kind:p.dm?'dm':'channel',name:'general'}));
 const receive=vi.fn<DiscordDrainOptions['receive']>(async()=>{}),current=vi.fn(()=>true),beforeRead=vi.fn(()=>true);
 function drain(patch:Partial<DiscordDrainOptions>={}) {const d=discordDrain({db:app.db,clock,binding:{venue,credentialEpoch:'one'},currentEpoch,channel,receive,current,beforeRead,...patch});closes.unshift(d.close);return d;}
 return {home,clock,app,inbox,channel,receive,current,beforeRead,drain,close,add,epoch:(value:string)=>{epoch=value;}};
}
async function until(condition:()=>boolean) { for(let n=0;n<1000;n++) { if(condition()) return; await Promise.resolve(); } throw Error('condition not reached'); }
async function settle() { for(let n=0;n<80;n++) await Promise.resolve(); }
function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
describe('serialized Discord raw normalization',()=>{
  it('serializes overlapping flushes and retries metadata with current names, without renewing expiry',async()=>{
    const f=await fixture();await f.add();const pending=deferred<Awaited<ReturnType<DiscordDrainOptions['channel']>>>();
    f.channel.mockReturnValueOnce(pending.promise);const d=f.drain();const first=d.flush();const second=d.flush();
    expect(first).toBe(second);expect(f.channel).toHaveBeenCalledOnce();pending.resolve('wait');await first;
    expect(f.channel).toHaveBeenCalledOnce();expect(f.receive).not.toHaveBeenCalled();
    f.clock.advance(4999);await d.flush();expect(f.channel).toHaveBeenCalledOnce();
    f.clock.advance(1);await settle();expect(f.channel).toHaveBeenCalledTimes(2);expect(f.receive).toHaveBeenCalledOnce();expect(f.inbox.pending()).toEqual([]);
  });
  it('keeps words on failed normalized commit and retries through restart',async()=>{
    const f=await fixture();await f.add();f.receive.mockRejectedValue(Error('commit failed'));const d=f.drain();await d.flush();
    const before=f.inbox.pending();expect(before).toHaveLength(1);await d.close();await f.close();
    const g=await fixture(f.home);expect(g.inbox.pending()).toEqual(before);await g.drain().flush();expect(g.receive).toHaveBeenCalledOnce();expect(g.inbox.pending()).toEqual([]);
  });
  it.each(['setup','restore','credential','shutdown','staging'] as const)('blocks a handoff after %s during metadata IO',async mode=>{
    const f=await fixture();await f.add();const metadata=deferred<Awaited<ReturnType<DiscordDrainOptions['channel']>>>();f.channel.mockReturnValue(metadata.promise);
    const d=f.drain();const flush=d.flush();let close:Promise<void>|undefined;
    if(mode==='setup') put(f.app.db,'venues',{...venue,enabled:false});
    if(mode==='restore') {put(f.app.db,'venues',{...venue,enabled:false});put(f.app.db,'venues',venue);}
    if(mode==='credential') f.current.mockReturnValue(false);
    if(mode==='shutdown') close=d.close();
    if(mode==='staging') f.beforeRead.mockReturnValue(false);
    metadata.resolve({id:'400',kind:'channel'});await flush;await close;
    expect(f.receive).not.toHaveBeenCalled();expect(f.app.db.prepare('SELECT state FROM bridges_discord_receipts').get()).toEqual({state:'pending'});
    if(mode!=='staging') {f.current.mockReturnValue(true);await d.flush();expect(f.receive).not.toHaveBeenCalled();}
    else {f.beforeRead.mockReturnValue(true);await d.flush();expect(f.receive).toHaveBeenCalledOnce();}
  });
  it('holds staging before metadata and stops retry timers on close',async()=>{
    const f=await fixture();await f.add();f.beforeRead.mockReturnValue(false);const d=f.drain();await d.flush();
    expect(f.channel).not.toHaveBeenCalled();expect(f.receive).not.toHaveBeenCalled();await d.close();f.beforeRead.mockReturnValue(true);f.clock.advance(10_000);await d.flush();expect(f.channel).not.toHaveBeenCalled();
  });
  it.each(['metadata','receive'] as const)('close waits for deferred %s and raw consumption waits for receive',async stage=>{
    const f=await fixture();await f.add();const gate=deferred<void>();
    if(stage==='metadata') f.channel.mockImplementation(async()=>{await gate.promise;return {id:'400',kind:'channel'};});
    else f.receive.mockImplementation(()=>gate.promise);
    const d=f.drain();const flush=d.flush();await settle();expect(f.inbox.pending()).toHaveLength(1);
    if(stage==='receive') expect(f.receive).toHaveBeenCalledOnce();else expect(f.channel).toHaveBeenCalledOnce();
    let closed=false;const close=d.close().then(()=>{closed=true;});await settle();expect(closed).toBe(false);
    gate.resolve();await close;await flush;expect(closed).toBe(true);expect(f.inbox.pending()).toHaveLength(1);
    if(stage==='metadata') expect(f.receive).not.toHaveBeenCalled();
  });
  it('cancels the scheduled retry rather than only suppressing its callback',async()=>{
    const f=await fixture();await f.add();const at=f.clock.at.bind(f.clock);const active=new Set<()=>void>();
    vi.spyOn(f.clock,'at').mockImplementation((time,fn)=>{let stop!:()=>void;const cancel=at(time,()=>{active.delete(stop);fn();});stop=()=>{active.delete(stop);cancel();};active.add(stop);return stop;});
    f.channel.mockResolvedValue('wait');const d=f.drain();await d.flush();expect(active.size).toBe(1);await d.close();expect(active.size).toBe(0);
  });
  it.each(['validation','page'] as const)('recovers a transient %s read failure automatically instead of invalidating the binding',async stage=>{
    const f=await fixture();await f.add();
    const fail=()=>vi.spyOn(f.app.db,'prepare').mockImplementationOnce(()=>{throw Error('transient storage failure');});
    let injected=false;
    const d=f.drain(stage==='page'?{beforeRead:()=>{if(!injected){injected=true;fail();}return true;}}:{});if(stage==='validation') fail();await expect(d.flush()).resolves.toBeUndefined();expect(f.channel).not.toHaveBeenCalled();expect(f.inbox.pending()).toHaveLength(1);
    f.clock.advance(5000);await until(()=>f.inbox.pending().length===0);expect(f.receive).toHaveBeenCalledOnce();
  });
  it('retains raw words if staging becomes held while the normalized commit is pending',async()=>{
    const f=await fixture();await f.add();const commit=deferred<void>();f.receive.mockReturnValueOnce(commit.promise);
    const d=f.drain();const flush=d.flush();await until(()=>f.receive.mock.calls.length===1);
    f.beforeRead.mockReturnValue(false);commit.resolve();await flush;expect(f.inbox.pending()).toHaveLength(1);
    f.clock.advance(5000);await settle();expect(f.receive).toHaveBeenCalledOnce();expect(f.inbox.pending()).toHaveLength(1);
    f.beforeRead.mockReturnValue(true);await d.flush();expect(f.receive).toHaveBeenCalledTimes(2);expect(f.inbox.pending()).toEqual([]);
  });
  it('expires from immutable receipt time across restart; exactly one hour is still eligible',async()=>{
    const f=await fixture();await f.add();f.channel.mockResolvedValue('wait');const d=f.drain();await d.flush();await d.close();await f.close();
    const g=await fixture(f.home);g.clock.advance(3_600_000);g.channel.mockResolvedValue('wait');const next=g.drain();await next.flush();expect(g.channel).toHaveBeenCalledOnce();expect(g.inbox.pending()).toHaveLength(1);
    g.clock.advance(1);await next.flush();expect(g.channel).toHaveBeenCalledOnce();expect(g.inbox.pending()).toEqual([]);expect(g.receive).not.toHaveBeenCalled();
  });
  it('bounds a pass to 64 receipts and schedules the rest',async()=>{
    const f=await fixture();for(let n=0;n<65;n++) {await f.add(String(300+n), {channel_id:String(400+n)});f.clock.advance(1);}const d=f.drain();await d.flush();expect(f.receive).toHaveBeenCalledTimes(64);expect(f.inbox.pending()).toHaveLength(1);
    expect(f.receive.mock.calls.map(call=>call[1].id)).toEqual(Array.from({length:64},(_,n)=>String(300+n)));
    f.clock.advance(5000);await until(()=>f.inbox.pending().length===0);expect(f.receive).toHaveBeenCalledTimes(65);expect(f.inbox.pending()).toEqual([]);
  });
  it('pages beyond a waiting prefix, then wraps to retry it',async()=>{
    const f=await fixture();for(let n=0;n<65;n++) {await f.add(String(300+n), {channel_id:String(400+n)});f.clock.advance(1);}
    f.channel.mockImplementation(async(_v,place)=>place.channel==='464'?{id:place.channel,kind:'channel'}:'wait');
    const d=f.drain();await d.flush();expect(f.channel).toHaveBeenCalledTimes(64);expect(f.receive).not.toHaveBeenCalled();
    f.clock.advance(5000);await settle();expect(f.receive).toHaveBeenCalledOnce();
    f.channel.mockImplementation(async(_v,place)=>({id:place.channel,kind:'channel'}));f.clock.advance(5000);await until(()=>f.inbox.pending().length===0);
    expect(f.receive).toHaveBeenCalledTimes(65);expect(f.inbox.pending()).toEqual([]);
  });
  it('allows metadata begun within the raw budget to finish after the hour',async()=>{
    const f=await fixture();await f.add();f.clock.advance(3_600_000);
    const metadata=deferred<Awaited<ReturnType<DiscordDrainOptions['channel']>>>();f.channel.mockReturnValue(metadata.promise);
    const d=f.drain();const flush=d.flush();expect(f.channel).toHaveBeenCalledOnce();f.clock.advance(1);
    metadata.resolve({id:'400',kind:'channel'});await flush;
    expect(f.receive).toHaveBeenCalledOnce();expect(f.inbox.pending()).toEqual([]);
  });
  it('does not hand off or consume inside an enclosing transaction',async()=>{
    const f=await fixture();await f.add();const d=f.drain();let flush!:Promise<void>;
    f.app.db.transaction(()=>{flush=d.flush();})();await flush;expect(f.channel).not.toHaveBeenCalled();expect(f.receive).not.toHaveBeenCalled();
    expect(f.inbox.pending()).toHaveLength(1);await d.flush();expect(f.receive).toHaveBeenCalledOnce();
  });
});
it('uses the real fresh REST channel and parent evidence, committing before raw erasure',async()=>{
 const f=await fixture();await f.add('300',{channel_id:'401'});const paths:string[]=[];
 const api=discordApi({withValue:async<T>(_name:string,use:(value:string)=>Promise<T>)=>use('PRIVATE')},()=>true,async(url,init)=>{
  expect(init?.headers).toEqual({Authorization:'Bot PRIVATE'});paths.push(String(url));
  return Response.json(String(url).endsWith('/401')?{id:'401',type:11,guild_id:'100',parent_id:'400',name:'PRIVATE STARTER'}:{id:'400',type:0,guild_id:'100',name:'general'});
 });
 f.receive.mockImplementation(async(id,message,snapshot)=>{
  expect(f.inbox.pending()).toHaveLength(1);expect(f.app.db.inTransaction).toBe(false);
  expect(id).toBe(venue.id);expect(snapshot).toEqual(venue);
  expect(message).toMatchObject({id:'300',channel:'401',parent:'400',thread:'401',label:'#general thread',mentions:['200']});
  expect(JSON.stringify(message)).not.toContain('PRIVATE STARTER');
 });
 await f.drain({channel:api.channel}).flush();expect(paths).toEqual(['https://discord.com/api/v10/channels/401','https://discord.com/api/v10/channels/400']);
 expect(f.receive).toHaveBeenCalledOnce();expect(f.app.db.prepare('SELECT event,state FROM bridges_discord_receipts').get()).toEqual({event:null,state:'consumed'});
});
it.each([{type:7},{author:{id:'200'}},{guild_id:'999'},{channel_id:'bad'},{content:3}])('erases definite unsupported payload without REST %j',async patch=>{
 const f=await fixture();await f.add('300',patch);await f.drain().flush();expect(f.channel).not.toHaveBeenCalled();expect(f.receive).not.toHaveBeenCalled();expect(f.inbox.pending()).toEqual([]);
});
it.each(['drop','wait','throw'] as const)('classifies fresh metadata %s without exposing upstream text',async mode=>{
 const f=await fixture();await f.add();f.channel.mockImplementation(async()=>{if(mode==='throw')throw Error('PRIVATE upstream');return mode;});
 const d=f.drain();await expect(d.flush()).resolves.toBeUndefined();expect(f.receive).not.toHaveBeenCalled();expect(f.inbox.pending()).toHaveLength(mode==='drop'?0:1);
 f.channel.mockResolvedValue({id:'400',kind:'channel'});f.clock.advance(5000);await settle();expect(f.receive).toHaveBeenCalledTimes(mode==='drop'?0:1);
});
it('uses fresh configured managed roles after metadata and normalizes DMs only with DM evidence',async()=>{
 const f=await fixture();const other=venueSchema.parse({...venue,id:'other',bot:'201',agent:'other',botRoles:['600']});put(f.app.db,'venues',other);
 // Setup changes require a newly bound raw store as well as a new drain.
 const inbox=discordInbox(f.app.db,f.clock,{venue,credentialEpoch:'one'},()=> 'one');
 await inbox.commit({type:'READY',seq:1,data:{user:{id:'200'},session_id:'SESSION'}},cursor(1));
 await inbox.commit({type:'MESSAGE_CREATE',seq:2,data:payload('300',{content:'hello <@&600>',mention_roles:['600']})},cursor(2));
 await f.drain().flush();expect(f.receive.mock.calls[0][1].mentions).toEqual(['201']);
 await inbox.commit({type:'MESSAGE_CREATE',seq:3,data:payload('301',{guild_id:undefined})},cursor(3));await f.drain().flush();expect(f.channel.mock.calls[1][1]).toEqual({channel:'400',user:'500',dm:true});expect(f.receive.mock.calls[1][1]).toMatchObject({dm:true,label:'Direct message'});
});
it('permanently invalidates on the public credential generation even if current stays true',async()=>{
 const f=await fixture();await f.add();const metadata=deferred<Awaited<ReturnType<DiscordDrainOptions['channel']>>>();f.channel.mockReturnValue(metadata.promise);
 const d=f.drain();const flush=d.flush();f.epoch('two');metadata.resolve({id:'400',kind:'channel'});await flush;f.epoch('one');await d.flush();expect(f.receive).not.toHaveBeenCalled();expect(f.inbox.pending()).toHaveLength(1);
});
it('replays a normalized commit after failed raw consumption through restart without duplicate delivery',async()=>{
 const f=await fixture();const effects=f.app.effects!;const delivered:Incoming[]=[];
 const engine=new Bridges(f.app,f.clock,{admit:async()=> 'allow',deliver:async input=>{delivered.push(input);return 'delivered';},stop:async()=>{}},{may:async()=>true,get:async()=> 'fixture'},[{platform:'discord',connect:async()=>({close(){}}),inspect:async()=> 'allow',send:async()=>({id:'post'})}],effects);closes.unshift(()=>engine.close());
 await f.add();f.app.db.exec("CREATE TRIGGER fail_consume BEFORE UPDATE ON bridges_discord_receipts BEGIN SELECT RAISE(ABORT,'fail'); END;");
 const first=f.drain({receive:engine.receive.bind(engine)});await first.flush();await engine.flush();expect(delivered).toHaveLength(1);expect(f.inbox.pending()).toHaveLength(1);
 await first.close();await engine.close();f.app.db.exec('DROP TRIGGER fail_consume');await f.close();
 const g=await fixture(f.home);const nextEffects=g.app.effects!;
 const next=new Bridges(g.app,g.clock,{admit:async()=> 'allow',deliver:async input=>{delivered.push(input);return 'delivered';},stop:async()=>{}},{may:async()=>true,get:async()=> 'fixture'},[{platform:'discord',connect:async()=>({close(){}}),inspect:async()=> 'allow',send:async()=>({id:'post'})}],nextEffects);closes.unshift(()=>next.close());
 await g.drain({receive:next.receive.bind(next)}).flush();await next.flush();expect(delivered).toHaveLength(1);expect(g.inbox.pending()).toEqual([]);expect(g.app.db.prepare('SELECT count(*) AS n FROM bridges_inbox').get()).toEqual({n:1});
});

it.each(['lifetime','setup','restore','epoch'] as const)('preserves raw words and permanently stops after %s changes during normalized commit',async mode=>{
 const f=await fixture();await f.add();const commit=deferred<void>();f.receive.mockReturnValueOnce(commit.promise);
 const d=f.drain();const flush=d.flush();await until(()=>f.receive.mock.calls.length===1);
 if(mode==='lifetime')f.current.mockReturnValue(false);
 else if(mode==='epoch')f.epoch('two');
 else {put(f.app.db,'venues',{...venue,enabled:false});if(mode==='restore')put(f.app.db,'venues',venue);}
 commit.resolve();await flush;expect(f.app.db.prepare('SELECT state,event FROM bridges_discord_receipts').get()).toEqual({state:'pending',event:JSON.stringify(payload())});
 f.current.mockReturnValue(true);f.epoch('one');await d.flush();expect(f.receive).toHaveBeenCalledOnce();
});
