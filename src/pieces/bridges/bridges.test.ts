import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing } from '../../core/index.js';
import { installEffects } from '../../core/effects.js';
import { installBridges } from './index.js';
import { Bridges } from './engine.js';
import type { BridgeRuntime, BridgeSecrets, VenueAdapter, Incoming, DeliveryOutcome, Inspection } from './role.js';
import { z } from 'zod';
import type { RecordType } from '../../core/live/index.js';
import { OperationError } from '../../core/index.js';
import { venueSchema, routeSchema, type Message, type Venue } from './model.js';
import { addressed } from './routing.js';
import { eventTime } from './time.js';
const sharing: Sharing = {members:{jonathan:{owner:true,agents:['art','mark']},pollock:{owner:false,agents:['pond-bot']}},projects:{pond:{members:['pollock'],agents:['pond-bot']}},services:{}};
const owner = {kind:'member',id:'jonathan'} as const;
const roots: string[] = [], closes: (()=>Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
class FakeVenue implements VenueAdapter {
  platform: Venue['platform'];
  callbacks?: Parameters<VenueAdapter['connect']>[2]; connections=0; closed=0; posts: unknown[][]=[]; uncertain=false; inspection: Inspection='allow';
  constructor(platform: Venue['platform']) {this.platform=platform;}
  async connect(_v: Venue,_c: unknown,callbacks: Parameters<VenueAdapter['connect']>[2]) { this.connections++; this.callbacks=callbacks; return {close:()=>{this.closed++;}}; }
  async inspect() { return this.inspection; }
  async send(...args: Parameters<VenueAdapter['send']>) { this.posts.push(args); if (this.uncertain) throw new Error('token-value-do-not-store'); return {id:`post-${this.posts.length}`}; }
}
async function fixture(platform: Venue['platform']='discord', staging=false, existingHome?: string) {
  const home=existingHome ?? mkdtempSync(join(tmpdir(),'bridges-')); if (!existingHome) roots.push(home);
  const clock=new FakeClock();
  const types = new Map<string,RecordType>();
  let effects!: ReturnType<typeof installEffects>;
  const app=await startLoom({home,clock,install(app) { const register=app.live.register.bind(app.live); app.live.register=type=>{types.set(type.name,type); register(type);}; installBridges(app,()=>sharing); effects=installEffects(app,()=>sharing,staging); }});
  const adapter=new FakeVenue(platform), deliveries=new Map<string,Incoming>(), stops: unknown[]=[];
  let gate: 'allow'|'drop'|'wait'='allow', failAfterDelivery=false, secretAllowed=true; const secretGets: string[]=[];
  const admitted: string[]=[];
  const runtime: BridgeRuntime={async admit(input){admitted.push(input.person);return gate;},async deliver(input){deliveries.set(input.id,input);if(failAfterDelivery)throw Error('body unavailable');return 'delivered';},async stop(i){stops.push(i);}};
  const secrets: BridgeSecrets={async may(){return secretAllowed;},async get(_agent,name){secretGets.push(name);return 'token-value-do-not-store';}};
  const engine=new Bridges(app,clock,runtime,secrets,[adapter],effects);
  const close=async()=>{await engine.close();await app.close();}; closes.push(close);
  const op=(name:string,input:unknown,id=crypto.randomUUID())=>app.operations.call('direct',owner,`bridges.${name}`,input,id);
  const venue=venueSchema.parse({id:'art-'+platform,platform,agent:'art',workspace:'house',bot:'100',tokenSecret:'art-token'});
  if (!existingHome) {
    expect(op('putVenues',venue).ok).toBe(true);
    expect(op('putLinks',{id:'person',platform,workspace:'house',user:'200',person:'jonathan'}).ok).toBe(true);
    expect(op('putRoutes',{id:'channel',platform,workspace:'house',channel:'300',primary:'art'}).ok).toBe(true);
  }
  const message=(overrides: Partial<Message>={}): Message=>({at:'2026-11-12T17:00:00.123456Z',label:'House chat',id:'m1',channel:platform==='slack'?'D300':'300',user:'200',text:'hi',mentions:[],dm:platform==='slack',...overrides});
  return {runtime,admitted,types,secretGets, denySecret:()=>{secretAllowed=false;}, home,app,clock,engine,adapter,deliveries,stops,op,venue,message,close,setGate:(g:typeof gate)=>{gate=g;},failDelivery:()=>{failAfterDelivery=true;}};
}
describe('in-process bridge delivery',()=>{
  async function groupFixture(staging=false) {
    const f=await fixture('slack',staging);
    expect(f.op('putLinks',{id:'member',platform:'slack',workspace:'house',user:'201',person:'mark'}).ok).toBe(true);
    f.adapter.inspection={kind:'allow',members:['100','200','201']};
    // MPIMs route to their own bot, even without a route or summons.
    const message=f.message({channel:'G300',group:true,dm:false});
    return {...f,groupMessage:message};
  }
  it('routes Slack groups to the receiving bot and admits every human before delivery',async()=>{
    const f=await groupFixture();
    await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    expect(f.admitted).toEqual(['jonathan','mark']); expect(f.deliveries.size).toBe(1);
    expect([...f.deliveries.values()][0].key.venue).toBe('slack:house:group:G300');
  });
  it('derives group identity and admission from non-D Slack ids even without flags',async()=>{
    const f=await groupFixture(); const raw={...f.groupMessage,dm:true,group:undefined};
    f.adapter.inspection='allow';
    await f.engine.receive(f.venue.id,raw); await f.engine.flush();
    expect(f.deliveries.size).toBe(0); expect(f.admitted).toEqual([]);
    f.adapter.inspection={kind:'allow',members:['100','200','201']};
    await f.engine.receive(f.venue.id,{...raw,id:'m2'}); await f.engine.flush();
    const incoming=[...f.deliveries.values()][0];
    expect(incoming.key.venue).toBe('slack:house:group:G300');
    expect(incoming.address).toMatchObject({group:true,dm:false});
    expect(f.admitted).toEqual(['jonathan','mark']);
    f.engine.reply({id:'reply',incomingId:incoming.id,text:'hello'}); await f.engine.flush();
    expect(f.adapter.posts[0][2]).toMatchObject({group:true,dm:false});
  });
  it('reclassifies pre-fix pending receipts and replies before admission and posting',async()=>{
    const f=await groupFixture(); f.setGate('wait');
    await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    const raw={...f.groupMessage,dm:true,group:undefined};
    f.app.db.prepare('UPDATE bridges_inbox SET message=?').run(JSON.stringify(raw));
    f.setGate('allow'); f.adapter.inspection='allow';
    f.clock.advance(5000); await f.engine.flush(); expect(f.deliveries.size).toBe(0);
    // A previously delivered pre-fix receipt can already have a pending reply.
    f.app.db.prepare("UPDATE bridges_inbox SET state='delivered',message=?").run(JSON.stringify(raw));
    const {id}=f.app.db.prepare('SELECT id FROM bridges_inbox').get() as {id:string};
    f.engine.reply({id:'reply',incomingId:id,text:'secret'});
    f.app.db.prepare('UPDATE bridges_outbox SET address=?').run(JSON.stringify({channel:'G300',dm:true}));
    await f.engine.flush(); expect(f.adapter.posts).toEqual([]);
    expect(f.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'held'});
  });
  it.each([
    ['legacy boolean','allow'],
    ['missing sender',{kind:'allow',members:['100','201','202']}],
    ['missing receiving bot',{kind:'allow',members:['200','201']}],
    ['duplicate member',{kind:'allow',members:['100','200','200']}],
    ['unknown member',{kind:'allow',members:['100','200','201','stranger']}],
    ['too few humans',{kind:'allow',members:['100','200']}],
    ['malformed member',{kind:'allow',members:['100','200',null]}],
  ])('drops Slack group inspection with %s',async(_name,inspection)=>{
    const f=await groupFixture(); f.adapter.inspection=inspection as Inspection;
    if(_name==='missing sender') expect(f.op('putLinks',{id:'third',platform:'slack',workspace:'house',user:'202',person:'pollock'}).ok).toBe(true);
    await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    expect(f.deliveries.size).toBe(0); expect(f.admitted).toEqual([]);
    expect(f.app.db.prepare('SELECT state,message FROM bridges_inbox').get()).toEqual({state:'dropped',message:'{}'});
  });
  it.each(['drop','wait'] as const)('honors a non-sender group member admission %s',async verdict=>{
    const f=await groupFixture(); f.runtime.admit=async input=>input.person==='mark'?verdict:'allow';
    await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    expect(f.deliveries.size).toBe(0);
    expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:verdict==='drop'?'dropped':'pending'});
    if(verdict==='wait') { f.runtime.admit=async()=> 'allow'; f.clock.advance(5000); await f.engine.flush(); expect(f.deliveries.size).toBe(1); }
  });
  it('refuses two Slack accounts claiming the same human',async()=>{
    const f=await groupFixture();
    expect(f.op('putLinks',{id:'member',platform:'slack',workspace:'house',user:'201',person:'jonathan'}).ok).toBe(true);
    await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    expect(f.deliveries.size).toBe(0); expect(f.admitted).toEqual([]);
  });
  it('rechecks member links after asynchronous admission',async()=>{
    const f=await groupFixture(); let changed=false;
    f.runtime.admit=async input=>{
      if(input.person==='mark' && !changed) { changed=true; f.op('putLinks',{id:'member',platform:'slack',workspace:'house',user:'201',person:'stranger'}); }
      return input.person==='stranger'?'drop':'allow';
    };
    await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    expect(changed).toBe(true); expect(f.deliveries.size).toBe(0);
    f.clock.advance(5000); await f.engine.flush(); expect(f.deliveries.size).toBe(0);
  });
  it.each(['intake','reply'] as const)('invalidates stale allow and drop after %s setup edits, including edit-and-restore',async phase=>{
    for (const kind of ['link','route','venue'] as const) for (const restore of [false,true]) for (const verdict of ['allow','drop'] as const) {
      const f=await groupFixture();
      if(phase==='reply') { await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush(); }
      let first=true, fresh=false; const attempts: string[]=[];
      f.runtime.admit=async input=>{
        attempts.push(input.person);
        if(first && input.person!=='mark') return 'allow';
        if(first) {
          first=false;
          if(kind==='link') {
            expect(f.op('putLinks',{id:'member',platform:'slack',workspace:'house',user:'201',person:'pollock'}).ok).toBe(true);
            if(restore) expect(f.op('putLinks',{id:'member',platform:'slack',workspace:'house',user:'201',person:'mark'}).ok).toBe(true);
          } else if(kind==='route') {
            expect(f.op('putRoutes',{id:'group-route',platform:'slack',workspace:'house',channel:'G300',readers:['pollock']}).ok).toBe(true);
            if(restore) expect(f.op('removeRoutes',{id:'group-route'}).ok).toBe(true);
          } else {
            expect(f.op('putVenues',{...f.venue,ignore:['unrelated']}).ok).toBe(true);
            if(restore) expect(f.op('putVenues',f.venue).ok).toBe(true);
          }
          return verdict;
        }
        return fresh?'allow':'wait';
      };
      if(phase==='intake') await f.engine.receive(f.venue.id,f.groupMessage);
      else f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'private'});
      await f.engine.flush();
      expect(first).toBe(false);
      expect(f.deliveries.size).toBe(phase==='intake'?0:1); expect(f.adapter.posts).toEqual([]);
      const table=phase==='intake'?'bridges_inbox':'bridges_outbox';
      expect(f.app.db.prepare(`SELECT state FROM ${table}`).get()).toEqual({state:'pending'});
      fresh=true; f.clock.advance(5000); await f.engine.flush();
      expect(f.deliveries.size).toBe(1); expect(f.adapter.posts).toHaveLength(phase==='reply'?1:0);
      expect(attempts.length).toBeGreaterThan(1);
    }
  });
  it.each(['platform','runtime','unknown-member'] as const)('freshly refuses an outgoing group reply after %s changes',async change=>{
    const f=await groupFixture(); const inspect=vi.spyOn(f.adapter,'inspect');
    await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    if(change==='platform') f.adapter.inspection='drop';
    if(change==='unknown-member') f.adapter.inspection={kind:'allow',members:['100','200','201','stranger']};
    if(change==='runtime') f.runtime.admit=async input=>input.person==='mark'?'drop':'allow';
    f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'private reply'}); await f.engine.flush();
    expect(inspect).toHaveBeenCalledTimes(2); expect(f.adapter.posts).toEqual([]);
    expect(f.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'held'});
  });
  it('rechecks groups on every reply and on staging release, retaining a temporary failure',async()=>{
    const f=await groupFixture(true); const inspect=vi.spyOn(f.adapter,'inspect');
    await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    const incomingId=[...f.deliveries.keys()][0];
    f.engine.reply({id:'reply',incomingId,text:'hello'}); await f.engine.flush();
    expect(f.adapter.posts).toEqual([]); expect(inspect).toHaveBeenCalledTimes(2);
    f.adapter.inspection='wait';
    expect(f.app.operations.call('direct',owner,'core.releaseEffect',{id:'bridges:reply'},'release').ok).toBe(true);
    await f.engine.flush(); expect(f.adapter.posts).toEqual([]);
    expect(f.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'pending'});
    f.adapter.inspection={kind:'allow',members:['100','200','201']}; f.clock.advance(5000); await f.engine.flush();
    expect(f.adapter.posts).toHaveLength(1);
    f.engine.reply({id:'second',incomingId,text:'another'}); await f.engine.flush();
    f.adapter.inspection='drop';
    expect(f.app.operations.call('direct',owner,'core.releaseEffect',{id:'bridges:second'},'release-second').ok).toBe(true);
    await f.engine.flush(); expect(f.adapter.posts).toHaveLength(1);
    expect(f.app.db.prepare("SELECT state FROM bridges_outbox WHERE id='second'").get()).toEqual({state:'held'});
  });
  it('preserves event time and label through durable receipt, restart and duplicate receipt',async()=>{
    const f=await fixture(); f.setGate('wait');
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    await f.engine.receive(f.venue.id,f.message({at:'2026-11-13T00:00:00Z',label:'changed while pending'})); await f.engine.flush();
    await f.close(); closes.splice(closes.indexOf(f.close),1);
    const next=await fixture('discord',false,f.home); await next.engine.sync();
    const binding=next.app.db.prepare('SELECT record FROM bridges_conversations').get() as {record:string};
    expect(JSON.parse(binding.record)).toEqual([...next.deliveries.values()][0].key);
    expect([...next.deliveries.values()][0]).toMatchObject({at:'2026-11-12T17:00:00.123Z',label:'House chat'});
    await next.engine.receive(next.venue.id,next.message({at:'2026-11-13T00:00:00Z',label:'changed'})); await next.engine.flush();
    expect(next.deliveries.size).toBe(1);
    expect([...next.deliveries.values()][0]).toMatchObject({at:'2026-11-12T17:00:00.123Z',label:'House chat'});
    await next.close(); closes.splice(closes.indexOf(next.close),1);
    const again=await fixture('discord',false,f.home); await again.engine.sync();
    expect(again.app.db.prepare('SELECT record FROM bridges_conversations').get()).toEqual(binding);
    expect(again.deliveries.size).toBe(0);
  });
  it.each(['refused','held','retry'] as const)('handles runtime %s without consuming a turn as delivered',async outcome=>{
    const f=await fixture(); f.runtime.deliver=async()=>outcome;
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    expect(f.app.db.prepare('SELECT state,message FROM bridges_inbox').get()).toEqual({
      state:outcome==='refused'?'dropped':outcome==='held'?'held':'pending',
      message:outcome==='refused'?'{}':JSON.stringify(f.message()),
    });
    expect(f.app.db.prepare('SELECT * FROM bridges_conversations').all()).toEqual([]);
    f.runtime.deliver=async input=>{f.deliveries.set(input.id,input);return 'delivered';};
    f.clock.advance(5000); await f.engine.flush();
    expect(f.deliveries.size).toBe(outcome==='retry'?1:0);
  });
  it('acknowledges durable receipt while runtime delivery is still blocked',async()=>{
    const f=await fixture(); await f.engine.sync();
    let release!: (outcome: DeliveryOutcome)=>void, started!: ()=>void;
    const entering=new Promise<void>(resolve=>{started=resolve;});
    const blocked=new Promise<DeliveryOutcome>(resolve=>{release=resolve;});
    f.runtime.deliver=async()=>{started();return blocked;};
    await f.adapter.callbacks!.message(f.message());
    expect(f.app.db.prepare('SELECT state,message FROM bridges_inbox').get()).toEqual({state:'pending',message:JSON.stringify(f.message())});
    await entering;
    release('delivered'); await f.engine.flush();
    expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'delivered'});
  });
  it.each([undefined,'unexpected'])('holds malformed runtime outcome %s without retries',async outcome=>{
    const f=await fixture(); const deliver=vi.fn(async()=>outcome as unknown as DeliveryOutcome); f.runtime.deliver=deliver;
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.clock.advance(5000); await f.engine.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(f.app.db.prepare('SELECT state,reason FROM bridges_inbox').get()).toEqual({state:'held',reason:'runtime delivery held'});
    expect(f.app.db.prepare('SELECT * FROM bridges_conversations').all()).toEqual([]);
  });
  it('holds a malformed stop event without stopping runtime or binding a conversation',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message({text:'cancel!',at:'bad'})); await f.engine.flush();
    expect(f.stops).toEqual([]); expect(f.deliveries.size).toBe(0);
    expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'held'});
    expect(f.app.db.prepare('SELECT * FROM bridges_conversations').all()).toEqual([]);
  });
  it.each(['admission-wait','credential-denied'])('holds malformed events before %s transient checks',async failure=>{
    const f=await fixture(); if (failure==='admission-wait') f.setGate('wait'); else f.denySecret();
    await f.engine.receive(f.venue.id,f.message({at:'bad'})); await f.engine.flush();
    f.clock.advance(5000); await f.engine.flush();
    expect(f.app.db.prepare('SELECT state,reason FROM bridges_inbox').get()).toEqual({state:'held',reason:'invalid event time'});
    expect(f.admitted).toEqual([]); expect(f.secretGets).toEqual([]);
    expect(f.deliveries.size).toBe(0);
  });
  it('holds malformed event metadata durably instead of inventing an event time',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message({at:'bad'})); await f.engine.flush();
    expect(f.deliveries.size).toBe(0);
    expect(f.app.db.prepare('SELECT state,reason FROM bridges_inbox').get()).toEqual({state:'held',reason:'invalid event time'});
    f.clock.advance(5000); await f.engine.flush(); expect(f.deliveries.size).toBe(0);
  });

  it.each(['discord','slack'] as const)('%s receives, routes, delivers and replies once',async platform=>{
    const f=await fixture(platform); await f.engine.sync(); expect(f.adapter.connections).toBe(1);
    await f.adapter.callbacks!.message(f.message()); await f.engine.flush();
    expect(f.deliveries.size).toBe(1);
    await f.adapter.callbacks!.message(f.message()); await f.engine.flush(); expect(f.deliveries.size).toBe(1);
    const incomingId=[...f.deliveries.keys()][0];
    f.engine.reply({id:'reply',incomingId,text:'hello'}); await f.engine.flush();
    f.engine.reply({id:'reply',incomingId,text:'hello'}); await f.engine.flush();
    expect(f.adapter.posts).toHaveLength(1); expect(f.adapter.posts[0][4]).toBe('reply');
    expect(()=>f.engine.reply({id:'reply',incomingId,text:'changed'})).toThrow('reused');
  });
  it('uses explicit resolved mentions, inherits thread routes and keeps DMs separate', async()=>{
    const f=await fixture(); const mark=venueSchema.parse({...f.venue,id:'mark-discord',agent:'mark',bot:'101'});
    expect(addressed(f.venue,f.message({mentions:['101']}),routeSchema.parse({id:'r',platform:'discord',workspace:'house',channel:'300',primary:'art'}),[f.venue,mark])).toBe(false);
    expect(addressed(f.venue,f.message(),undefined,[f.venue,mark])).toBe(false);
    expect(addressed(mark,f.message({mentions:['101']}),routeSchema.parse({id:'r',platform:'discord',workspace:'house',channel:'300',primary:'art'}),[f.venue,mark])).toBe(true);
    await f.engine.receive(f.venue.id,f.message({channel:'400',parent:'300',thread:'400'}));
    await f.engine.receive(f.venue.id,f.message({id:'m2',channel:'D200',dm:true})); await f.engine.flush();
    const messages=[...f.deliveries.values()]; expect(messages).toHaveLength(2);
    expect(messages.map(m=>m.key.venue)).toEqual(expect.arrayContaining(['discord:house:thread:400:400','discord:house:dm:jonathan']));
  });
  it('leaves unknown users on read, gates known users, and waits on transient checks',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message({user:'stranger'})); await f.engine.flush();
    expect(f.deliveries.size).toBe(0);
    expect(f.app.db.prepare('SELECT message,reason FROM bridges_inbox').get()).toEqual({message:'{}',reason:'unknown user'});
    f.setGate('wait'); await f.engine.receive(f.venue.id,f.message({id:'m2'})); await f.engine.flush(); expect(f.deliveries.size).toBe(0);
    f.setGate('allow'); f.clock.advance(5000); await f.engine.flush(); expect(f.deliveries.size).toBe(1);
  });
  it('deduplicates a runtime retry after the turn was committed',async()=>{
    const f=await fixture(); f.failDelivery(); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.clock.advance(5000); await f.engine.flush(); expect(f.deliveries.size).toBe(1);
  });
  it('holds every staging send until released, then sends exactly once',async()=>{
    const f=await fixture('slack',true); await f.engine.receive(f.venue.id,f.message({dm:true})); await f.engine.flush();
    f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'held'}); await f.engine.flush(); expect(f.adapter.posts).toHaveLength(0);
    const posted = new Promise<void>(resolve=>{ const send=f.adapter.send.bind(f.adapter); f.adapter.send=async(...args)=>{const result=await send(...args);resolve();return result;}; });
    expect(f.app.operations.call('direct',owner,'core.releaseEffect',{id:'bridges:reply'},'release').ok).toBe(true);
    f.clock.advance(0); await posted; expect(f.adapter.posts).toHaveLength(1);
  });
  it('holds an uncertain send for a person and never sends it again, including after restart',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush(); f.adapter.uncertain=true;
    f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'hello'}); await f.engine.flush(); await f.engine.flush();
    expect(f.adapter.posts).toHaveLength(1); expect(f.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'uncertain'});
    await f.close(); closes.splice(closes.indexOf(f.close),1);
    const restarted=await fixture('discord',false,f.home); await restarted.engine.sync(); expect(restarted.adapter.posts).toHaveLength(0);
    const records=restarted.app.db.prepare('SELECT result FROM core_operations').all(); expect(JSON.stringify(records)).not.toContain('token-value');
  });
  it('reconnects after a drop with a fake clock and cancels reconnect on shutdown',async()=>{
    const f=await fixture(); await f.engine.sync(); f.adapter.callbacks!.dropped(); expect(f.adapter.connections).toBe(1);
    f.clock.advance(1000); await f.engine.sync(); // Await credentials/connect microtasks without a wall clock sleep.
    await Promise.resolve(); await Promise.resolve(); expect(f.adapter.connections).toBe(2);
    f.adapter.callbacks!.dropped(); await f.engine.close(); f.clock.advance(120000); expect(f.adapter.connections).toBe(2);
  });
  it('accepts stop without waking another body',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message({text:'<@100> cancel!'})); await f.engine.flush(); expect(f.stops).toHaveLength(1); expect(f.deliveries.size).toBe(0);
    expect(f.app.db.prepare('SELECT * FROM bridges_conversations').all()).toEqual([]);
  });

  it('never gets a denied credential or opens a connection or sends with one',async()=>{
    const f=await fixture(); f.denySecret(); await f.engine.sync();
    expect(f.secretGets).toEqual([]); expect(f.adapter.connections).toBe(0);
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    expect(f.deliveries.size).toBe(0); expect(f.adapter.posts).toEqual([]); expect(f.secretGets).toEqual([]);
  });
  it('holds pending work if its receiving identity changes',async()=>{
    const f=await fixture(); f.setGate('wait'); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    expect(f.op('putVenues',{...f.venue,agent:'mark',bot:'101'}).ok).toBe(true);
    f.setGate('allow'); await f.engine.flush(); expect(f.deliveries.size).toBe(0);
    expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'held'});
  });
  it('holds a queued reply if the bot identity is replaced',async()=>{
    const f=await fixture('discord',true); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'hello'}); await f.engine.flush();
    f.op('putVenues',{...f.venue,workspace:'another-workspace'}); await f.engine.flush();
    expect(f.adapter.posts).toHaveLength(0); expect(f.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'held'});
  });
  it('keeps a pending runtime turn id across restart',async()=>{
    const f=await fixture(); f.failDelivery(); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    const id=[...f.deliveries.keys()][0]; await f.close(); closes.splice(closes.indexOf(f.close),1);
    const next=await fixture('discord',false,f.home); await next.engine.sync(); expect([...next.deliveries.keys()]).toEqual([id]);
  });
  it('recovers an interrupted sending row as uncertain without attempting another post',async()=>{
    const f=await fixture('discord',true); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'hello'}); await f.engine.flush();
    f.app.db.prepare("UPDATE bridges_outbox SET state='sending' WHERE id='reply'").run();
    await f.close(); closes.splice(closes.indexOf(f.close),1);
    const next=await fixture('discord',false,f.home); await next.engine.sync(); expect(next.adapter.posts).toHaveLength(0);
    expect(next.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'uncertain'});
  });
  it('handles multiple bot connections once per addressed agent',async()=>{
    const f=await fixture();
    f.op('putVenues',{...f.venue,id:'second-connection'});
    await f.engine.receive(f.venue.id,f.message()); await f.engine.receive('second-connection',f.message()); await f.engine.flush();
    expect(f.deliveries.size).toBe(1);
    f.op('putVenues',{...f.venue,id:'mark-connection',agent:'mark',bot:'101'});
    const both=f.message({id:'both',mentions:['100','101']});
    await f.engine.receive(f.venue.id,both); await f.engine.receive('mark-connection',both); await f.engine.flush();
    expect([...f.deliveries.values()].filter(d=>d.text==='hi')).toHaveLength(3);
    expect(new Set([...f.deliveries.values()].map(d=>d.key.agent))).toEqual(new Set(['art','mark']));
  });

  it('publishes replies only after their runtime operation commits and suppresses rollback',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    const changed=vi.spyOn(f.app.live,'changed'); const incomingId=[...f.deliveries.keys()][0];
    f.app.operations.register({name:'test.reply',write:true,input:z.boolean(),output:z.null(),may:()=>true,run(ctx,fail){
      f.engine.reply({id:fail?'rolled-back':'committed',incomingId,text:'hello'},ctx);
      expect(changed).not.toHaveBeenCalled(); if(fail)throw new OperationError('conflict','rollback'); return null;
    }});
    expect(f.app.operations.call('direct',owner,'test.reply',true,'fail').ok).toBe(false);
    expect(changed).not.toHaveBeenCalled(); expect(f.app.db.prepare('SELECT * FROM bridges_outbox').all()).toEqual([]);
    expect(f.app.operations.call('direct',owner,'test.reply',false,'ok').ok).toBe(true);
    expect(changed).toHaveBeenCalledWith([{type:'bridges.send',id:'committed'}]);
  });
  it('rechecks setup after asynchronous credential retrieval before sending',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'hello'});
    // flush yields on the grant check; remove the venue before it can send.
    const flushing=f.engine.flush(); f.op('removeVenues',{id:f.venue.id}); await flushing;
    expect(f.adapter.posts).toHaveLength(0);
  });
  it('rechecks grants before sending an already queued reply',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    const gets=f.secretGets.length; f.denySecret();
    f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'hello'}); await f.engine.flush();
    expect(f.secretGets).toHaveLength(gets); expect(f.adapter.posts).toHaveLength(0);
  });
  it('announces held sends on venue removal and removes sent records from live scope',async()=>{
    const f=await fixture('discord',true); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.engine.reply({id:'held',incomingId:[...f.deliveries.keys()][0],text:'hello'}); await f.engine.flush();
    const changed=vi.spyOn(f.app.live,'changed'); f.op('removeVenues',{id:f.venue.id});
    expect(changed).toHaveBeenCalledWith(expect.arrayContaining([{type:'bridges.send',id:'held'}]));
    const type=f.types.get('bridges.send')!; expect(type.read('held',owner)?.state).toBe('held');
    expect(type.inScope({...type.read('held',owner)!,state:'sent'},undefined,0)).toBe(false);
    expect(type.inScope({...type.read('held',owner)!,state:'uncertain'},undefined,0)).toBe(true);
  });
  it('filters every setup and traffic projection, and never stores credential values',async()=>{
    const f=await fixture(); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.engine.reply({id:'reply',incomingId:[...f.deliveries.keys()][0],text:'hello'}); f.adapter.uncertain=true; await f.engine.flush();
    for (const name of ['bridges.venue','bridges.route','bridges.link','bridges.send']) {
      const type=f.types.get(name)!; const ids=type.ids(undefined); expect(ids.length).toBeGreaterThan(0);
      expect(ids.map(id=>type.read(id,owner)).every(Boolean)).toBe(true);
      expect(ids.map(id=>type.read(id,{kind:'member',id:'pollock'})).every(r=>r===undefined)).toBe(true);
      expect(ids.map(id=>type.read(id,{kind:'agent',id:'art'})).every(r=>r===undefined)).toBe(true);
      expect(JSON.stringify(ids.map(id=>type.read(id,owner)))).not.toContain('token-value-do-not-store');
    }
    for(const table of ['bridges_venues','bridges_routes','bridges_links','bridges_status','bridges_inbox','bridges_outbox','core_operations','core_effects'])
      expect(JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain('token-value-do-not-store');
  });

  it('rechecks the person link after asynchronous admission and admits the replacement afresh',async()=>{
    const f=await fixture(); let replaced=false;
    f.adapter.inspect=async()=>{if(!replaced){replaced=true;f.op('putLinks',{id:'person',platform:'discord',workspace:'house',user:'200',person:'pollock'});}return 'allow';};
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.clock.advance(5000); await f.engine.flush();
    expect(f.admitted).toEqual(['jonathan','pollock']); expect([...f.deliveries.values()][0].person).toBe('pollock');
  });
  it('drops a known sender denied by runtime and erases the message words',async()=>{
    const f=await fixture(); f.setGate('drop'); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    expect(f.deliveries.size).toBe(0); expect(f.app.db.prepare('SELECT message,reason FROM bridges_inbox').get()).toEqual({message:'{}',reason:'not admitted'});
  });
  it('protects links and connection setup through the central household policy',async()=>{
    const f=await fixture();
    for (const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'},{kind:'runner',id:'box'}] as const) {
      expect(f.app.operations.call('direct',viewer,'bridges.putVenues',f.venue,'change').ok).toBe(false);
      expect(f.app.operations.call('direct',viewer,'bridges.putLinks',{id:'link',platform:'discord',workspace:'house',user:'x',person:'jonathan'},'link').ok).toBe(false);
    }
  });
});

describe('platform event timestamps',()=>{
  it('normalizes offsets and truncates microseconds without rounding',()=>{
    expect(eventTime('slack','unused','0000-02-29T00:00:00Z')).toBe('0000-02-29T00:00:00.000Z');
    expect(eventTime('slack','unused','2026-11-12T17:00:00.1234567890Z')).toBe('2026-11-12T17:00:00.123Z');
    expect(eventTime('slack','unused','2026-11-12T11:12:13.999999-06:00')).toBe('2026-11-12T17:12:13.999Z');
    expect(eventTime('slack','1794503533.000999')).toBe('2026-11-12T17:12:13.000Z');
    expect(eventTime('discord',String((BigInt(Date.parse('2026-11-12T17:12:13.123Z'))-1420070400000n)<<22n))).toBe('2026-11-12T17:12:13.123Z');
  });
  it('refuses malformed or missing event ids and invalid supplied dates',()=>{
    for (const at of ['bad','2026-02-30T00:00:00Z','2026-11-12T24:00:00Z','2026-11-12',''])
      expect(eventTime('slack','1794503533.123456',at)).toBeUndefined();
    for (const id of ['','-1','1.5','18446744073709551616']) expect(eventTime('discord',id)).toBeUndefined();
    expect(eventTime('slack','not-a-ts')).toBeUndefined();
  });
});
