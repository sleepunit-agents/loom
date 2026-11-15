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
  expect(await f.api.channel(f.id)).toEqual(f.raw);
  expect(await f.api.channel(f.id)).toEqual(f.raw);
  expect(f.secrets.withValue).toHaveBeenCalledTimes(2);
  const [url, options] = f.request.mock.calls[0];
  expect(url).toBe(platform === 'discord' ? 'https://discord.com/api/v10/channels/123' : 'https://slack.com/api/conversations.info');
  expect(options).toMatchObject({ method: platform === 'discord' ? 'GET' : 'POST', redirect: 'error',
    headers: { Authorization: platform === 'discord' ? 'Bot synthetic-token' : 'Bearer synthetic-token' } });
  if (platform === 'slack') expect(String(options?.body)).toBe('channel=CROOM&team_id=TWORK');
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
it.each([{ ok: false, error: 'private upstream words' }, { ok: true, channel: { id: 'OTHER' } }, { ok: true, channel: [] }])('rejects Slack errors and wrong envelopes: %j', async body => {
  const f = fixture('slack'); f.request.mockResolvedValue(Response.json(body));
  expect(await f.api.channel(f.id)).toBeUndefined();
});
it.each([403, 404, 429, 500])('retains retry eligibility for HTTP %s without reflecting upstream text', async status => {
  const f = fixture(); f.request.mockResolvedValue(new Response('private-token', { status }));
  expect(await f.api.channel(f.id)).toBeUndefined();
});
it('rejects malformed JSON and hides holder and network exceptions', async () => {
  const f = fixture(); f.request.mockResolvedValue(new Response('not JSON private-token'));
  expect(await f.api.channel(f.id)).toBeUndefined();
  f.request.mockRejectedValue(Error('private-token')); expect(await f.api.channel(f.id)).toBeUndefined();
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
