import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { discordGateway, type DiscordGatewayOptions, type DiscordCheckpoint } from './discord-gateway.js';
import { FakeClock } from '../../core/index.js';
class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn((_text: string, callback: (error?: Error) => void) => callback());
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close',1006); });
  frame(f: unknown) { this.emit('message',Buffer.from(JSON.stringify(f)),false); }
  hello() { this.frame({op:10,d:{heartbeat_interval:10_000}}); }
  sent() { return this.send.mock.calls.map(([s]) => JSON.parse(s)); }
}
class TrackingClock extends FakeClock {
  active = new Set<object>();
  override at(time:number,fn:()=>void) {
    const key={}; this.active.add(key);
    const cancel=super.at(time,()=>{this.active.delete(key);fn();});
    return ()=>{this.active.delete(key);cancel();};
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function settled() { for (let i=0;i<50;i++) await Promise.resolve(); }
async function until(check:()=>boolean) { for(let n=0;n<2000&&!check();n++) await Promise.resolve(); expect(check()).toBe(true); }
const ready = (seq=1) => ({op:0,t:'READY',s:seq,d:{user:{id:'123'},session_id:'private-session',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg'}});
const message = (seq=2) => ({op:0,t:'MESSAGE_CREATE',s:seq,d:{id:'777',content:'hello'}});
function fixture(overrides: Partial<DiscordGatewayOptions> = {}) {
  const clock = new FakeClock(), sockets: Socket[] = [];
  let saved: DiscordCheckpoint | undefined;
  const load = vi.fn(() => saved);
  const commit = vi.fn(async (_event: unknown,next: DiscordCheckpoint) => { saved = {...next}; });
  const reset = vi.fn(async () => { saved = undefined; });
  const withValue = vi.fn(async <T>(_name: string,use: (value: string) => Promise<T>) => use('PRIVATE-TOKEN'));
  const socket = vi.fn((_url: string) => { const s = new Socket(); sockets.push(s); return s as unknown as ReturnType<NonNullable<DiscordGatewayOptions['socket']>>; });
  const beforeConnect = vi.fn(() => true);
  const transport = discordGateway({bot:'123',tokenSecret:'discord-token',clock,secrets:{withValue},load,commit,reset,socket,beforeConnect,random:()=>0.5,...overrides});
  cleanups.push(transport.close);
  return {clock,sockets,load,commit,reset,withValue,socket,beforeConnect,transport,saved:()=>saved};
}
async function identified(f: ReturnType<typeof fixture>) { await settled(); const s=f.sockets[0]; s.hello(); await settled(); return s; }
async function connected(f: ReturnType<typeof fixture>) { const s=await identified(f); s.frame(ready()); await settled(); return s; }
async function retry(f: ReturnType<typeof fixture>,delay=1000) { await settled(); f.clock.advance(delay); await settled(); return f.sockets.at(-1)!; }
describe('Discord gateway session transport',()=>{
  it('uses fixed Discord JSON v10 and current service credential only in Identify',async()=>{
    const f=fixture(); await settled(); expect(f.withValue).not.toHaveBeenCalled();
    expect(f.socket).toHaveBeenCalledExactlyOnceWith('wss://gateway.discord.gg/?v=10&encoding=json', {maxPayload:1024*1024,followRedirects:false,perMessageDeflate:false,handshakeTimeout:15_000});
    const s=await identified(f);
    expect(s.sent()).toEqual([{op:2,d:{token:'PRIVATE-TOKEN',intents:37377,properties:{os:'linux',browser:'loom',device:'loom'}}}]);
    expect(f.withValue.mock.calls[0][0]).toBe('discord-token');
    s.frame(ready()); await settled(); expect(f.saved()).toEqual({session:'private-session',url:'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json',seq:1});
  });
  it('resumes committed sequence on returned host with fresh credentials; accepts replay before RESUMED',async()=>{
    const f=fixture(),s=await connected(f); s.frame(message()); await settled(); s.frame({op:7});
    const next=await retry(f); expect(f.socket.mock.calls[1][0]).toBe('wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json');
    next.hello(); await settled(); expect(next.sent()[0]).toEqual({op:6,d:{token:'PRIVATE-TOKEN',session_id:'private-session',seq:2}});
    expect(f.withValue).toHaveBeenCalledTimes(2);
    next.frame(message(3)); next.frame({op:0,t:'RESUMED',s:4,d:{}}); await settled();
    expect(f.commit.mock.calls.map(([event])=>event)).toEqual([
      {type:'READY',data:ready().d,seq:1},{type:'MESSAGE_CREATE',data:message().d,seq:2},
      {type:'MESSAGE_CREATE',data:message().d,seq:3},{type:'RESUMED',data:{},seq:4},
    ]); expect(f.saved()?.seq).toBe(4);
  });
  it('serializes commit and reconnect waits for the durable in-flight cursor; queued frames replay',async()=>{
    let finish!:()=>void;
    let saved:DiscordCheckpoint|undefined; let count=0;
    const g=fixture({load:()=>saved,commit:async (_event,next)=>{if(++count===2) await new Promise<void>(r=>{finish=r;}); saved={...next};}});
    const a=await connected(g); a.frame(message(2)); a.frame(message(3)); await settled(); a.emit('close',1006);
    g.clock.advance(60_000); await settled(); expect(g.sockets).toHaveLength(1); expect(saved?.seq).toBe(1);
    finish(); await settled(); const b=await retry(g); b.hello(); await settled(); expect(b.sent()[0].d.seq).toBe(2);
    expect(saved?.seq).toBe(2); expect(count).toBe(2);
  });
  it('failed receipt keeps previous cursor and retries through resume',async()=>{
    const f=fixture(),s=await connected(f); f.commit.mockRejectedValueOnce(Error('private')); s.frame(message(2)); s.frame(message(3)); await settled();
    expect(f.saved()?.seq).toBe(1); expect(f.commit).toHaveBeenCalledTimes(2);
    const b=await retry(f); b.hello(); await settled(); expect(b.sent()[0].d.seq).toBe(1);
  });
  it('queues READY and messages without waiting for the first write',async()=>{
    let release!:()=>void; let count=0;
    const f=fixture({commit:async()=>{if(++count===1) await new Promise<void>(r=>{release=r;});}}),s=await identified(f);
    s.frame(ready()); s.frame(message()); await settled(); expect(count).toBe(1); release(); await settled(); expect(count).toBe(2);
  });
  it('uses received sequence in heartbeats without advancing the durable resume cursor',async()=>{
    let release!:()=>void;
    const f=fixture(),s=await connected(f); f.commit.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));
    s.frame(message(2)); await settled(); f.clock.advance(4999); expect(s.sent()).toHaveLength(1);
    f.clock.advance(1); expect(s.sent().at(-1)).toEqual({op:1,d:2}); expect(f.saved()?.seq).toBe(1);
    s.frame({op:11}); f.clock.advance(10_000); expect(s.sent().filter(v=>v.op===1)).toHaveLength(2);
    f.clock.advance(10_000); expect(s.terminate).toHaveBeenCalledOnce(); release(); await settled();
  });
  it('answers server heartbeats immediately without shifting periodic schedule',async()=>{
    const f=fixture(),s=await connected(f); s.frame({op:1}); await settled(); expect(s.sent().at(-1)).toEqual({op:1,d:1});
    s.frame({op:11}); f.clock.advance(5000); expect(s.sent().filter(v=>v.op===1)).toHaveLength(2);
  });
  it.each([false,true])('invalid session %s resets only when nonresumable and waits five seconds',async resumable=>{
    const f=fixture(),s=await connected(f); s.frame({op:9,d:resumable}); await settled();
    expect(f.reset).toHaveBeenCalledTimes(resumable?0:1);
    f.clock.advance(4999); await settled(); expect(f.sockets).toHaveLength(1);
    f.clock.advance(1); await settled(); const b=f.sockets[1]; b.hello(); await settled(); expect(b.sent()[0].op).toBe(resumable?6:2);
  });
  it.each([4007,4009])('resets cursor on nonresumable close %s',async code=>{
    const f=fixture(),s=await connected(f); s.emit('close',code); const b=await retry(f,5000); b.hello(); await settled();
    expect(f.reset).toHaveBeenCalledOnce(); expect(b.sent()[0].op).toBe(2);
  });
  it.each([4004,4010,4011,4012,4013,4014])('stops on fatal code %s without an Identify loop',async code=>{
    const f=fixture(),s=await connected(f); s.emit('close',code); f.clock.advance(3_600_000); await settled();
    expect(f.sockets).toHaveLength(1); expect(f.withValue).toHaveBeenCalledOnce(); expect(f.reset).not.toHaveBeenCalled();
  });
  it('rechecks lifetime after holder acquisition and close awaits it',async()=>{
    let acquire!:()=>void,done=false;
    const withValue=async<T>(_name:string,use:(v:string)=>Promise<T>)=>{await new Promise<void>(r=>{acquire=r;}); return use('PRIVATE');};
    const f=fixture({secrets:{withValue}}),s=await identified(f); const close=f.transport.close().then(()=>{done=true;}); await settled(); expect(done).toBe(false);
    acquire(); await close; expect(s.send).not.toHaveBeenCalled(); f.clock.advance(60_000); await settled(); expect(f.sockets).toHaveLength(1);
  });
  it('close waits for receipt and skips queued work and late frames',async()=>{
    let release!:()=>void,done=false;
    const f=fixture(),s=await connected(f); f.commit.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));
    s.frame(message(2)); s.frame(message(3)); await settled(); const closing=f.transport.close().then(()=>{done=true;});
    s.frame(message(4)); await settled(); expect(done).toBe(false); release(); await closing;
    expect(f.commit).toHaveBeenCalledTimes(2); f.clock.advance(60_000); await settled(); expect(f.sockets).toHaveLength(1);
  });
  it('checks staging before dial and inside credential write',async()=>{
    const gate=vi.fn(()=>false); const f=fixture({beforeConnect:gate}); await settled(); expect(f.socket).not.toHaveBeenCalled(); expect(f.withValue).not.toHaveBeenCalled();
    gate.mockReturnValue(true); const s=await retry(f); gate.mockReturnValue(false); s.hello(); await settled(); expect(s.send).not.toHaveBeenCalled();
  });
  it.each(['wss://evil.example/','wss://gateway.discord.gg.evil.example/','https://gateway.discord.gg/','wss://user:pass@gateway.discord.gg/','wss://gateway.discord.gg:8443/','wss://gateway.discord.gg/private','wss://gateway.discord.gg/#private'])('rejects unsafe persisted host %s before dial',async url=>{
    const f=fixture({load:()=>({session:'private',seq:1,url})}); await settled(); expect(f.socket).not.toHaveBeenCalled(); expect(f.withValue).not.toHaveBeenCalled();
  });
  it.each([null,[],{op:10,d:{heartbeat_interval:0}},{op:10,d:{heartbeat_interval:Infinity}},{op:0,s:1,t:'READY',d:{}},{op:9,d:'false'}])('disconnects malformed frame %j without committing',async frame=>{
    const f=fixture(); await settled(); f.sockets[0].frame(frame); await settled(); expect(f.sockets[0].terminate).toHaveBeenCalledOnce(); expect(f.commit).not.toHaveBeenCalled();
  });
  it('rejects READY bot mismatch and unsafe resume host without persisting them',async()=>{
    for (const d of [{...ready().d,user:{id:'other'}},{...ready().d,resume_gateway_url:'wss://evil.example/'}]) {
      const f=fixture(),s=await identified(f); s.frame({...ready(),d}); await settled(); expect(f.commit).not.toHaveBeenCalled(); expect(s.terminate).toHaveBeenCalledOnce();
    }
  });
  it('bounds the receipt backlog and frames before writes',async()=>{
    const f=fixture(),s=await identified(f); s.frame(ready()); for(let n=2;n<=65;n++) s.frame(message(n));
    await settled(); expect(s.terminate).toHaveBeenCalledOnce(); expect(f.commit).not.toHaveBeenCalled();
    const g=fixture(),t=await connected(g); t.frame({...message(),d:{content:'x'.repeat(1024*1024)}}); await settled(); expect(g.commit).toHaveBeenCalledOnce(); expect(t.terminate).toHaveBeenCalledOnce();
  });
  it('recovers the full 64-dispatch capacity after overflowing a retired connection',async()=>{
    const clock=new TrackingClock(),f=fixture({clock}),a=await identified(f); a.frame(ready()); for(let n=2;n<=65;n++) a.frame(message(n));
    await until(()=>clock.active.size===1); expect(a.terminate).toHaveBeenCalledOnce(); expect(f.commit).not.toHaveBeenCalled();
    clock.advance(5000); await settled(); const b=f.sockets[1]; b.hello(); await settled(); b.frame(ready()); for(let n=2;n<=64;n++) b.frame(message(n));
    await until(()=>f.saved()?.seq===64 || b.terminate.mock.calls.length>0); expect(b.terminate).not.toHaveBeenCalled(); expect(f.commit).toHaveBeenCalledTimes(64); expect(f.saved()?.seq).toBe(64);
  });
  it('times out silent gateway and missing READY; write errors reconnect',async()=>{
    const f=fixture(); await settled(); f.clock.advance(15_000); await settled(); expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
    const g=fixture(),s=await identified(g); g.clock.advance(15_000); await settled(); expect(s.terminate).toHaveBeenCalledOnce();
    const h=fixture(); await settled(); h.sockets[0].send.mockImplementationOnce((_t,cb)=>cb(Error('private'))); await identified(h); expect(h.sockets[0].terminate).toHaveBeenCalledOnce();
  });
  it('resumes only atomically stored raw receipts after daemon restart; rollback replays a failed write',async()=>{
    const home=mkdtempSync(join(tmpdir(),'discord-gateway-')); let app=await startLoom({home});
    try {
      app.db.exec('CREATE TABLE gateway_cursor (id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE gateway_events (seq INTEGER PRIMARY KEY, value TEXT)');
      let fail=false;
      const store={
        load:()=>{const row=app.db.prepare('SELECT value FROM gateway_cursor WHERE id=1').get() as {value:string}|undefined; return row?JSON.parse(row.value) as DiscordCheckpoint:undefined;},
        reset:async()=>{app.db.prepare('DELETE FROM gateway_cursor').run();},
        commit:async(event:unknown,next:DiscordCheckpoint)=>{app.db.transaction(()=>{
          app.db.prepare('INSERT OR IGNORE INTO gateway_events VALUES (?,?)').run(next.seq,JSON.stringify(event));
          if(fail) throw Error('fixture interrupted transaction');
          app.db.prepare('INSERT OR REPLACE INTO gateway_cursor VALUES (1,?)').run(JSON.stringify(next));
        })();},
      };
      const f=fixture(store),a=await connected(f); fail=true; a.frame(message(2)); await settled();
      expect(store.load()?.seq).toBe(1); expect(app.db.prepare('SELECT seq FROM gateway_events').all()).toEqual([{seq:1}]);
      await f.transport.close(); await app.close(); app=await startLoom({home}); fail=false;
      const g=fixture(store); await settled(); g.sockets[0].hello(); await settled(); expect(g.sockets[0].sent()[0].d.seq).toBe(1);
      g.sockets[0].frame(message(2)); g.sockets[0].frame({op:0,t:'RESUMED',s:3,d:{}}); await settled();
      expect(store.load()?.seq).toBe(3); expect(app.db.prepare('SELECT seq FROM gateway_events ORDER BY seq').all()).toEqual([{seq:1},{seq:2},{seq:3}]);
      await g.transport.close();
    } finally {await app.close(); rmSync(home,{recursive:true,force:true});}
  });
  it('allows separate 15-second connection, credential acquisition and READY waits',async()=>{
    let acquire!:()=>void;
    const withValue=async<T>(_name:string,use:(v:string)=>Promise<T>)=>{await new Promise<void>(r=>{acquire=r;});return use('PRIVATE');};
    const f=fixture({secrets:{withValue}}); await settled(); const s=f.sockets[0];
    f.clock.advance(14_000); s.hello(); await settled(); f.clock.advance(14_000); expect(s.terminate).not.toHaveBeenCalled();
    acquire(); await settled(); expect(s.sent().some(frame=>frame.op===2)).toBe(true);
    // The first heartbeat from HELLO needs its ACK before the next periodic beat.
    s.frame({op:11}); f.clock.advance(9999); s.frame({op:11}); f.clock.advance(4000);
    expect(s.terminate).not.toHaveBeenCalled(); s.frame(ready()); await settled(); expect(f.commit).toHaveBeenCalledOnce();
  });
  it('expires a missing READY fifteen seconds after successful authentication',async()=>{
    const f=fixture(); await settled(); f.clock.advance(14_000); const s=f.sockets[0]; s.hello(); await settled();
    f.clock.advance(5000); s.frame({op:11}); f.clock.advance(9999); expect(s.terminate).not.toHaveBeenCalled();
    f.clock.advance(1); expect(s.terminate).toHaveBeenCalledOnce();
  });
  it('keeps Identify and Resume socket writes inside the active credential callback until completion',async()=>{
    let active=false,finish!:()=>void;
    const withValue=async<T>(_name:string,use:(v:string)=>Promise<T>)=>{active=true;try{return await use('PRIVATE');}finally{active=false;}};
    const f=fixture({secrets:{withValue}}); await settled(); const a=f.sockets[0];
    a.send.mockImplementationOnce((_text,callback)=>{expect(active).toBe(true);finish=()=>callback();});
    a.hello(); await settled(); expect(active).toBe(true); finish(); await settled(); expect(active).toBe(false);
    a.frame(ready()); await settled(); a.emit('close',1006); const b=await retry(f);
    b.send.mockImplementationOnce((_text,callback)=>{expect(active).toBe(true);finish=()=>callback();});
    b.hello(); await settled(); expect(b.sent()[0].op).toBe(6); expect(active).toBe(true); finish(); await settled(); expect(active).toBe(false);
  });
  it('does not Identify again within five seconds even after a failed socket write',async()=>{
    const f=fixture(); await settled(); f.sockets[0].send.mockImplementationOnce((_text,callback)=>callback(Error('failed')));
    await identified(f); expect(f.withValue).toHaveBeenCalledOnce();
    const b=await retry(f); b.hello(); await settled(); expect(b.send).not.toHaveBeenCalled(); expect(f.withValue).toHaveBeenCalledOnce();
    const c=await retry(f,2000); c.hello(); await settled(); expect(c.send).not.toHaveBeenCalled();
    const d=await retry(f,4000); d.hello(); await settled(); expect(d.sent()[0].op).toBe(2); expect(f.withValue).toHaveBeenCalledTimes(2);
  });
  it.each(['deadline','heartbeat','retry'])('close removes every timer during %s',async phase=>{
    const clock=new TrackingClock(); const f=fixture({clock}); await settled(); const s=f.sockets[0];
    if(phase==='heartbeat') {s.hello();await settled();s.frame(ready());await settled();}
    if(phase==='retry') {s.emit('close',1006);await settled();}
    expect(clock.active.size).toBeGreaterThan(0); await f.transport.close(); expect(clock.active.size).toBe(0);
  });
  it('caps reconnect backoff and cancels scheduled retries on close',async()=>{
    const socket=vi.fn(()=>{throw Error('private');}); const f=fixture({socket}); await settled();
    for(const delay of [1000,2000,4000,8000,16000,32000,60000,60000]) {
      const count=socket.mock.calls.length; f.clock.advance(delay-1); await settled(); expect(socket).toHaveBeenCalledTimes(count);
      f.clock.advance(1); await settled(); expect(socket).toHaveBeenCalledTimes(count+1);
    }
    await f.transport.close(); const count=socket.mock.calls.length; f.clock.advance(60000); await settled(); expect(socket).toHaveBeenCalledTimes(count);
  });
});
