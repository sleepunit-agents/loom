import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { signInFailureLine, workerSignIn, httpWorkerControl, reportWorkerAccountUsage, reportWorkerHealth } from './worker-http.js';
import { SILENCE_MS } from './silence.js';
vi.mock('node:crypto', async original => { const actual = await original<typeof import('node:crypto')>(); return { ...actual, randomBytes: vi.fn((size: number) => actual.randomBytes(size)) }; });
const assignment = { id: 'j1', box: 'attic', agent: 'art', conversation: 'cv1', model: 'm', account: 'a', harness: 'h', brief: 'private', house: { repository: 'r', file: 'f', branch: 'main' } };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, value }));
function client(fetcher: typeof fetch, signal = new AbortController().signal) {
  return httpWorkerControl({ url: 'https://loom.example', token: 'private-token', fetch: fetcher, signal });
}
describe('worker operation client', () => {
  it('reports the failing sign-in step without provider or account data', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('private upstream words', { status: 503 }))
      .mockRejectedValueOnce(new Error('private URL'))
      .mockResolvedValueOnce(response({ secret: 'private code' }));
    const remote = workerSignIn({ url: 'https://loom.example', token: 'private-token', fetch: fetcher, signal: new AbortController().signal });
    expect(await remote.next().catch(signInFailureLine)).toBe('Worker sign-in check unavailable (checking for a request, HTTP 503)\n');
    expect(await remote.page({ id: 'private-id', link: 'private-link' }).catch(signInFailureLine)).toBe('Worker sign-in check unavailable (reporting the sign-in page, connection failed)\n');
    expect(await remote.code('private-id', 'private-take').catch(signInFailureLine)).toBe('Worker sign-in check unavailable (checking for a code, invalid response)\n');
    expect(signInFailureLine(new Error('private relay output'))).toBe('Worker sign-in check unavailable\n');
  });
  it('uses authenticated operation door, unique ids and no caller-supplied machine', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(assignment)).mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ active: false })).mockResolvedValueOnce(response({ ok: true }));
    const control = client(fetcher);
    expect(await control.next()).toEqual(assignment);
    await control.started('j1', 'image');
    expect(await control.heartbeat('j1', 'running')).toBe(false);
    await control.finish('j1', 0, 'done', 'body');
    const requests = fetcher.mock.calls.map(([url, init]) => ({ url: String(url), ...init, data: JSON.parse(String(init?.body)) }));
    expect(requests.map(r => r.url)).toEqual(['next', 'started', 'heartbeat', 'finish'].map(n => `https://loom.example/api/runtime/${n}`));
    expect(requests.map(r => r.data.input)).toEqual([{ execution: 'container', reviewResults:true }, { job: 'j1', build: 'image' }, { job: 'j1', state: 'running' }, { job: 'j1', exitCode: 0, logTail: 'done', exitBy: 'body' }]);
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
  it('discards error diagnostics and stops on an explicit rejection', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-token private-url private-brief', { status: 403 }));
    await expect(client(fetcher).started('j1', 'image')).rejects.toThrow(/^Worker started failed; outcome may be uncertain$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['started', 'finish'] as const)('survives refusal and a starting server when reporting %s, with the same receipt', async name => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => new Response(null, { status: 503 }))
      .mockImplementationOnce(async () => new Response(null, { status: 429 }))
      .mockImplementationOnce(async () => new Response(null, { status: 500 }))
      .mockResolvedValueOnce(response({ ok: true }));
    const pause = vi.fn(async () => {});
    const control = httpWorkerControl({ url: 'https://loom.example', token: 'private-token', fetch: fetcher, signal: new AbortController().signal, pause });
    if (name === 'started') await control.started('j1', 'image');
    else await control.finish('j1', 0, 'done', 'body');
    const sent = fetcher.mock.calls.map(([, init]) => init?.body);
    expect(sent).toHaveLength(5); expect(new Set(sent).size).toBe(1);
  });
  it('retries enrollment when the socket refused the connection before delivery', async () => {
    const refused = Object.assign(new Error(), { code: 'ECONNREFUSED' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed', { cause: refused }))
      .mockResolvedValueOnce(response({ registered: true }));
    const control = httpWorkerControl({ url: 'https://loom.example', token: 'private-token', fetch: fetcher, signal: new AbortController().signal, pause: async () => {} });
    const bootstrap = await control.enrollBody!('job', new AbortController().signal);
    expect(fetcher.mock.calls[0][1]?.body).toEqual(fetcher.mock.calls[1][1]?.body);
    bootstrap.erase?.();
  });
  it.each([401, 403])('ceases claiming authority when Loom explicitly rejects the heartbeat (HTTP %i)', async status => {
    expect(await client(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, code: 'denied', message: 'Not permitted' }, { status }))).heartbeat('j1', 'running')).toBe(false);
  });
  it.each([200, 401, 403, 429, 500])('treats an unrecognized heartbeat reply (HTTP %i) as unanswered', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('malformed', { status }));
    await expect(client(fetcher).heartbeat('j1', 'running')).rejects.toThrow('Worker heartbeat failed');
  });
  it('retries a repository secret read only after the initial connection was refused', async () => {
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }) });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(refused).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const control = httpWorkerControl({ url: 'https://loom.example', token: 'synthetic', fetch: fetcher, signal: new AbortController().signal, pause: async () => {} });
    expect(await control.repositoryInput!('j1', new AbortController().signal)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockRejectedValueOnce(new TypeError('socket reset'));
    await expect(control.repositoryInput!('j1', new AbortController().signal)).rejects.toThrow('Private secret input unavailable');
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockResolvedValueOnce(new Response('synthetic', { headers: {
      'content-type': 'application/octet-stream', 'x-loom-secret-use': 'use-input-' + 'a'.repeat(64),
    } })).mockRejectedValueOnce(refused);
    await expect(control.repositoryInput!('j1', new AbortController().signal)).rejects.toThrow('Private secret input unavailable');
    expect(fetcher.mock.calls.slice(3).map(([url]) => new URL(String(url)).pathname))
      .toEqual(['/api/secrets/private/read', '/api/secrets/private/confirm']);
  });
  it('keeps every try of a finish report inside the budget the silence interval leaves, whatever the request deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    try {
      const began = performance.now(), gaveUp: number[] = [];
      // loom never answers: each request ends only when its own deadline aborts it.
      const silent = vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => { gaveUp.push(performance.now() - began); reject(new Error('aborted')); })));
      const finished = httpWorkerControl({ url: 'https://loom.example', token: 'private-token', fetch: silent, signal: new AbortController().signal, timeoutMs: 60_000, pause: async () => {} }).finish('j1', 0, 'done', 'body');
      const refused = expect(finished).rejects.toThrow(/^Worker finish failed; outcome may be uncertain$/);
      await vi.advanceTimersByTimeAsync(300_000); await refused;
      expect(gaveUp.length).toBeGreaterThan(0);
      expect(Math.max(...gaveUp)).toBe(60_000 + SILENCE_MS + 1000);
    } finally { vi.useRealTimers(); }
  });
  it.each(['started', 'finish'] as const)('delivers %s when a 119-second outage begins during its first request', async name => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (performance.now() === 0) await new Promise(resolve => setTimeout(resolve, 15_000));
        if (performance.now() < 124_000) throw Error('offline');
        return response({ ok: true });
      });
      const control = httpWorkerControl({ url: 'https://loom.example', token: 'synthetic', signal: new AbortController().signal,
        fetch: fetcher, pause: ms => new Promise(resolve => setTimeout(resolve, ms)) });
      const pending = name === 'finish' ? control.finish('j1', 0, 'done', 'body') : control.started('j1', 'build'); void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(135_000); await pending;
      expect(new Set(fetcher.mock.calls.map(([, init]) => init?.body)).size).toBe(1);
    } finally { vi.useRealTimers(); }
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
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).input)).toEqual([{ execution: 'container', reviewResults:true, facts: ['gpu:5090'] }, { execution: 'container', reviewResults:true, facts: ['gpu:5090'] }]);
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

it('sends the validated program result on the retried finish receipt', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('lost reply')).mockResolvedValueOnce(response({ ok: true }));
  const control = httpWorkerControl({ url: 'https://loom.example', token: 'fixture', signal: new AbortController().signal, fetch: fetcher, pause: async () => {} });
  const result = { version: 1 as const, wake: false, state: { count: 1 } };
  await control.finish('program', 0, '', 'body', result);
  const reports = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(reports[0].input.programResult).toEqual(result);
  expect(reports[1]).toEqual(reports[0]);
});

it('keeps its container witness when an older server refuses the claim schema', async () => {
 const fetcher=vi.fn<typeof fetch>()
   .mockResolvedValueOnce(new Response(JSON.stringify({ok:false,code:'invalid',message:'Input does not match operation schema'}),{status:400}))
   .mockResolvedValueOnce(response(assignment));
 const control=httpWorkerControl({url:'https://loom.example',token:'fixture',signal:new AbortController().signal,fetch:fetcher,programs:true});
 expect(await control.next()).toEqual(assignment);
 expect(fetcher.mock.calls.map(([,init])=>JSON.parse(String(init?.body)).input)).toEqual([{execution:'container',reviewResults:true,programs:true},{execution:'container',programs:true}]);
});

it('keeps review-result capability when only coldReviews is unknown to the server', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: 'invalid', message: 'Input does not match operation schema' }), { status: 400 }))
    .mockResolvedValueOnce(response(assignment));
  const control = httpWorkerControl({ url: 'https://loom.example', token: 'fixture', signal: new AbortController().signal, fetch: fetcher });
  expect(await control.next(true)).toEqual(assignment);
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).input)).toEqual([
    { execution: 'container', reviewResults: true, coldReviews: true }, { execution: 'container', reviewResults: true },
  ]);
});
