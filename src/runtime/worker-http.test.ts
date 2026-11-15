import { describe, it, expect, vi } from 'vitest';
import { httpWorkerControl, reportWorkerAccountUsage, reportWorkerHealth } from './worker-http.js';
const assignment = { id: 'j1', box: 'attic', agent: 'art', conversation: 'cv1', model: 'm', account: 'a', harness: 'h', brief: 'private', house: { repository: 'r', file: 'f', branch: 'main' } };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, value }));
function client(fetcher: typeof fetch, signal = new AbortController().signal) {
  return httpWorkerControl({ url: 'https://loom.example', token: 'private-token', fetch: fetcher, signal });
}
describe('worker operation client', () => {
  it('uses authenticated operation door, unique ids and no caller-supplied machine', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(assignment)).mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ active: false })).mockResolvedValueOnce(response({ ok: true }));
    const control = client(fetcher);
    expect(await control.next()).toEqual(assignment);
    await control.started('j1', 'image');
    expect(await control.heartbeat('j1', 'running')).toBe(false);
    await control.finish('j1', 0, 'done');
    const requests = fetcher.mock.calls.map(([url, init]) => ({ url: String(url), ...init, data: JSON.parse(String(init?.body)) }));
    expect(requests.map(r => r.url)).toEqual(['next', 'started', 'heartbeat', 'finish'].map(n => `https://loom.example/api/runtime/${n}`));
    expect(requests.map(r => r.data.input)).toEqual([{}, { job: 'j1', build: 'image' }, { job: 'j1', state: 'running' }, { job: 'j1', exitCode: 0, logTail: 'done' }]);
    expect(new Set(requests.map(r => r.data.id)).size).toBe(4);
    expect(requests.every(r => r.redirect === 'error' && r.signal && (r.headers as Record<string,string>).authorization === 'Bearer private-token')).toBe(true);
  });
  it('accepts no work and rejects malformed assignments without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response({ id: 'incomplete' }));
    const control = client(fetcher);
    expect(await control.next()).toBeUndefined();
    await expect(control.next()).rejects.toThrow('outcome may be uncertain');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('discards error diagnostics and never retries uncertain writes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-token private-url private-brief'));
    await expect(client(fetcher).started('j1', 'image')).rejects.toThrow(/^Worker started failed; outcome may be uncertain$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects an oversized body and cancels its stream', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1_048_577)); }, cancel });
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream))).next()).rejects.toThrow('Worker next failed');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('forwards worker cancellation to a stalled request', async () => {
    const abort = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_url, init) => new Promise((_yes, no) => {
      requestSignal = init?.signal as AbortSignal;
      requestSignal.addEventListener('abort', () => no(new Error('cancelled')), { once: true });
    });
    const pending = client(fetcher, abort.signal).next();
    abort.abort();
    await expect(pending).rejects.toThrow('Worker next failed');
    expect(requestSignal?.aborted).toBe(true);
  });
  it('refuses insecure or credential-bearing origins before fetching', () => {
    for (const url of ['http://remote.example', 'https://user:pass@loom.example', 'https://loom.example/path', 'https://loom.example/?token=x'])
      expect(() => httpWorkerControl({ url, token: 'token', signal: new AbortController().signal })).toThrow();
    expect(() => httpWorkerControl({ url: 'http://127.0.0.1:8787', token: 'token', signal: new AbortController().signal })).not.toThrow();
  });
});
it('refuses oversized UTF-8 requests without dispatch', async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(client(fetcher).started('j1', 'é'.repeat(600_000))).rejects.toThrow('Worker started failed');
  expect(fetcher).not.toHaveBeenCalled();
});
it('expires a stalled request on the configured deadline', async () => {
  vi.useFakeTimers();
  try {
    const fetcher: typeof fetch = async (_url, init) => new Promise((_yes, no) => {
      init!.signal!.addEventListener('abort', () => no(new Error('deadline')), { once: true });
    });
    const control = httpWorkerControl({ url: 'https://loom.example', token: 'secret', signal: new AbortController().signal, fetch: fetcher, timeoutMs: 100 });
    const pending = expect(control.next()).rejects.toThrow('Worker next failed');
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('keeps the deadline active while consuming the response body', async () => {
  vi.useFakeTimers();
  try {
    let reading!: () => void;
    const started = new Promise<void>(yes => { reading = yes; });
    const fetcher: typeof fetch = async (_url, init) => new Response(new ReadableStream({
      start(stream) { init!.signal!.addEventListener('abort', () => stream.error(new Error('deadline')), { once: true }); },
      pull() { reading(); },
    }));
    const control = httpWorkerControl({ url: 'https://loom.example', token: 'secret', signal: new AbortController().signal, fetch: fetcher, timeoutMs: 100 });
    const pending = expect(control.next()).rejects.toThrow('Worker next failed');
    await started;
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('preserves explicit worker run capabilities and rejects malformed ports', async () => {
  const run = { nestedContainers: true, gpu: false, ports: [{ address: '127.0.0.1', port: 8080 }], policy: { deniedTools: [{ pattern: 'tool-*', guestsOnly: true }], people: [{ kind: 'outside', person: '[\"discord\",\"w\",\"u\"]', tier: 1 }] } };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...assignment, run }))
    .mockResolvedValueOnce(response({ ...assignment, run: { ...run, ports: [{ address: 'x', port: 65536 }] } }));
  const control = client(fetcher);
  expect((await control.next())?.run).toEqual(run);
  await expect(control.next()).rejects.toThrow('Worker next failed');
});

it('reports quota observations once with distinct ids and the existing transport guards', async () => {
  const observation = { account: 'a', owner: 'm', provider: 'p', windows: [], basis: '00000000-0000-4000-8000-000000000001' };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ recorded: true }));
  const options = { url: 'https://loom.example', token: 'secret', signal: new AbortController().signal, fetch: fetcher };
  for (let i = 0; i < 2; i++) {
    fetcher.mockResolvedValueOnce(response({ recorded: true }));
    await reportWorkerAccountUsage(options, observation);
  }
  const bodies = fetcher.mock.calls.map(([url, init]) => {
    expect(String(url)).toBe('https://loom.example/api/runtime/accountUsage');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ authorization: 'Bearer secret', 'content-type': 'application/json' });
    return JSON.parse(String(init?.body));
  });
  expect(bodies[0].id).not.toBe(bodies[1].id); expect(bodies.map(body => body.input)).toEqual([observation, observation]);
  expect(() => reportWorkerAccountUsage({ ...options, url: 'http://remote.example' }, observation)).toThrow();
  fetcher.mockRejectedValueOnce(Error('secret remote diagnostic'));
  await expect(reportWorkerAccountUsage(options, observation)).rejects.toThrow(/^Worker accountUsage failed; outcome may be uncertain$/);
  expect(fetcher).toHaveBeenCalledTimes(3);
  await expect(reportWorkerAccountUsage(options, { ...observation, account: 'é'.repeat(600_000) })).rejects.toThrow('Worker accountUsage failed');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
for (const cancel of [false, true]) it(`bounds quota reporting by ${cancel ? 'worker cancellation' : 'deadline'}`, async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController(), fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_yes, no) => {
      init!.signal!.addEventListener('abort', () => no(Error('private diagnostic')), { once: true });
    }));
    const pending = expect(reportWorkerAccountUsage({ url: 'https://loom.example', token: 'secret', signal: abort.signal, fetch: fetcher, timeoutMs: 100 }, { account: 'a', owner: 'm', provider: 'p', windows: [], basis: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow('Worker accountUsage failed');
    if (cancel) abort.abort(); else await vi.advanceTimersByTimeAsync(100);
    await pending; expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('snapshots configured machine facts for each poll without caller-supplied machine identity', async () => {
  const facts = ['gpu:5090'], fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(null));
  const control = httpWorkerControl({ url: 'https://loom.example', token: 'machine-token', signal: new AbortController().signal, fetch: fetcher, facts });
  facts[0] = 'changed'; await control.next(); await control.next();
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).input)).toEqual([{ facts: ['gpu:5090'] }, { facts: ['gpu:5090'] }]);
});

it('uses the existing bounded authenticated operation door for health without claiming work', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true }));
  expect(await reportWorkerHealth({ url: 'https://loom.example', token: 'machine-token', signal: new AbortController().signal, fetch: fetcher, facts: ['os:linux'] })).toEqual({ ok: true });
  expect(String(fetcher.mock.calls[0][0])).toBe('https://loom.example/api/runtime/health');
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).input).toEqual({ facts: ['os:linux'] });
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer machine-token' } });
});
