import { describe, it, expect, vi } from 'vitest';
import { httpWorkerControl } from './worker-http.js';
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
