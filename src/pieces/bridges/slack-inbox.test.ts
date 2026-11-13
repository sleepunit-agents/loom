import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, migrate, openDb, type RecordType } from '../../core/index.js';
import { installBridges } from './index.js';
import { venueSchema } from './model.js';
import { put } from './store.js';
import { Bridges } from './engine.js';
import type { Incoming } from './role.js';
import { installEffects } from '../../core/effects.js';
import { slackInbox } from './slack-inbox.js';
import { slackSocket, type SlackSocketOptions } from './slack-socket.js';
import { schema as initial } from './schema/001.js';
import { schema as retry } from './schema/002.js';
import { schema as receipts } from './schema/003.js';
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const venue = venueSchema.parse({ id:'art-slack', platform:'slack', agent:'art', workspace:'T123', bot:'U123', tokenSecret:'bot', appSecret:'app' });
const payload = (eventId='Ev123') => ({ type:'event_callback', team_id:'T123', api_app_id:'A123', event_id:eventId,
  token:'OUTER-VERIFICATION-TOKEN', authorizations:[{user_id:'U123'}], event:{type:'message',channel:'D123',user:'U200',ts:'1793828004.242749',text:'private words'} });
async function fixture(existing?: string) {
  const home=existing ?? mkdtempSync(join(tmpdir(),'slack-inbox-')); if (!existing) homes.push(home);
  const clock=new FakeClock(1000);
  const types: RecordType[]=[];
  const app=await startLoom({home,clock,install(app) {
    const register=app.live.register.bind(app.live);app.live.register=type=>{types.push(type);register(type);};
    installBridges(app,()=>({members:{jonathan:{owner:true,agents:['art','mark']}},projects:{},services:{}}));
  }});
  let closed=false;
  const close=async()=>{if(!closed){closed=true;await app.close();}}; closes.push(close);
  if (!existing) {
    put(app.db,'venues',venue);
    put(app.db,'links',{id:'jonathan',platform:'slack',workspace:'T123',user:'U200',person:'jonathan'});
  }
  const inbox=slackInbox(app.db,clock,{venue,app:'A123'});
  return {home,clock,app,inbox,close,types};
}
class Socket extends EventEmitter {
  readyState=1;
  send=vi.fn((_text:string,callback:(error?:Error)=>void)=>callback());
  terminate=vi.fn(()=>{this.readyState=3;});
  ping=vi.fn();
  frame(value:unknown) {this.emit('message',Buffer.from(JSON.stringify(value)),false);}
}
async function settle() {for(let n=0;n<40;n++) await Promise.resolve();}
function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const socket=new Socket();
  const transport=slackSocket({appSecret:'app',clock:f.clock,beforeConnect:()=>true,
    secrets:{withValue:async<T>(_name:string,use:(value:string)=>Promise<T>)=>use('APP-SECRET')},
    request:vi.fn(async()=>Response.json({ok:true,url:'wss://wss.slack.com/link?ticket=SECRET'})) as typeof fetch,
    socket:()=>socket as unknown as ReturnType<NonNullable<SlackSocketOptions['socket']>>,receive:f.inbox.receive});
  closes.unshift(async()=>transport.close());
  return {socket,transport};
}
describe('private Slack durable raw inbox',()=>{
  it('installs migration on a prior database, preserves old rows and is repeatable',()=>{
    const home=mkdtempSync(join(tmpdir(),'slack-upgrade-'));homes.push(home);
    const lease=openDb(home);try {
      migrate(lease.db,'bridges',[...initial,...retry]);
      put(lease.db,'venues',venue);
      const before=lease.db.prepare('SELECT * FROM bridges_venues').all();
      migrate(lease.db,'bridges',[...initial,...retry,...receipts]);
      migrate(lease.db,'bridges',[...initial,...retry,...receipts]);
      expect(lease.db.prepare('SELECT * FROM bridges_venues').all()).toEqual(before);
      expect(lease.db.prepare('SELECT * FROM bridges_slack_receipts').all()).toEqual([]);
    } finally {lease.close();}
  });
  it('commits actual Socket Mode receipt before ACK; restart keeps words and dedups event id across envelopes',async()=>{
    const f=await fixture();const {socket,transport}=connect(f);await settle();socket.frame({type:'hello'});
    socket.send.mockImplementation((_text,callback)=>{
      expect(f.app.db.inTransaction).toBe(false);
      expect(f.inbox.pending()).toHaveLength(1);
      callback();
    });
    socket.frame({type:'events_api',envelope_id:'first',payload:payload()});await settle();
    expect(socket.send).toHaveBeenCalledExactlyOnceWith('{"envelope_id":"first"}',expect.any(Function));
    transport.close();await f.close();
    const g=await fixture(f.home);const before=g.inbox.pending();
    expect(before[0]).toMatchObject({eventId:'Ev123',received:1000,event:payload().event});
    g.clock.advance(5000);await g.inbox.receive({...payload(),event:{...payload().event,text:'changed duplicate'}});
    expect(g.inbox.pending()).toEqual(before);
    await g.inbox.receive(payload('EvDifferentSameTimestamp'));
    expect(g.inbox.pending()).toHaveLength(2);
    expect(JSON.stringify(g.app.db.prepare('SELECT * FROM bridges_slack_receipts').all())).not.toContain('OUTER-VERIFICATION-TOKEN');
    expect(g.app.operations.call('direct',{kind:'service',id:'bridges'},'bridges.slackReceipts',{},'private')).toMatchObject({ok:false});
  });
  it('keeps raw words and outer token out of actual operations, registered projections and live changes',async()=>{
    const f=await fixture();const changes:unknown[]=[];const stop=f.app.live.observe(batch=>changes.push(...batch));
    await f.inbox.receive(payload());const [raw]=f.inbox.pending();
    const owner={kind:'member',id:'jonathan'} as const;
    const result=f.app.operations.call('direct',owner,'bridges.putRoutes',{id:'route',platform:'slack',workspace:'T123',channel:'D123'},'create-route');
    expect(result).toEqual({ok:true,value:{id:'route'}});
    const records=f.types.flatMap(type=>type.ids(undefined).map(id=>type.read(id,owner)).concat([type.read(raw.id,owner)]));
    expect(records).toContainEqual(expect.objectContaining({id:venue.id,bot:venue.bot}));
    expect(records).toContainEqual(expect.objectContaining({id:'route',channel:'D123'}));
    expect(changes).toContainEqual({type:'bridges.route',id:'route'});
    const output=JSON.stringify({result,records,changes,operations:f.app.operations.offered('direct').map(op=>op.name),retryResults:f.app.db.prepare('SELECT result FROM core_operations').all()});
    expect(output).not.toContain('private words');expect(output).not.toContain('OUTER-VERIFICATION-TOKEN');expect(output).not.toContain(raw.id);
    stop();
  });
  it('a failed durable insert never ACKs and leaves no partial receipt',async()=>{
    const f=await fixture();f.app.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON bridges_slack_receipts BEGIN SELECT RAISE(ABORT,'private failure'); END;");
    const {socket}=connect(f);await settle();socket.frame({type:'hello'});socket.frame({type:'events_api',envelope_id:'first',payload:payload()});await settle();
    expect(socket.send).not.toHaveBeenCalled();expect(socket.terminate).toHaveBeenCalledOnce();expect(f.inbox.pending()).toEqual([]);
  });
  it('refuses an enclosing transaction so a later rollback cannot follow an ACK',async()=>{
    const f=await fixture();let receipt!:Promise<void>;
    f.app.db.transaction(()=>{receipt=f.inbox.receive(payload());})();
    await expect(receipt).rejects.toThrow('own transaction');expect(f.inbox.pending()).toEqual([]);
  });
  it.each([
    {team_id:'TOTHER'}, {api_app_id:'AOTHER'}, {type:'url_verification'}, {event_id:''}, {event_id:42},
    {event:null}, {event:[]}, {event:{type:''}}, {event:{type:7}},
  ])('rejects malformed or cross-binding receipt %j',async patch=>{
    const f=await fixture();await expect(f.inbox.receive({...payload(),...patch})).rejects.toThrow('Invalid Slack receipt');expect(f.inbox.pending()).toEqual([]);
  });
  it('rejects an oversized otherwise-valid event without storing words',async()=>{
    const f=await fixture();await expect(f.inbox.receive({...payload(),event:{...payload().event,text:'x'.repeat(1024*1024)}})).rejects.toThrow('too large');expect(f.inbox.pending()).toEqual([]);
  });
  it('consumes only its own receipts, erases words and retains dedup tombstones through restart',async()=>{
    const f=await fixture();await f.inbox.receive(payload());const [row]=f.inbox.pending();
    expect(()=>f.inbox.consume('unknown')).toThrow('Unknown');f.inbox.consume(row.id);f.inbox.consume(row.id);
    expect(f.inbox.pending()).toEqual([]);expect(f.app.db.prepare('SELECT event,state FROM bridges_slack_receipts').get()).toEqual({event:null,state:'consumed'});
    await f.close();const g=await fixture(f.home);await g.inbox.receive(payload());expect(g.inbox.pending()).toEqual([]);
  });
  it('isolates bots, apps and connection ids, even with identical platform event ids',async()=>{
    const f=await fixture();
    const otherVenue={...venue,id:'mark-slack',agent:'mark',bot:'U456'};put(f.app.db,'venues',otherVenue);
    const secondVenue={...venue,id:'second-art'};put(f.app.db,'venues',secondVenue);
    const first=slackInbox(f.app.db,f.clock,{venue,app:'A123'});
    const other=slackInbox(f.app.db,f.clock,{venue:otherVenue,app:'A456'});
    const second=slackInbox(f.app.db,f.clock,{venue:secondVenue,app:'A123'});
    await first.receive(payload());await other.receive({...payload(),api_app_id:'A456'});await second.receive(payload());
    const [row]=other.pending();expect(()=>first.consume(row.id)).toThrow('Unknown');expect(first.pending()).toHaveLength(1);expect(other.pending()).toHaveLength(1);expect(second.pending()).toHaveLength(1);
    expect(f.app.db.prepare('SELECT count(*) AS n FROM bridges_slack_receipts').get()).toEqual({n:3});
  });
  it('isolates receipts and consumption when only the authenticated app binding differs',async()=>{
    const f=await fixture();await f.inbox.receive(payload());const [first]=f.inbox.pending();
    const other=slackInbox(f.app.db,f.clock,{venue,app:'A456'});expect(other.pending()).toEqual([]);
    expect(()=>other.consume(first.id)).toThrow('Unknown');await other.receive({...payload(),api_app_id:'A456'});
    const [second]=other.pending();expect(second.id).not.toBe(first.id);expect(()=>f.inbox.consume(second.id)).toThrow('Unknown');
    expect(f.inbox.pending()).toEqual([first]);other.consume(second.id);expect(other.pending()).toEqual([]);expect(f.inbox.pending()).toEqual([first]);
  });
  it('a replacement identity under the same venue id cannot read or consume prior pending words',async()=>{
    const f=await fixture();await f.inbox.receive(payload());const [old]=f.inbox.pending();
    const replacement={...venue,bot:'U456',agent:'mark'};put(f.app.db,'venues',replacement);
    const fresh=slackInbox(f.app.db,f.clock,{venue:replacement,app:'A456'});
    expect(fresh.pending()).toEqual([]);expect(()=>fresh.consume(old.id)).toThrow('Unknown');
    await fresh.receive({...payload(),api_app_id:'A456'});expect(fresh.pending()).toHaveLength(1);expect(fresh.pending()[0].id).not.toBe(old.id);
    expect(f.app.db.prepare('SELECT state,event FROM bridges_slack_receipts WHERE id=?').get(old.id)).toEqual({state:'pending',event:JSON.stringify(payload().event)});
  });
  it.each(['restore','remove-recreate','unrelated-setup'])('rejects obsolete receiver after %s and lets a fresh receiver recover pending work',async change=>{
    const f=await fixture();await f.inbox.receive(payload());const [row]=f.inbox.pending();
    if(change==='restore') {put(f.app.db,'venues',{...venue,enabled:false});put(f.app.db,'venues',venue);}
    else if(change==='remove-recreate') {f.app.db.prepare('DELETE FROM bridges_venues').run();put(f.app.db,'venues',venue);}
    else put(f.app.db,'links',{id:'another',platform:'slack',workspace:'T123',user:'U201',person:'other'});
    await expect(f.inbox.receive(payload('EvNew'))).rejects.toThrow('binding changed');
    expect(()=>f.inbox.pending()).toThrow('binding changed');expect(()=>f.inbox.consume(row.id)).toThrow('binding changed');
    const fresh=slackInbox(f.app.db,f.clock,{venue,app:'A123'});expect(fresh.pending()).toEqual([row]);await fresh.receive(payload());expect(fresh.pending()).toEqual([row]);
  });
  it('replays a crash after normalized commit before consumption without a second engine delivery',async()=>{
    const delivered: Incoming[]=[];
    function engine(f:Awaited<ReturnType<typeof fixture>>) {
      const runtime={admit:async()=> 'allow' as const,deliver:async(input:Incoming)=>{delivered.push(input);return 'delivered' as const;},stop:async()=>{}};
      const secrets={may:async()=>true,get:async()=> 'fixture-only'};
      const adapter={platform:'slack' as const,connect:async()=>({close(){}}),inspect:async()=> 'allow' as const,send:async()=>({id:'post'})};
      const effects=installEffects(f.app,()=>({members:{},projects:{},services:{}}),false);
      const bridges=new Bridges(f.app,f.clock,runtime,[adapter],effects);closes.unshift(()=>bridges.close());return bridges;
    }
    const message={id:payload().event.ts,channel:'D123',user:'U200',text:'private words',dm:true,mentions:[]};
    const f=await fixture();const first=engine(f);await f.inbox.receive(payload());const [raw]=f.inbox.pending();
    await first.receive(venue.id,message);await first.flush();expect(delivered).toHaveLength(1);const stable=delivered[0].id;
    // Simulated crash point: normalized receipt committed; raw consumption absent.
    await first.close();await f.close();
    const g=await fixture(f.home);const next=engine(g);expect(g.inbox.pending()).toEqual([raw]);
    await next.receive(venue.id,message);await next.flush();expect(delivered.map(value=>value.id)).toEqual([stable]);
    expect(g.app.db.prepare('SELECT count(*) AS n FROM bridges_inbox').get()).toEqual({n:1});
    g.inbox.consume(raw.id);expect(g.inbox.pending()).toEqual([]);
  });
  it.each([{enabled:false},{workspace:'TOTHER'},{bot:'UOTHER'},{agent:'mark'},{tokenSecret:'replacement'},{appSecret:'replacement'}])('rejects stale binding after setup edit %j',async patch=>{
    const f=await fixture();await f.inbox.receive(payload());const [row]=f.inbox.pending();put(f.app.db,'venues',{...venue,...patch});
    await expect(f.inbox.receive(payload('EvNew'))).rejects.toThrow('binding changed');expect(()=>f.inbox.pending()).toThrow('binding changed');expect(()=>f.inbox.consume(row.id)).toThrow('binding changed');
    expect(f.app.db.prepare('SELECT state FROM bridges_slack_receipts').get()).toEqual({state:'pending'});
  });
  it('pages in stable received/id order past retained and consumed receipts',async()=>{
    const f=await fixture();await f.inbox.receive(payload('EvA'));await f.inbox.receive(payload('EvB'));
    f.clock.advance(1);await f.inbox.receive(payload('EvC'));
    const rows=f.inbox.pending();const cursor={received:rows[0].received,id:rows[0].id};
    expect(f.inbox.pending(1,cursor)).toEqual([rows[1]]);f.inbox.consume(rows[0].id);
    expect(f.inbox.pending(64,cursor)).toEqual(rows.slice(1));
    expect(f.inbox.pending(64,rows[2])).toEqual([]);
    expect(()=>f.inbox.pending(1,{received:NaN,id:cursor.id})).toThrow('cursor');
    expect(()=>f.inbox.pending(1,{received:cursor.received,id:'invalid'})).toThrow('cursor');
  });
  it('rejects removed setup, snapshots inputs and bounds pending pages',async()=>{
    const f=await fixture();const copy=structuredClone(venue);const inbox=slackInbox(f.app.db,f.clock,{venue:copy,app:'A123'});copy.bot='changed';await inbox.receive(payload());
    await inbox.receive(payload('Ev2'));expect(inbox.pending(1)).toHaveLength(1);
    for(const limit of [0,65,1.5,NaN]) expect(()=>inbox.pending(limit)).toThrow('limit');
    f.app.db.prepare('DELETE FROM bridges_venues').run();await expect(inbox.receive(payload())).rejects.toThrow('binding changed');
  });
});
