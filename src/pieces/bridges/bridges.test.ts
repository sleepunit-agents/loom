import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, migrate, openDb, type Sharing } from '../../core/index.js';
import { installEffects } from '../../core/effects.js';
import { installBridges } from './index.js';
import { schema as foundationSchema } from './schema/001.js';
import { schema as retrySchema } from './schema/002.js';
import { Bridges } from './engine.js';
import type { BridgeRuntime, VenueAdapter, Incoming, DeliveryOutcome, Inspection } from './role.js';
import { z } from 'zod';
import type { RecordType } from '../../core/live/index.js';
import { OperationError } from '../../core/index.js';
import { venueSchema, routeSchema, type Message, type Venue } from './model.js';
import { addressed } from './routing.js';
import { eventTime } from './time.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { postReply } from './outbound.js';
const sharing: Sharing = {members:{jonathan:{owner:true,agents:['art','mark']},pollock:{owner:false,agents:['pond-bot']}},projects:{pond:{members:['pollock'],agents:['pond-bot']}},services:{}};
const owner = {kind:'member',id:'jonathan'} as const;
const roots: string[] = [], closes: (()=>Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
class FakeVenue implements VenueAdapter {
  platform: Venue['platform'];
  callbacks?: Parameters<VenueAdapter['connect']>[1]; connections=0; closed=0; posts: unknown[][]=[]; uncertain=false; inspection: Inspection='allow';
  constructor(platform: Venue['platform']) {this.platform=platform;}
  current(){return ()=>true;}
  async connect(_v: Venue,callbacks: Parameters<VenueAdapter['connect']>[1]) { await this.acquire(_v); this.connections++; this.callbacks=callbacks; return {close:()=>{this.closed++;}}; }
  acquire: (v: Venue) => Promise<void> = async()=>{};
  async inspect(v: Venue) { await this.acquire(v); return this.inspection; }
  async send(...args: Parameters<VenueAdapter['send']>) { this.posts.push(args); if (this.uncertain) throw new Error('token-value-do-not-store'); return {id:`post-${this.posts.length}`}; }
}
async function fixture(platform: Venue['platform']='discord', staging=false, existingHome?: string, now?: number) {
  const home=existingHome ?? mkdtempSync(join(tmpdir(),'bridges-')); if (!existingHome) roots.push(home);
  const clock=new FakeClock(now);
  const types = new Map<string,RecordType>();
  let effects!: ReturnType<typeof installEffects>;
  const app=await startLoom({home,clock,install(app) { const register=app.live.register.bind(app.live); app.live.register=type=>{types.set(type.name,type); register(type);}; installBridges(app,()=>sharing); effects=installEffects(app,()=>sharing,staging); }});
  const adapter=new FakeVenue(platform), deliveries=new Map<string,Incoming>(), stops: unknown[]=[];
  let gate: 'allow'|'drop'|'wait'='allow', failAfterDelivery=false, secretAllowed=true; const secretGets: string[]=[];
  const admitted: string[]=[];
  const runtime: BridgeRuntime={async admit(input){admitted.push(input.person);return gate;},async deliver(input){deliveries.set(input.id,input);if(failAfterDelivery)throw Error('body unavailable');return 'delivered';},async stop(i){stops.push(i);}};
  adapter.acquire=async v=>{if(!secretAllowed) throw Error('Credential unavailable'); secretGets.push(v.tokenSecret);};
  const engine=new Bridges(app,clock,runtime,[adapter],effects);
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
describe('send disposition',()=>{
  async function reply(staging=false) {
    const f=await fixture('discord',staging);
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    const incomingId=[...f.deliveries.keys()][0];
    f.engine.reply({id:'reply',incomingId,text:'the original reply'});
    return {...f,incomingId};
  }
  it('dismisses an uncertain attempt without changing its receipt or permitting replay, including after restart',async()=>{
    const f=await reply(); f.adapter.uncertain=true; await f.engine.flush();
    f.app.db.prepare('UPDATE bridges_outbox SET remote_id=?').run('partial-platform-receipt');
    const before=f.app.db.prepare('SELECT * FROM bridges_outbox').get() as {state:string};
    expect(before.state).toBe('uncertain'); expect(f.adapter.posts).toHaveLength(1);
    const changes: unknown[]=[];
    const stop=f.app.live.observe(batch=>{
      expect(f.app.db.inTransaction).toBe(false);
      expect(f.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'dismissed'});
      changes.push(...batch);
    });
    expect(f.op('dismissSend',{id:'reply',state:'uncertain'},'dismiss-once')).toEqual({ok:true,value:{id:'reply'}});
    stop(); expect(changes).toEqual([{type:'bridges.send',id:'reply'}]);
    expect(f.app.db.prepare('SELECT * FROM bridges_outbox').get()).toEqual({...before,state:'dismissed'});
    const type=f.types.get('bridges.send')!;
    expect(type.ids(undefined)).not.toContain('reply');
    expect(type.inScope(type.read('reply',owner)!,undefined,f.clock.now())).toBe(false);
    expect(f.op('dismissSend',{id:'reply',state:'uncertain'},'dismiss-once')).toEqual({ok:true,value:{id:'reply'}});
    expect(f.op('dismissSend',{id:'reply',state:'uncertain'})).toEqual({ok:true,value:{id:'reply'}});
    f.engine.reply({id:'reply',incomingId:f.incomingId,text:'the original reply'});
    expect(()=>f.engine.reply({id:'reply',incomingId:f.incomingId,text:'changed'})).toThrow('Reply id reused');
    await f.engine.flush(); expect(f.adapter.posts).toHaveLength(1);
    await f.close(); closes.pop();
    const restarted=await fixture('discord',false,f.home); await restarted.engine.sync();
    expect(restarted.app.db.prepare('SELECT * FROM bridges_outbox').get()).toEqual({...before,state:'dismissed'});
    expect(restarted.adapter.posts).toEqual([]);
  });
  it('never sends a dismissed row retained in a drain snapshot behind an in-flight send',async()=>{
    const f=await reply();
    f.engine.reply({id:'second-reply',incomingId:f.incomingId,text:'must never send'});
    const started=Promise.withResolvers<void>(), finish=Promise.withResolvers<void>();
    const send=f.adapter.send.bind(f.adapter);
    f.adapter.send=async(...args)=>{started.resolve();await finish.promise;return send(...args);};
    const draining=f.engine.flush();await started.promise;
    expect(f.op('removeVenues',{id:f.venue.id}).ok).toBe(true);
    expect(f.op('dismissSend',{id:'second-reply',state:'held'})).toEqual({ok:true,value:{id:'second-reply'}});
    expect(f.op('putVenues',f.venue).ok).toBe(true);
    finish.resolve();await draining;
    expect(f.adapter.posts).toHaveLength(1);
    expect(f.app.db.prepare('SELECT id,state FROM bridges_outbox ORDER BY id').all()).toEqual([
      {id:'reply',state:'sent'},{id:'second-reply',state:'dismissed'},
    ]);
    await f.engine.flush();expect(f.adapter.posts).toHaveLength(1);
  });
  it('dismisses a held reply while a stale released staging effect cannot send it',async()=>{
    const f=await reply(true); await f.engine.flush();
    expect(f.app.db.prepare('SELECT state FROM core_effects').get()).toEqual({state:'due'});
    expect(f.op('removeVenues',{id:f.venue.id}).ok).toBe(true);
    expect(f.op('dismissSend',{id:'reply',state:'held'})).toEqual({ok:true,value:{id:'reply'}});
    expect(f.op('putVenues',f.venue).ok).toBe(true);
    expect(f.app.operations.call('direct',owner,'core.releaseEffect',{id:'bridges:reply'},'release').ok).toBe(true);
    f.clock.advance(0); await f.engine.sync();
    expect(f.adapter.posts).toEqual([]);
    expect(f.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'dismissed'});
  });
  it.each(['pending','sending','sent','held','uncertain'])('rejects stale or active %s disposition without changing any row',async state=>{
    const f=await reply(true); await f.engine.flush();
    f.app.db.prepare('UPDATE bridges_outbox SET state=?').run(state);
    const before=f.app.db.prepare('SELECT * FROM bridges_outbox').all();
    const observed=state==='held'?'uncertain':'held';
    expect(f.op('dismissSend',{id:'reply',state:observed})).toMatchObject({ok:false,code:'conflict'});
    expect(f.app.db.prepare('SELECT * FROM bridges_outbox').all()).toEqual(before);
    expect(f.adapter.posts).toEqual([]);
  });
  it('requires household-owner policy on every door and rejects malformed or missing targets',async()=>{
    const f=await reply(true); await f.engine.flush();
    f.app.db.prepare("UPDATE bridges_outbox SET state='uncertain'").run();
    const before=f.app.db.prepare('SELECT * FROM bridges_outbox').all();
    for(const door of ['direct','http','socket','mcp'] as const) for(const viewer of [
      {kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'runner',id:'box'},{kind:'service',id:'bridges'},
    ] as const) {
      expect(f.app.operations.call(door,viewer,'bridges.dismissSend',{id:'reply',state:'uncertain'},crypto.randomUUID())).toMatchObject({ok:false,code:'denied'});
      expect(f.app.db.prepare('SELECT * FROM bridges_outbox').all()).toEqual(before);
    }
    for(const input of [{id:'reply'},{id:'reply',state:'pending'},{id:'reply',state:'uncertain',retry:true}])
      expect(f.op('dismissSend',input)).toMatchObject({ok:false,code:'invalid'});
    expect(f.op('dismissSend',{id:'missing',state:'held'})).toMatchObject({ok:false,code:'not-found'});
    expect(f.op('dismissSend',{id:'reply',state:'uncertain'})).toEqual({ok:true,value:{id:'reply'}});
  });
});

describe('transient intake expiry',()=>{
  const hour=3_600_000;
  it('upgrades foundation receipts with the original pending budget and preserves every other byte on repeat',async()=>{
    const home=mkdtempSync(join(tmpdir(),'bridges-upgrade-')); roots.push(home); const lease=openDb(home);
    try {
      migrate(lease.db,'bridges',foundationSchema);
      const states=['pending','held','dropped','delivered'];
      for(const state of states) lease.db.prepare('INSERT INTO bridges_inbox VALUES (?,?,?,?,?,?,?,?)').run(
        state,'art-discord','identity','original '+state,state,state==='held'?'runtime delivery held':null,10, state==='delivered'?20:null);
      const before=lease.db.prepare('SELECT * FROM bridges_inbox ORDER BY id').all() as {id:string;state:string;received:number}[];
      migrate(lease.db,'bridges',[...foundationSchema,...retrySchema]);
      const after=lease.db.prepare('SELECT * FROM bridges_inbox ORDER BY id').all();
      expect(after).toEqual(before.map(row=>({...row,retry_since:row.state==='pending'?row.received:null})));
      migrate(lease.db,'bridges',[...foundationSchema,...retrySchema]);
      expect(lease.db.prepare('SELECT * FROM bridges_inbox ORDER BY id').all()).toEqual(after);
    } finally {lease.close();}
  });
  it('expires a foundation pending receipt using its backfilled budget before credentials or admission',async()=>{
    const f=await fixture(); f.setGate('wait'); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    // Reconstruct the pre-upgrade shape with a real pending payload, then reopen normally.
    f.app.db.exec('ALTER TABLE bridges_inbox DROP COLUMN retry_since; DROP TABLE bridges_slack_receipts; DROP TABLE bridges_discord_receipts; DROP TABLE bridges_discord_sessions');
    f.app.db.prepare("DELETE FROM core_migrations WHERE piece='bridges' AND number>=2").run();
    const now=f.clock.now()+hour+1; await f.close(); closes.pop();
    const next=await fixture('discord',false,f.home,now); await next.engine.flush();
    expect(next.secretGets).toEqual([]); expect(next.admitted).toEqual([]); expect(next.deliveries.size).toBe(0);
    expect(next.app.db.prepare('SELECT state,reason,message FROM bridges_inbox').get()).toEqual({state:'dropped',reason:'transient intake expired',message:'{}'});
  });

  it.each(['discord','slack'] as const)('%s keeps the first wait budget through duplicates and restart, then erases without another attempt',async platform=>{
    const f=await fixture(platform); f.setGate('wait');
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    const original=f.app.db.prepare('SELECT * FROM bridges_inbox').get() as {id:string;received:number};
    f.clock.advance(hour/2); await f.engine.flush();
    await f.engine.receive(f.venue.id,f.message({text:'changed duplicate'})); await f.engine.flush();
    const now=f.clock.now(); await f.close(); closes.pop();
    const next=await fixture(platform,false,f.home,now); next.setGate('wait'); await next.engine.sync();
    next.clock.advance(hour/2); await next.engine.flush();
    expect(next.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'pending'});
    const attempts=next.admitted.length, reads=next.secretGets.length;
    next.setGate('allow'); next.clock.advance(1); await next.engine.flush();
    expect(next.deliveries.size).toBe(0); expect(next.admitted).toHaveLength(attempts); expect(next.secretGets).toHaveLength(reads);
    expect(next.app.db.prepare('SELECT id,state,reason,message,received FROM bridges_inbox').get()).toEqual({
      id:original.id,state:'dropped',reason:'transient intake expired',message:'{}',received:original.received,
    });
    expect(next.app.db.prepare('SELECT * FROM bridges_conversations').all()).toEqual([]);
    await next.engine.receive(next.venue.id,next.message()); await next.engine.flush(); expect(next.deliveries.size).toBe(0);
    const end=next.clock.now(); await next.close(); closes.pop();
    const again=await fixture(platform,false,f.home,end); await again.engine.sync(); expect(again.deliveries.size).toBe(0);
  });
  it.each(['credential','inspection','admission','runtime','exception','setup'] as const)('bounds %s transient failures and publishes expiry',async failure=>{
    const f=await fixture();
    if(failure==='credential') f.denySecret();
    if(failure==='inspection') f.adapter.inspection='wait';
    if(failure==='admission') f.setGate('wait');
    if(failure==='runtime') f.runtime.deliver=async()=> 'retry';
    if(failure==='exception') f.runtime.deliver=async()=>{throw Error('upstream token-value-do-not-store');};
    if(failure==='setup') f.runtime.admit=async()=>{f.op('putVenues',f.venue);return 'allow';};
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    const changes: unknown[]=[]; const stop=f.app.live.observe(batch=>changes.push(...batch));
    f.clock.advance(hour+1); await f.engine.flush(); stop();
    expect(f.app.db.prepare('SELECT state,reason,message FROM bridges_inbox').get()).toEqual({state:'dropped',reason:'transient intake expired',message:'{}'});
    expect(changes).toContainEqual({type:'bridges.venue',id:f.venue.id});
    expect(f.app.db.prepare('SELECT * FROM bridges_conversations').all()).toEqual([]);
  });
  it('starts the hour at the first transient result, not event or receipt time',async()=>{
    const f=await fixture(); const entered=Promise.withResolvers<void>(), finish=Promise.withResolvers<DeliveryOutcome>();
    f.runtime.deliver=async()=>{entered.resolve();return finish.promise;};
    await f.engine.receive(f.venue.id,f.message({at:'2000-01-01T00:00:00Z'})); await entered.promise;
    f.clock.advance(2*hour); finish.resolve('retry'); await f.engine.flush();
    f.clock.advance(hour); await f.engine.flush();
    expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'pending'});
    f.clock.advance(1); await f.engine.flush();
    expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'dropped'});
  });
  it('does not expire a successful attempt that began within its budget',async()=>{
    const f=await fixture(); f.setGate('wait'); await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    const entered=Promise.withResolvers<void>(), finish=Promise.withResolvers<DeliveryOutcome>();
    f.setGate('allow'); f.runtime.deliver=async()=>{entered.resolve();return finish.promise;};
    f.clock.advance(hour); const draining=f.engine.flush(); await entered.promise;
    f.clock.advance(1); finish.resolve('delivered'); await draining;
    expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'delivered'});
  });
  it('exempts a held result, then starts a fresh transient budget after restart recovery',async()=>{
    const f=await fixture(); f.runtime.deliver=async()=> 'retry';
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.runtime.deliver=async()=> 'held'; f.clock.advance(hour/2); await f.engine.flush();
    const before=f.app.db.prepare('SELECT * FROM bridges_inbox').get();
    f.clock.advance(2*hour); await f.engine.flush(); expect(f.app.db.prepare('SELECT * FROM bridges_inbox').get()).toEqual(before);
    const now=f.clock.now(); await f.close(); closes.pop();
    const next=await fixture('discord',false,f.home,now); next.setGate('wait'); await next.engine.sync();
    next.clock.advance(hour); await next.engine.flush();
    expect(next.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'pending'});
    next.clock.advance(1); await next.engine.flush();
    expect(next.app.db.prepare('SELECT state,reason FROM bridges_inbox').get()).toEqual({state:'dropped',reason:'transient intake expired'});
  });
});

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
    expect(f.adapter.posts[0][1]).toMatchObject({group:true,dm:false});
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
  it('keeps transient outgoing replies eligible beyond the intake hour and sends exactly once after recovery',async()=>{
    const f=await groupFixture(); await f.engine.receive(f.venue.id,f.groupMessage); await f.engine.flush();
    const incomingId=[...f.deliveries.keys()][0];
    f.engine.reply({id:'late-reply',incomingId,text:'reply after a long outage'});
    f.adapter.inspection='wait'; await f.engine.flush();
    f.clock.advance(3_600_001); await f.engine.flush();
    expect(f.app.db.prepare('SELECT state,text FROM bridges_outbox').get()).toEqual({state:'pending',text:'reply after a long outage'});
    expect(f.adapter.posts).toEqual([]);
    f.adapter.inspection={kind:'allow',members:['100','200','201']}; await f.engine.flush();
    expect(f.adapter.posts).toHaveLength(1); expect(f.adapter.posts[0][2]).toBe('reply after a long outage');
    expect(f.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'sent'});
    await f.engine.flush(); expect(f.adapter.posts).toHaveLength(1);
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
  it.each(['discord','slack'] as const)('%s retries runtime-held intake only after restart with its original receipt',async platform=>{
    const f=await fixture(platform); const deliver=vi.fn(async()=> 'held' as const); f.runtime.deliver=deliver;
    const message=f.message();
    await f.engine.receive(f.venue.id,message); await f.engine.flush();
    const before=f.app.db.prepare('SELECT * FROM bridges_inbox').get() as {id:string;message:string;received:number};
    f.clock.advance(3_600_001); await f.engine.sync(); await f.engine.receive(f.venue.id,{...message,text:'changed duplicate'}); await f.engine.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(f.app.db.prepare('SELECT * FROM bridges_inbox').get()).toEqual(before);
    await f.close(); closes.pop();
    const restarted=await fixture(platform,false,f.home); await restarted.engine.sync();
    expect([...restarted.deliveries.values()]).toEqual([expect.objectContaining({id:before.id,text:message.text,at:'2026-11-12T17:00:00.123Z',label:message.label})]);
    expect(restarted.app.db.prepare('SELECT state,reason,message,received FROM bridges_inbox').get()).toEqual({state:'delivered',reason:null,message:before.message,received:before.received});
    await restarted.close(); closes.pop();
    const again=await fixture(platform,false,f.home); await again.engine.sync();
    expect(again.deliveries.size).toBe(0);
  });
  it('rechecks current admission before repairing held intake and erases a newly denied message',async()=>{
    const f=await fixture(); f.runtime.deliver=async()=> 'held';
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    await f.close(); closes.pop();
    const restarted=await fixture('discord',false,f.home); restarted.setGate('drop'); await restarted.engine.sync();
    expect(restarted.deliveries.size).toBe(0);
    expect(restarted.app.db.prepare('SELECT state,reason,message FROM bridges_inbox').get()).toEqual({state:'dropped',reason:'not admitted',message:'{}'});
  });
  it.each(['held',undefined,'unexpected'])('holds a still-broken runtime outcome %s once again for the new process',async outcome=>{
    const f=await fixture(); f.runtime.deliver=async()=> 'held';
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    await f.close(); closes.pop();
    const restarted=await fixture('discord',false,f.home); const deliver=vi.fn(async()=> outcome as unknown as DeliveryOutcome); restarted.runtime.deliver=deliver;
    await restarted.engine.sync(); restarted.clock.advance(10_000); await restarted.engine.sync();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(restarted.app.db.prepare('SELECT state,reason FROM bridges_inbox').get()).toEqual({state:'held',reason:'runtime delivery held'});
  });
  it('waits for current credential grants before draining recovered intake',async()=>{
    const f=await fixture(); f.runtime.deliver=async()=> 'held';
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    await f.close(); closes.pop();
    const restarted=await fixture('discord',false,f.home); restarted.denySecret(); await restarted.engine.sync();
    expect(restarted.secretGets).toEqual([]); expect(restarted.admitted).toEqual([]); expect(restarted.deliveries.size).toBe(0);
    expect(restarted.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'pending'});
  });
  it('uses changed person links and routes when draining recovered intake',async()=>{
    const f=await fixture(); f.runtime.deliver=async()=> 'held';
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    await f.close(); closes.pop();
    const restarted=await fixture('discord',false,f.home);
    expect(restarted.op('putLinks',{id:'person',platform:'discord',workspace:'house',user:'200',person:'mark'}).ok).toBe(true);
    expect(restarted.op('putRoutes',{id:'channel',platform:'discord',workspace:'house',channel:'300',primary:'art',readers:['mark']}).ok).toBe(true);
    await restarted.engine.sync();
    expect(restarted.admitted).toEqual(['mark']);
    expect([...restarted.deliveries.values()]).toEqual([expect.objectContaining({person:'mark',route:expect.objectContaining({readers:['mark']})})]);
  });
  it.each(['venue removed','venue identity changed','invalid event time'])('leaves %s intake holds untouched on restart',async reason=>{
    const f=await fixture(); f.runtime.deliver=async()=> 'held';
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    f.app.db.prepare('UPDATE bridges_inbox SET reason=?').run(reason);
    const before=f.app.db.prepare('SELECT * FROM bridges_inbox').get();
    f.clock.advance(3_600_001); await f.engine.flush();
    expect(f.app.db.prepare('SELECT * FROM bridges_inbox').get()).toEqual(before);
    const now=f.clock.now(); await f.close(); closes.pop();
    const restarted=await fixture('discord',false,f.home,now); await restarted.engine.sync();
    restarted.clock.advance(3_600_001); await restarted.engine.flush();
    expect(restarted.deliveries.size).toBe(0);
    expect(restarted.app.db.prepare('SELECT * FROM bridges_inbox').get()).toEqual(before);
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
    expect(f.adapter.posts).toHaveLength(1); expect(f.adapter.posts[0][3]).toBe('reply');
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
  it.each(['discord','slack'] as const)('%s releases one whole split reply attempt in staging and keeps its thread address',async platform=>{
    const f=await fixture(platform,true);
    const address=platform==='slack'?{channel:'D300',thread:'1794503533.000001',dm:true}:{channel:'400',parent:'300',thread:'400'};
    await f.engine.receive(f.venue.id,f.message(address)); await f.engine.flush();
    const posts: {text:string;channel:string;thread?:string}[]=[];
    f.adapter.send=async(v,address,text)=>postReply(v.platform,text,async part=>{
      posts.push({text:part,channel:address.channel,thread:address.thread}); return {id:`part-${posts.length}`};
    });
    const text='line\n'.repeat(1800), incomingId=[...f.deliveries.keys()][0];
    f.engine.reply({id:'split',incomingId,text}); await f.engine.flush();
    expect(posts).toEqual([]);
    expect(f.app.operations.call('direct',owner,'core.releaseEffect',{id:'bridges:split'},'release-split').ok).toBe(true);
    await f.engine.flush();
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.map(p=>p.text).join('')).toBe(text);
    expect(posts.every(p=>p.channel===address.channel&&p.thread===address.thread)).toBe(true);
    expect(f.app.db.prepare('SELECT state,remote_id FROM bridges_outbox').get()).toEqual({state:'sent',remote_id:`part-${posts.length}`});
    f.engine.reply({id:'split',incomingId,text}); await f.engine.flush();
    expect(posts.map(p=>p.text).join('')).toBe(text);
  });
  it.each(['discord','slack'] as const)('%s never replays any of a partially posted reply, even after restart',async platform=>{
    const f=await fixture(platform);
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    const posts:string[]=[];
    f.adapter.send=async(v,_address,text)=>postReply(v.platform,text,async part=>{
      posts.push(part); if(posts.length===2)throw new Error('token-value-do-not-store'); return {id:'first-part'};
    });
    f.engine.reply({id:'partial',incomingId:[...f.deliveries.keys()][0],text:'x'.repeat(9000)}); await f.engine.flush();
    expect(posts).toHaveLength(2);
    expect(f.app.db.prepare('SELECT state,remote_id FROM bridges_outbox').get()).toEqual({state:'uncertain',remote_id:null});
    f.clock.advance(120000); await f.engine.flush(); expect(posts).toHaveLength(2);
    await f.close(); closes.splice(closes.indexOf(f.close),1);
    const next=await fixture(platform,false,f.home); await next.engine.sync();
    expect(next.adapter.posts).toEqual([]);
    expect(next.app.db.prepare('SELECT state FROM bridges_outbox').get()).toEqual({state:'uncertain'});
    expect(JSON.stringify(next.app.db.prepare('SELECT * FROM core_effects').all())).not.toContain('token-value-do-not-store');
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
  it('holds pending intake on connection removal durably without later delivery',async()=>{
    const f=await fixture(); f.setGate('wait');
    await f.engine.receive(f.venue.id,f.message()); await f.engine.flush();
    expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'pending'});
    expect(f.op('removeVenues',{id:f.venue.id}).ok).toBe(true);
    expect(f.app.db.prepare('SELECT state,reason FROM bridges_inbox').get()).toEqual({state:'held',reason:'venue removed'});
    f.setGate('allow'); f.clock.advance(60_000); await f.engine.flush(); expect(f.deliveries.size).toBe(0);
    await f.close(); closes.pop();
    const restarted=await fixture('discord',false,f.home); await restarted.engine.flush();
    expect(restarted.app.db.prepare('SELECT state,reason FROM bridges_inbox').get()).toEqual({state:'held',reason:'venue removed'});
    expect(restarted.deliveries.size).toBe(0);
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
  it('refuses non-owner route edits and removal without changing saved routes',async()=>{
    const f=await fixture();
    const before=f.app.db.prepare('SELECT id,record FROM bridges_routes ORDER BY id').all();
    const changed=routeSchema.parse({id:'channel',platform:'discord',workspace:'house',channel:'300',primary:'mark'});
    for (const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'},{kind:'runner',id:'box'}] as const) {
      for (const [name,input] of [['putRoutes',changed],['removeRoutes',{id:'channel'}]] as const) {
        expect(f.app.operations.call('direct',viewer,`bridges.${name}`,input,crypto.randomUUID())).toMatchObject({ok:false,code:'denied'});
        expect(f.app.db.prepare('SELECT id,record FROM bridges_routes ORDER BY id').all()).toEqual(before);
      }
    }
    expect(f.op('putRoutes',changed).ok).toBe(true);
    expect(f.app.db.prepare('SELECT id,record FROM bridges_routes ORDER BY id').all()).not.toEqual(before);
    expect(f.op('removeRoutes',{id:'channel'}).ok).toBe(true);
    expect(f.app.db.prepare('SELECT id FROM bridges_routes').all()).toEqual([]);
  });
  it('refuses non-owner connection writes and removal with exact saved content unchanged',async()=>{
    const f=await fixture();
    const before=f.app.db.prepare('SELECT id,record FROM bridges_venues ORDER BY id').all();
    const changed={...f.venue,bot:'replacement',enabled:false};
    for(const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'},{kind:'runner',id:'box'}] as const){
      for(const [name,input] of [['putVenues',changed],['removeVenues',{id:f.venue.id}]] as const){
        expect(f.app.operations.call('direct',viewer,`bridges.${name}`,input,crypto.randomUUID())).toMatchObject({ok:false,code:'denied'});
        expect(f.app.db.prepare('SELECT id,record FROM bridges_venues ORDER BY id').all()).toEqual(before);
      }
    }
    expect(f.op('putVenues',changed).ok).toBe(true);
    expect(f.app.db.prepare('SELECT id,record FROM bridges_venues ORDER BY id').all()).not.toEqual(before);
    expect(f.op('removeVenues',{id:f.venue.id}).ok).toBe(true);
    expect(f.app.db.prepare('SELECT id FROM bridges_venues').all()).toEqual([]);
  });
  it('refuses non-owner person-link edits and removal without changing saved identities',async()=>{
    const f=await fixture();
    const before=f.app.db.prepare('SELECT id,record FROM bridges_links ORDER BY id').all();
    const changed={id:'person',platform:'discord',workspace:'house',user:'200',person:'mark'};
    const household=new HouseholdDatabase(f.app.db);
    f.app.db.transaction(()=>household.replace(f.home,{v:1,agents:['art','mark'],default:'art',members:[
      {person:'jonathan',role:'owner',agents:'*'},{person:'mark',role:'member',agents:['mark']},
    ]}))();
    const accessBefore=household.document(), sharingBefore=structuredClone(sharing);
    const unchangedAccess=()=>{ expect(household.document()).toEqual(accessBefore); expect(sharing).toEqual(sharingBefore); };
    for(const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'},{kind:'runner',id:'box'}] as const){
      for(const [name,input] of [['putLinks',changed],['removeLinks',{id:'person'}]] as const){
        expect(f.app.operations.call('direct',viewer,`bridges.${name}`,input,crypto.randomUUID())).toMatchObject({ok:false,code:'denied'});
        expect(f.app.db.prepare('SELECT id,record FROM bridges_links ORDER BY id').all()).toEqual(before);
      }
    }
    const added={...changed,id:'added',user:'201'};
    expect(f.op('putLinks',added).ok).toBe(true); unchangedAccess();
    expect(f.op('removeLinks',{id:'added'}).ok).toBe(true); unchangedAccess();
    expect(f.op('putLinks',changed).ok).toBe(true); unchangedAccess();
    expect(f.app.db.prepare('SELECT id,record FROM bridges_links ORDER BY id').all()).toEqual([{id:'person',record:JSON.stringify(changed)}]);
    expect(f.op('removeLinks',{id:'person'}).ok).toBe(true); unchangedAccess();
    expect(f.app.db.prepare('SELECT id FROM bridges_links').all()).toEqual([]);
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

it('does not deliver an inspection lifetime invalidated during runtime admission',async()=>{
  const f=await fixture(),started=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let generation=0;
  f.adapter.current=()=>{const captured=generation;return ()=>captured===generation;};
  let calls=0;f.runtime.admit=async()=>{if(calls++)return 'wait';started.resolve();await finish.promise;return 'allow';};
  await f.engine.receive(f.venue.id,f.message());await started.promise;generation++;finish.resolve();await f.engine.flush();
  expect(f.deliveries.size).toBe(0);expect(f.app.db.prepare('SELECT state FROM bridges_inbox').get()).toEqual({state:'pending'});
  f.runtime.admit=async()=> 'allow';f.clock.advance(5000);await f.engine.flush();expect(f.deliveries.size).toBe(1);
});
