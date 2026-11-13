import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing } from '../../core/index.js';
import { installEffects } from '../../core/effects.js';
import { installBridges } from './index.js';
import { Bridges } from './engine.js';
import type { BridgeRuntime, BridgeSecrets, VenueAdapter, Incoming } from './role.js';
import { venueSchema, type Message, type Venue } from './model.js';
import { addressed } from './routing.js';
const sharing: Sharing = {members:{jonathan:{owner:true,agents:['art','mark']},pollock:{owner:false,agents:['pond-bot']}},projects:{pond:{members:['pollock'],agents:['pond-bot']}},services:{}};
const owner = {kind:'member',id:'jonathan'} as const;
const roots: string[] = [], closes: (()=>Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
class FakeVenue implements VenueAdapter {
  platform: Venue['platform'];
  callbacks?: Parameters<VenueAdapter['connect']>[2]; connections=0; closed=0; posts: unknown[][]=[]; uncertain=false; inspection: 'allow'|'drop'|'wait'='allow';
  constructor(platform: Venue['platform']) {this.platform=platform;}
  async connect(_v: Venue,_c: unknown,callbacks: Parameters<VenueAdapter['connect']>[2]) { this.connections++; this.callbacks=callbacks; return {close:()=>{this.closed++;}}; }
  async inspect() { return this.inspection; }
  async send(...args: Parameters<VenueAdapter['send']>) { this.posts.push(args); if (this.uncertain) throw new Error('token-value-do-not-store'); return {id:`post-${this.posts.length}`}; }
}
async function fixture(platform: Venue['platform']='discord', staging=false, existingHome?: string) {
  const home=existingHome ?? mkdtempSync(join(tmpdir(),'bridges-')); if (!existingHome) roots.push(home);
  const clock=new FakeClock();
  let effects!: ReturnType<typeof installEffects>;
  const app=await startLoom({home,clock,install(app) { installBridges(app,()=>sharing); effects=installEffects(app,()=>sharing,staging); }});
  const adapter=new FakeVenue(platform), deliveries=new Map<string,Incoming>(), stops: unknown[]=[];
  let gate: 'allow'|'drop'|'wait'='allow', failAfterDelivery=false, secretAllowed=true; const secretGets: string[]=[];
  const runtime: BridgeRuntime={async admit(){return gate;},async deliver(input){deliveries.set(input.id,input);if(failAfterDelivery)throw Error('body unavailable');},async stop(i){stops.push(i);}};
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
  const message=(overrides: Partial<Message>={}): Message=>({id:'m1',channel:'300',user:'200',text:'hi',mentions:[],dm:false,...overrides});
  return {secretGets, denySecret:()=>{secretAllowed=false;}, home,app,clock,engine,adapter,deliveries,stops,op,venue,message,close,setGate:(g:typeof gate)=>{gate=g;},failDelivery:()=>{failAfterDelivery=true;}};
}
describe('in-process bridge delivery',()=>{
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
    expect(addressed(f.venue,f.message({mentions:['101']}),{primary:'art'} as any,[f.venue,mark])).toBe(false);
    expect(addressed(mark,f.message({mentions:['101']}),{primary:'art'} as any,[f.venue,mark])).toBe(true);
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
  it('protects links and connection setup through the central household policy',async()=>{
    const f=await fixture();
    for (const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'},{kind:'runner',id:'box'}] as const) {
      expect(f.app.operations.call('direct',viewer,'bridges.putVenues',f.venue,'change').ok).toBe(false);
      expect(f.app.operations.call('direct',viewer,'bridges.putLinks',{id:'link',platform:'discord',workspace:'house',user:'x',person:'jonathan'},'link').ok).toBe(false);
    }
  });
});
