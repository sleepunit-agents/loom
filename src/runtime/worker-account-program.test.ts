import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { workerProgram } from './worker-program.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const identity = { account: 'subscription', owner: 'member', provider: 'provider' };
const command = { command: '/private/helper', args: ['--json'], cwd: '/private', env: { PRIVATE: 'credential-secret' } };
const windows = [{ name: 'week', usage: 0.5, readAt: '2026-11-14T20:00:00Z', resetsAt: '2026-11-15T20:00:00Z', durationMs: 7 * 86400_000 }];
function fixture(mode: '--account-signin' | '--account-usage', timeoutMs?: number) {
  vi.useFakeTimers();
  let stdin = '';
  const child = Object.assign(new EventEmitter(), { pid: 123,
    stdin: new Writable({ write(chunk, _encoding, done) { stdin += chunk.toString(); done(); } }),
    stdout: new PassThrough(), stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const sent = new Promise<void>(resolve => { child.stdin.once('finish', resolve); });
  vi.mocked(spawn).mockReset().mockReturnValue(child);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const handlers = new Map<string, () => void>();
  const config = { command, account: identity, ...(mode === '--account-signin' ? { box: 'worker' } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const input = { usageBasis: vi.fn(async () => ({ basis: '00000000-0000-4000-8000-000000000001' })), usageUnavailable: vi.fn(async () => ({ recorded: true })), args: [mode, '/config'], read: vi.fn<(path: string) => Promise<string>>(async path => { if (path !== '/config') throw Error('Unexpected local read'); return JSON.stringify(config); }), output: vi.fn(), error: vi.fn(),
    on: (name: string, callback: () => void) => { handlers.set(name, callback); },
    off: (name: string) => { handlers.delete(name); }, control: vi.fn(), run: vi.fn() };
  return { child, input, handlers, kill, config, sent, stdin: () => stdin };
}
function configureReporting(f: ReturnType<typeof fixture>) {
  f.input.read.mockImplementation(async path => {
    if (path === '/token') return 'worker-credential';
    if (path !== '/config') throw Error('Unexpected reporting read');
    return JSON.stringify({ ...f.config, report: { url: 'https://loom.example', tokenFile: '/token' } });
  });
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function spawned(f: ReturnType<typeof fixture>) {
  await flush();
  expect(spawn).toHaveBeenCalledExactlyOnceWith('/private/helper', ['--json'], {
    cwd: '/private', env: { PRIVATE: 'credential-secret' }, shell: false, detached: true, stdio: 'pipe',
  });
  f.child.emit('spawn'); await f.sent; await flush();
}
for (const mode of ['--account-signin', '--account-usage'] as const) {
  it(`runs ${mode} through the real adapter without exposing private diagnostics`, async () => {
    const f = fixture(mode), result = workerProgram(f.input); await spawned(f);
    expect(JSON.parse(f.stdin())).toEqual({ ...identity, ...(mode === '--account-signin' ? { box: 'worker' } : {}) });
    f.child.stderr.emit('data', 'credential-secret');
    f.child.stdout.emit('data', JSON.stringify(mode === '--account-signin' ? { signedIn: true } : windows));
    f.child.emit('close', 0, null); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(0);
    expect(f.input.output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(mode === '--account-signin'
      ? { ...identity, box: 'worker', signedIn: true } : { ...identity, windows }) + '\n');
    expect(f.input.read).toHaveBeenCalledExactlyOnceWith('/config');
    expect(f.input.error).not.toHaveBeenCalled(); expect(f.input.run).not.toHaveBeenCalled(); expect(f.input.control).not.toHaveBeenCalled();
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(-123, 'SIGKILL');
    expect(f.handlers.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  for (const timeoutMs of [undefined, 20]) it(`bounds ${mode} with ${timeoutMs ?? 'default'} deadline even if the process never closes`, async () => {
    const f = fixture(mode, timeoutMs), result = workerProgram(f.input); await spawned(f);
    let settled = false; void result.then(() => { settled = true; });
    const deadline = timeoutMs ?? (mode === '--account-signin' ? 300_000 : 30_000);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).toBe(false); expect(f.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(1); expect(spawn).toHaveBeenCalledOnce();
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(-123, 'SIGKILL');
    expect(f.input.output).not.toHaveBeenCalled(); expect(f.handlers.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it(`cancels the actual ${mode} process and suppresses late success`, async () => {
    const f = fixture(mode), result = workerProgram(f.input); await spawned(f);
    f.handlers.get('SIGTERM')!();
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(-123, 'SIGKILL');
    f.child.stdout.emit('data', JSON.stringify(mode === '--account-signin' ? { signedIn: true } : windows));
    f.child.emit('close', 0, null); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(1); expect(f.input.output).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce(); expect(f.handlers.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
}
for (const output of ['not-json', JSON.stringify([{ ...windows[0], token: 'credential-secret' }]), JSON.stringify([{ ...windows[0], usage: 2 }]), JSON.stringify([{ ...windows[0], readAt: 'invalid' }]), JSON.stringify([{ ...windows[0], durationMs: 0 }]), JSON.stringify([{ name: 'week' }])]) {
  it('rejects invalid private quota output through the actual worker entry', async () => {
    const f = fixture('--account-usage'), result = workerProgram(f.input); await spawned(f);
    f.child.stdout.emit('data', output); f.child.emit('close', 0, null); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(1); expect(f.input.output).not.toHaveBeenCalled();
    expect(f.input.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: invalid configuration or unavailable execution\n');
    expect(spawn).toHaveBeenCalledOnce(); expect(f.handlers.size).toBe(0);
  });
}
for (const mode of ['--account-signin', '--account-usage'] as const) {
for (const patch of [
  { account: { ...identity, token: 'credential-secret' } },
  { account: { account: 'subscription', owner: 'member' } },
  { command: { ...command, shell: true } },
  { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 300_001 },
]) it('refuses malformed private command configuration before spawning', async () => {
  const f = fixture(mode); f.input.read.mockResolvedValue(JSON.stringify({ ...f.config, ...patch }));
  expect(await workerProgram(f.input)).toBe(1); expect(spawn).not.toHaveBeenCalled();
  expect(f.input.read).toHaveBeenCalledExactlyOnceWith('/config'); expect(f.input.output).not.toHaveBeenCalled();
});

}

for (const [output, code] of [['{"signedIn":false}', 0], ['not-json', 0], ['{"signedIn":true}', 7], ['{"signedIn":true,"token":"credential-secret"}', 0]] as const) {
  it('never acknowledges unsuccessful or invalid private sign-in through the executable program', async () => {
    const f = fixture('--account-signin'), result = workerProgram(f.input); await spawned(f);
    f.child.stdout.emit('data', output); f.child.emit('close', code, null); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(1); expect(f.input.output).not.toHaveBeenCalled();
    expect(f.input.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: invalid configuration or unavailable execution\n');
    expect(spawn).toHaveBeenCalledOnce(); expect(f.handlers.size).toBe(0);
  });
}

it('rejects valid quota output when the private command exits unsuccessfully', async () => {
  const f = fixture('--account-usage'), result = workerProgram(f.input); await spawned(f);
  f.child.stdout.emit('data', JSON.stringify(windows)); f.child.emit('close', 7, null);
  expect(await result).toBe(1); expect(f.input.output).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledOnce();
});
it('refuses a box field in a usage configuration', async () => {
  const f = fixture('--account-usage'); f.input.read.mockResolvedValue(JSON.stringify({ ...f.config, box: 'unexpected' }));
  expect(await workerProgram(f.input)).toBe(1); expect(spawn).not.toHaveBeenCalled(); expect(f.input.output).not.toHaveBeenCalled();
});

it('reports a successful configured quota read before acknowledging local completion', async () => {
  const f = fixture('--account-usage'), report = vi.fn(async () => ({ recorded: true }));
  configureReporting(f);
  const pending = workerProgram({ ...f.input, reportUsage: report }); await spawned(f);
  f.child.stdout.emit('data', JSON.stringify(windows)); f.child.emit('close', 0, null);
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBe(0);
  expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: 'https://loom.example', token: 'worker-credential' }), { ...identity, windows, basis: '00000000-0000-4000-8000-000000000001' });
  expect(f.input.read.mock.calls.map(call => call[0])).toEqual(['/config', '/token']);
});
it('does not retry or print a success after an uncertain quota report', async () => {
  const f = fixture('--account-usage'), report = vi.fn(async () => { throw Error('private remote diagnostics'); });
  configureReporting(f);
  const pending = workerProgram({ ...f.input, reportUsage: report }); await spawned(f);
  f.child.stdout.emit('data', JSON.stringify(windows)); f.child.emit('close', 0, null); await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBe(1); expect(report).toHaveBeenCalledOnce(); expect(f.input.output).not.toHaveBeenCalled();
  expect(f.input.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: invalid configuration or unavailable execution\n');
});

it('waits for a configured report and suppresses a late success after SIGTERM', async () => {
  const f = fixture('--account-usage'); let release!: (value: { recorded: boolean }) => void;
  const report = vi.fn(() => new Promise<{ recorded: boolean }>(resolve => { release = resolve; }));
  configureReporting(f);
  const pending = workerProgram({ ...f.input, reportUsage: report }); await spawned(f);
  f.child.stdout.emit('data', JSON.stringify(windows)); f.child.emit('close', 0, null); await flush();
  expect(report).toHaveBeenCalledOnce(); expect(f.input.output).not.toHaveBeenCalled();
  const signal = (report.mock.calls[0] as unknown as [ { signal: AbortSignal } ])[0].signal;
  f.handlers.get('SIGTERM')!(); expect(signal.aborted).toBe(true);
  release({ recorded: true }); expect(await pending).toBe(1); expect(f.input.output).not.toHaveBeenCalled();
});
for (const output of ['invalid-json', '[{"name":"week","usage":2}]']) it('reports unavailability rather than successful usage after a failed provider read', async () => {
  const f = fixture('--account-usage'), report = vi.fn();
  configureReporting(f);
  const pending = workerProgram({ ...f.input, reportUsage: report }); await spawned(f);
  f.child.stdout.emit('data', output); f.child.emit('close', 0, null); await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBe(1); expect(report).not.toHaveBeenCalled(); expect(f.input.read.mock.calls.map(call => call[0])).toEqual(['/config', '/token']);
  expect(f.input.usageUnavailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ token: 'worker-credential' }), { ...identity, basis: '00000000-0000-4000-8000-000000000001' });
});
it('prints a local success only after the reporting promise acknowledges', async () => {
  const f = fixture('--account-usage'); let release!: (value: { recorded: boolean }) => void;
  const report = vi.fn(() => new Promise<{ recorded: boolean }>(resolve => { release = resolve; }));
  configureReporting(f);
  const pending = workerProgram({ ...f.input, reportUsage: report }); await spawned(f);
  f.child.stdout.emit('data', JSON.stringify(windows)); f.child.emit('close', 0, null); await flush();
  expect(report).toHaveBeenCalledOnce(); expect(f.input.output).not.toHaveBeenCalled();
  release({ recorded: true }); expect(await pending).toBe(0);
  expect(f.input.output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ...identity, windows }) + '\n');
});
it('does not launch a provider after cancellation during the witness request', async () => {
  const f = fixture('--account-usage'); configureReporting(f); let release!: (value: { basis: string }) => void;
  const usageBasis = vi.fn(() => new Promise<{ basis: string }>(resolve => { release = resolve; }));
  const pending = workerProgram({ ...f.input, usageBasis }); await flush(); expect(usageBasis).toHaveBeenCalledOnce(); expect(spawn).not.toHaveBeenCalled();
  f.handlers.get('SIGTERM')!(); release({ basis: '00000000-0000-4000-8000-000000000001' });
  expect(await pending).toBe(1); expect(spawn).not.toHaveBeenCalled(); expect(f.input.usageUnavailable).not.toHaveBeenCalled();
});
it('does not retry an uncertain failure acknowledgement or leak provider diagnostics', async () => {
  const f = fixture('--account-usage'); configureReporting(f); const usageUnavailable = vi.fn(async () => { throw Error('private upstream failure'); });
  const pending = workerProgram({ ...f.input, usageUnavailable }); await spawned(f); f.child.emit('close', 1, null); await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBe(1); expect(usageUnavailable).toHaveBeenCalledOnce(); expect(f.input.output).not.toHaveBeenCalled();
  expect(f.input.error).toHaveBeenCalledExactlyOnceWith('Worker stopped: invalid configuration or unavailable execution\n');
});

it('does not request a witness after cancellation during its token file read', async () => {
  const f = fixture('--account-usage'); let release!: (value: string) => void;
  f.input.read.mockImplementation(async path => path === '/config'
    ? JSON.stringify({ ...f.config, report: { url: 'https://loom.example', tokenFile: '/token' } })
    : new Promise<string>(resolve => { release = resolve; }));
  const pending = workerProgram(f.input); await flush(); expect(f.input.read).toHaveBeenCalledTimes(2);
  f.handlers.get('SIGTERM')!(); release('worker-credential'); expect(await pending).toBe(1);
  expect(f.input.usageBasis).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
});

it('does not report either outcome after cancelling an active reporting provider', async () => {
  const f = fixture('--account-usage'); configureReporting(f); const reportUsage = vi.fn();
  const pending = workerProgram({ ...f.input, reportUsage }); await spawned(f);
  f.handlers.get('SIGTERM')!(); await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBe(1); expect(f.input.usageBasis).toHaveBeenCalledOnce();
  expect(reportUsage).not.toHaveBeenCalled(); expect(f.input.usageUnavailable).not.toHaveBeenCalled(); expect(f.input.output).not.toHaveBeenCalled();
});
