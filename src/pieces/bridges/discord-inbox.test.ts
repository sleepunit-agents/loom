import { EventEmitter } from 'node:events';
import { discordGateway, type DiscordGatewayOptions } from './discord-gateway.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, openDb, migrate } from '../../core/index.js';
import { installBridges } from './index.js';
import { venueSchema } from './model.js';
import { put } from './store.js';
import { discordInbox } from './discord-inbox.js';
import { schema as initial } from './schema/001.js';
import { schema as retry } from './schema/002.js';
import { schema as slack } from './schema/003.js';
import { schema as discord } from './schema/004.js';
const homes:string[]=[], closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0)) await close();for(const home of homes.splice(0)) rmSync(home,{recursive:true,force:true});});
const venue=venueSchema.parse({id:'discord',platform:'discord',workspace:'100',bot:'200',agent:'art',tokenSecret:'bot'});
const cursor=(seq:number,session='SESSION_PRIVATE')=>({session,url:'wss://gateway.discord.gg/?v=10&encoding=json',seq});
const ready=(seq=1)=>({type:'READY',seq,data:{user:{id:'200'},session_id:'SESSION_PRIVATE'}});
const message=(seq=2,id='300',text='PRIVATE WORDS')=>({type:'MESSAGE_CREATE',seq,data:{id,channel_id:'400',guild_id:'100',content:text}});
async function fixture(existing?:string) {
 const home=existing??mkdtempSync(join(tmpdir(),'discord-inbox-'));if(!existing)homes.push(home);
 const clock=new FakeClock(1000);const app=await startLoom({home,clock,install:app=>installBridges(app,()=>({members:{},projects:{},services:{}}))});
 let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};closes.push(close);
 if(!existing)put(app.db,'venues',venue);
 let epoch='generation-one';const inbox=discordInbox(app.db,clock,{venue,credentialEpoch:epoch},()=>epoch);
 return {app,clock,home,close,inbox,epoch:(value:string)=>{epoch=value;}};
}
it('atomically persists words and resume cursor through restart, preserving first receipt across sessions',async()=>{
 const f=await fixture();await f.inbox.commit(ready(),cursor(1));await f.inbox.commit(message(),cursor(2));const rows=f.inbox.pending();
 await f.close();const g=await fixture(f.home);expect(g.inbox.load()).toEqual(cursor(2));expect(g.inbox.pending()).toEqual(rows);
 await g.inbox.reset();await g.close();const h=await fixture(f.home);
 expect(h.inbox.load()).toBeUndefined();expect(h.inbox.pending()).toEqual(rows);
 await h.inbox.commit(ready(),cursor(1));await h.inbox.commit(message(2,'300','CHANGED'),cursor(2));expect(h.inbox.pending()).toEqual(rows);
 h.inbox.consume(rows[0].id);await h.close();const j=await fixture(f.home);
 expect(j.inbox.load()).toEqual(cursor(2));await j.inbox.commit(message(3),cursor(3));expect(j.inbox.pending()).toEqual([]);
 expect(j.app.db.prepare('SELECT event,state FROM bridges_discord_receipts').get()).toEqual({event:null,state:'consumed'});
});
it.each(['receipt','checkpoint'])('rolls back both sides on failed %s write',async target=>{
 const f=await fixture();await f.inbox.commit(ready(),cursor(1));
 f.app.db.exec(target==='receipt'?"CREATE TRIGGER fail BEFORE INSERT ON bridges_discord_receipts BEGIN SELECT RAISE(ABORT,'fail'); END;":"CREATE TRIGGER fail BEFORE UPDATE ON bridges_discord_sessions BEGIN SELECT RAISE(ABORT,'fail'); END;");
 await expect(f.inbox.commit(message(),cursor(2))).rejects.toThrow();expect(f.inbox.load()).toEqual(cursor(1));expect(f.inbox.pending()).toEqual([]);
 await f.close();const g=await fixture(f.home);expect(g.inbox.load()).toEqual(cursor(1));expect(g.inbox.pending()).toEqual([]);
});
it('refuses enclosing transactions for every entrypoint',async()=>{
 const f=await fixture();let commit!:Promise<void>,reset!:Promise<void>;
 f.app.db.transaction(()=>{commit=f.inbox.commit(ready(),cursor(1));reset=f.inbox.reset();expect(()=>f.inbox.load()).toThrow('own transaction');expect(()=>f.inbox.pending()).toThrow('own transaction');expect(()=>f.inbox.consume('x')).toThrow('own transaction');})();
 await expect(commit).rejects.toThrow('own transaction');await expect(reset).rejects.toThrow('own transaction');expect(f.inbox.load()).toBeUndefined();
});
it.each(['setup','restore','credential'])('invalidates all old access after %s changes',async kind=>{
 const f=await fixture();await f.inbox.commit(ready(),cursor(1));await f.inbox.commit(message(),cursor(2));const [row]=f.inbox.pending();
 if(kind==='credential')f.epoch('generation-two');else{put(f.app.db,'venues',{...venue,enabled:false});if(kind==='restore')put(f.app.db,'venues',venue);}
 expect(()=>f.inbox.load()).toThrow('binding changed');expect(()=>f.inbox.pending()).toThrow('binding changed');expect(()=>f.inbox.consume(row.id)).toThrow('binding changed');await expect(f.inbox.reset()).rejects.toThrow('binding changed');await expect(f.inbox.commit(message(3),cursor(3))).rejects.toThrow('binding changed');
 if(kind==='credential') {
 const fresh=discordInbox(f.app.db,f.clock,{venue,credentialEpoch:'generation-two'},()=> 'generation-two');expect(fresh.load()).toBeUndefined();expect(fresh.pending()).toEqual([]);expect(()=>fresh.consume(row.id)).toThrow('Unknown');
 }
});
it('rejects wrong READY identity, missing session, stale cursor and session replacement without reset',async()=>{
 const f=await fixture();await expect(f.inbox.commit(message(),cursor(2))).rejects.toThrow('requires READY');
 await expect(f.inbox.commit({...ready(),data:{user:{id:'999'},session_id:'SESSION_PRIVATE'}},cursor(1))).rejects.toThrow('READY');
 await f.inbox.commit(ready(),cursor(1));await expect(f.inbox.commit(message(1),cursor(1))).rejects.toThrow('Obsolete');await expect(f.inbox.commit(message(),cursor(2,'OTHER'))).rejects.toThrow('Obsolete');
 await expect(f.inbox.commit(message(),cursor(3))).rejects.toThrow('dispatch');expect(f.inbox.load()).toEqual(cursor(1));
});
it('stores only message words, retains independent ids, bounds and pages private reads',async()=>{
 const f=await fixture();await f.inbox.commit(ready(),cursor(1));expect(f.inbox.pending()).toEqual([]);
 await f.inbox.commit(message(),cursor(2));await f.inbox.commit(message(3,'301'),cursor(3));const rows=f.inbox.pending();expect(rows).toHaveLength(2);expect(f.inbox.pending(1,rows[0])).toEqual([rows[1]]);
 for(const limit of [0,65,NaN,1.1])expect(()=>f.inbox.pending(limit)).toThrow('limit');expect(()=>f.inbox.pending(1,{id:'x',received:0})).toThrow('cursor');expect(()=>f.inbox.consume('unknown')).toThrow('Unknown');
 const changes:unknown[]=[];const stop=f.app.live.observe(c=>changes.push(c));await f.inbox.commit({type:'TYPING_START',seq:4,data:{secret:'UNNEEDED'}},cursor(4));stop();expect(changes).toEqual([]);
 const receiptText=JSON.stringify(f.app.db.prepare('SELECT * FROM bridges_discord_receipts').all());expect(receiptText).not.toContain('SESSION_PRIVATE');expect(receiptText).not.toContain('UNNEEDED');
 expect(f.app.operations.call('direct',{kind:'service',id:'bridges'},'bridges.discordSessions',{},'private')).toMatchObject({ok:false});
});
it('rejects oversized words without advancing cursor',async()=>{
 const f=await fixture();await f.inbox.commit(ready(),cursor(1));await expect(f.inbox.commit(message(2,'300','x'.repeat(1024*1024)),cursor(2))).rejects.toThrow('too large');expect(f.inbox.load()).toEqual(cursor(1));expect(f.inbox.pending()).toEqual([]);
});

it('upgrades existing bridge tables without changing setup or Slack receipts and repeats safely',()=>{
 const home=mkdtempSync(join(tmpdir(),'discord-upgrade-'));homes.push(home);const lease=openDb(home);
 try {
 migrate(lease.db,'bridges',[...initial,...retry,...slack]);put(lease.db,'venues',venue);
 lease.db.prepare("INSERT INTO bridges_slack_receipts VALUES (?,?,?,?,?,'pending',?)").run('s','v','b','e','{}',1000);
 const before=lease.db.prepare('SELECT * FROM bridges_venues').all();
 migrate(lease.db,'bridges',[...initial,...retry,...slack,...discord]);migrate(lease.db,'bridges',[...initial,...retry,...slack,...discord]);
 expect(lease.db.prepare('SELECT * FROM bridges_venues').all()).toEqual(before);
 expect(lease.db.prepare('SELECT event FROM bridges_slack_receipts').get()).toEqual({event:'{}'});
 expect(lease.db.prepare('SELECT * FROM bridges_discord_sessions').all()).toEqual([]);
 }finally{lease.close();}
});
it('snapshots caller binding and rejects unsafe checkpoints without side effects',async()=>{
 const f=await fixture();const input={venue:structuredClone(venue),credentialEpoch:'generation-one'};
 const inbox=discordInbox(f.app.db,f.clock,input,()=> 'generation-one');input.venue.bot='999';input.credentialEpoch='changed';
 for(const patch of [{seq:-1},{session:''},{url:'wss://evil.example/'},{url:'wss://gateway.discord.gg/?ticket=secret'}])
 await expect(inbox.commit(ready(),{...cursor(1),...patch})).rejects.toThrow('checkpoint');
 await inbox.commit(ready(),cursor(1));expect(inbox.load()).toEqual(cursor(1));
});

it('real Gateway resumes the durable cursor after restart and retries failed raw commit',async()=>{
 class Socket extends EventEmitter {
 readyState=1;send=vi.fn((_text:string,done:(error?:Error)=>void)=>done());
 terminate(){this.readyState=3;this.emit('close',1006);}
 frame(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)),false);}
 }
 async function until(check:()=>boolean){for(let n=0;n<2000&&!check();n++)await Promise.resolve();expect(check()).toBe(true);}
 function connect(f:Awaited<ReturnType<typeof fixture>>){
 const sockets:Socket[]=[];const transport=discordGateway({bot:venue.bot,tokenSecret:venue.tokenSecret,clock:f.clock,
 secrets:{withValue:async<T>(_name:string,use:(value:string)=>Promise<T>)=>use('fixture-credential')},beforeConnect:()=>true,
 load:f.inbox.load,commit:f.inbox.commit,reset:f.inbox.reset,random:()=>0.5,
 socket:()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as ReturnType<NonNullable<DiscordGatewayOptions['socket']>>;}});
 closes.unshift(transport.close);return {sockets,transport};
 }
 const f=await fixture(),a=connect(f);await until(()=>a.sockets.length===1);const socket=a.sockets[0];
 socket.frame({op:10,d:{heartbeat_interval:10000}});await until(()=>socket.send.mock.calls.length===1);
 socket.frame({op:0,t:'READY',s:1,d:{...ready().data,resume_gateway_url:'wss://gateway.discord.gg'}});await until(()=>f.inbox.load()?.seq===1);
 f.app.db.exec("CREATE TRIGGER fail BEFORE UPDATE ON bridges_discord_sessions BEGIN SELECT RAISE(ABORT,'fail'); END;");
 socket.frame({op:0,t:'MESSAGE_CREATE',s:2,d:message().data});await until(()=>socket.readyState===3);
 expect(f.inbox.pending()).toEqual([]);expect(f.inbox.load()?.seq).toBe(1);
 await a.transport.close();f.app.db.exec('DROP TRIGGER fail');await f.close();
 const g=await fixture(f.home),b=connect(g);await until(()=>b.sockets.length===1);const resumed=b.sockets[0];
 resumed.frame({op:10,d:{heartbeat_interval:10000}});await until(()=>resumed.send.mock.calls.length===1);
 expect(JSON.parse(resumed.send.mock.calls[0][0])).toMatchObject({op:6,d:{session_id:'SESSION_PRIVATE',seq:1}});
 resumed.frame({op:0,t:'MESSAGE_CREATE',s:2,d:message().data});await until(()=>g.inbox.load()?.seq===2);expect(g.inbox.pending()).toHaveLength(1);
 await b.transport.close();
});
it.each([{bot:'201'},{workspace:'101'},{agent:'mark'},{id:'another-venue'},{tokenSecret:'replacement'}])('isolates a fresh receiving identity at unchanged credential generation %j',async patch=>{
 const f=await fixture();await f.inbox.commit(ready(),cursor(1));await f.inbox.commit(message(),cursor(2));const [old]=f.inbox.pending();
 const replacement={...venue,...patch};put(f.app.db,'venues',replacement);
 const fresh=discordInbox(f.app.db,f.clock,{venue:replacement,credentialEpoch:'generation-one'},()=> 'generation-one');
 expect(fresh.load()).toBeUndefined();expect(fresh.pending()).toEqual([]);expect(()=>fresh.consume(old.id)).toThrow('Unknown');
 await fresh.commit({...ready(),data:{user:{id:replacement.bot},session_id:'SESSION_PRIVATE'}},cursor(1));await fresh.commit(message(),cursor(2));
 const [next]=fresh.pending();expect(next.id).not.toBe(old.id);fresh.consume(next.id);
 expect(f.app.db.prepare('SELECT state,event FROM bridges_discord_receipts WHERE id=?').get(old.id)).toEqual({state:'pending',event:JSON.stringify(message().data)});
});
it('enforces requested and maximum page sizes with more eligible candidates',async()=>{
 const f=await fixture();await f.inbox.commit(ready(),cursor(1));
 for(let seq=2;seq<=71;seq++)await f.inbox.commit(message(seq,String(300+seq)),cursor(seq));
 expect(f.inbox.pending(1)).toHaveLength(1);expect(f.inbox.pending()).toHaveLength(32);
 const first=f.inbox.pending(64);expect(first).toHaveLength(64);const last=f.inbox.pending(64,first[63]);expect(last).toHaveLength(6);
 expect(new Set([...first,...last].map(row=>row.id)).size).toBe(70);
});
