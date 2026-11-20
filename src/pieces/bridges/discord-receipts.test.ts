import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {createDataSchema} from '../../core/data/database.js';
import {FakeClock} from '../../core/clock.js';
import {members,agents,secrets,bridgeConnections,bridgeRawEvents,bridgeResume} from '../../core/data/schema.js';
import {BridgeReceiver} from './receiver.js';
import {liveDiscordReceipts} from './discord-receipts.js';
const clients:Database.Database[]=[];afterEach(()=>{for(const client of clients.splice(0))client.close();});
function fixture(){
 const client=new Database(':memory:');clients.push(client);const db=createDataSchema(client),clock=new FakeClock(),at=new Date(clock.now()).toISOString();db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(secrets).values({name:'TOKEN',description:'',changedAt:at,changedBy:'owner'}).run();db.insert(bridgeConnections).values({id:'connection',platform:'discord',agent:'art',workspace:'456',botUser:'123',tokenSecret:'TOKEN',enabled:true,state:'connected',stateAt:at}).run();const receiver=new BridgeReceiver(db,clock,{discord:()=>undefined,slack:()=>undefined});let live=true;const receipts=liveDiscordReceipts(receiver,'connection','identity',()=>live),next={session:'session',url:'wss://gateway.discord.gg',seq:1},raw=(seq=1)=>Buffer.from(JSON.stringify({op:0,t:'READY',s:seq,d:{user:{id:'123'}}}));return {client,db,receiver,receipts,next,raw,retire:()=>{live=false;}};
}
it('commits the original raw frame and the cursor together before exposing a copy of the cursor',()=>{
 const f=fixture(),raw=f.raw(),original=Buffer.from(raw);f.receipts.retain(raw,f.next);raw.fill(0);expect(f.db.select().from(bridgeRawEvents).get()?.event).toEqual(original);expect(f.db.select().from(bridgeResume).get()).toMatchObject({session:'session',sequence:1,resumeUrl:'wss://gateway.discord.gg'});const loaded=f.receipts.checkpoint()!;loaded.seq=999;expect(f.receipts.checkpoint()?.seq).toBe(1);
});
it('gives the cursor only to the credential identity that stored it, and lets another replace it without a reset',()=>{
 const f=fixture();f.receipts.retain(f.raw(),f.next);
 const other=liveDiscordReceipts(f.receiver,'connection','another credential',()=>true);
 expect(other.checkpoint()).toBeUndefined();
 other.retain(f.raw(),{...f.next,session:'fresh'});expect(other.checkpoint()).toEqual({...f.next,session:'fresh'});
 expect(f.receipts.checkpoint()).toBeUndefined();expect(f.db.select().from(bridgeResume).all()).toHaveLength(1);
});
it('resumes after a restart from the cursor the last lifetime stored',()=>{
 const f=fixture();f.receipts.retain(f.raw(),f.next);f.receipts.retain(f.raw(2),{...f.next,seq:2});
 // A new process builds a new receipts object over the same database.
 const restarted=liveDiscordReceipts(new BridgeReceiver(f.db,new FakeClock(),{discord:()=>undefined,slack:()=>undefined}),'connection','identity',()=>true);
 expect(restarted.checkpoint()).toEqual({...f.next,seq:2});
 // Discord replays from there; a replayed frame is the same receipt, not a second one.
 restarted.retain(f.raw(2),{...f.next,seq:2});restarted.retain(f.raw(3),{...f.next,seq:3});
 expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(3);expect(restarted.checkpoint()?.seq).toBe(3);
});
it('never advances its cursor when raw persistence fails',()=>{
 const f=fixture();f.client.exec("CREATE TRIGGER no_receipt BEFORE INSERT ON bridge_raw_events BEGIN SELECT RAISE(ABORT, 'Synthetic disk failure'); END");expect(()=>f.receipts.retain(f.raw(),f.next)).toThrow('Synthetic disk failure');expect(f.receipts.checkpoint()).toBeUndefined();expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);
});
it('requires reset before changing sessions or rewinding and retains raw when the cursor resets',()=>{
 const f=fixture();f.receipts.retain(f.raw(),f.next);for(const next of [{...f.next,seq:0},{...f.next,session:'other'},{...f.next,url:'wss://gateway-us-east1.discord.gg'}])expect(()=>f.receipts.retain(f.raw(next.seq),next)).toThrow('lifetime');expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);f.receipts.reset();expect(f.receipts.checkpoint()).toBeUndefined();f.receipts.retain(f.raw(),{...f.next,session:'other'});expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(2);
});
it('fences old load and receipt callbacks after retirement without touching SQLite',()=>{
 const f=fixture();f.retire();expect(()=>f.receipts.retain(f.raw(),f.next)).toThrow('lifetime');expect(()=>f.receipts.checkpoint()).toThrow('lifetime');expect(()=>f.receipts.reset()).toThrow('lifetime');expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);
});
it('refuses a commit whose lifetime ended during the durable receiver call',()=>{
 const f=fixture();let live=true;const receipts=liveDiscordReceipts({discord(...args){f.receiver.discord(...args);live=false;},checkpoint:(id,identity)=>f.receiver.checkpoint(id,identity),reset:id=>f.receiver.reset(id)},'connection','identity',()=>live);expect(()=>receipts.retain(f.raw(),f.next)).toThrow('lifetime');expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);
});
it('preserves the existing receiver default of persistent cursor advancement for other callers',()=>{
 const f=fixture();f.receiver.discord('connection',f.raw(),{session:f.next.session,sequence:f.next.seq,resumeUrl:f.next.url,identity:'identity'});expect(f.db.select().from(bridgeResume).get()).toMatchObject({session:'session',sequence:1,resumeUrl:'wss://gateway.discord.gg'});
});
