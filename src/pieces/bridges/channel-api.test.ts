import { afterEach, expect, it, vi } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import { bridgeChannelApi } from './channel-api.js';
import type { SecretUse } from '../secrets/role.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(platform: 'discord' | 'slack' = 'discord') {
  const clock = new FakeClock(); let live = true;
  const id = platform === 'discord' ? '123' : 'CROOM';
  const workspace = platform === 'discord' ? '456' : 'TWORK';
  const raw = platform === 'discord' ? { id, guild_id: workspace, type: 11, parent_id: '789' }
    : { id, context_team_id: workspace, is_im: false, is_mpim: false, is_channel: true };
  const request = vi.fn<typeof fetch>(async () => Response.json(platform === 'discord' ? raw : { ok: true, channel: raw }));
  const secrets: SecretUse = { withValue: vi.fn(async (_name, use) => use('synthetic-token')) };
  const api = bridgeChannelApi({ platform, workspace, tokenSecret: 'bot-token', clock, secrets, request, current: () => live });
  return { api, clock, id, workspace, raw, request, secrets, stop: () => { live = false; } };
}
afterEach(() => vi.restoreAllMocks());

it.each(['discord', 'slack'] as const)('fetches raw %s metadata with the exact fixed endpoint and fresh token each time', async platform => {
  const f = fixture(platform);
  let generation = 0;
  f.secrets.withValue = vi.fn(async (_name, use) => use(++generation === 1 ? 'synthetic-token' : 'replacement-token'));
  expect(await f.api.channel(f.id)).toEqual(f.raw);
  expect(await f.api.channel(f.id)).toEqual(f.raw);
  expect(f.secrets.withValue).toHaveBeenCalledTimes(2);
  const [url, options] = f.request.mock.calls[0];
  expect(url).toBe(platform === 'discord' ? 'https://discord.com/api/v10/channels/123' : 'https://slack.com/api/conversations.info');
  expect(options).toMatchObject({ method: platform === 'discord' ? 'GET' : 'POST', redirect: 'error',
    headers: { Authorization: platform === 'discord' ? 'Bot synthetic-token' : 'Bearer synthetic-token' } });
  if (platform === 'slack') expect(String(options?.body)).toBe('channel=CROOM&team_id=TWORK');
  expect(f.request.mock.calls[1][1]?.headers).toMatchObject({ Authorization: platform === 'discord' ? 'Bot replacement-token' : 'Bearer replacement-token' });
});

it.each(['../token', '123?url=elsewhere', '', 'https://example.test'])('rejects path input before token acquisition: %s', async id => {
  const f = fixture(); expect(await f.api.channel(id)).toBeUndefined();
  expect(f.secrets.withValue).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it('does not acquire a token for an invalidated connection', async () => {
  const f = fixture(); f.stop(); expect(await f.api.channel(f.id)).toBeUndefined();
  expect(f.secrets.withValue).not.toHaveBeenCalled();
});
it('rejects a late holder callback before sending its token', async () => {
  const f = fixture();
  f.secrets.withValue = async (_name, use) => { f.stop(); return use('private'); };
  expect(await f.api.channel(f.id)).toBeUndefined(); expect(f.request).not.toHaveBeenCalled();
});

it.each(['headers', 'body', 'holder return'] as const)('discards metadata when the lifetime ends at %s', async phase => {
  const f = fixture(); let cancelled = false;
  if (phase === 'headers') f.request.mockImplementation(async () => { f.stop(); return new Response(new ReadableStream({ cancel() { cancelled = true; } })); });
  if (phase === 'body') f.request.mockImplementation(async () => new Response(new ReadableStream({ pull(c) { f.stop(); c.enqueue(Buffer.from('{}')); }, cancel() { cancelled = true; } })));
  if (phase === 'holder return') f.secrets.withValue = async (_name, use) => { const result = await use('private'); f.stop(); return result; };
  expect(await f.api.channel(f.id)).toBeUndefined();
  if (phase !== 'holder return') expect(cancelled).toBe(true);
});

it.each([
  { id: 'wrong', type: 0 }, [], null, { ok: true },
])('rejects malformed or mismatched Discord responses: %j', async body => {
  const f = fixture(); f.request.mockResolvedValue(Response.json(body));
  expect(await f.api.channel(f.id)).toBeUndefined();
});
it.each([{ ok: false, error: 'private upstream words', channel: { id: 'CROOM' } }, { ok: true, channel: { id: 'OTHER' } }, { ok: true, channel: [] }])('rejects Slack errors and wrong envelopes: %j', async body => {
  const f = fixture('slack'); f.request.mockResolvedValue(Response.json(body));
  expect(await f.api.channel(f.id)).toBeUndefined();
});
it.each([403, 404, 429, 500])('retains retry eligibility for HTTP %s without reflecting upstream text', async status => {
  const f = fixture(); f.request.mockResolvedValue(Response.json({ id: f.id, error: 'private-token' }, { status }));
  expect(await f.api.channel(f.id)).toBeUndefined();
  f.clock.advance(60_000); await Promise.resolve();
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.secrets.withValue).toHaveBeenCalledTimes(1);
});
it('rejects malformed JSON and hides holder and network exceptions', async () => {
  const f = fixture(); f.request.mockResolvedValue(new Response('not JSON private-token'));
  expect(await f.api.channel(f.id)).toBeUndefined();
  f.request.mockRejectedValue(Error('private-token')); expect(await f.api.channel(f.id)).toBeUndefined();
  f.clock.advance(60_000); await Promise.resolve(); expect(f.request).toHaveBeenCalledTimes(2);
  f.secrets.withValue = async () => { throw Error('private-token'); };
  expect(await f.api.channel(f.id)).toBeUndefined();
});

it.each(['length', 'stream'] as const)('bounds the response by %s and cancels it', async kind => {
  const f = fixture(); let cancelled = false;
  f.request.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } }),
    kind === 'length' ? { headers: { 'content-length': String(1024 * 1024 + 1) } } : undefined));
  expect(await f.api.channel(f.id)).toBeUndefined(); expect(cancelled).toBe(true);
});

it.each(['holder', 'headers', 'body'] as const)('bounds stalled %s with one total fake-clock deadline', async where => {
  const f = fixture(), late = deferred<Response>(); let cancelled = false, done = false;
  if (where === 'holder') {
    const holder = deferred<void>();
    f.secrets.withValue = async (_name, use) => { await holder.promise; return use('late-token'); };
    const pending = f.api.channel(f.id); void pending.then(() => { done = true; });
    f.clock.advance(15_000); expect(await pending).toBeUndefined(); holder.resolve();
    await Promise.resolve(); await Promise.resolve(); expect(f.request).not.toHaveBeenCalled(); return;
  }
  if (where === 'headers') f.request.mockReturnValue(late.promise);
  if (where === 'body') f.request.mockImplementation(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = f.api.channel(f.id); void pending.then(() => { done = true; });
  await Promise.resolve(); await Promise.resolve();
  f.clock.advance(14_999); await Promise.resolve(); expect(done).toBe(false);
  f.clock.advance(1); expect(await pending).toBeUndefined();
  if (where === 'headers') {
    late.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await Promise.resolve(); await Promise.resolve();
  }
  expect(cancelled).toBe(true); expect(f.request.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it('shares the deadline across slow token acquisition, headers and streaming', async () => {
  const f = fixture(), holder = deferred<void>(), headers = deferred<Response>();
  f.secrets.withValue = async (_name, use) => { await holder.promise; return use('token'); };
  f.request.mockReturnValue(headers.promise);
  const pending = f.api.channel(f.id);
  f.clock.advance(5000); holder.resolve(); await Promise.resolve(); await Promise.resolve();
  f.clock.advance(5000); headers.resolve(new Response(new ReadableStream())); await Promise.resolve(); await Promise.resolve();
  f.clock.advance(5000); expect(await pending).toBeUndefined();
});

it.each(['holder', 'headers', 'body'] as const)('checks absolute expiry at %s even before the timer callback runs', async phase => {
  let now = 0, reads = 0;
  const acquired = deferred<void>(), headers = deferred<Response>(), body = deferred<ReadableStreamReadResult<Uint8Array>>();
  const request = vi.fn<typeof fetch>(async () => {
    if (phase === 'headers') return headers.promise;
    return { ok: true, redirected: false, headers: new Headers(), body: { getReader: () => ({
      read: () => ++reads === 1 ? body.promise : Promise.resolve({ done: true, value: undefined }), cancel: async () => {},
    }) } } as unknown as Response;
  });
  const secrets: SecretUse = { withValue: async (_name, use) => {
    if (phase === 'holder') await acquired.promise;
    return use('synthetic-token');
  } };
  // Time advances while dispatch of the scheduled timer is delayed.
  const clock = { now: () => now, at: () => () => {} };
  const api = bridgeChannelApi({ platform: 'discord', workspace: '456', tokenSecret: 'bot', clock, secrets, request, current: () => true });
  const pending = api.channel('123');
  await Promise.resolve(); await Promise.resolve();
  now = 15_000;
  acquired.resolve(); headers.resolve(Response.json({ id: '123' })); body.resolve({ done: false, value: Buffer.from('{"id":"123"}') });
  expect(await pending).toBeUndefined();
  if (phase === 'holder') expect(request).not.toHaveBeenCalled();
});

it.each(['discord', 'slack'] as const)('leaves %s kind and workspace validation to the bound cache', async platform => {
  const f = fixture(platform);
  for (const raw of [{ id: f.id }, { id: f.id, guild_id: 'other', context_team_id: 'TOTHER', type: 999 }]) {
    f.request.mockResolvedValue(Response.json(platform === 'discord' ? raw : { ok: true, channel: raw }));
    expect(await f.api.channel(f.id)).toEqual(raw);
  }
});


it.each([
  ['discord', 'lifetime'], ['discord', 'absolute deadline'],
  ['slack', 'lifetime'], ['slack', 'absolute deadline'],
] as const)('fences queued %s %s changes before the public return', async (platform, phase) => {
  const f = fixture(platform); let returned = false, checks = 0, now = 0, live = true;
  f.secrets.withValue = async (_name, use) => { const value = await use('private'); returned = true; return value; };
  const current = () => {
    if (returned && ++checks === 1) queueMicrotask(() => { if (phase === 'lifetime') live = false; else now = 15_000; });
    return live;
  };
  const clock = { now: () => now, at: () => () => {} };
  const api = bridgeChannelApi({ platform, workspace: f.workspace, tokenSecret: 'bot-token', secrets: f.secrets, clock, current, request: f.request });
  expect(await api.channel(f.id), phase).toBeUndefined();
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('asks Discord about no channel whose id authentication would refuse', async () => {
  const f = fixture('discord');
  // A leading zero, and one past the largest id Discord can make: the same rule as discord-id.ts.
  for (const id of ['0123', '18446744073709551616', '', '12a']) expect(await f.api.channel(id)).toBeUndefined();
  expect(f.request).not.toHaveBeenCalled();
  expect(await f.api.channel(f.id)).toEqual(f.raw);
});
