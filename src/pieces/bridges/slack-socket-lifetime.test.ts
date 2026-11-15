import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import { slackSocket, type SlackSocketOptions } from './slack-socket.js';
afterEach(() => vi.restoreAllMocks());
async function settled() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function fixture(overrides: Partial<SlackSocketOptions> = {}) {
  const clock = new FakeClock();
  const request = vi.fn<typeof fetch>(async () => Response.json({ok:true,url:'wss://wss.slack.com/link?ticket=PRIVATE'}));
  const socket = vi.fn<NonNullable<SlackSocketOptions['socket']>>(() => ({on: vi.fn(), send: vi.fn(), ping: vi.fn(), terminate: vi.fn(), readyState: 1}));
  const transport = slackSocket({appSecret:'app',clock,secrets:{withValue:async (_name,use)=>use('private')},beforeConnect:()=>true,receive:async()=>{},request,socket,...overrides});
  return {clock,request,socket,transport};
}


describe('Socket Mode credential acquisition lifetime', () => {
  it.each(['timeout', 'shutdown', 'invalidation'] as const)('does not send a late holder token after %s', async phase => {
    let release!: () => void, live = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ beforeConnect: () => live, secrets: { withValue: async (_name, use) => { await gate; return use('late-private'); } } });
    await settled();
    if (phase === 'timeout') f.clock.advance(15_000);
    if (phase === 'shutdown') void f.transport.close();
    if (phase === 'invalidation') live = false;
    release(); await settled();
    expect(f.request).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled();
    await f.transport.close();
  });
  it.each(['holder', 'headers', 'body', 'holder return'] as const)('checks the absolute acquisition deadline at %s when timers are delayed', async phase => {
    let now = 0;
    const clock = { now: () => now, at: () => () => {} };
    const secrets: SlackSocketOptions['secrets'] = { withValue: async (_name, use) => {
      if (phase === 'holder') now = 15_000;
      const result = await use('private'); if (phase === 'holder return') now = 15_000; return result;
    } };
    const request = vi.fn(async () => {
      if (phase === 'headers') now = 15_000;
      return new Response(new ReadableStream({start(c) {
        c.enqueue(Buffer.from(JSON.stringify({ok:true,url:'wss://wss.slack.com/link?ticket=PRIVATE'}))); c.close();
      }, pull() { if (phase === 'body') now = 15_000; }}));
    });
    if (phase === 'body') { let reads = 0; request.mockImplementation(async () => ({ok:true,redirected:false,headers:new Headers(),body:{getReader:()=>({read:async()=>{now=15_000;return ++reads === 1 ? {done:false,value:Buffer.from(JSON.stringify({ok:true,url:'wss://wss.slack.com/link?ticket=PRIVATE'}))} : {done:true,value:undefined};},cancel:async()=>{}})}} as unknown as Response)); }
    const f = fixture({clock,secrets,request}); await settled();
    expect(f.socket).not.toHaveBeenCalled(); if (phase === 'holder') expect(request).not.toHaveBeenCalled();
    await f.transport.close();
  });
  it('cancels a response arriving after timeout before reading its body', async () => {
    let resolve!: (r: Response) => void;
    const request = vi.fn(() => new Promise<Response>(yes => { resolve = yes; }));
    const f = fixture({request}); await settled(); f.clock.advance(15_000);
    const cancel = vi.fn(), read = vi.fn(async () => ({done:true,value:undefined}));
    resolve({ok:true,body:{getReader:()=>({read,cancel:async()=>{cancel();}})}} as unknown as Response); await settled();
    expect(cancel).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled();
    await f.transport.close();
  });
});


it('does not await an uncooperative body cancellation before dialing', async () => {
  let reads = 0;
  const f = fixture({request:vi.fn(async () => ({ok:true,redirected:false,body:{getReader:()=>({
    read:async()=>++reads === 1 ? {done:false,value:Buffer.from(JSON.stringify({ok:true,url:'wss://wss.slack.com/link?ticket=PRIVATE'}))} : {done:true,value:undefined},
    cancel:()=>new Promise<void>(()=>{}),
  })}} as unknown as Response))});
  await settled(); expect(f.socket).toHaveBeenCalledOnce(); await f.transport.close();
});
it('refuses redirected evidence and cancels it', async () => {
  const cancel = vi.fn(async()=>{}), read = vi.fn();
  const f = fixture({request:vi.fn(async()=>({ok:true,redirected:true,body:{getReader:()=>({cancel,read})}} as unknown as Response))});
  await settled(); expect(cancel).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled(); await f.transport.close();
});
it('keeps token and ticket diagnostics off console and process output', async () => {
  const logs = [vi.spyOn(console,'log'),vi.spyOn(console,'info'),vi.spyOn(console,'warn'),vi.spyOn(console,'error'),vi.spyOn(console,'debug'),vi.spyOn(console,'trace'),
    vi.spyOn(process.stdout,'write').mockImplementation(()=>true),vi.spyOn(process.stderr,'write').mockImplementation(()=>true)];
  const f = fixture(); await settled(); await f.transport.close();
  for (const where of ['holder','HTTP','JSON'] as const) {
    const g = fixture(where === 'holder' ? {secrets:{withValue:async()=>{throw Error('PRIVATE token');}}}
      : {request:vi.fn(async()=>{if (where === 'HTTP') throw Error('PRIVATE ticket');return new Response('PRIVATE JSON');})});
    await settled(); await g.transport.close();
  }
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it('shares one total acquisition deadline across successive holder, header and body waits', async () => {
  let now = 0, reads = 0;
  const clock = { now: () => now, at: () => () => {} };
  const f = fixture({clock,secrets:{withValue:async (_name,use)=>{now += 6000;return use('private');}},
    request:vi.fn(async()=>{now += 6000;return {ok:true,redirected:false,body:{getReader:()=>({
      read:async()=>{now += 3000;return ++reads === 1 ? {done:false,value:Buffer.from(JSON.stringify({ok:true,url:'wss://wss.slack.com/link?ticket=PRIVATE'}))} : {done:true,value:undefined};},
      cancel:async()=>{},
    })}} as unknown as Response;})});
  await settled(); expect(f.socket).not.toHaveBeenCalled(); await f.transport.close();
});
