import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { FakeClock } from '../../core/clock.js';
import type { SecretUse } from '../secrets/role.js';
import { bridgeSlackSocket, type SlackSocketOptions } from './slack-socket.js';
class Socket extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = 1;
  send = vi.fn((_text: string, callback: (error?: Error) => void) => callback());
  ping = vi.fn();
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
async function settled() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of close.splice(0)) await stop(); });
function fixture(app = 'AEXPECTED') {
  const clock = new FakeClock(), sockets: Socket[] = [];
  const receive = vi.fn(async () => {}), withValue = vi.fn();
  const secrets: SecretUse = {withValue:async (name,use)=>{withValue(name);return use('PRIVATE');}};
  const request = vi.fn<typeof fetch>(async () => Response.json({ok:true,url:'wss://wss.slack.com/link?ticket=PRIVATE'}));
  const input = {app,appSecret:'app-secret',clock,secrets,request,beforeConnect:()=>true,receive,
    socket:()=>{const s = new Socket();sockets.push(s);return s as unknown as ReturnType<NonNullable<SlackSocketOptions['socket']>>;}};
  const transport = bridgeSlackSocket(input); close.push(transport.close);
  return {clock,sockets,receive,withValue,request,transport,input};
}
const envelope = {type:'events_api',envelope_id:'env',payload:{event_id:'Ev1',team_id:'TWORK',event:{type:'message',text:'hello'}}};
it.each([undefined,null,[],{}, {app_id:'AOTHER'},{app_id:123}])('rejects wrong or missing hello app evidence: %j', async connection_info => {
  const f = fixture(); await settled(); const s = f.sockets[0];
  s.frame({type:'hello',connection_info}); s.frame(envelope); await settled();
  expect(s.terminate).toHaveBeenCalledOnce(); expect(f.receive).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled();
});
it('accepts matching hello and preserves raw receipt before ACK', async () => {
  const f = fixture(); await settled(); const s = f.sockets[0];
  s.frame({type:'hello',connection_info:{app_id:'AEXPECTED'}});
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2)); s.emit('message',bytes,false); await settled();
  expect(f.receive).toHaveBeenCalledExactlyOnceWith(envelope.payload,bytes);
  expect(s.send).toHaveBeenCalledExactlyOnceWith('{"envelope_id":"env"}',expect.any(Function));
  expect(s.terminate).not.toHaveBeenCalled();
});
it('rechecks app evidence on reconnect rather than retaining prior hello', async () => {
  const f = fixture(); await settled(); const first = f.sockets[0];
  first.frame({type:'hello',connection_info:{app_id:'AEXPECTED'}}); first.frame({type:'disconnect'});
  f.clock.advance(1000); await settled(); const second = f.sockets[1];
  second.frame({type:'hello',connection_info:{app_id:'AOTHER'}}); second.frame(envelope); await settled();
  expect(second.terminate).toHaveBeenCalledOnce(); expect(f.receive).not.toHaveBeenCalled(); expect(second.send).not.toHaveBeenCalled();
  expect(f.withValue).toHaveBeenCalledTimes(2);
});
it.each(['','../token','A?bad','not-an-app'])('rejects invalid expected app before credentials: %s', app => {
  expect(()=>fixture(app)).toThrow('Invalid Slack app binding');
});
it('never accepts an event before hello even when the envelope claims the expected app', async () => {
  const f = fixture(); await settled(); const s = f.sockets[0];
  s.frame({...envelope,payload:{...envelope.payload,api_app_id:'AEXPECTED'}}); await settled();
  expect(s.terminate).toHaveBeenCalledOnce(); expect(f.receive).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled();
});

it('snapshots the authenticated app across initial and reconnected sockets', async () => {
  const f = fixture(); f.input.app = 'AOTHER'; await settled(); const first = f.sockets[0];
  first.frame({type:'hello',connection_info:{app_id:'AEXPECTED'}}); first.frame(envelope); await settled();
  expect(f.receive).toHaveBeenCalledOnce(); expect(first.send).toHaveBeenCalledOnce();
  first.frame({type:'disconnect'}); f.clock.advance(1000); await settled(); const second = f.sockets[1];
  second.frame({type:'hello',connection_info:{app_id:'AOTHER'}}); second.frame(envelope); await settled();
  expect(second.terminate).toHaveBeenCalledOnce(); expect(f.receive).toHaveBeenCalledOnce(); expect(second.send).not.toHaveBeenCalled();
});
it('requires hello before receipt on a replacement socket', async () => {
  const f = fixture(); await settled(); const first = f.sockets[0];
  first.frame({type:'hello',connection_info:{app_id:'AEXPECTED'}}); first.frame({type:'disconnect'});
  f.clock.advance(1000); await settled(); const second = f.sockets[1];
  second.frame(envelope); await settled();
  expect(second.terminate).toHaveBeenCalledOnce(); expect(f.receive).not.toHaveBeenCalled(); expect(second.send).not.toHaveBeenCalled();
});
it('delivers after a fresh matching hello on a replacement socket', async () => {
  const f = fixture(); await settled(); const first = f.sockets[0];
  first.frame({type:'hello',connection_info:{app_id:'AEXPECTED'}}); first.frame({type:'disconnect'});
  f.clock.advance(1000); await settled(); const second = f.sockets[1];
  second.frame({type:'hello',connection_info:{app_id:'AEXPECTED'}}); second.frame(envelope); await settled();
  expect(second.terminate).not.toHaveBeenCalled(); expect(f.receive).toHaveBeenCalledOnce(); expect(second.send).toHaveBeenCalledOnce();
});
