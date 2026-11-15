import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { DataWrites } from '../../core/data/writes.js';
import { FakeClock } from '../../core/clock.js';
import { members, agents, secrets, bridgeConnections, bridgeChannels, bridgePeople, bridgeIncoming, bridgeRawEvents, inbox } from '../../core/data/schema.js';
import { SharedBridges, bridgeCredentialBinding } from './shared-daemon.js';
import type { bridgeSlackSocket } from './slack-socket.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const generation='12345678-1234-4234-8234-123456789abc';
function fixture(){
 const client=new Database(':memory:');clean.push(()=>{client.close();});const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client);
 db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();
 db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 for(const name of ['TOKEN','APP'])db.insert(secrets).values({name,description:'',changedAt:at,changedBy:'owner'}).run();
 db.insert(bridgeConnections).values({id:'connection',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'art',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,state:'disconnected',stateAt:at}).run();
 db.insert(bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'art',botsMayTalk:false}).run();
 db.insert(bridgePeople).values({platform:'slack',workspace:'TWORK',user:'UUSER',member:'owner'}).run();
 const buffers:Buffer[]=[],source={generation:vi.fn(async()=>generation),read:vi.fn(async(name:string)=>{const bytes=Buffer.from('synthetic:'+name);buffers.push(bytes);return bytes;})};
 const request=vi.fn<typeof fetch>(async(url)=>{
  const workspace=db.select().from(bridgeConnections).get()!.workspace;
  if(String(url).endsWith('/auth.test'))return Response.json({ok:true,user_id:'UBOT',team_id:workspace,bot_id:'BBOT'});
  if(String(url).endsWith('/bots.info'))return Response.json({ok:true,bot:{id:'BBOT',user_id:'UBOT',app_id:'AAPP',deleted:false}});
  if(String(url).endsWith('/conversations.info'))return Response.json({ok:true,channel:{id:'CROOM',context_team_id:workspace,is_channel:true}});
  throw Error('Unexpected endpoint');
 });
 const transports:Parameters<typeof bridgeSlackSocket>[0][]=[],closed=vi.fn(async()=>{});
 const slack:typeof bridgeSlackSocket=options=>{transports.push(options);options.state?.('connected');return {close:closed};};
 const published:unknown[]=[],signal=vi.fn((ids:readonly string[])=>{expect(client.inTransaction).toBe(false);for(const id of ids)expect(db.select().from(inbox).where(eq(inbox.id,id)).get()).toBeTruthy();});
 const notify=()=>{expect(client.inTransaction).toBe(false);published.push(db.select().from(bridgeIncoming).all().map(row=>row.state));};
 const writes=new DataWrites(db,{refreshAccess(){},changed:notify}),errors:Error[]=[];
 let allowed=true;
 const resume=vi.fn(()=>{throw Error('Slack must not use Discord resume');});
 const daemon=new SharedBridges({db,clock,writes,source,effectsAllowed:()=>allowed,resume,changed:notify,inboxCommitted:signal,reportError:error=>errors.push(error),request,slack});clean.push(()=>daemon.close());
 const raw=(event='event',envelope='ack')=>Buffer.from(JSON.stringify({type:'events_api',envelope_id:envelope,payload:{type:'event_callback',event_id:event,team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text:'A synthetic question',ts:'1794432000.000001'}}}));
 return {client,db,clock,writes,source,buffers,request,transports,closed,published,signal,errors,daemon,raw,deny:()=>{allowed=false;}};
}
it('authenticates the bot/app binding, durably accepts before drain and signals committed Inbox items exactly once',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();expect(f.transports).toHaveLength(1);expect(f.transports[0].app).toBe('AAPP');
 expect(f.db.select().from(bridgeConnections).get()?.state).toBe('connected');
 await f.transports[0].receive({},f.raw());expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);expect(f.db.select().from(inbox).all()).toEqual([]);expect(f.signal).not.toHaveBeenCalled();
 f.clock.advance(0);await f.daemon.idle();
 expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);expect(f.db.select().from(bridgeIncoming).get()).toMatchObject({state:'delivered',member:'owner'});expect(f.signal).toHaveBeenCalledOnce();
 await f.transports[0].receive({},f.raw('event','different-ack'));f.clock.advance(0);await f.daemon.idle();expect(f.signal).toHaveBeenCalledOnce();expect(f.db.select().from(inbox).all()).toHaveLength(1);
 expect(f.buffers.every(buffer=>buffer.every(byte=>byte===0))).toBe(true);expect(f.client.serialize().includes(Buffer.from('synthetic:TOKEN'))).toBe(false);expect(f.errors).toEqual([]);
});
it('fences old socket callbacks and state reports after a committed disable',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();const old=f.transports[0];
 f.writes.run(()=>f.db.update(bridgeConnections).set({enabled:false}).run());f.daemon.changed();await f.daemon.idle();
 await expect(old.receive({},f.raw())).rejects.toThrow();old.state?.('connected');expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);
 expect(f.db.select().from(bridgeConnections).get()?.state).toBe('disconnected');expect(f.closed).toHaveBeenCalledOnce();
});
it('rejects a stale authentication response after retargeting without overwriting the new lifetime state',async()=>{
 const f=fixture();let release!:(value:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 f.request.mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve;});});
 await f.daemon.ready();await started;
 f.writes.run(()=>f.db.update(bridgeConnections).set({workspace:'TNEW'}).run());f.daemon.changed();await f.daemon.reconcile();
 release(Response.json({ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'}));await f.daemon.idle();
 expect(f.transports).toHaveLength(1);expect(f.db.select().from(bridgeConnections).get()?.state).toBe('connected');expect(f.errors).toEqual([]);
});
it('holds all platform work when outside effects are not enabled',async()=>{
 const f=fixture();f.deny();await f.daemon.ready();await f.daemon.idle();expect(f.request).not.toHaveBeenCalled();expect(f.source.read).not.toHaveBeenCalled();expect(f.transports).toEqual([]);
});
it('closes admission synchronously and drains a metadata call without touching the database afterward',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();let release!:(value:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 f.request.mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve;});});
 await f.transports[0].receive({},f.raw());f.clock.advance(0);await started;
 const closing=f.daemon.close();expect(f.daemon.close()).toBe(closing);
 release(Response.json({ok:true,channel:{id:'CROOM',context_team_id:'TWORK',is_channel:true}}));await closing;
 expect(f.db.select().from(bridgeIncoming).all()).toEqual([]);expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);expect(f.signal).not.toHaveBeenCalled();
});
it('binds private resume identity to every authentication/configuration field and holder generation',()=>{
 const f=fixture(),row=f.db.select().from(bridgeConnections).get()!,baseline=bridgeCredentialBinding(row,generation);
 for(const change of [{id:'other'},{platform:'discord' as const},{workspace:'OTHER'},{botUser:'OTHER'},{agent:'other'},{tokenSecret:'OTHER'},{appSecret:'OTHER'}])expect(bridgeCredentialBinding({...row,...change},generation)).not.toBe(baseline);
 expect(bridgeCredentialBinding(row,'87654321-1234-4234-8234-123456789abc')).not.toBe(baseline);
});
