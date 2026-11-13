import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../../core/index.js';
import { slackSocket, type SlackSocketOptions } from './slack-socket.js';
class FakeSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn((_text: string, callback: (error?: Error) => void) => callback());
  ping = vi.fn();
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  frame(data: unknown) { this.emit('message', Buffer.from(JSON.stringify(data)), false); }
  hello() { this.emit('open'); this.frame({type:'hello'}); }
}
class TrackingClock extends FakeClock {
  active = new Set<object>();
  override at(time: number, fn: () => void) {
    const key = {}; this.active.add(key);
    const cancel = super.at(time, () => { this.active.delete(key); fn(); });
    return () => { this.active.delete(key); cancel(); };
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function settled() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function fixture(overrides: Partial<SlackSocketOptions> = {}) {
  const clock = new FakeClock(), sockets: FakeSocket[] = [];
  const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ok:true,url:'wss://wss-primary.slack.com/link/?ticket=PRIVATE'}));
  const receive = vi.fn(async (_payload: Record<string,unknown>) => {});
  const withValue = vi.fn(async <T>(_name: string, use: (value: string) => Promise<T>): Promise<T> => use('APP-SECRET'));
  const socket = vi.fn((_url: string) => { const s = new FakeSocket(); sockets.push(s); return s as unknown as ReturnType<NonNullable<SlackSocketOptions['socket']>>; });
  const beforeConnect = vi.fn(() => true);
  const transport = slackSocket({appSecret:'slack-app',secrets:{withValue},clock,request:request as typeof fetch,receive,socket,beforeConnect,...overrides});
  cleanups.push(transport.close);
  return {clock,sockets,request,receive,withValue,socket,beforeConnect,transport};
}
const payload = {team_id:'T123',event:{type:'message',channel:'D123',user:'U123',ts:'1793828004.242749',text:'hello'}};
const envelope = (id='env-1') => ({type:'events_api',envelope_id:id,payload});
describe('Slack Socket Mode transport', () => {
  it('uses app withValue and bounded fixed-origin POST before dialing the private ticket', async () => {
    const f = fixture(); await settled();
    expect(f.withValue.mock.calls[0][0]).toBe('slack-app');
    expect(f.request.mock.calls[0]).toMatchObject(['https://slack.com/api/apps.connections.open', {
      method:'POST',redirect:'error',headers:{Authorization:'Bearer APP-SECRET'},signal:expect.any(AbortSignal),
    }]);
    expect(f.socket).toHaveBeenCalledWith('wss://wss-primary.slack.com/link/?ticket=PRIVATE');
    expect(f.beforeConnect).toHaveBeenCalledTimes(2);
  });
  it('does not ACK until the durable receiver resolves; preserves the raw payload', async () => {
    let commit!: () => void;
    const f = fixture({receive:vi.fn(() => new Promise<void>(resolve => { commit = resolve; }))});
    await settled(); const s = f.sockets[0]; s.hello(); s.frame(envelope()); await settled();
    expect(s.send).not.toHaveBeenCalled(); commit(); await settled();
    expect(s.send).toHaveBeenCalledExactlyOnceWith('{"envelope_id":"env-1"}',expect.any(Function));
  });
  it('serializes receipts, and never ACKs a failed write or queued work after disconnect', async () => {
    const f = fixture(); await settled(); const s = f.sockets[0]; s.hello();
    f.receive.mockRejectedValueOnce(Error('private failure'));
    s.frame(envelope()); s.frame(envelope('env-2')); await settled();
    expect(f.receive).toHaveBeenCalledTimes(1); expect(s.send).not.toHaveBeenCalled(); expect(s.terminate).toHaveBeenCalledOnce();
    f.clock.advance(1000); await settled(); expect(f.sockets).toHaveLength(2); expect(f.withValue).toHaveBeenCalledTimes(2);
  });
  it('never ACKs an in-flight receipt that finishes after shutdown', async () => {
    let commit!: () => void;
    const f = fixture({receive:() => new Promise<void>(resolve => { commit = resolve; })});
    await settled(); const s = f.sockets[0]; s.hello(); s.frame(envelope()); await settled();
    f.transport.close(); commit(); await settled(); f.clock.advance(120_000); await settled();
    expect(s.send).not.toHaveBeenCalled(); expect(f.sockets).toHaveLength(1);
  });
  it('checks staging before credentials and again before dial', async () => {
    const beforeConnect = vi.fn(() => false);
    const f = fixture({beforeConnect}); await settled(); expect(f.withValue).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled();
    beforeConnect.mockReturnValueOnce(true).mockReturnValue(false);
    f.clock.advance(1000); await settled(); expect(f.withValue).toHaveBeenCalledOnce(); expect(f.socket).not.toHaveBeenCalled();
  });
  it.each(['https://wss.slack.com/link','wss://evil.example/link','wss://wss.slack.com.evil.example',
    'wss://user:pass@wss.slack.com/link','wss://wss.slack.com:8443/link','wss://wss.slack.com/link#secret'])('refuses unsafe socket target %s', async url => {
    const f = fixture({request:vi.fn(async () => Response.json({ok:true,url})) as typeof fetch}); await settled(); expect(f.socket).not.toHaveBeenCalled();
  });
  it.each([{ok:false,url:'wss://wss.slack.com'}, {ok:true}, [], 'bad', null])('refuses incomplete API response %j', async body => {
    const f = fixture({request:vi.fn(async () => Response.json(body)) as typeof fetch}); await settled(); expect(f.socket).not.toHaveBeenCalled();
  });
  it('bounds HTTP body, and expires a stuck HTTP request with abort and backoff', async () => {
    const f = fixture({request:vi.fn(async () => Response.json({ok:true,url:'wss://wss.slack.com/link',padding:'x'.repeat(16_385)})) as typeof fetch}); await settled(); expect(f.socket).not.toHaveBeenCalled();
    const g = fixture({request:vi.fn((_url, init) => new Promise((_resolve,reject) => init?.signal?.addEventListener('abort',()=>reject(Error('PRIVATE'))))) as typeof fetch});
    await settled(); g.clock.advance(15_000); await settled(); expect(g.socket).not.toHaveBeenCalled();
    g.clock.advance(999); await settled(); expect(g.withValue).toHaveBeenCalledOnce();
    g.clock.advance(1); await settled(); expect(g.withValue).toHaveBeenCalledTimes(2);
  });
  it('closes late HTTP results after a timeout or shutdown without dialing', async () => {
    let finish!: (r: Response) => void;
    const f = fixture({request:vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch});
    await settled(); f.transport.close(); finish(Response.json({ok:true,url:'wss://wss.slack.com/link'})); await settled();
    expect(f.socket).not.toHaveBeenCalled(); f.clock.advance(120_000); await settled(); expect(f.withValue).toHaveBeenCalledOnce();
  });
  it('refreshes URLs on Slack disconnect, ignores obsolete frames and backs off failed opens', async () => {
    const f = fixture(); await settled(); const s = f.sockets[0]; s.hello(); s.frame({type:'disconnect',reason:'refresh_requested'});
    s.frame(envelope()); await settled(); expect(f.receive).not.toHaveBeenCalled();
    f.request.mockRejectedValueOnce(Error('PRIVATE')); f.clock.advance(1000); await settled();
    f.clock.advance(1999); await settled(); expect(f.withValue).toHaveBeenCalledTimes(2);
    f.clock.advance(1); await settled(); expect(f.sockets).toHaveLength(2);
  });
  it('waits for hello, pings, detects missed pong, and cancels heartbeat on close', async () => {
    const f = fixture(); await settled(); const s = f.sockets[0]; s.hello();
    f.clock.advance(30_000); expect(s.ping).toHaveBeenCalledOnce();
    s.emit('pong'); f.clock.advance(30_000); expect(s.ping).toHaveBeenCalledTimes(2);
    f.clock.advance(10_000); expect(s.terminate).toHaveBeenCalledOnce();
    f.transport.close(); f.clock.advance(120_000); await settled(); expect(f.sockets).toHaveLength(1);
  });
  it('expires a socket that never opens or never says hello', async () => {
    const f = fixture(); await settled(); f.clock.advance(15_000); expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
    const g = fixture(); await settled(); g.sockets[0].emit('open'); g.clock.advance(15_000); expect(g.sockets[0].terminate).toHaveBeenCalledOnce();
  });
  it.each([null,[],{type:'events_api'}, {type:'events_api',envelope_id:'x',payload:[]}, {type:'unknown',envelope_id:'x'}])('never ACKs malformed envelope %j', async frame => {
    const f = fixture(); await settled(); const s = f.sockets[0]; s.hello(); s.frame(frame); await settled();
    expect(s.send).not.toHaveBeenCalled(); expect(s.terminate).toHaveBeenCalledOnce();
  });
  it('bounds queued envelopes even if the receiver stalls', async () => {
    const f = fixture({receive:() => new Promise<void>(()=>{})}); await settled(); const s = f.sockets[0]; s.hello();
    for (let i=0; i<65; i++) s.frame(envelope(String(i)));
    await settled(); expect(s.terminate).toHaveBeenCalledOnce(); expect(s.send).not.toHaveBeenCalled();
  });
  it('bounds otherwise-valid event frames before receipt or ACK', async () => {
    const f = fixture(); await settled(); const s = f.sockets[0]; s.hello();
    s.frame({...envelope(),payload:{...payload,event:{...payload.event,text:'x'.repeat(1024*1024)}}}); await settled();
    expect(s.terminate).toHaveBeenCalledOnce(); expect(f.receive).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled();
  });
  it('caps exponential backoff at 60 seconds and resets after hello', async () => {
    const request = vi.fn(async (): Promise<Response> => { throw Error('unavailable'); });
    const f = fixture({request:request as typeof fetch}); await settled();
    for (const delay of [1000,2000,4000,8000,16000,32000,60000,60000]) {
      const count = f.withValue.mock.calls.length;
      f.clock.advance(delay-1); await settled(); expect(f.withValue).toHaveBeenCalledTimes(count);
      f.clock.advance(1); await settled(); expect(f.withValue).toHaveBeenCalledTimes(count+1);
    }
    request.mockResolvedValueOnce(Response.json({ok:true,url:'wss://wss.slack.com/link'}));
    f.clock.advance(60000); await settled(); const s = f.sockets[0]; s.hello(); s.emit('close');
    const count = f.withValue.mock.calls.length;
    f.clock.advance(999); await settled(); expect(f.withValue).toHaveBeenCalledTimes(count);
    f.clock.advance(1); await settled(); expect(f.withValue).toHaveBeenCalledTimes(count+1);
  });
  it('aborts the pending HTTP request on shutdown', async () => {
    let signal: AbortSignal | undefined;
    const aborted = vi.fn();
    const f = fixture({request:vi.fn((_url, init) => new Promise<Response>((_resolve,reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort',()=>{aborted(); reject(Error('private'));});
    })) as typeof fetch});
    await settled(); expect(signal?.aborted).toBe(false); f.transport.close(); await settled();
    expect(signal?.aborted).toBe(true); expect(aborted).toHaveBeenCalledOnce(); expect(f.socket).not.toHaveBeenCalled();
    f.clock.advance(120000); await settled(); expect(f.withValue).toHaveBeenCalledOnce();
  });
  it.each(['error','close'])('reconnects on socket %s independently', async event => {
    const f = fixture(); await settled(); const s = f.sockets[0]; s.hello(); s.emit(event);
    expect(s.terminate).toHaveBeenCalledOnce(); f.clock.advance(1000); await settled();
    expect(f.sockets).toHaveLength(2); expect(f.withValue).toHaveBeenCalledTimes(2);
  });
  it('keeps ACK writes within the queue bound when outbound callbacks stall', async () => {
    const f = fixture(); await settled(); const s = f.sockets[0]; s.hello();
    let sent!: () => void;
    s.send.mockImplementation((_text, callback) => { sent = () => callback(); });
    s.frame(envelope()); await settled(); expect(f.receive).toHaveBeenCalledOnce();
    s.frame(envelope('two')); await settled();
    expect(f.receive).toHaveBeenCalledOnce(); expect(s.send).toHaveBeenCalledOnce();
    sent(); await settled(); expect(f.receive).toHaveBeenCalledTimes(2); expect(s.send).toHaveBeenCalledTimes(2);
    for (let i=0; i<64; i++) s.frame(envelope(`extra-${i}`));
    await settled(); expect(s.terminate).toHaveBeenCalledOnce(); expect(s.send).toHaveBeenCalledTimes(2);
  });
  it('does not ACK a receipt finishing after disconnect and reconnect', async () => {
    let commit!: () => void;
    const f = fixture({receive:() => new Promise<void>(resolve => { commit = resolve; })});
    await settled(); const s = f.sockets[0]; s.hello(); s.frame(envelope()); await settled();
    // A closing real socket need not change readyState until after termination.
    s.terminate.mockImplementationOnce(() => {});
    s.frame({type:'disconnect'}); f.clock.advance(1000); await settled();
    expect(f.sockets).toHaveLength(2); f.sockets[1].hello();
    commit(); await settled(); expect(s.send).not.toHaveBeenCalled(); expect(f.sockets[1].send).not.toHaveBeenCalled();
  });
  it.each(['retry','heartbeat','deadline'])('cancels all scheduled timers on close during %s', async phase => {
    const clock = new TrackingClock(); const f = fixture({clock}); await settled(); const s = f.sockets[0];
    if (phase === 'retry') s.emit('close');
    if (phase === 'heartbeat') s.hello();
    expect(clock.active.size).toBeGreaterThan(0); f.transport.close();
    expect(clock.active.size).toBe(0);
  });
  it('handles ACK failure and consumes unsupported interactions without delivery', async () => {
    const f = fixture(); await settled(); const s = f.sockets[0]; s.hello();
    s.frame({type:'interactive',envelope_id:'i'}); await settled(); expect(f.receive).not.toHaveBeenCalled(); expect(s.send).toHaveBeenCalledOnce();
    s.send.mockImplementationOnce((_text, callback)=>callback(Error('ticket'))); s.frame(envelope()); await settled(); expect(s.terminate).toHaveBeenCalledOnce();
  });
  it('proves durable commit before ACK and dedup after a daemon/socket restart', async () => {
    const home = mkdtempSync(join(tmpdir(),'slack-socket-'));
    let app = await startLoom({home});
    try {
      app.db.exec('CREATE TABLE socket_fixture (id TEXT PRIMARY KEY, content TEXT)');
      let commit!: () => void;
      const gate = new Promise<void>(resolve => { commit = resolve; });
      const receive = vi.fn(async (p: Record<string,unknown>) => {
        await gate;
        const event = p.event;
        if (!event || typeof event !== 'object' || !('ts' in event) || typeof event.ts !== 'string') throw Error('Invalid fixture event');
        app.db.transaction(() => app.db.prepare('INSERT OR IGNORE INTO socket_fixture VALUES (?,?)').run(event.ts,JSON.stringify(p)))();
      });
      const f = fixture({receive}); await settled(); const s = f.sockets[0]; s.hello();
      s.send.mockImplementation((_text, callback) => { expect(app.db.inTransaction).toBe(false); expect(app.db.prepare('SELECT COUNT(*) AS n FROM socket_fixture').get()).toEqual({n:1}); callback(); });
      s.frame(envelope()); await settled();
      expect(s.send).not.toHaveBeenCalled(); expect(app.db.prepare('SELECT COUNT(*) AS n FROM socket_fixture').get()).toEqual({n:0});
      commit(); await settled(); expect(receive).toHaveBeenCalledWith(payload); expect(s.send).toHaveBeenCalledOnce();
      f.transport.close(); await app.close(); app = await startLoom({home});
      const g = fixture({receive}); await settled(); g.sockets[0].hello(); g.sockets[0].frame(envelope('new-envelope-id')); await settled();
      expect(g.sockets[0].send).toHaveBeenCalledOnce(); expect(app.db.prepare('SELECT * FROM socket_fixture').all()).toEqual([{id:payload.event.ts,content:JSON.stringify(payload)}]);
    } finally { await app.close(); rmSync(home,{recursive:true,force:true}); }
  });
});
