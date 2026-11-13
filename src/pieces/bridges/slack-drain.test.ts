import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { installEffects } from '../../core/effects.js';
import { installBridges } from './index.js';
import { venueSchema } from './model.js';
import { put } from './store.js';
import { slackInbox } from './slack-inbox.js';
import { slackDrain, type SlackDrainOptions } from './slack-drain.js';
import { slackApi } from './slack-api.js';
import { Bridges } from './engine.js';
import type { BridgeRuntime, Incoming } from './role.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home,{recursive:true,force:true}); });
const venue = venueSchema.parse({ id:'art-slack',platform:'slack',agent:'art',workspace:'T123',bot:'U123',tokenSecret:'bot' });
const payload = (id='Ev123', event: Record<string, unknown> = {}) => ({type:'event_callback',team_id:'T123',api_app_id:'A123',event_id:id,
  event:{type:'message',channel:'D123',user:'U200',ts:'1793828004.242749',text:'hello <@U200|untrusted>',...event}});
async function fixture(existing?: string) {
  const home = existing ?? mkdtempSync(join(tmpdir(),'slack-drain-')); if (!existing) homes.push(home);
  const clock = new FakeClock(1000);
  const app = await startLoom({home,clock,install:app=>installBridges(app,()=>({members:{},projects:{},services:{}}))});
  let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}}; closes.push(close);
  if(!existing) {
    put(app.db,'venues',venue);
    put(app.db,'links',{id:'jonathan',platform:'slack',workspace:'T123',user:'U200',person:'jonathan'});
    put(app.db,'links',{id:'mark',platform:'slack',workspace:'T123',user:'U201',person:'mark'});
  }
  const inbox=slackInbox(app.db,clock,{venue,app:'A123'});
  const inspect=vi.fn<SlackDrainOptions['inspect']>(async()=>({kind:'allow',members:['U123','U200']}));
  const receive=vi.fn<SlackDrainOptions['receive']>(async()=>{});
  const name=vi.fn((user:string)=>user==='U200'?'Jonathan':user==='U201'?'Mark':undefined);
  const current=vi.fn(()=>true),beforeRead=vi.fn(()=>true);
  function drain(patch:Partial<SlackDrainOptions>={}) {
    const result=slackDrain({db:app.db,clock,binding:{venue,app:'A123'},inspect,receive,name,current,beforeRead,...patch});
    closes.unshift(()=>result.close());return result;
  }
  return {home,clock,app,inbox,inspect,receive,name,current,beforeRead,drain,close};
}
async function until(condition:()=>boolean) { for(let n=0;n<1000;n++) { if(condition()) return; await Promise.resolve(); } throw Error('condition not reached'); }
async function settle() { for(let n=0;n<80;n++) await Promise.resolve(); }
function engineFor(f:Awaited<ReturnType<typeof fixture>>,runtime:BridgeRuntime,group=false) {
  const effects=installEffects(f.app,()=>({members:{},projects:{},services:{}}),false);
  const engine=new Bridges(f.app,f.clock,runtime,{may:async()=>true,get:async()=> 'fixture'},
    [{platform:'slack',connect:async()=>({close(){}}),inspect:async()=>group?{kind:'allow',members:['U123','U200','U201']}:'allow',send:async()=>({id:'post'})}],effects);
  closes.unshift(()=>engine.close());return engine;
}
function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
describe('serialized Slack raw receipt normalization',()=>{
  it('uses fresh authenticated metadata and trusted People names, then hands off before erasing words',async()=>{
    const f=await fixture();await f.inbox.receive(payload());
    const calls:string[]=[];
    const request=vi.fn<typeof fetch>(async(url,init)=>{
      expect(init?.headers).toMatchObject({Authorization:'Bearer PRIVATE'});calls.push(String(url));
      return Response.json(String(url).endsWith('conversations.info') ? {ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U200'}}
        : {ok:true,user:{id:'U200',team_id:'T123',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}});
    });
    const api=slackApi({withValue:async<T>(_name:string,use:(value:string)=>Promise<T>)=>use('PRIVATE')},()=>true,request);
    f.receive.mockImplementation(async(id,message,snapshot)=>{
      expect(f.inbox.pending()).toHaveLength(1);expect(f.app.db.inTransaction).toBe(false);
      expect(id).toBe(venue.id);expect(snapshot).toEqual(venue);
      expect(message).toMatchObject({text:'hello @Jonathan',label:'DM with Jonathan',id:payload().event.ts,dm:true});
    });
    const d=f.drain({inspect:api.inspect});await d.flush();
    expect(calls).toEqual(['https://slack.com/api/conversations.info','https://slack.com/api/users.info']);
    expect(f.receive).toHaveBeenCalledOnce();expect(f.inbox.pending()).toEqual([]);
    expect(f.app.db.prepare('SELECT state,event FROM bridges_slack_receipts').get()).toEqual({state:'consumed',event:null});
  });
  it('serializes overlapping flushes and retries metadata with current names, without renewing expiry',async()=>{
    const f=await fixture();await f.inbox.receive(payload());const pending=deferred<Awaited<ReturnType<SlackDrainOptions['inspect']>>>();
    f.inspect.mockReturnValueOnce(pending.promise);const d=f.drain();const first=d.flush();const second=d.flush();
    expect(first).toBe(second);expect(f.inspect).toHaveBeenCalledOnce();pending.resolve('wait');await first;
    expect(f.inspect).toHaveBeenCalledOnce();expect(f.receive).not.toHaveBeenCalled();
    f.clock.advance(4999);await d.flush();expect(f.inspect).toHaveBeenCalledOnce();
    f.clock.advance(1);await settle();expect(f.inspect).toHaveBeenCalledTimes(2);expect(f.receive).toHaveBeenCalledOnce();expect(f.inbox.pending()).toEqual([]);
  });
  it.each(['wait','throw','bare-allow','missing-bot','duplicate','wrong-dm-members'] as const)('retains raw receipt for retry on %s',async mode=>{
    const f=await fixture();await f.inbox.receive(payload());const before=f.inbox.pending();
    f.inspect.mockImplementation(async()=>{
      if(mode==='throw') throw Error('SECRET upstream words');
      if(mode==='bare-allow') return 'allow';
      if(mode==='wait') return 'wait';
      return {kind:'allow',members:mode==='missing-bot'?['U200']:mode==='duplicate'?['U123','U200','U200']:['U123','U200','U201']};
    });
    const d=f.drain();await expect(d.flush()).resolves.toBeUndefined();expect(f.receive).not.toHaveBeenCalled();expect(f.inbox.pending()).toEqual(before);
    f.inspect.mockResolvedValue({kind:'allow',members:['U123','U200']});f.name.mockReturnValue('New name');
    f.clock.advance(5000);await settle();expect(f.receive).toHaveBeenCalledOnce();expect(f.receive.mock.calls[0][1].label).toBe('DM with New name');
  });
  it.each([{subtype:'message_deleted'},{type:'reaction_added'},{bot_id:'B123'},{user:'U123'},{ts:'bad'}])('erases definite unsupported event %j without metadata or delivery',async event=>{
    const f=await fixture();await f.inbox.receive(payload('Ev123',event));await f.drain().flush();
    expect(f.inspect).not.toHaveBeenCalled();expect(f.receive).not.toHaveBeenCalled();expect(f.inbox.pending()).toEqual([]);
  });
  it('erases definite platform refusal and does not retry it',async()=>{
    const f=await fixture();await f.inbox.receive(payload());f.inspect.mockResolvedValue('drop');const d=f.drain();await d.flush();f.clock.advance(5000);await d.flush();
    expect(f.inspect).toHaveBeenCalledOnce();expect(f.receive).not.toHaveBeenCalled();expect(f.inbox.pending()).toEqual([]);
  });
  it('keeps words on failed normalized commit and retries through restart',async()=>{
    const f=await fixture();await f.inbox.receive(payload());f.receive.mockRejectedValue(Error('commit failed'));const d=f.drain();await d.flush();
    const before=f.inbox.pending();expect(before).toHaveLength(1);await d.close();await f.close();
    const g=await fixture(f.home);expect(g.inbox.pending()).toEqual(before);await g.drain().flush();expect(g.receive).toHaveBeenCalledOnce();expect(g.inbox.pending()).toEqual([]);
  });
  it.each(['setup','restore','credential','shutdown','staging'] as const)('blocks a handoff after %s during metadata IO',async mode=>{
    const f=await fixture();await f.inbox.receive(payload());const metadata=deferred<Awaited<ReturnType<SlackDrainOptions['inspect']>>>();f.inspect.mockReturnValue(metadata.promise);
    const d=f.drain();const flush=d.flush();let close:Promise<void>|undefined;
    if(mode==='setup') put(f.app.db,'venues',{...venue,enabled:false});
    if(mode==='restore') {put(f.app.db,'venues',{...venue,enabled:false});put(f.app.db,'venues',venue);}
    if(mode==='credential') f.current.mockReturnValue(false);
    if(mode==='shutdown') close=d.close();
    if(mode==='staging') f.beforeRead.mockReturnValue(false);
    metadata.resolve({kind:'allow',members:['U123','U200']});await flush;await close;
    expect(f.receive).not.toHaveBeenCalled();expect(f.app.db.prepare('SELECT state FROM bridges_slack_receipts').get()).toEqual({state:'pending'});
    if(mode!=='staging') {f.current.mockReturnValue(true);await d.flush();expect(f.receive).not.toHaveBeenCalled();}
    else {f.beforeRead.mockReturnValue(true);await d.flush();expect(f.receive).toHaveBeenCalledOnce();}
  });
  it('holds staging before metadata and stops retry timers on close',async()=>{
    const f=await fixture();await f.inbox.receive(payload());f.beforeRead.mockReturnValue(false);const d=f.drain();await d.flush();
    expect(f.inspect).not.toHaveBeenCalled();expect(f.receive).not.toHaveBeenCalled();await d.close();f.beforeRead.mockReturnValue(true);f.clock.advance(10_000);await d.flush();expect(f.inspect).not.toHaveBeenCalled();
  });
  it.each(['metadata','receive'] as const)('close waits for deferred %s and raw consumption waits for receive',async stage=>{
    const f=await fixture();await f.inbox.receive(payload());const gate=deferred<void>();
    if(stage==='metadata') f.inspect.mockImplementation(async()=>{await gate.promise;return {kind:'allow',members:['U123','U200']};});
    else f.receive.mockImplementation(()=>gate.promise);
    const d=f.drain();const flush=d.flush();await settle();expect(f.inbox.pending()).toHaveLength(1);
    if(stage==='receive') expect(f.receive).toHaveBeenCalledOnce();else expect(f.inspect).toHaveBeenCalledOnce();
    let closed=false;const close=d.close().then(()=>{closed=true;});await settle();expect(closed).toBe(false);
    gate.resolve();await close;await flush;expect(closed).toBe(true);expect(f.inbox.pending()).toHaveLength(1);
    if(stage==='metadata') expect(f.receive).not.toHaveBeenCalled();
  });
  it('cancels the scheduled retry rather than only suppressing its callback',async()=>{
    const f=await fixture();await f.inbox.receive(payload());const at=f.clock.at.bind(f.clock);const active=new Set<()=>void>();
    vi.spyOn(f.clock,'at').mockImplementation((time,fn)=>{let stop!:()=>void;const cancel=at(time,()=>{active.delete(stop);fn();});stop=()=>{active.delete(stop);cancel();};active.add(stop);return stop;});
    f.inspect.mockResolvedValue('wait');const d=f.drain();await d.flush();expect(active.size).toBe(1);await d.close();expect(active.size).toBe(0);
  });
  it.each(['validation','page'] as const)('recovers a transient %s read failure automatically instead of invalidating the binding',async stage=>{
    const f=await fixture();await f.inbox.receive(payload());
    const fail=()=>vi.spyOn(f.app.db,'prepare').mockImplementationOnce(()=>{throw Error('transient storage failure');});
    let injected=false;
    const d=f.drain(stage==='page'?{beforeRead:()=>{if(!injected){injected=true;fail();}return true;}}:{});if(stage==='validation') fail();await expect(d.flush()).resolves.toBeUndefined();expect(f.inspect).not.toHaveBeenCalled();expect(f.inbox.pending()).toHaveLength(1);
    f.clock.advance(5000);await until(()=>f.inbox.pending().length===0);expect(f.receive).toHaveBeenCalledOnce();
  });
  it('retains raw words if staging becomes held while the normalized commit is pending',async()=>{
    const f=await fixture();await f.inbox.receive(payload());const commit=deferred<void>();f.receive.mockReturnValueOnce(commit.promise);
    const d=f.drain();const flush=d.flush();await until(()=>f.receive.mock.calls.length===1);
    f.beforeRead.mockReturnValue(false);commit.resolve();await flush;expect(f.inbox.pending()).toHaveLength(1);
    f.clock.advance(5000);await settle();expect(f.receive).toHaveBeenCalledOnce();expect(f.inbox.pending()).toHaveLength(1);
    f.beforeRead.mockReturnValue(true);await d.flush();expect(f.receive).toHaveBeenCalledTimes(2);expect(f.inbox.pending()).toEqual([]);
  });
  it('expires from immutable receipt time across restart; exactly one hour is still eligible',async()=>{
    const f=await fixture();await f.inbox.receive(payload());f.inspect.mockResolvedValue('wait');const d=f.drain();await d.flush();await d.close();await f.close();
    const g=await fixture(f.home);g.clock.advance(3_600_000);g.inspect.mockResolvedValue('wait');const next=g.drain();await next.flush();expect(g.inspect).toHaveBeenCalledOnce();expect(g.inbox.pending()).toHaveLength(1);
    g.clock.advance(1);await next.flush();expect(g.inspect).toHaveBeenCalledOnce();expect(g.inbox.pending()).toEqual([]);expect(g.receive).not.toHaveBeenCalled();
  });
  it('bounds a pass to 64 receipts and schedules the rest',async()=>{
    const f=await fixture();for(let n=0;n<65;n++) {await f.inbox.receive(payload(`Ev${n}`,{ts:`1793828004.${String(n).padStart(6,'0')}`}));f.clock.advance(1);}const d=f.drain();await d.flush();expect(f.receive).toHaveBeenCalledTimes(64);expect(f.inbox.pending()).toHaveLength(1);
    expect(f.receive.mock.calls.map(call=>call[1].id)).toEqual(Array.from({length:64},(_,n)=>`1793828004.${String(n).padStart(6,'0')}`));
    f.clock.advance(5000);await until(()=>f.inbox.pending().length===0);expect(f.receive).toHaveBeenCalledTimes(65);expect(f.inbox.pending()).toEqual([]);
  });
  it('pages beyond a waiting prefix, then wraps to retry it',async()=>{
    const f=await fixture();for(let n=0;n<65;n++) {await f.inbox.receive(payload(`Ev${n}`,{ts:`1793828004.${String(n).padStart(6,'0')}`}));f.clock.advance(1);}
    f.inspect.mockImplementation(async(_v,message)=>message.id==='1793828004.000064'?{kind:'allow',members:['U123','U200']}:'wait');
    const d=f.drain();await d.flush();expect(f.inspect).toHaveBeenCalledTimes(64);expect(f.receive).not.toHaveBeenCalled();
    f.clock.advance(5000);await settle();expect(f.receive).toHaveBeenCalledOnce();expect(f.receive.mock.calls[0][1].id).toBe('1793828004.000064');
    f.inspect.mockResolvedValue({kind:'allow',members:['U123','U200']});f.clock.advance(5000);await until(()=>f.inbox.pending().length===0);
    expect(f.receive).toHaveBeenCalledTimes(65);expect(f.inbox.pending()).toEqual([]);
  });
  it('allows metadata begun within the raw budget to finish after the hour',async()=>{
    const f=await fixture();await f.inbox.receive(payload());f.clock.advance(3_600_000);
    const metadata=deferred<Awaited<ReturnType<SlackDrainOptions['inspect']>>>();f.inspect.mockReturnValue(metadata.promise);
    const d=f.drain();const flush=d.flush();expect(f.inspect).toHaveBeenCalledOnce();f.clock.advance(1);
    metadata.resolve({kind:'allow',members:['U123','U200']});await flush;
    expect(f.receive).toHaveBeenCalledOnce();expect(f.inbox.pending()).toEqual([]);
  });
  it('does not hand off or consume inside an enclosing transaction',async()=>{
    const f=await fixture();await f.inbox.receive(payload());const d=f.drain();let flush!:Promise<void>;
    f.app.db.transaction(()=>{flush=d.flush();})();await flush;expect(f.inspect).not.toHaveBeenCalled();expect(f.receive).not.toHaveBeenCalled();
    expect(f.inbox.pending()).toHaveLength(1);await d.flush();expect(f.receive).toHaveBeenCalledOnce();
  });
  it('replays after a normalized commit and failed raw consumption without a second delivery',async()=>{
    const f=await fixture();const delivered:Incoming[]=[];
    const engine=engineFor(f,{admit:async()=> 'allow',deliver:async input=>{delivered.push(input);return 'delivered';},stop:async()=>{}});
    await f.inbox.receive(payload());
    f.app.db.exec("CREATE TRIGGER fail_consume BEFORE UPDATE ON bridges_slack_receipts BEGIN SELECT RAISE(ABORT,'simulated consumption failure'); END;");
    const first=f.drain({receive:engine.receive.bind(engine)});await first.flush();await engine.flush();
    expect(delivered).toHaveLength(1);expect(f.inbox.pending()).toHaveLength(1);
    await first.close();f.app.db.exec('DROP TRIGGER fail_consume');
    await f.drain({receive:engine.receive.bind(engine)}).flush();await engine.flush();
    expect(f.inbox.pending()).toEqual([]);expect(delivered).toHaveLength(1);
    expect(f.app.db.prepare('SELECT count(*) AS n FROM bridges_inbox').get()).toEqual({n:1});
  });
  it.each(['allow','drop'] as const)('the real engine freshly admits every group member, including %s',async verdict=>{
    const f=await fixture();const delivered:Incoming[]=[];
    const admit=vi.fn(async(input:{person:string})=>input.person==='mark'?verdict:'allow' as const);
    const engine=engineFor(f,{admit,deliver:async input=>{delivered.push(input);return 'delivered';},stop:async()=>{}},true);
    await f.inbox.receive(payload('EvGroup',{channel:'G123'}));f.inspect.mockResolvedValue({kind:'allow',members:['U123','U200','U201']});
    await f.drain({receive:engine.receive.bind(engine)}).flush();await engine.flush();
    expect(f.inbox.pending()).toEqual([]);expect(admit.mock.calls).toHaveLength(2);expect(delivered).toHaveLength(verdict==='allow'?1:0);if(verdict==='allow') expect(delivered[0]).toMatchObject({person:'jonathan',label:'group DM with Jonathan, Mark',at:'2026-11-04T21:33:24.242Z'});
  });
});
