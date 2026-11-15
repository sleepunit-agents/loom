import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { httpWorkerControl, reportWorkerAccountUsage, reportWorkerHealth } from './worker-http.js';
vi.mock('node:crypto', async original => { const actual = await original<typeof import('node:crypto')>(); return { ...actual, randomBytes: vi.fn((size: number) => actual.randomBytes(size)) }; });
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
it.each([30000,60000])('bounds stalled private input to fifteen seconds under worker timeout %s',async timeoutMs=>{
 vi.useFakeTimers();const fetch=vi.fn<typeof globalThis.fetch>(()=>new Promise<Response>(()=>{}));const control=httpWorkerControl({url:'https://loom.example',token:'synthetic',signal:new AbortController().signal,timeoutMs,fetch});
 try{let settled=false;const pending=control.repositoryInput!('job',new AbortController().signal);void pending.then(()=>{settled=true;},()=>{settled=true;});const refused=expect(pending).rejects.toThrow(/^Private secret input unavailable$/);await vi.advanceTimersByTimeAsync(14999);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);await refused;expect(fetch).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}
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

it('generates body bytes locally and registers only their fingerprint once on the runner door', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ registered: true }));
  const bootstrap = await client(fetcher).enrollBody!('job', new AbortController().signal);
  const raw = Buffer.from(bootstrap.token).toString(); expect(raw).toMatch(/^body_[a-f0-9]{64}$/); expect(bootstrap).toMatchObject({ origin: 'https://loom.example', job: 'job' });
  const input = JSON.parse(String(fetcher.mock.calls[0][1]?.body)).input;
  expect(input).toEqual({ job: 'job', fingerprint: createHash('sha256').update(raw).digest('hex') });
  expect(String(fetcher.mock.calls[0][0])).toBe('https://loom.example/api/runtime/enrollBody');
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain(raw); expect(fetcher).toHaveBeenCalledOnce(); bootstrap.token.fill(0);
});
it('does not retry a lost enrollment ACK or return a credential after a late canceled ACK', async () => {
  const lost = vi.fn<typeof fetch>().mockRejectedValue(Error('private diagnostics'));
  await expect(client(lost).enrollBody!('job', new AbortController().signal)).rejects.toThrow(/^Worker body enrollment failed; outcome may be uncertain$/); expect(lost).toHaveBeenCalledOnce();
  const abort = new AbortController(), late = vi.fn<typeof fetch>().mockImplementation(async () => { abort.abort(); return response({ registered: true }); });
  await expect(client(late).enrollBody!('job', abort.signal)).rejects.toThrow(/^Worker body enrollment failed; outcome may be uncertain$/); expect(late).toHaveBeenCalledOnce();
});

for (const value of [{}, { registered: false }, { registered: 'true' }, { registered: true, token: 'must-not-be-returned' }]) it('requires the exact metadata-only body enrollment acknowledgement', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value));
  await expect(client(fetcher).enrollBody!('job', new AbortController().signal)).rejects.toThrow(/^Worker body enrollment failed; outcome may be uncertain$/); expect(fetcher).toHaveBeenCalledOnce();
});
for (const source of ['worker', 'attempt']) it(`cancels the actual enrollment request on ${source} abort`, async () => {
  const worker = new AbortController(), attempt = new AbortController(); let began!: () => void; const ready = new Promise<void>(resolve => { began = resolve; }); let signal!: AbortSignal;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => { signal = init!.signal!; signal.addEventListener('abort', () => reject(Error('private network abort')), { once: true }); began(); }));
  const pending = client(fetcher, worker.signal).enrollBody!('job', attempt.signal); const rejected = expect(pending).rejects.toThrow(/^Worker body enrollment failed; outcome may be uncertain$/); await ready;
  try { (source === 'worker' ? worker : attempt).abort(); expect(signal.aborted).toBe(true); await rejected; expect(fetcher).toHaveBeenCalledOnce(); }
  finally { worker.abort(); attempt.abort(); await pending.catch(() => {}); }
});

it('erases client-owned bytes on abort even while an ignoring transport still holds the enrollment ACK', async () => {
  const original = Buffer.from, owned: Buffer[] = [];
  const from = vi.spyOn(Buffer, 'from').mockImplementation(((...args: unknown[]) => { const result = Reflect.apply(original, Buffer, args) as Buffer; if (typeof args[0] === 'string' && /^body_[a-f0-9]{64}$/.test(args[0])) owned.push(result); return result; }) as typeof Buffer.from);
  let release!: (value: Response) => void, began!: () => void; const ready = new Promise<void>(resolve => { began = resolve; });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Promise<Response>(resolve => { release = resolve; began(); })), abort = new AbortController();
  const pending = client(fetcher).enrollBody!('job', abort.signal); const rejected = expect(pending).rejects.toThrow('Worker body enrollment failed');
  try { await ready; expect(owned).toHaveLength(1); expect(owned[0][0]).not.toBe(0); abort.abort(); expect(owned[0].every(byte => byte === 0)).toBe(true); }
  finally { release(response({ registered: true })); await rejected; from.mockRestore(); }
});
it('keeps an abort eraser across successful ownership handoff until the parent erases the token', async () => {
  const abort = new AbortController(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ registered: true }));
  const bootstrap = await client(fetcher).enrollBody!('job', abort.signal); expect(bootstrap.token[0]).not.toBe(0); abort.abort(); expect(bootstrap.token.every(byte => byte === 0)).toBe(true); bootstrap.erase?.();
});

it('erases enrollment bytes on its request deadline before an ignoring transport returns, and rejects its late ACK', async () => {
  vi.useFakeTimers(); const original = Buffer.from, owned: Buffer[] = [];
  const from = vi.spyOn(Buffer, 'from').mockImplementation(((...args: unknown[]) => { const result = Reflect.apply(original, Buffer, args) as Buffer; if (typeof args[0] === 'string' && /^body_[a-f0-9]{64}$/.test(args[0])) owned.push(result); return result; }) as typeof Buffer.from);
  let release!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Promise<Response>(resolve => { release = resolve; }));
  const control = httpWorkerControl({ url: 'https://loom.example', token: 'machine-token', signal: new AbortController().signal, timeoutMs: 10, fetch: fetcher });
  const pending = control.enrollBody!('job', new AbortController().signal), rejected = expect(pending).rejects.toThrow('Worker body enrollment failed');
  try { expect(owned).toHaveLength(1); expect(owned[0][0]).not.toBe(0); await vi.advanceTimersByTimeAsync(10); expect(owned[0].every(byte => byte === 0)).toBe(true); }
  finally { release(response({ registered: true })); await rejected; from.mockRestore(); vi.useRealTimers(); }
});

it('uses32randombytes per locally generated token and never reuses a constant credential', async () => {
  const source = vi.mocked(randomBytes as (size: number) => Buffer), before = source.mock.calls.length;
  source.mockReturnValueOnce(Buffer.alloc(32, 0x11)).mockReturnValueOnce(Buffer.alloc(32, 0x22));
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ registered: true })), control = client(fetcher);
  const first = await control.enrollBody!('first', new AbortController().signal), second = await control.enrollBody!('second', new AbortController().signal);
  expect(Buffer.from(first.token).toString()).toBe('body_'+'11'.repeat(32)); expect(Buffer.from(second.token).toString()).toBe('body_'+'22'.repeat(32));
  expect(source.mock.calls.slice(before)).toEqual([[32], [32]]); first.erase?.(); second.erase?.();
});
