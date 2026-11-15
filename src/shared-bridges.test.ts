import Database from 'better-sqlite3';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,secrets,boxes,jobs,tokens,bridgeConnections,bridgeChannels,bridgeIncoming,bridgeSends,conversations,inbox,secretChanges,turns} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
const clean:(()=>unknown|Promise<unknown>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const token={body:'a'.repeat(64),other:'b'.repeat(64),owner:'c'.repeat(64)};
function fixture(){
 const client=new Database(':memory:');clean.push(()=>client.close());const db=createDataSchema(client),clock=new FakeClock(),at=new Date(clock.now()).toISOString();
 db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at}).run();db.insert(secrets).values(['TOKEN','APP'].map(name=>({name,description:'',changedAt:at,changedBy:'owner'}))).run();
 db.insert(bridgeConnections).values({id:'connection',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'art',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,state:'disconnected',stateAt:at}).run();db.insert(bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'art',botsMayTalk:false}).run();
 const source={generation:vi.fn(async()=> '12345678-1234-4234-8234-123456789abc'),read:vi.fn(async(name:string)=>Buffer.from('synthetic:'+name))},transports:Parameters<typeof bridgeSlackSocket>[0][]=[],closed=vi.fn(async()=>{}),slack:typeof bridgeSlackSocket=options=>{transports.push(options);options.state?.('connected');return {close:closed};};
 const request=vi.fn<typeof fetch>(async url=>{
  if(String(url).endsWith('auth.test'))return Response.json({ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'});
  if(String(url).endsWith('bots.info'))return Response.json({ok:true,bot:{id:'BBOT',user_id:'UBOT',app_id:'AAPP',deleted:false}});
  if(String(url).endsWith('conversations.info'))return Response.json({ok:true,channel:{id:'CROOM',context_team_id:'TWORK',is_channel:true}});
  if(String(url).endsWith('chat.postMessage'))return Response.json({ok:true,channel:'CROOM',ts:'1794432000.000009'});throw Error('Unexpected endpoint');
 });
 const admitted=vi.fn(()=>true),root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},tempo:{admit:admitted},bridges:{source,effectsAllowed:()=>true,request,slack}});clean.push(()=>root.close());
 for(const id of ['body','other'])db.insert(jobs).values({id,agent:'art',box:'box',title:'',brief:'',model:'test',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:at}).run();
 for(const [id,value] of Object.entries(token))db.insert(tokens).values({fingerprint:createHash('sha256').update(value).digest('hex'),label:id,kind:id==='owner'?'owner':'agent',member:id==='owner'?'owner':null,agent:id==='owner'?null:'art',job:id==='owner'?null:id,createdAt:at}).run();
 const call=async(piece:string,operation:string,input:unknown,credential=token.body,id=randomUUID())=>{const response=await root.http.request('http://loom/api/'+piece+'/'+operation,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({id,input})});return {status:response.status,body:await response.json()};};
 const receive=async()=>{await root.services.bridges.daemon!.ready();await root.services.bridges.daemon!.idle();await transports.at(-1)!.receive({},Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack',payload:{type:'event_callback',event_id:'event',team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text:'Hello',ts:'1794432000.000001'}}})));clock.advance(0);await root.services.bridges.daemon!.idle();return db.select().from(bridgeIncoming).get()!;};
 return {client,db,clock,root,source,transports,closed,request,call,receive,admitted};
}
it('mounts actual intake, committed Tempo admission, body reply door and current-credential network send',async()=>{
 const f=fixture();f.root.services.tempo.volume.setTimings({kind:'agent',id:'art'},{settleSeconds:0});const incoming=await f.receive();expect(f.db.select().from(inbox).get()?.conversation).toBe(incoming.conversation);expect(f.db.select().from(conversations).get()?.venue).toBe('slack');expect(f.admitted).toHaveBeenCalledOnce();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.db.update(conversations).set({job:'body'}).where(eq(conversations.id,incoming.conversation!)).run();});
 const input={id:randomUUID(),incoming:incoming.id,text:'Reply',model:'observed',outcome:'progressed'},receipt=randomUUID();expect((await f.call('bridges','reply',input,token.other,receipt)).status).toBe(403);expect((await f.call('bridges','reply',input,token.owner,receipt)).status).toBe(403);expect((await f.call('bridges','reply',{...input,job:'other'})).status).toBe(400);
 expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);await f.root.services.bridges.daemon!.idle();expect(f.db.select().from(bridgeSends).get()).toMatchObject({state:'sent',postedId:'1794432000.000009'});
 expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);expect((await f.call('bridges','reply',input,token.body,randomUUID())).status).toBe(200);expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('chat.postMessage'))).toHaveLength(1);expect(f.db.select().from(turns).all()).toMatchObject([{kind:'message'},{kind:'reply',run:'body',model:'observed',outcome:'progressed'}]);
});
it('retires actual sockets after committed owner disconnect and drains on root close',async()=>{
 const f=fixture();await f.receive();expect((await f.call('bridges','command',{action:'disconnect',id:'connection'},token.owner)).status).toBe(200);await f.root.services.bridges.daemon!.idle();expect(f.closed).toHaveBeenCalledOnce();await expect(f.transports[0].receive({},Buffer.from('{}'))).rejects.toThrow();await f.root.close();expect((await f.call('bridges','reply',{id:randomUUID(),incoming:'in',text:'Late'})).status).toBe(503);
});

it('invalidates sockets on committed credential audits but never on rolled-back writes',async()=>{
 const f=fixture();await f.receive();const old=f.transports[0],audit={id:randomUUID(),secret:'TOKEN',action:'replace' as const,by:'owner',at:new Date(f.clock.now()).toISOString()};
 expect(()=>f.root.writes.run(()=>{f.db.insert(secretChanges).values(audit).run();throw Error('Rollback');})).toThrow('Rollback');expect(f.closed).not.toHaveBeenCalled();old.state?.('connected');expect(f.db.select().from(bridgeConnections).get()?.state).toBe('connected');
 f.root.writes.run(()=>f.db.insert(secretChanges).values(audit).run());await expect(old.receive({},Buffer.from('{}'))).rejects.toThrow();await f.root.services.bridges.daemon!.idle();expect(f.closed).toHaveBeenCalledOnce();
});
it('binds receipt replay to the actual job and conversation and rechecks source state before cached acknowledgement',async()=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.db.update(conversations).set({job:'body'}).where(eq(conversations.id,incoming.conversation!)).run();});const input={id:randomUUID(),incoming:incoming.id,text:'Reply',model:'observed'},receipt=randomUUID();expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);await f.root.services.bridges.daemon!.idle();f.root.writes.run(()=>{f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'other')).run();f.db.update(conversations).set({job:'other'}).where(eq(conversations.id,incoming.conversation!)).run();});expect((await f.call('bridges','reply',input,token.other,receipt)).status).toBe(409);
 const currentReceipt=randomUUID();expect((await f.call('bridges','reply',input,token.other,currentReceipt)).status).toBe(200);
 const moved=f.root.services.conversations.open({agent:'art',venue:'slack',place:'moved',label:'Moved'});f.root.writes.run(()=>{f.db.update(jobs).set({conversation:moved.id}).where(eq(jobs.id,'other')).run();f.db.update(conversations).set({job:'other'}).where(eq(conversations.id,moved.id)).run();f.db.update(bridgeIncoming).set({conversation:moved.id}).run();});expect((await f.call('bridges','reply',input,token.other,currentReceipt)).status).toBe(409);
 f.root.writes.run(()=>f.db.update(bridgeIncoming).set({state:'dropped'}).run());expect((await f.call('bridges','reply',input,token.other,currentReceipt)).status).toBe(403);
});
it('fences startup configuration failure before late source completion can touch closed SQLite',async()=>{
 const client=new Database(':memory:'),db=createDataSchema(client),clock=new FakeClock();let release!:(generation:string)=>void;const generation=new Promise<string>(resolve=>{release=resolve;});
 expect(()=>sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},bridges:{source:{generation:()=>generation,read:async()=>Buffer.from('synthetic')},effectsAllowed:()=>true},tempo:{contributors:[{name:'',open:()=>[]}]}})).toThrow('Duplicate or empty sweep part');client.close();const reads=vi.spyOn(db,'select');release('12345678-1234-4234-8234-123456789abc');await generation;await Promise.resolve();clock.advance(60000);await Promise.resolve();expect(reads).not.toHaveBeenCalled();reads.mockRestore();
});

it('rolls back a queued reply if its observed-model turn cannot be recorded',async()=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.db.update(conversations).set({job:'body'}).where(eq(conversations.id,incoming.conversation!)).run();});
 f.client.exec("CREATE TRIGGER refuse_reply_turn BEFORE INSERT ON turns WHEN NEW.kind='reply' BEGIN SELECT RAISE(ABORT,'Fictitious turn failure'); END");
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Reply',model:'observed'})).status).toBe(503);expect(f.db.select().from(bridgeSends).all()).toEqual([]);await f.root.services.bridges.daemon!.idle();expect(f.request.mock.calls.some(([url])=>String(url).endsWith('chat.postMessage'))).toBe(false);
});
it.each(['replacement','venue','private-assignment'])('refuses a reply after the current %s scope changes',async change=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.db.update(conversations).set({job:'body'}).where(eq(conversations.id,incoming.conversation!)).run();});
 f.root.writes.run(()=>{
  if(change==='replacement')f.db.update(conversations).set({job:'other'}).where(eq(conversations.id,incoming.conversation!)).run();
  if(change==='venue')f.db.update(conversations).set({venue:'loom'}).where(eq(conversations.id,incoming.conversation!)).run();
  if(change==='private-assignment'){f.db.insert(members).values({id:'stranger',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.update(jobs).set({member:'stranger'}).where(eq(jobs.id,'body')).run();f.db.update(conversations).set({member:'stranger'}).where(eq(conversations.id,incoming.conversation!)).run();}
 });
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Late reply',model:'observed'})).status).toBe(403);expect(f.db.select().from(bridgeSends).all()).toEqual([]);
});

it('requires an observed model before a body can queue a reply',async()=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.db.update(conversations).set({job:'body'}).where(eq(conversations.id,incoming.conversation!)).run();});
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Missing model'})).status).toBe(400);expect(f.db.select().from(bridgeSends).all()).toEqual([]);
});
