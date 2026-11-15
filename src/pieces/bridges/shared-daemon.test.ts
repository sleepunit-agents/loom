import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { DataWrites } from '../../core/data/writes.js';
import { FakeClock } from '../../core/clock.js';
import { members, agents, secrets, bridgeConnections, bridgeChannels, bridgePeople, bridgeIncoming, bridgeRawEvents, inbox, bridgeSends, bridgeFiles } from '../../core/data/schema.js';
import { SharedBridges, type SharedBridgeOptions } from './shared-daemon.js';
import type { bridgeSlackSocket } from './slack-socket.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const generation='12345678-1234-4234-8234-123456789abc';
function fixture(overrides:Partial<SharedBridgeOptions>={}){
 const client=new Database(':memory:');clean.push(()=>{if(client.open)client.close();});const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client);
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
 const daemon=new SharedBridges({db,clock,writes,source,effectsAllowed:()=>allowed,changed:notify,inboxCommitted:signal,reportError:error=>errors.push(error),request,slack,...overrides});clean.push(()=>daemon.close());
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

it('flushes the shared send queue through the current bot credential and confirms the actual platform receipt',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();await f.transports[0].receive({},f.raw());f.clock.advance(0);await f.daemon.idle();
 const incoming=f.db.select().from(bridgeIncoming).get()!;f.request.mockImplementation(async(url)=>{expect(String(url)).toBe('https://slack.com/api/chat.postMessage');expect(f.client.inTransaction).toBe(false);expect(f.db.select().from(bridgeSends).get()?.state).toBe('sending');return Response.json({ok:true,channel:'CROOM',ts:'1794432000.000009'});});
 f.daemon.sends.queue({id:'reply',incoming:incoming.id,text:'Hi <@everyone>'});f.daemon.changed();await f.daemon.idle();
 expect(f.db.select().from(bridgeSends).get()).toMatchObject({state:'sent',postedId:'1794432000.000009'});expect(f.buffers.every(buffer=>buffer.every(byte=>byte===0))).toBe(true);
});
it('drains an in-flight post during close and records uncertainty without a second network attempt',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();await f.transports[0].receive({},f.raw());f.clock.advance(0);await f.daemon.idle();const incoming=f.db.select().from(bridgeIncoming).get()!;
 let release!:(response:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.request.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});
 f.daemon.sends.queue({id:'reply',incoming:incoming.id,text:'Hi'});f.daemon.changed();await started;let stopped=false;const closing=f.daemon.close().then(()=>{stopped=true;});expect(stopped).toBe(false);release(Response.json({ok:true,channel:'CROOM',ts:'1794432000.000009'}));await closing;
 expect(f.db.select().from(bridgeSends).get()?.state).toBe('uncertain');expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('chat.postMessage'))).toHaveLength(1);
});
it('uses fresh credentials per part and publishes direct queue/claim/confirmation commits',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();await f.transports[0].receive({},f.raw());f.clock.advance(0);await f.daemon.idle();const incoming=f.db.select().from(bridgeIncoming).get()!,before=f.source.read.mock.calls.length,states:string[]=[];
 const unobserve=f.writes.observe(()=>{expect(f.client.inTransaction).toBe(false);const state=f.db.select().from(bridgeSends).get()?.state;if(state)states.push(state);});
 f.request.mockImplementation(async(url,options)=>{expect(String(url)).toBe('https://slack.com/api/chat.postMessage');expect(JSON.parse(String(options?.body))).toMatchObject({channel:'CROOM'});return Response.json({ok:true,channel:'CROOM',ts:'1794432000.000009'});});
 try{f.daemon.sends.queue({id:'reply',incoming:incoming.id,text:'x'.repeat(4000)});f.daemon.changed();await f.daemon.idle();expect(f.source.read.mock.calls.length-before).toBe(2);expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('chat.postMessage'))).toHaveLength(2);expect(states).toEqual(expect.arrayContaining(['pending','sending','sent']));}finally{unobserve();}
});
it('refuses the next part when connection identity changes during its fresh credential acquisition',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();await f.transports[0].receive({},f.raw());f.clock.advance(0);await f.daemon.idle();const incoming=f.db.select().from(bridgeIncoming).get()!;let reads=0;
 f.source.read.mockImplementation(async()=>{const bytes=Buffer.from('synthetic:TOKEN');f.buffers.push(bytes);if(++reads===2)f.writes.run(()=>f.db.update(bridgeConnections).set({botUser:'UREPLACED'}).run());return bytes;});
 f.request.mockImplementation(async()=>Response.json({ok:true,channel:'CROOM',ts:'1794432000.000009'}));
 f.daemon.sends.queue({id:'reply',incoming:incoming.id,text:'x'.repeat(4000)});f.daemon.changed();await f.daemon.idle();expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('chat.postMessage'))).toHaveLength(1);expect(f.db.select().from(bridgeSends).get()?.state).toBe('uncertain');expect(f.buffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
});
it('flushes a preexisting pending send on the connected-state callback without a caller flush',async()=>{
 const f=fixture();f.db.insert(bridgeIncoming).values({id:'in',connection:'connection',channel:'CROOM',isDm:false,user:'UUSER',text:'Hi',postedAt:new Date(f.clock.now()).toISOString(),receivedAt:new Date(f.clock.now()).toISOString(),state:'delivered'}).run();f.daemon.sends.queue({id:'reply',incoming:'in',text:'Reply'});
 const original=f.request.getMockImplementation()!;f.request.mockImplementation(async(url,options)=>String(url).endsWith('/chat.postMessage')?Response.json({ok:true,channel:'CROOM',ts:'1794432000.000009'}):original(url,options));await f.daemon.ready();await f.daemon.idle();expect(f.db.select().from(bridgeSends).get()?.state).toBe('sent');
});

it('does not access a closed database when a timed-out post response arrives after manager close',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();await f.transports[0].receive({},f.raw());f.clock.advance(0);await f.daemon.idle();const incoming=f.db.select().from(bridgeIncoming).get()!;
 let release!:(response:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.request.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});f.daemon.sends.queue({id:'reply',incoming:incoming.id,text:'Hi'});f.daemon.changed();await started;const closing=f.daemon.close();f.clock.advance(15000);await closing;f.client.close();const reads=vi.spyOn(f.db,'select');let cancelled=false;
 release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await f.request.mock.results.at(-1)!.value;await Promise.resolve();expect(cancelled).toBe(true);expect(reads).not.toHaveBeenCalled();reads.mockRestore();
});
it('fetches attachments only after committed delivery, stores private bytes, and consumes raw only after caching',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();const original=f.request.getMockImplementation()!;f.request.mockImplementation(async(url,options)=>{if(String(url).startsWith('https://files.slack.com/')){expect(f.client.inTransaction).toBe(false);expect(f.db.select().from(inbox).all()).toHaveLength(1);expect(f.db.select().from(bridgeIncoming).get()?.state).toBe('delivered');return new Response('DATA',{headers:{'content-type':'application/octet-stream'}});}return original(url,options);});
 const frame=JSON.parse(f.raw().toString());frame.payload.event.files=[{id:'FABC',name:'../image x',size:4,url_private:'https://files.slack.com/files-pri/TWORK-FABC/image'}];await f.transports[0].receive({},Buffer.from(JSON.stringify(frame)));expect(f.db.select().from(bridgeFiles).all()).toEqual([]);f.clock.advance(0);await f.daemon.idle();
 expect(f.db.select().from(bridgeFiles).get()).toMatchObject({file:'FABC',name:'image_x',contents:Buffer.from('DATA')});expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);f.clock.advance(1);await f.daemon.idle();expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);expect(f.db.select().from(inbox).all()).toHaveLength(1);expect(f.buffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
});
it.each([{state:'dropped' as const},{channel:'OTHER'},{member:null}])('revokes an attachment fetch when its saved incoming proof changes: %j',async change=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();const original=f.request.getMockImplementation()!;f.request.mockImplementation(async(url,options)=>{if(String(url).startsWith('https://files.slack.com/')){f.writes.run(()=>f.db.update(bridgeIncoming).set(change).run());return new Response('DATA');}return original(url,options);});const frame=JSON.parse(f.raw().toString());frame.payload.event.files=[{id:'FABC',name:'file',size:4,url_private:'https://files.slack.com/files-pri/TWORK-FABC/file'}];await f.transports[0].receive({},Buffer.from(JSON.stringify(frame)));f.clock.advance(0);await f.daemon.idle();expect(f.db.select().from(bridgeFiles).all()).toEqual([]);expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);
});
it('recovers a failed attachment fetch from the same durable raw receipt after manager restart',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();const original=f.request.getMockImplementation()!;let succeeds=false;f.request.mockImplementation(async(url,options)=>String(url).startsWith('https://files.slack.com/')?succeeds?new Response('DATA'):new Response('Unavailable',{status:503}):original(url,options));const frame=JSON.parse(f.raw().toString());frame.payload.event.files=[{id:'FABC',name:'file',size:4,url_private:'https://files.slack.com/files-pri/TWORK-FABC/file'}];await f.transports[0].receive({},Buffer.from(JSON.stringify(frame)));f.clock.advance(0);await f.daemon.idle();expect(f.db.select().from(bridgeFiles).all()).toEqual([]);expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);await f.daemon.close();succeeds=true;
 const restarted=new SharedBridges({db:f.db,clock:f.clock,writes:f.writes,source:f.source,effectsAllowed:()=>true,changed(){},reportError(){},request:f.request,slack:options=>{options.state?.('connected');return {close:async()=>{}};}});clean.push(()=>restarted.close());await restarted.ready();await restarted.idle();f.clock.advance(1);await restarted.idle();expect(f.db.select().from(bridgeFiles).get()?.contents).toEqual(Buffer.from('DATA'));expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);expect(f.db.select().from(inbox).all()).toHaveLength(1);
});
it('drains an active attachment fetch before close and refuses its late bytes',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();const original=f.request.getMockImplementation()!;let release!:(response:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.request.mockImplementation(async(url,options)=>{if(String(url).startsWith('https://files.slack.com/')){entered();return new Promise(resolve=>{release=resolve;});}return original(url,options);});const frame=JSON.parse(f.raw().toString());frame.payload.event.files=[{id:'FABC',name:'file',size:4,url_private:'https://files.slack.com/files-pri/TWORK-FABC/file'}];await f.transports[0].receive({},Buffer.from(JSON.stringify(frame)));f.clock.advance(0);await started;let stopped=false;const closing=f.daemon.close().then(()=>{stopped=true;});expect(stopped).toBe(false);release(new Response('DATA'));await closing;expect(f.db.select().from(bridgeFiles).all()).toEqual([]);expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);
});

it('fetches only the first five attachments and erases fetched buffers after private SQLite copies',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();const original=f.request.getMockImplementation()!,store=vi.spyOn(f.daemon.files,'store');f.request.mockImplementation(async(url,options)=>String(url).startsWith('https://files.slack.com/')?new Response('DATA'):original(url,options));const frame=JSON.parse(f.raw().toString());frame.payload.event.files=Array.from({length:6},(_,i)=>({id:'FABC'+i,name:'file-'+i,size:4,url_private:'https://files.slack.com/files-pri/TWORK-FABC'+i+'/file'}));await f.transports[0].receive({},Buffer.from(JSON.stringify(frame)));f.clock.advance(0);await f.daemon.idle();f.clock.advance(1);await f.daemon.idle();
 expect(f.request.mock.calls.filter(([url])=>String(url).startsWith('https://files.slack.com/'))).toHaveLength(5);const cached=f.db.select().from(bridgeFiles).all();expect(cached.map(file=>file.file).sort()).toEqual(['FABC0','FABC1','FABC2','FABC3','FABC4']);expect(cached.every(file=>file.contents.equals(Buffer.from('DATA')))).toBe(true);expect(store).toHaveBeenCalledTimes(5);for(const [input] of store.mock.calls)expect(input.contents.every(byte=>byte===0)).toBe(true);expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);store.mockRestore();
});
it.each([true,false])('never drains retained raw during pending authentication, even under repeated reconciliation (eventual success=%s)',async success=>{
 const f=fixture(),frame=JSON.parse(f.raw().toString());frame.payload.event.channel_type='channel';const now=f.clock.now();f.db.insert(bridgeRawEvents).values({connection:'connection',id:'retained',event:Buffer.from(JSON.stringify(frame)),receivedAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString()}).run();
 let release!:(response:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.request.mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve;});});await f.daemon.ready();await started;
 f.writes.run(()=>f.db.update(members).set({role:'owner'}).run());f.daemon.changed();await f.daemon.reconcile();expect(f.db.select().from(inbox).all()).toEqual([]);expect(f.db.select().from(bridgeIncoming).all()).toEqual([]);expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);
 release(Response.json(success?{ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'}:{ok:false}));await f.daemon.idle();expect(f.db.select().from(inbox).all()).toHaveLength(success?1:0);expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(success?1:0);
});

it('connects Discord through its owned live cursor and durably retains raw before advancing',async()=>{
 let gateway:Parameters<NonNullable<SharedBridgeOptions['discord']>>[0]|undefined;
 const f=fixture({discord:options=>{gateway=options;expect(options.load()).toBeUndefined();return {close:async()=>{}};}});f.db.update(bridgeConnections).set({platform:'discord',workspace:'456',botUser:'123',appSecret:null}).run();f.request.mockImplementation(async url=>Response.json(String(url).endsWith('users/@me')?{id:'123',bot:true}:{id:'456'}));await f.daemon.ready();await f.daemon.idle();expect(gateway).toBeDefined();
 const raw=Buffer.from(JSON.stringify({op:0,t:'READY',s:1,d:{user:{id:'123'}}})),checkpoint={session:'session',seq:1,url:'wss://gateway.discord.gg'};await gateway!.commit({type:'READY',data:{},seq:1},checkpoint,raw);expect(f.db.select().from(bridgeRawEvents).get()?.event).toEqual(raw);expect(gateway!.load()).toEqual(checkpoint);await gateway!.reset();expect(gateway!.load()).toBeUndefined();
});
it('publishes an earlier committed intake when a later receipt in the drain fails',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();const first=JSON.parse(f.raw('first','one').toString()),bad=JSON.parse(f.raw('bad','two').toString());first.payload.event.channel_type='channel';bad.payload.event.channel_type='channel';bad.payload.event.text=123;bad.payload.event.ts='1794432000.000002';
 await f.transports[0].receive({},Buffer.from(JSON.stringify(first)));await f.transports[0].receive({},Buffer.from(JSON.stringify(bad)));f.published.length=0;f.clock.advance(0);await f.daemon.idle();
 expect(f.db.select().from(inbox).all()).toHaveLength(1);expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);expect(f.published).toContainEqual(['delivered']);expect(f.signal).toHaveBeenCalledOnce();expect(f.errors.length).toBeGreaterThan(0);
});
it('does not publish an empty drain during ordinary reconciliation',async()=>{
 const f=fixture();await f.daemon.ready();await f.daemon.idle();f.published.length=0;f.daemon.changed();await f.daemon.idle();expect(f.published).toEqual([]);
});
