import { expect, it, vi } from 'vitest';
import { workerProgram } from './worker-program.js';
import type { WorkerCommand } from './worker-process.js';
import { WORKER_STOP, workerStopLine } from './worker-stop.js';
const command = { command: '/private-reader', args: [], cwd: '/private', env: {} };
const account = { account: 'sub', owner: 'owner', provider: 'provider' };
const windows = [{ name: 'week', usage: 0.2, readAt: '2026-11-15T00:00:00Z', resetsAt: '2026-11-16T00:00:00Z', durationMs: 604800000 }];
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { resolve, reject, promise }; }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  const config = { url: 'https://loom.example', box: 'box', tokenFile: '/token', build: command, runners: { native: command },
    accountUsage: { readers: [{ command, account }], intervalMs: 1000 } };
  const handlers = new Map<string, () => void>(), stopRun = deferred<void>();
  const provider = vi.fn(async (_account: typeof account) => windows);
  const input = { args: ['/config'], read: vi.fn(async (path: string) => path === '/config' ? JSON.stringify(config) : 'machine-token'),
    on: (name: string, stop: () => void) => { handlers.set(name, stop); }, off: (name: string) => { handlers.delete(name); },
    error: vi.fn(), output: vi.fn(), health: vi.fn(async (_input: { signal: AbortSignal; facts?: readonly string[] }) => ({ ok: true as const })), usage: vi.fn((_plan: WorkerCommand, _options: { signal: AbortSignal; timeoutMs?: number }) => provider), usageBasis: vi.fn(async () => ({ basis: '00000000-0000-4000-8000-000000000001' })),
    reportUsage: vi.fn(async (_remote: unknown, _observation: { basis: string }) => ({ recorded: true })), usageUnavailable: vi.fn(async () => ({ recorded: true })),
    control: vi.fn(() => ({} as never)), executor: vi.fn(() => ({} as never)),
    run: vi.fn(async ({ signal }: { signal: AbortSignal }) => { signal.addEventListener('abort', () => stopRun.resolve(), { once: true }); await stopRun.promise; }),
    pause: vi.fn(async (_ms: number, signal: AbortSignal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }) };
  return { config, input, handlers, provider, stopRun };
}
it('refreshes before the first claim and repeats only after the configured pause', async () => {
  const f = fixture(), tick = deferred<void>();
  f.input.usageBasis.mockResolvedValueOnce({ basis: '00000000-0000-4000-8000-000000000001' }).mockResolvedValueOnce({ basis: '00000000-0000-4000-8000-000000000002' });
  let signal!: AbortSignal;
  f.input.pause.mockImplementationOnce(async (ms, current) => { expect(ms).toBe(1000); signal = current; await tick.promise; });
  f.input.run.mockImplementation(async () => { expect(f.input.reportUsage).toHaveBeenCalledOnce(); await f.stopRun.promise; });
  const running = workerProgram(f.input); await flush();
  expect(f.provider).toHaveBeenCalledOnce(); expect(f.input.usageBasis).toHaveBeenCalledOnce(); expect(f.input.run).toHaveBeenCalledOnce();
  tick.resolve(); await flush(); expect(f.provider).toHaveBeenCalledTimes(2); expect(f.input.reportUsage).toHaveBeenCalledTimes(2);
  expect(f.input.reportUsage).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'machine-token', signal }), { ...account, windows, basis: '00000000-0000-4000-8000-000000000002' });
  expect(f.input.usageBasis).toHaveBeenCalledTimes(2);
  expect(f.input.reportUsage.mock.calls[0][1].basis).toBe('00000000-0000-4000-8000-000000000001');
  f.stopRun.resolve(); expect(await running).toBe(0); expect(signal.aborted).toBe(true); expect(f.handlers.size).toBe(0); expect(f.input.output).not.toHaveBeenCalled();
});
it('does not overlap accounts or scans while a private reader is pending', async () => {
  const f = fixture(), pending = deferred<typeof windows>();
  f.config.accountUsage.readers.push({ command, account: { ...account, account: 'other' } });
  f.provider.mockImplementationOnce(() => pending.promise);
  const running = workerProgram(f.input); await flush();
  expect(f.provider).toHaveBeenCalledOnce(); expect(f.input.pause).not.toHaveBeenCalled(); expect(f.input.run).not.toHaveBeenCalled();
  pending.resolve(windows); await flush(); expect(f.provider).toHaveBeenCalledTimes(2); expect(f.input.run).toHaveBeenCalledOnce();
  f.stopRun.resolve(); expect(await running).toBe(0);
});
it('reports an unavailable provider without stopping the next account or leaking its diagnostics', async () => {
  const f = fixture(); f.config.accountUsage.readers.push({ command, account: { ...account, account: 'other' } });
  f.provider.mockRejectedValueOnce(new Error('private profile password'));
  const running = workerProgram(f.input); await flush();
  expect(f.input.usageUnavailable).toHaveBeenCalledExactlyOnceWith(expect.anything(), { ...account, basis: '00000000-0000-4000-8000-000000000001' });
  expect(f.input.reportUsage).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ account: 'other' }));
  expect(f.input.error).toHaveBeenCalledExactlyOnceWith('Worker quota refresh unavailable\n'); expect(f.input.run).toHaveBeenCalledOnce();
  f.stopRun.resolve(); expect(await running).toBe(0);
});
it('does not invoke the provider or mark failure when the reporting door is unavailable', async () => {
  const f = fixture(); f.input.usageBasis.mockRejectedValueOnce(new Error('private HTTP diagnostics'));
  const running = workerProgram(f.input); await flush();
  expect(f.provider).not.toHaveBeenCalled(); expect(f.input.usageUnavailable).not.toHaveBeenCalled(); expect(f.input.run).toHaveBeenCalledOnce();
  f.stopRun.resolve(); expect(await running).toBe(0); expect(f.input.error).toHaveBeenCalledExactlyOnceWith('Worker quota refresh unavailable\n');
});
it('cancels and joins the initial private reader before returning, with no late report or claim', async () => {
  const f = fixture(), pending = deferred<typeof windows>(); f.provider.mockImplementationOnce(() => pending.promise);
  let finished = false; const running = workerProgram(f.input).then(code => { finished = true; return code; }); await flush();
  f.handlers.get('SIGTERM')!(); await flush(); expect(finished).toBe(false);
  expect(f.input.usage.mock.calls[0][1].signal.aborted).toBe(true);
  pending.resolve(windows); expect(await running).toBe(0);
  expect(f.input.reportUsage).not.toHaveBeenCalled(); expect(f.input.usageUnavailable).not.toHaveBeenCalled(); expect(f.input.run).not.toHaveBeenCalled(); expect(f.input.error).not.toHaveBeenCalled();
});
it('joins an in-flight background read after the worker slot stops and suppresses its late failure', async () => {
  const f = fixture(), tick = deferred<void>(), pending = deferred<typeof windows>();
  f.input.pause.mockImplementationOnce(() => tick.promise); f.provider.mockImplementationOnce(async () => windows).mockImplementationOnce(() => pending.promise);
  let returned = false; const running = workerProgram(f.input).then(code => { returned = true; return code; }); await flush(); tick.resolve(); await flush(); expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.input.pause).toHaveBeenCalledOnce(); await flush(); expect(f.provider).toHaveBeenCalledTimes(2);
  f.stopRun.resolve(); await flush(); expect(f.input.usage.mock.calls[1][1].signal.aborted).toBe(true);
  expect(returned).toBe(false); expect(f.handlers.size).toBe(2);
  pending.reject(new Error('private late failure')); expect(await running).toBe(0); expect(f.handlers.size).toBe(0); expect(f.input.reportUsage).toHaveBeenCalledOnce(); expect(f.input.usageUnavailable).not.toHaveBeenCalled();
});
for (const patch of [{ readers: [] }, { intervalMs: 0 }, { intervalMs: 3600001 }, { intervalMs: 1.5 }, { readers: [{ command, account }, { command, account }] }, { readers: [{ command: { ...command, command: '\0' }, account }] }]) {
  it('rejects invalid refresh configuration before reading the machine token or starting commands', async () => {
    const f = fixture(); Object.assign(f.config.accountUsage, patch);
    expect(await workerProgram(f.input)).toBe(WORKER_STOP.config[0]); expect(f.input.read).toHaveBeenCalledExactlyOnceWith('/config');
    expect(f.input.usage).not.toHaveBeenCalled(); expect(f.input.control).not.toHaveBeenCalled(); expect(f.input.run).not.toHaveBeenCalled();
  });
}

it('aborts and joins the worker slot after unexpected timer rejection without an unhandled rejection', async () => {
  const f = fixture(), failure = deferred<void>(), unhandled = vi.fn(); let signal!: AbortSignal;
  f.input.pause.mockImplementationOnce(() => failure.promise);
  f.input.run.mockImplementation(async input => { signal = input.signal; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); });
  process.on('unhandledRejection', unhandled);
  try {
    const running = workerProgram(f.input); await flush(); expect(f.input.run).toHaveBeenCalledOnce();
    failure.reject(new Error('private timer diagnostics'));
    expect(await running).toBe(WORKER_STOP.refresh[0]); await new Promise<void>(resolve => setImmediate(resolve));
    expect(signal.aborted).toBe(true); expect(f.handlers.size).toBe(0); expect(unhandled).not.toHaveBeenCalled();
    expect(f.input.error).toHaveBeenCalledExactlyOnceWith(workerStopLine('refresh'));
  } finally { process.off('unhandledRejection', unhandled); }
});
for (const stage of ['provider', 'basis', 'report'] as const) it(`runs a new read on a later scan after ${stage} failure`, async () => {
  const f = fixture(), tick = deferred<void>();
  f.input.pause.mockImplementationOnce(() => tick.promise);
  if (stage === 'provider') f.provider.mockRejectedValueOnce(new Error('private diagnostics'));
  else if (stage === 'basis') f.input.usageBasis.mockRejectedValueOnce(new Error('private diagnostics'));
  else f.input.reportUsage.mockRejectedValueOnce(new Error('private diagnostics'));
  const running = workerProgram(f.input); await flush(); expect(f.input.run).toHaveBeenCalledOnce();
  tick.resolve(); await flush();
  expect(f.input.usageBasis).toHaveBeenCalledTimes(2); expect(f.provider).toHaveBeenCalledTimes(stage === 'basis' ? 1 : 2);
  expect(f.input.reportUsage).toHaveBeenCalledTimes(stage === 'report' ? 2 : 1);
  expect(f.input.usageUnavailable).toHaveBeenCalledTimes(stage === 'provider' ? 1 : 0);
  expect(f.input.error).toHaveBeenCalledExactlyOnceWith('Worker quota refresh unavailable\n');
  f.stopRun.resolve(); expect(await running).toBe(0);
});

it('starts no refresh timer or provider/reporting work while an unconfigured worker slot remains active', async () => {
  const f = fixture(), { accountUsage: _unused, ...config } = f.config;
  f.input.read.mockImplementation(async path => path === '/config' ? JSON.stringify(config) : 'machine-token');
  const running = workerProgram(f.input); await flush(); expect(f.input.run).toHaveBeenCalledOnce();
  expect(f.input.pause).not.toHaveBeenCalled(); expect(f.input.usage).not.toHaveBeenCalled(); expect(f.input.usageBasis).not.toHaveBeenCalled();
  expect(f.input.reportUsage).not.toHaveBeenCalled(); expect(f.input.usageUnavailable).not.toHaveBeenCalled();
  f.stopRun.resolve(); expect(await running).toBe(0); expect(f.handlers.size).toBe(0);
});
it('refuses more than32 distinct readers before reading the machine credential', async () => {
  const f = fixture(); f.config.accountUsage.readers = Array.from({ length: 33 }, (_, index) => ({ command, account: { ...account, account: 'subscription-'+index } }));
  expect(await workerProgram(f.input)).toBe(WORKER_STOP.config[0]); expect(f.input.read).toHaveBeenCalledExactlyOnceWith('/config');
  expect(f.input.usage).not.toHaveBeenCalled(); expect(f.input.control).not.toHaveBeenCalled(); expect(f.input.run).not.toHaveBeenCalled();
});
it('aborts and joins a pending background reader when the worker slot fails', async () => {
  const f = fixture(), tick = deferred<void>(), pending = deferred<typeof windows>();
  f.input.pause.mockImplementationOnce(() => tick.promise); f.provider.mockImplementationOnce(async () => windows).mockImplementationOnce(() => pending.promise);
  let returned = false; const running = workerProgram(f.input).then(code => { returned = true; return code; });
  await flush(); tick.resolve(); await flush(); expect(f.provider).toHaveBeenCalledTimes(2);
  f.stopRun.reject(new Error('private execution diagnostic')); await flush();
  expect(f.input.usage.mock.calls[1][1].signal.aborted).toBe(true); expect(returned).toBe(false); expect(f.handlers.size).toBe(2);
  pending.resolve(windows); expect(await running).toBe(WORKER_STOP.slot[0]); expect(f.handlers.size).toBe(0);
  expect(f.input.reportUsage).toHaveBeenCalledOnce(); expect(f.input.usageUnavailable).not.toHaveBeenCalled();
  expect(f.input.error).toHaveBeenCalledExactlyOnceWith(workerStopLine('slot'));
});
it('uses the documented one-minute interval when omitted from normal-worker configuration', async () => {
  const f = fixture(), { intervalMs: _unused, ...accountUsage } = f.config.accountUsage;
  f.input.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...f.config, accountUsage }) : 'machine-token');
  const running = workerProgram(f.input); await flush();
  expect(f.input.pause).toHaveBeenCalledExactlyOnceWith(60_000, expect.any(AbortSignal));
  f.stopRun.resolve(); expect(await running).toBe(0);
});

it('reports health before and during a long initial read without allowing an early claim', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), pending = deferred<typeof windows>(); f.provider.mockImplementationOnce(() => pending.promise);
    f.input.read.mockImplementation(async path => path === '/config' ? JSON.stringify({ ...f.config, facts: ['gpu:5090'] }) : 'machine-token');
    const running = workerProgram(f.input); await flush();
    expect(f.input.health).toHaveBeenCalledOnce(); expect(f.provider).toHaveBeenCalledOnce(); expect(f.input.run).not.toHaveBeenCalled();
    for (let i = 1; i <= 3; i++) { await vi.advanceTimersByTimeAsync(14999); expect(f.input.health).toHaveBeenCalledTimes(i); await vi.advanceTimersByTimeAsync(1); expect(f.input.health).toHaveBeenCalledTimes(i+1); }
    expect(f.input.health.mock.calls.map(([input]) => input.facts)).toEqual(Array.from({ length: 4 }, () => ['gpu:5090'])); expect(f.input.run).not.toHaveBeenCalled();
    pending.resolve(windows); await flush(); expect(f.input.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30000); expect(f.input.health).toHaveBeenCalledTimes(4);
    f.stopRun.resolve(); expect(await running).toBe(0); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('serializes startup health reports and joins a pending report before claiming', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), reader = deferred<typeof windows>(), health = deferred<{ ok: true }>();
    f.provider.mockImplementationOnce(() => reader.promise); f.input.health.mockImplementationOnce(async () => ({ ok: true })).mockImplementationOnce(() => health.promise);
    const running = workerProgram(f.input); await flush(); await vi.advanceTimersByTimeAsync(45000);
    expect(f.input.health).toHaveBeenCalledTimes(2); reader.resolve(windows); await flush(); expect(f.input.run).not.toHaveBeenCalled();
    health.resolve({ ok: true }); await flush(); expect(f.input.run).toHaveBeenCalledOnce();
    f.stopRun.resolve(); expect(await running).toBe(0); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
for (const synchronous of [false, true]) for (const outcome of ['success', 'failure']) it(`suppresses late ${outcome} and aborts the initial reader after ${synchronous ? 'synchronous' : 'asynchronous'} health failure and emits no late quota report`, async () => {
  vi.useFakeTimers(); const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
  try {
    const f = fixture(), reader = deferred<typeof windows>(); f.provider.mockImplementationOnce(() => reader.promise);
    f.input.health.mockImplementationOnce(async () => ({ ok: true })).mockImplementationOnce(() => { if (synchronous) throw Error('private credential'); return Promise.reject(Error('private credential')); });
    const running = workerProgram(f.input); await flush(); await vi.advanceTimersByTimeAsync(15000);
    expect(f.input.usage.mock.calls[0][1].signal.aborted).toBe(true); expect(f.input.run).not.toHaveBeenCalled();
    if (outcome === 'failure') reader.reject(Error('private late quota failure')); else reader.resolve(windows);
    expect(await running).toBe(WORKER_STOP.health[0]); await vi.advanceTimersByTimeAsync(0); expect(unhandled).not.toHaveBeenCalled();
    expect(f.input.reportUsage).not.toHaveBeenCalled(); expect(f.input.usageUnavailable).not.toHaveBeenCalled();
    expect(f.input.error).toHaveBeenCalledExactlyOnceWith(workerStopLine('health')); expect(vi.getTimerCount()).toBe(0);
  } finally { process.off('unhandledRejection', unhandled); vi.useRealTimers(); }
});
it('refuses an initial health failure before invoking private readers or claiming work', async () => {
  const f = fixture(); f.input.health.mockRejectedValueOnce(Error('private credential'));
  expect(await workerProgram(f.input)).toBe(WORKER_STOP.health[0]); expect(f.provider).not.toHaveBeenCalled(); expect(f.input.run).not.toHaveBeenCalled(); expect(f.handlers.size).toBe(0);
});

it('cancels and joins the initial health request without opening a reader or claiming', async () => {
  const f = fixture(), health = deferred<{ ok: true }>(); f.input.health.mockImplementationOnce(() => health.promise);
  let returned = false; const running = workerProgram(f.input).then(code => { returned = true; return code; }); await flush();
  f.handlers.get('SIGTERM')!(); await flush(); expect(f.input.health.mock.calls[0][0].signal.aborted).toBe(true); expect(returned).toBe(false); expect(f.handlers.size).toBe(2);
  health.resolve({ ok: true }); expect(await running).toBe(0); expect(f.provider).not.toHaveBeenCalled(); expect(f.input.run).not.toHaveBeenCalled(); expect(f.handlers.size).toBe(0);
});
it('joins an outstanding startup health request after cancellation even when the reader settles first', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), reader = deferred<typeof windows>(), health = deferred<{ ok: true }>();
    f.provider.mockImplementationOnce(() => reader.promise); f.input.health.mockResolvedValueOnce({ ok: true }).mockImplementationOnce(() => health.promise);
    let returned = false; const running = workerProgram(f.input).then(code => { returned = true; return code; }); await flush(); await vi.advanceTimersByTimeAsync(15000);
    f.handlers.get('SIGINT')!(); reader.resolve(windows); await flush(); expect(returned).toBe(false); expect(f.handlers.size).toBe(2);
    expect(f.input.health.mock.calls[1][0].signal.aborted).toBe(true); health.resolve({ ok: true }); expect(await running).toBe(0);
    expect(f.input.reportUsage).not.toHaveBeenCalled(); expect(f.input.usageUnavailable).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); expect(f.handlers.size).toBe(0);
  } finally { vi.useRealTimers(); }
});
