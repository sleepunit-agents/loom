import { afterEach, expect, it, vi } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import type { SecretUse } from '../secrets/role.js';
import { bridgeAuthentication } from './authentication.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(platform: 'discord' | 'slack' = 'discord') {
  const clock = new FakeClock(); let live = true, tokens = 0;
  const bot = platform === 'discord' ? '123' : 'UBOT', workspace = platform === 'discord' ? '456' : 'TWORK';
  const bodies = platform === 'discord' ? [{ id: bot, bot: true }, { id: workspace }]
    : [{ ok: true, user_id: bot, team_id: workspace, bot_id: 'BBOT' }, { ok: true, bot: { id: 'BBOT', user_id: bot, deleted: false, app_id: 'AAPP' } }];
  let reads = 0;
  const request = vi.fn<typeof fetch>(async () => Response.json(bodies[reads++ % 2]));
  const secrets: SecretUse = { withValue: vi.fn(async (_name, use) => use(`synthetic-${++tokens}`)) };
  const input = { platform, bot, workspace, tokenSecret: 'bot-token', clock, secrets, request, current: () => live };
  return { api: bridgeAuthentication(input), input, bodies, clock, request, secrets, stop: () => { live = false; } };
}
afterEach(() => vi.restoreAllMocks());

it.each(['discord', 'slack'] as const)('authenticates %s with fixed endpoints and fresh token for every call, without caching', async platform => {
  const f = fixture(platform), expected = { bot: f.input.bot, workspace: f.input.workspace, ...(platform === 'slack' ? { app: 'AAPP' } : {}) };
  expect(await f.api.authenticate()).toEqual(expected);
  expect(await f.api.authenticate()).toEqual(expected);
  expect(f.secrets.withValue).toHaveBeenCalledTimes(4);
  expect(f.secrets.withValue).toHaveBeenCalledWith('bot-token', expect.any(Function));
  expect(f.request.mock.calls.map(([url]) => url)).toEqual(platform === 'discord'
    ? ['https://discord.com/api/v10/users/@me', 'https://discord.com/api/v10/guilds/456', 'https://discord.com/api/v10/users/@me', 'https://discord.com/api/v10/guilds/456']
    : ['https://slack.com/api/auth.test', 'https://slack.com/api/bots.info', 'https://slack.com/api/auth.test', 'https://slack.com/api/bots.info']);
  for (const [i, [, options]] of f.request.mock.calls.entries()) expect(options).toMatchObject({ method: platform === 'discord' ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: `${platform === 'discord' ? 'Bot' : 'Bearer'} synthetic-${i + 1}` } });
  if (platform === 'slack') {
    expect(String(f.request.mock.calls[0][1]?.body)).toBe('');
    expect(String(f.request.mock.calls[1][1]?.body)).toBe('bot=BBOT&team_id=TWORK');
  }
});
it.each(['', '../token', '123?x=y', 'https://example.test', '0', '18446744073709551616'])('rejects invalid Discord setup %s before acquisition', async value => {
  const f = fixture();
  for (const field of ['bot', 'workspace'] as const) expect(await bridgeAuthentication({ ...f.input, [field]: value }).authenticate()).toBeUndefined();
  expect(f.secrets.withValue).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});
it.each([{ bot: 'BBOT' }, { bot: 'ubot' }, { workspace: 'UWORK' }, { workspace: 'T../../' }])('rejects invalid Slack setup %j', async setup => {
  const f = fixture('slack'); expect(await bridgeAuthentication({ ...f.input, ...setup }).authenticate()).toBeUndefined();
  expect(f.secrets.withValue).not.toHaveBeenCalled();
});
it.each([{ id: 'other', bot: true }, { id: '123', bot: false }, { id: '123' }, [], null])('refuses Discord user evidence %j before guild lookup', async body => {
  const f = fixture(); f.request.mockResolvedValue(Response.json(body));
  expect(await f.api.authenticate()).toBeUndefined(); expect(f.request).toHaveBeenCalledTimes(1);
});
it.each([{ id: 'other' }, { id: '456', unavailable: true }, [], null])('refuses Discord guild evidence %j', async body => {
  const f = fixture(); f.request.mockResolvedValueOnce(Response.json(f.bodies[0])).mockResolvedValueOnce(Response.json(body));
  expect(await f.api.authenticate()).toBeUndefined(); expect(f.request).toHaveBeenCalledTimes(2);
});
it.each([{ user_id: 'OTHER' }, { team_id: 'OTHER' }, { bot_id: 'UBOT' }, { bot_id: '' }, { ok: false }])('refuses Slack auth evidence %j before bot lookup', async change => {
  const f = fixture('slack'); f.request.mockResolvedValue(Response.json({ ...f.bodies[0], ...change }));
  expect(await f.api.authenticate()).toBeUndefined(); expect(f.request).toHaveBeenCalledTimes(1);
});
it.each([{ id: 'OTHER' }, { user_id: 'OTHER' }, { deleted: true }, { deleted: undefined }, { app_id: 'BAPP' }, { app_id: undefined }])('refuses Slack bot evidence %j', async change => {
  const f = fixture('slack');
  f.request.mockResolvedValueOnce(Response.json(f.bodies[0])).mockResolvedValueOnce(Response.json({ ok: true, bot: { id: 'BBOT', user_id: 'UBOT', deleted: false, app_id: 'AAPP', ...change } }));
  expect(await f.api.authenticate()).toBeUndefined();
});
it('refuses an invalidated lifetime before acquisition and at a late holder callback', async () => {
  const f = fixture(); f.stop(); expect(await f.api.authenticate()).toBeUndefined(); expect(f.secrets.withValue).not.toHaveBeenCalled();
  const g = fixture(); g.secrets.withValue = async (_name, use) => { g.stop(); return use('private'); };
  expect(await g.api.authenticate()).toBeUndefined(); expect(g.request).not.toHaveBeenCalled();
});
it.each(['headers', 'body', 'holder return'] as const)('fences lifetime changes at %s and cancels bodies', async phase => {
  const f = fixture(); let cancelled = false;
  if (phase === 'headers') f.request.mockImplementation(async () => { f.stop(); return new Response(new ReadableStream({ cancel() { cancelled = true; } })); });
  if (phase === 'body') f.request.mockImplementation(async () => new Response(new ReadableStream({ pull(c) { f.stop(); c.enqueue(Buffer.from(JSON.stringify(f.bodies[0]))); }, cancel() { cancelled = true; } })));
  if (phase === 'holder return') f.secrets.withValue = async (_name, use) => { const value = await use('private'); f.stop(); return value; };
  expect(await f.api.authenticate()).toBeUndefined(); expect(f.request).toHaveBeenCalledTimes(1);
  if (phase !== 'holder return') expect(cancelled).toBe(true);
});
it.each([401, 403, 404, 429, 500])('hides HTTP %s bodies and performs no retry', async status => {
  const f = fixture(); f.request.mockResolvedValue(Response.json(f.bodies[0], { status }));
  expect(await f.api.authenticate()).toBeUndefined(); f.clock.advance(60_000); await Promise.resolve();
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.secrets.withValue).toHaveBeenCalledTimes(1);
});
it('hides network, holder and JSON errors and refuses redirected evidence', async () => {
  const f = fixture(); f.request.mockRejectedValue(Error('synthetic-private')); expect(await f.api.authenticate()).toBeUndefined();
  f.request.mockResolvedValue(new Response('synthetic-private')); expect(await f.api.authenticate()).toBeUndefined();
  const response = Response.json(f.bodies[0]); Object.defineProperty(response, 'redirected', { value: true });
  f.request.mockResolvedValue(response); expect(await f.api.authenticate()).toBeUndefined();
  f.secrets.withValue = async () => { throw Error('synthetic-private'); }; expect(await f.api.authenticate()).toBeUndefined();
});
it.each(['length', 'stream'] as const)('bounds %s to 1MiB and cancels the response', async kind => {
  const f = fixture(); let cancelled = false;
  f.request.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } }), kind === 'length' ? { headers: { 'content-length': String(1024 * 1024 + 1) } } : undefined));
  expect(await f.api.authenticate()).toBeUndefined(); expect(cancelled).toBe(true);
});
it.each(['holder', 'headers', 'body'] as const)('bounds stalled %s and fences late completion', async phase => {
  const f = fixture(), holder = deferred<void>(), headers = deferred<Response>(); let cancelled = false;
  if (phase === 'holder') f.secrets.withValue = async (_name, use) => { await holder.promise; return use('private'); };
  if (phase === 'headers') f.request.mockReturnValue(headers.promise);
  if (phase === 'body') f.request.mockImplementation(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = f.api.authenticate(); await Promise.resolve(); await Promise.resolve();
  f.clock.advance(15_000); expect(await pending).toBeUndefined();
  holder.resolve(); headers.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve(); await Promise.resolve();
  if (phase === 'holder') expect(f.request).not.toHaveBeenCalled();
  else { expect(cancelled).toBe(true); expect(f.request.mock.calls[0][1]?.signal?.aborted).toBe(true); }
});
it.each(['holder', 'headers', 'body'] as const)('checks absolute expiry at %s before timer dispatch', async phase => {
  const f = fixture(), holder = deferred<void>(), headers = deferred<Response>(), body = deferred<ReadableStreamReadResult<Uint8Array>>();
  let now = 0, reads = 0;
  const clock = { now: () => now, at: () => () => {} };
  f.secrets.withValue = async (_name, use) => { if (phase === 'holder') await holder.promise; return use('private'); };
  f.request.mockImplementation(async () => phase === 'headers' ? headers.promise : { ok: true, redirected: false, headers: new Headers(), body: { getReader: () => ({ read: () => ++reads === 1 ? body.promise : Promise.resolve({ done: true, value: undefined }), cancel: async () => {} }) } } as unknown as Response);
  const pending = bridgeAuthentication({ ...f.input, clock }).authenticate(); await Promise.resolve(); await Promise.resolve(); now = 15_000;
  holder.resolve(); headers.resolve(Response.json(f.bodies[0])); body.resolve({ done: false, value: Buffer.from(JSON.stringify(f.bodies[0])) });
  expect(await pending).toBeUndefined();
  if (phase === 'holder') expect(f.request).not.toHaveBeenCalled(); else expect(f.request).toHaveBeenCalledTimes(1);
});
it('uses one deadline for both HTTP calls including reacquisition, without refreshing it', async () => {
  const f = fixture(), second = deferred<Response>(), started = deferred<void>();
  f.request.mockImplementationOnce(async () => { f.clock.advance(10_000); return Response.json(f.bodies[0]); }).mockImplementationOnce(() => { started.resolve(); return second.promise; });
  const pending = f.api.authenticate();
  await started.promise; expect(f.request).toHaveBeenCalledTimes(2);
  f.clock.advance(5000); expect(await pending).toBeUndefined();
  second.resolve(Response.json(f.bodies[1])); await Promise.resolve();
  expect(f.secrets.withValue).toHaveBeenCalledTimes(2);
});
it('does not publish success if lifetime ends after the second holder callback', async () => {
  const f = fixture(); let calls = 0;
  f.secrets.withValue = async (_name, use) => { const value = await use('private'); if (++calls === 2) f.stop(); return value; };
  expect(await f.api.authenticate()).toBeUndefined(); expect(f.request).toHaveBeenCalledTimes(2);
});

it.each(['lifetime', 'absolute deadline'] as const)('fences %s changes queued between final evidence and public return', async phase => {
  const f = fixture(); let calls = 0, returned = false, checks = 0, now = 0;
  f.secrets.withValue = async (_name, use) => { const value = await use('private'); if (++calls === 2) returned = true; return value; };
  const current = () => {
    if (returned && ++checks === 2) queueMicrotask(() => { if (phase === 'lifetime') f.stop(); else now = 15_000; });
    return f.input.current();
  };
  const clock = { now: () => now, at: () => () => {} };
  expect(await bridgeAuthentication({ ...f.input, current, clock }).authenticate()).toBeUndefined();
  expect(f.request).toHaveBeenCalledTimes(2);
});
it('does not log credentials or upstream diagnostics on success or failures', async () => {
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'debug'), vi.spyOn(console, 'trace')];
  const output = [vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];
  const f = fixture(); expect(await f.api.authenticate()).toEqual({ bot: '123', workspace: '456' });
  f.request.mockRejectedValue(Error('synthetic-private-upstream')); expect(await f.api.authenticate()).toBeUndefined();
  f.request.mockResolvedValue(new Response('synthetic-private-body')); expect(await f.api.authenticate()).toBeUndefined();
  f.secrets.withValue = async () => { throw Error('synthetic-private-holder'); }; expect(await f.api.authenticate()).toBeUndefined();
  for (const log of [...logs, ...output]) expect(log).not.toHaveBeenCalled();
});
