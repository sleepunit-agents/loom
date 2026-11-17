import Database from 'better-sqlite3';
import { setupCall } from '../test/fixtures/setup-call.js';
import { afterEach,expect,it,vi } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { conversations,members,agents,secrets,tokens,memberAgents,bridgeConnections,bridgeChannelFilters,bridgeChannels,bridgePeople,bridgeIncoming,bridgeSends,bridgeFiles } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const close:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const f of close.splice(0).reverse())await f();});
const credential={owner:'a'.repeat(64),member:'b'.repeat(64),agent:'c'.repeat(64)};
function fixture(){
 const client=new Database(':memory:');close.push(()=>client.close());const db=createDataSchema(client),clock=new FakeClock(),at=new Date(clock.now()).toISOString();
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'member',role:'member',joinedAt:at}]).run();
 db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values({member:'member',agent:'art'}).run();
 db.insert(secrets).values(['TOKEN','APP'].map(name=>({name,description:'',changedAt:at,changedBy:'owner'}))).run();
 for(const [kind,value] of Object.entries(credential))db.insert(tokens).values({fingerprint:createHash('sha256').update(value).digest('hex'),label:kind,kind:kind==='agent'?'agent':'owner',member:kind==='agent'?null:kind,agent:kind==='agent'?'art':null,createdAt:at}).run();
 const changed=vi.fn(),root=sharedRoot({db,clock,originAllowed:()=>true,changed,reportError:()=>{}});close.push(()=>root.close());
 const call=async(input:unknown,token=credential.owner,id=randomUUID())=>{const res=setupCall(root,'bridges.command',input,'owner')??await root.http.request('http://loom/api/bridges/command',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id,input})});return {status:res.status,body:await res.json()};};
 const config={action:'connection' as const,id:'discord',platform:'discord' as const,agent:'art',workspace:'w',botUser:'bot',tokenSecret:'TOKEN',appSecret:null,enabled:true,only:['room','room'],ignore:['noise']};
 return {db,client,clock,at,root,changed,call,config};
}
it('rejects ordinary agent owners, agents, unknown fields and missing foreign keys without partial writes',async()=>{
 const f=fixture();
 expect((await f.call({...f.config,claim:'owner'})).status).toBe(400);
 expect((await f.call({...f.config,tokenSecret:'MISSING'})).status).toBe(400);expect(f.db.select().from(bridgeConnections).all()).toEqual([]);expect(f.db.select().from(bridgeChannelFilters).all()).toEqual([]);
 // Installed services do not ask for service grants or a fabricated viewer.
 f.root.services.bridges.settings.change(f.config);expect(f.db.select().from(bridgeConnections).get()?.id).toBe('discord');
});
it('edits channel and person metadata through the actual root and removes only those rules',async()=>{
 const f=fixture();expect((await f.call({action:'channel',platform:'slack',workspace:'w',channel:'room',answers:'art',botsMayTalk:true})).status).toBe(200);
 expect((await f.call({action:'person',platform:'slack',workspace:'w',user:'outside',member:'member'})).status).toBe(200);
 expect(f.db.select().from(bridgeChannels).get()?.botsMayTalk).toBe(true);expect(f.db.select().from(bridgePeople).get()?.member).toBe('member');
 expect((await f.call({action:'removeChannel',platform:'slack',workspace:'w',channel:'room'})).status).toBe(200);
 expect((await f.call({action:'removePerson',platform:'slack',workspace:'w',user:'outside'})).status).toBe(200);
 expect(f.db.select().from(bridgeChannels).all()).toEqual([]);expect(f.db.select().from(bridgePeople).all()).toEqual([]);
});
it('requires platform credential names and disconnects without deleting retained history',async()=>{
 const f=fixture();expect((await f.call({...f.config,platform:'slack'})).status).toBe(400);expect((await f.call({...f.config,appSecret:'APP'})).status).toBe(400);
 expect((await f.call({...f.config,platform:'slack',appSecret:'APP'})).status).toBe(200);
 f.db.insert(bridgeIncoming).values({id:'incoming',connection:'discord',channel:'room',isDm:false,user:'outside',text:'Words',postedAt:f.at,receivedAt:f.at,state:'delivered'}).run();
 expect((await f.call({action:'disconnect',id:'discord'})).status).toBe(200);expect(f.db.select().from(bridgeConnections).get()?.enabled).toBe(false);expect(f.db.select().from(bridgeIncoming).get()?.text).toBe('Words');
});
it('releases held sends but never requeues an uncertain send; dismissal retains its record',async()=>{
 const f=fixture();await f.call(f.config);
 f.db.insert(bridgeIncoming).values({id:'incoming',connection:'discord',channel:'room',isDm:false,user:'outside',text:'Words',postedAt:f.at,receivedAt:f.at,state:'delivered'}).run();
 for(const state of ['held','uncertain'] as const)f.db.insert(bridgeSends).values({id:state,incoming:'incoming',connection:'discord',channel:'room',text:'Reply',state,createdAt:f.at}).run();
 expect((await f.call({action:'review',id:'uncertain',decision:'release'})).status).toBe(400);
 // The door and the service read one shape, and a reply's id is taken as sent: neither trims a padded id into this reply's.
 expect((await f.call({action:'review',id:' held ',decision:'release'})).status).toBe(403);
 expect(()=>f.root.services.bridges.settings.change({action:'review',id:' held ',decision:'release'})).toThrow('Unknown send');
 expect(f.db.select().from(bridgeSends).where(eq(bridgeSends.id,'held')).get()?.state).toBe('held');
 expect((await f.call({action:'review',id:'held',decision:'release'})).status).toBe(200);
 expect((await f.call({action:'review',id:'uncertain',decision:'dismiss'})).status).toBe(200);
 expect(f.db.select().from(bridgeSends).all().map(row=>[row.id,row.state])).toEqual([['held','pending'],['uncertain','dismissed']]);
});

it('retires an edited connection and atomically replaces filters while preserving referenced history',async()=>{
 const f=fixture();await f.call(f.config);f.db.update(bridgeConnections).set({state:'connected'}).run();
 f.db.insert(bridgeIncoming).values({id:'incoming',connection:'discord',channel:'room',isDm:false,user:'outside',text:'Kept',postedAt:f.at,receivedAt:f.at,state:'delivered'}).run();
 expect((await f.call({...f.config,tokenSecret:'APP',only:['new-room'],ignore:[]})).body).toEqual({ok:true,value:{saved:true}});
 expect(f.db.select().from(bridgeConnections).get()).toMatchObject({tokenSecret:'APP',state:'disconnected'});expect(f.db.select().from(bridgeIncoming).get()?.text).toBe('Kept');
 expect(f.db.select().from(bridgeChannelFilters).all()).toEqual([{connection:'discord',channel:'new-room',rule:'only'}]);
 f.client.exec("CREATE TRIGGER fail_filter BEFORE INSERT ON bridge_channel_filters BEGIN SELECT RAISE(ABORT, 'PRIVATE upstream failure'); END");
 const failed=await f.call({...f.config,tokenSecret:'TOKEN',only:['fail']});expect(failed.status).toBe(400);expect(failed.body).toMatchObject({ok:false,code:'invalid'});expect(JSON.stringify(failed.body)).not.toContain('PRIVATE');
 expect(f.db.select().from(bridgeConnections).get()?.tokenSecret).toBe('APP');expect(f.db.select().from(bridgeChannelFilters).all()).toEqual([{connection:'discord',channel:'new-room',rule:'only'}]);
});
it('rejects fresh reviews outside held/uncertain and permits held dismissal',async()=>{
 const f=fixture();await f.call(f.config);f.db.insert(bridgeIncoming).values({id:'incoming',connection:'discord',channel:'room',isDm:false,user:'outside',text:'Words',postedAt:f.at,receivedAt:f.at,state:'delivered'}).run();
 for(const state of ['pending','sending','sent','dismissed','held'] as const)f.db.insert(bridgeSends).values({id:state,incoming:'incoming',connection:'discord',channel:'room',text:'Reply',state,createdAt:f.at}).run();
 for(const id of ['pending','sending','sent','dismissed'])for(const decision of ['release','dismiss'])expect((await f.call({action:'review',id,decision})).status).toBe(400);
 expect((await f.call({action:'review',id:'held',decision:'dismiss'})).status).toBe(200);expect(f.db.select().from(bridgeSends).where(eq(bridgeSends.id,'held')).get()?.state).toBe('dismissed');
});
it('publishes trusted installed writes only after commit and never makes network calls',async()=>{
 const f=fixture(),network=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('Unexpected network');}),publish=vi.fn(()=>{expect(f.client.inTransaction).toBe(false);});
 const unobserve=f.root.writes.observe(publish);try{
  f.root.services.bridges.settings.change(f.config);expect(publish).toHaveBeenCalledOnce();
  expect(()=>f.root.services.bridges.settings.change({...f.config,agent:'missing'})).toThrow();expect(publish).toHaveBeenCalledOnce();
  expect((await f.call({action:'disconnect',id:'discord'})).status).toBe(200);expect(network).not.toHaveBeenCalled();
 }finally{unobserve();network.mockRestore();}
});
it('updates existing composite keys and removes only the addressed channel/person',async()=>{
 const f=fixture();
 for(const workspace of ['w','neighbor']){
  await f.call({action:'channel',platform:'discord',workspace,channel:'room',answers:'art',botsMayTalk:false});
  await f.call({action:'person',platform:'discord',workspace,user:'outside',member:'owner'});
 }
 await f.call({action:'channel',platform:'discord',workspace:'w',channel:'room',answers:'art',botsMayTalk:true});
 await f.call({action:'person',platform:'discord',workspace:'w',user:'outside',member:'member'});
 expect(f.db.select().from(bridgeChannels).where(eq(bridgeChannels.workspace,'w')).get()?.botsMayTalk).toBe(true);expect(f.db.select().from(bridgePeople).where(eq(bridgePeople.workspace,'w')).get()?.member).toBe('member');
 await f.call({action:'removeChannel',platform:'discord',workspace:'w',channel:'room'});await f.call({action:'removePerson',platform:'discord',workspace:'w',user:'outside'});
 expect(f.db.select().from(bridgeChannels).all().map(row=>row.workspace)).toEqual(['neighbor']);expect(f.db.select().from(bridgePeople).all().map(row=>row.workspace)).toEqual(['neighbor']);
});

it('keeps retained receipts scoped to one connection identity while permitting credential-name changes',async()=>{
 const f=fixture();await f.call(f.config);f.db.insert(agents).values({...f.db.select().from(agents).get()!,id:'another'}).run();
 for(const changed of [{agent:'another'},{workspace:'another'},{botUser:'another'},{platform:'slack',appSecret:'APP'}])expect((await f.call({...f.config,...changed})).status).toBe(400);
 expect(f.db.select().from(bridgeConnections).get()).toMatchObject({platform:'discord',workspace:'w',botUser:'bot',agent:'art'});
 expect((await f.call({...f.config,tokenSecret:'APP'})).status).toBe(200);
});


it('lets the people a direct message is shown to review a reply in it, since the owner role does not show it',async()=>{
 const f=fixture();f.root.services.bridges.settings.change(f.config);
 const other='d'.repeat(64);f.db.insert(members).values({id:'other',role:'member',joinedAt:f.at}).run();f.db.insert(tokens).values({fingerprint:createHash('sha256').update(other).digest('hex'),label:'other',kind:'owner',member:'other',createdAt:f.at}).run();
 // The member's own direct message with art, a direct message from somebody who is not linked, and a room.
 f.db.insert(conversations).values([{id:'own',agent:'art',venue:'discord',place:'dm:1',label:'',member:'member',direct:true,startedAt:f.at,lastAt:f.at,turnCount:0},
  {id:'outside',agent:'art',venue:'discord',place:'dm:2',label:'',direct:true,startedAt:f.at,lastAt:f.at,turnCount:0},{id:'room',agent:'art',venue:'discord',place:'room',label:'',startedAt:f.at,lastAt:f.at,turnCount:0}]).run();
 for(const [id,isDm,member] of [['own',true,'member'],['outside',true,null],['room',false,null]] as const){
  f.db.insert(bridgeIncoming).values({id,connection:'discord',channel:id,isDm,member,conversation:id,user:'u-'+id,text:'Words',postedAt:f.at,receivedAt:f.at,state:'delivered'}).run();
  for(const state of ['held','uncertain'] as const)f.db.insert(bridgeSends).values({id:id+'-'+state,incoming:id,connection:'discord',channel:id,text:'Reply',state,createdAt:f.at}).run();
 }
 const review=async(id:string,decision:'release'|'dismiss',token:string)=>(await f.call({action:'review',id,decision},token)).status;
 const state=(id:string)=>f.db.select().from(bridgeSends).where(eq(bridgeSends.id,id)).get()!.state;
 // Nobody but its member reads the member's own direct message, so nobody else decides about a reply in it.
 for(const token of [credential.owner,other,credential.agent])for(const id of ['own-held','own-uncertain'])expect([id,await review(id,'dismiss',token)]).toEqual([id,403]);
 expect(await review('own-held','release',credential.member)).toBe(200);expect(state('own-held')).toBe('pending');
 expect(await review('own-uncertain','release',credential.member)).toBe(400);expect(await review('own-uncertain','dismiss',credential.member)).toBe(200);expect(state('own-uncertain')).toBe('dismissed');
 // A direct message from anybody else is shown to art's owners. The owner here does not have art.
 expect(await review('outside-held','release',credential.owner)).toBe(403);expect(await review('outside-held','release',other)).toBe(403);
 expect(await review('outside-held','release',credential.member)).toBe(200);expect(await review('outside-uncertain','dismiss',credential.member)).toBe(200);
 // A room's reply stays the household owners': having the agent shows it and does not decide about it.
 expect(await review('room-held','release',credential.member)).toBe(403);expect(await review('room-held','release',credential.agent)).toBe(403);
 expect(await review('room-held','release',credential.owner)).toBe(200);expect(await review('room-uncertain','dismiss',credential.owner)).toBe(200);
 expect(await review('missing','dismiss',credential.owner)).toBe(403);
});
