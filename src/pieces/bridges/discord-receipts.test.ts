import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {createDataSchema} from '../../core/data/database.js';
import {FakeClock} from '../../core/clock.js';
import {members,agents,secrets,bridgeConnections,bridgeRawEvents,bridgeResume} from '../../core/data/schema.js';
import {BridgeReceiver} from './receiver.js';
import {liveDiscordReceipts} from './discord-receipts.js';
const clients:Database.Database[]=[];afterEach(()=>{for(const client of clients.splice(0))client.close();});
function fixture(){
 const client=new Database(':memory:');clients.push(client);const db=createDataSchema(client),clock=new FakeClock(),at=new Date(clock.now()).toISOString();db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(secrets).values({name:'TOKEN',description:'',changedAt:at,changedBy:'owner'}).run();db.insert(bridgeConnections).values({id:'connection',platform:'discord',agent:'art',workspace:'456',botUser:'123',tokenSecret:'TOKEN',enabled:true,state:'connected',stateAt:at}).run();const receiver=new BridgeReceiver(db,clock,{discord:()=>undefined,slack:()=>undefined});let live=true;const receipts=liveDiscordReceipts(receiver,'connection',()=>live),next={session:'session',url:'wss://gateway.discord.gg',seq:1},raw=(seq=1)=>Buffer.from(JSON.stringify({op:0,t:'READY',s:seq,d:{user:{id:'123'}}}));return {client,db,receiver,receipts,next,raw,retire:()=>{live=false;}};
}
it('commits original raw before exposing a copied memory cursor and never writes a persistent cursor',()=>{
 const f=fixture(),raw=f.raw(),original=Buffer.from(raw);f.receipts.retain(raw,f.next);raw.fill(0);expect(f.db.select().from(bridgeRawEvents).get()?.event).toEqual(original);expect(f.db.select().from(bridgeResume).all()).toEqual([]);const loaded=f.receipts.checkpoint()!;loaded.seq=999;expect(f.receipts.checkpoint()?.seq).toBe(1);
});
it('starts fresh after restart even if an old persistent cursor exists',()=>{
 const f=fixture();f.db.insert(bridgeResume).values({connection:'connection',session:'old',sequence:999,resumeUrl:'wss://gateway.discord.gg'}).run();expect(f.receipts.checkpoint()).toBeUndefined();f.receipts.retain(f.raw(),f.next);expect(liveDiscordReceipts(f.receiver,'connection',()=>true).checkpoint()).toBeUndefined();expect(f.db.select().from(bridgeResume).get()?.session).toBe('old');
});
it('never advances its cursor when raw persistence fails',()=>{
 const f=fixture();f.client.exec("CREATE TRIGGER no_receipt BEFORE INSERT ON bridge_raw_events BEGIN SELECT RAISE(ABORT, 'Synthetic disk failure'); END");expect(()=>f.receipts.retain(f.raw(),f.next)).toThrow('Synthetic disk failure');expect(f.receipts.checkpoint()).toBeUndefined();expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);
});
it('requires reset before changing sessions or rewinding and retains raw when memory resets',()=>{
 const f=fixture();f.receipts.retain(f.raw(),f.next);for(const next of [{...f.next,seq:0},{...f.next,session:'other'},{...f.next,url:'wss://gateway-us-east1.discord.gg'}])expect(()=>f.receipts.retain(f.raw(next.seq),next)).toThrow('lifetime');expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);f.receipts.reset();expect(f.receipts.checkpoint()).toBeUndefined();f.receipts.retain(f.raw(),{...f.next,session:'other'});expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(2);
});
it('fences old load and receipt callbacks after retirement without touching SQLite',()=>{
 const f=fixture();f.retire();expect(()=>f.receipts.retain(f.raw(),f.next)).toThrow('lifetime');expect(()=>f.receipts.checkpoint()).toThrow('lifetime');expect(f.db.select().from(bridgeRawEvents).all()).toEqual([]);
});
it('rechecks retirement after the real durable receiver call before exposing the cursor',()=>{
 const f=fixture();let live=true;const receipts=liveDiscordReceipts({discord(...args){f.receiver.discord(...args);live=false;}},'connection',()=>live);expect(()=>receipts.retain(f.raw(),f.next)).toThrow('lifetime');expect(f.db.select().from(bridgeRawEvents).all()).toHaveLength(1);live=true;expect(receipts.checkpoint()).toBeUndefined();
});
it('preserves the existing receiver default of persistent cursor advancement for other callers',()=>{
 const f=fixture();f.receiver.discord('connection',f.raw(),{session:f.next.session,sequence:f.next.seq,resumeUrl:f.next.url});expect(f.db.select().from(bridgeResume).get()).toMatchObject({session:'session',sequence:1,resumeUrl:'wss://gateway.discord.gg'});
});
