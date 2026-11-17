import Database from 'better-sqlite3';
import { createDataSchema } from '../core/data/database.js';
import { members, modelAccounts } from '../core/data/schema.js';
import { refreshAccountWindows, readAccountWindows, currentAccountCapacity } from './account-windows.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { commandUsageProvider, commandWorkerExecutor, commandOutput, workerRunner, type ProcessRuntime, type WorkerCommand } from './worker-process.js';
import { NoRunnerError, type WorkerAssignment } from './worker.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'c', model: 'custom-model', account: 'sub', harness: 'custom-runner', brief: 'private brief', house: { repository: 'repo', file: 'Containerfile', branch: 'main' } };
const plan: WorkerCommand = { command: '/worker/build', args: ['--json'], cwd: '/worker', env: { PATH: '/usr/bin' } };
function fixture() {
  const children: Array<{ child: ChildProcessWithoutNullStreams; input: () => string }> = [];
  const runtime: ProcessRuntime = {
    spawn: vi.fn(() => {
      const events = new EventEmitter(); let input = '';
      const stdin = new Writable({ write(chunk, _encoding, callback) { input += chunk.toString(); callback(); } });
      const child = Object.assign(events, { pid: 123, stdin, stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams;
      children.push({ child, input: () => input }); return child;
    }),
    kill: vi.fn(child => { child.emit('close', null, 'SIGKILL'); }),
  };
  return { runtime, children, executor: commandWorkerExecutor({ build: plan, runners: { 'custom-runner': { ...plan, command: '/worker/run' } } }, runtime) };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe('worker command adapter (no child processes in tests)', () => {
  it('runs configured builder, supplies only house metadata, and uses its artifact', async () => {
    const f = fixture(), signal = new AbortController().signal, result = f.executor.build(job, signal);
    const child = f.children[0]; child.child.emit('spawn'); await flush();
    expect(JSON.parse(child.input())).toEqual({ job: 'j', house: job.house });
    expect(child.input()).not.toContain('private brief');
    child.child.stdout.emit('data', Buffer.from('{"build":"image@sha"}')); child.child.emit('close', 0, null);
    expect(await result).toBe('image@sha'); expect(f.runtime.spawn).toHaveBeenCalledWith(plan);
    // A completed leader can leave descendants; cleanup still kills its group.
    expect(f.runtime.kill).toHaveBeenCalledOnce();
  });
  it('gives the configured builder a repository credential only on private stdin', async () => {
    const f = fixture(), bytes = Buffer.from('PRIVATE_REPO_VALUE');
    const result = f.executor.build(job, new AbortController().signal, bytes), child = f.children[0];
    child.child.emit('spawn'); await flush();
    expect(JSON.parse(child.input())).toEqual({ job: 'j', house: job.house, repositoryInput: { encoding: 'base64', value: bytes.toString('base64') } });
    expect(JSON.stringify(vi.mocked(f.runtime.spawn).mock.calls)).not.toContain(bytes.toString('base64'));
    expect(JSON.stringify(job)).not.toContain('PRIVATE_REPO_VALUE');
    child.child.stdout.emit('data', Buffer.from('{"build":"image@sha"}')); child.child.emit('close', 0, null);
    expect(await result).toBe('image@sha'); bytes.fill(0);
  });
  it('preserves UTF-8 build identities split between output chunks', async () => {
    const f = fixture(), result = f.executor.build(job, new AbortController().signal), child = f.children[0].child;
    child.emit('spawn'); await flush();
    const bytes = Buffer.from('{"build":"image:é"}'), split = bytes.indexOf(Buffer.from('é')) + 1;
    child.stdout.emit('data', bytes.subarray(0, split)); child.stdout.emit('data', bytes.subarray(split));
    child.emit('close', 0, null); expect(await result).toBe('image:é');
  });
  it('holds body input until release and preserves model/account/harness independently', async () => {
    const configured: WorkerAssignment = { ...job, run: { nestedContainers: true, gpu: true, ports: [{ address: '127.0.0.1', port: 8080 }], policy: { deniedTools: [{ pattern: 'tool-*', guestsOnly: true }], people: [{ kind: 'outside', person: 'outside-key', tier: 1 }] } } };
    const f = fixture(), body = f.executor.start(configured, 'image@sha', new AbortController().signal);
    const child = f.children[0]; child.child.emit('spawn'); await body.spawned;
    expect(child.input()).toBe(''); await body.release();
    expect(JSON.parse(child.input())).toEqual({ job: configured, build: 'image@sha' });
    await expect(body.release()).rejects.toThrow('unavailable');
    child.child.stderr.emit('data', 'error '); child.child.stdout.emit('data', 'result'); child.child.emit('close', 9, null);
    expect(await body.exited).toMatchObject({ exitCode: 9, logTail: 'error result' });
    await body.stop(); await body.stop(); expect(f.runtime.kill).toHaveBeenCalledOnce();
  });
  it('cancels and reaps builds and bodies without releasing body input', async () => {
    const f = fixture(), abort = new AbortController(), build = f.executor.build(job, abort.signal);
    f.children[0].child.emit('spawn'); await flush(); abort.abort(); await expect(build).rejects.toThrow('build failed');
    const controller = new AbortController(), body = f.executor.start(job, 'image', controller.signal);
    f.children[1].child.emit('spawn'); await body.spawned; controller.abort();
    expect((await body.exited).exitCode).toBe(1); expect(f.children[1].input()).toBe('');
    await expect(body.release()).rejects.toThrow('unavailable'); await body.stop();
  });
  it('kills descendants at leader exit so inherited pipes cannot keep close pending', async () => {
    const f = fixture(), body = f.executor.start(job, 'image', new AbortController().signal);
    const child = f.children[0].child; child.emit('spawn'); await body.spawned; await body.release();
    child.emit('exit', 0, null);
    expect(f.runtime.kill).toHaveBeenCalledOnce();
    // Simulates group termination closing inherited stdout/stderr handles.
    expect((await body.exited).exitCode).toBe(0); await body.stop(); expect(f.runtime.kill).toHaveBeenCalledOnce();
  });
  it('keeps stop pending until the killed process has actually closed', async () => {
    const f = fixture(); vi.mocked(f.runtime.kill).mockImplementation(() => {});
    const body = f.executor.start(job, 'image', new AbortController().signal), child = f.children[0].child;
    child.emit('spawn'); await body.spawned;
    let settled = false; const stopped = body.stop().then(() => { settled = true; });
    await flush(); expect(f.runtime.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    child.emit('close', null, 'SIGKILL'); await stopped; expect(settled).toBe(true);
  });
  it('remembers stop before a pending spawn acquires its process id', async () => {
    const f = fixture(), signal = new AbortController().signal;
    const body = f.executor.start(job, 'image', signal), child = f.children[0].child;
    Object.assign(child, { pid: undefined });
    const stopped = body.stop();
    expect(f.runtime.kill).not.toHaveBeenCalled();
    Object.assign(child, { pid: 123 }); child.emit('spawn');
    expect(f.runtime.kill).toHaveBeenCalledOnce();
    await stopped;
    expect(signal.aborted).toBe(false);
    expect(f.children[0].input()).toBe('');
  });
  it('refuses input as soon as stop begins, before process close', async () => {
    const f = fixture(); vi.mocked(f.runtime.kill).mockImplementation(() => {});
    const body = f.executor.start(job, 'image', new AbortController().signal), child = f.children[0];
    child.child.emit('spawn'); await body.spawned;
    const stopped = body.stop();
    try {
      await expect(body.release()).rejects.toThrow('unavailable');
      expect(child.input()).toBe('');
    } finally { child.child.emit('close', null, 'SIGKILL'); await stopped; }
  });
  it('rejects failed, malformed and oversized build output', async () => {
    for (const output of ['not json', '{}', '{"build":" "}', 'x'.repeat(70_000)]) {
      const f = fixture(), built = f.executor.build(job, new AbortController().signal);
      f.children[0].child.emit('spawn'); await flush();
      f.children[0].child.stdout.emit('data', output); f.children[0].child.emit('close', 0, null);
      await expect(built).rejects.toThrow(); expect(f.runtime.kill).toHaveBeenCalled();
    }
  });
  it('bounds log memory while collecting body stdout/stderr', async () => {
    const f = fixture(), body = f.executor.start(job, 'image', new AbortController().signal);
    const child = f.children[0].child; child.emit('spawn'); await body.spawned;
    child.stderr.emit('data', 'old'.repeat(30_000)); child.stdout.emit('data', 'new'.repeat(30_000));
    child.emit('close', 0, null);
    expect((await body.exited).logTail).toBe('new'.repeat(30_000).slice(-16_384)); await body.stop();
  });
  it('native spawn uses fixed argv, detached groups, no shell and only configured environment', async () => {
    const f = fixture();
    const fake = f.runtime.spawn(plan); vi.mocked(spawn).mockReturnValueOnce(fake);
    const executor = commandWorkerExecutor({ build: plan, runners: { 'custom-runner': plan } });
    const body = executor.start(job, 'image', new AbortController().signal);
    // The configured environment and nothing of the worker's own, plus the body's scratch directory.
    expect(spawn).toHaveBeenLastCalledWith('/worker/build', ['--json'], {
      cwd: '/worker', env: { PATH: '/usr/bin', LOOM_BODY_SCRATCH: expect.any(String) }, shell: false, detached: true, stdio: 'pipe',
    });
    fake.emit('spawn'); await body.spawned; fake.emit('close', 0, null); await body.exited;
    // Fake has no real group: mock process.kill so cleanup launches no processes.
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try { await body.stop(); expect(kill).toHaveBeenCalledWith(-123, 'SIGKILL'); } finally { kill.mockRestore(); }
  });
  it('says whether a body ended by itself or was killed', async () => {
    const f = fixture();
    const alone = f.executor.start(job, 'image', new AbortController().signal);
    f.children[0].child.emit('spawn'); await alone.spawned;
    f.children[0].child.emit('exit', 16, null); f.children[0].child.emit('close', 16, null);
    expect(await alone.exited).toMatchObject({ exitCode: 16, own: true });
    const killed = f.executor.start(job, 'image', new AbortController().signal);
    f.children[1].child.emit('spawn'); await killed.spawned;
    f.children[1].child.emit('exit', null, 'SIGKILL'); f.children[1].child.emit('close', null, 'SIGKILL');
    expect(await killed.exited).toMatchObject({ exitCode: 1, own: false });
  });
  it('refuses a job when several accounts of its provider are signed in here and one command serves the harness', async () => {
    const f = fixture();
    await expect(f.executor.build({ ...job, accountChoices: 2 }, new AbortController().signal)).rejects.toBeInstanceOf(NoRunnerError);
    expect(() => f.executor.start({ ...job, accountChoices: 2 }, 'image', new AbortController().signal)).toThrow(NoRunnerError);
    expect(f.runtime.spawn).not.toHaveBeenCalled();
    // A runner bound to the account is the answer; one account, or a loom that does not say, runs as before.
    const bound = workerRunner({ runners: {}, accountRunners: { sub: { 'custom-runner': { ...plan, command: '/worker/run-sub' } } } });
    expect(bound({ ...job, accountChoices: 2 }).command).toBe('/worker/run-sub');
    expect(() => bound({ ...job, account: 'other', accountChoices: 2 })).toThrow(NoRunnerError);
    // So is a runner that says it signs in to the account its envelope names.
    expect(workerRunner({ runners: { 'custom-runner': { ...plan, selectsAccount: true } } })({ ...job, accountChoices: 2 })).toMatchObject({ command: plan.command });
    const shared = workerRunner({ runners: { 'custom-runner': plan } });
    expect(shared({ ...job, accountChoices: 1 })).toMatchObject({ command: plan.command }); expect(shared(job)).toMatchObject({ command: plan.command });
  });
  it('rejects native Windows before launching anything', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const before = vi.mocked(spawn).mock.calls.length;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const executor = commandWorkerExecutor({ build: plan, runners: { 'custom-runner': plan } });
      expect(() => executor.start(job, 'image', new AbortController().signal)).toThrow('require POSIX');
      expect(vi.mocked(spawn).mock.calls.length).toBe(before);
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
  it('rejects unavailable harnesses before a build, and reports spawn failure', async () => {
    const f = fixture(); await expect(f.executor.build({ ...job, harness: 'unknown' }, new AbortController().signal)).rejects.toThrow('configured runner');
    expect(f.runtime.spawn).not.toHaveBeenCalled();
    const built = f.executor.build(job, new AbortController().signal);
    f.children[0].child.emit('error', new Error('ENOENT')); f.children[0].child.emit('close', -2, null);
    await expect(built).rejects.toThrow('could not start'); expect(f.runtime.kill).toHaveBeenCalled();
  });
});

describe('configured quota reader', () => {
  const identity = { account: 'sub', owner: 'owner', provider: 'custom' };
  const window = { name: 'week', usage: 0.2, readAt: '2026-11-14T20:00:00Z',
    resetsAt: '2026-11-14T21:00:00Z', durationMs: 604800000 };
  it('uses fixed command/environment and returns complete validated windows', async () => {
    const f = fixture(), provider = commandUsageProvider(plan, { signal: new AbortController().signal }, f.runtime);
    const result = provider({ ...identity, credential: 'private' } as typeof identity), child = f.children[0];
    child.child.emit('spawn'); await flush();
    expect(JSON.parse(child.input())).toEqual(identity);
    expect(f.runtime.spawn).toHaveBeenCalledWith(plan);
    child.child.stdout.emit('data', JSON.stringify([window])); child.child.emit('close', 0);
    expect(await result).toEqual([window]); expect(f.runtime.kill).toHaveBeenCalledOnce();
  });
  it('rejects malformed, excessive and failed output without exposing private text', async () => {
    for (const [output, code] of [['private credential', 0], [JSON.stringify([{ ...window, usage: 2 }]), 0],
      [JSON.stringify([{ ...window, credential: 'secret' }]), 0],
      [JSON.stringify([window, { name: 'incomplete' }]), 0],
      [JSON.stringify([{ ...window, readAt: 'invalid' }]), 0], ['x'.repeat(70000), 0], ['secret', 1]] as const) {
      const f = fixture(), provider = commandUsageProvider(plan, { signal: new AbortController().signal }, f.runtime);
      const result = provider(identity), child = f.children[0].child;
      child.emit('spawn'); await flush(); child.stdout.emit('data', output); child.emit('close', code);
      await expect(result).rejects.toThrow(/^Quota reader unavailable$/);
      expect(f.runtime.kill).toHaveBeenCalledOnce();
    }
  });
  it('cancels and reaps a read, and never starts a read after shutdown', async () => {
    const f = fixture(), abort = new AbortController();
    const provider = commandUsageProvider(plan, { signal: abort.signal }, f.runtime);
    const result = provider(identity); f.children[0].child.emit('spawn'); await flush(); abort.abort();
    await expect(result).rejects.toThrow('unavailable'); expect(f.runtime.kill).toHaveBeenCalledOnce();
    await expect(provider(identity)).rejects.toThrow('unavailable'); expect(f.runtime.spawn).toHaveBeenCalledOnce();
  });
  it('feeds shared windows and closes admission on command failure without erasing usage', async () => {
    const client = new Database(':memory:');
    try {
      const db = createDataSchema(client), now = '2026-11-14T20:00:00Z';
      db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now }).run();
      db.insert(modelAccounts).values({ id: 'sub', owner: 'owner', provider: 'custom', label: 'Subscription', hasRoom: false }).run();
      const f = fixture(), provider = commandUsageProvider(plan, { signal: new AbortController().signal }, f.runtime);
      const good = refreshAccountWindows(db, 'sub', provider, () => now);
      const child = f.children[0].child; child.emit('spawn'); await flush();
      child.stdout.emit('data', JSON.stringify([window])); child.emit('close', 0);
      expect(await good).toEqual({ refreshed: true });
      expect(readAccountWindows(db, 'sub')[0]?.usage).toBe(0.2);
      expect(currentAccountCapacity(db, 'sub', now).hasRoom).toBe(true);
      const bad = refreshAccountWindows(db, 'sub', provider, () => now);
      f.children[1].child.emit('spawn'); await flush(); f.children[1].child.emit('close', 1);
      expect(await bad).toEqual({ refreshed: false });
      expect(currentAccountCapacity(db, 'sub', now).hasRoom).toBe(false);
      expect(readAccountWindows(db, 'sub')[0]?.usage).toBe(0.2);
    } finally { client.close(); }
  });
  it('contains kill failures during cancellation and cleanup without leaking diagnostics', async () => {
    const f = fixture(), abort = new AbortController();
    vi.mocked(f.runtime.kill).mockImplementation(() => { throw new Error('private runtime diagnostic'); });
    const provider = commandUsageProvider(plan, { signal: abort.signal }, f.runtime);
    const result = provider(identity), rejection = expect(result).rejects.toThrow(/^Quota reader unavailable$/);
    f.children[0].child.emit('spawn'); await flush();
    expect(() => abort.abort()).not.toThrow(); await rejection;
  });
  it('settles at the deadline even when group termination never closes inherited pipes', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); vi.mocked(f.runtime.kill).mockImplementation(() => {});
      const provider = commandUsageProvider(plan, { signal: new AbortController().signal, timeoutMs: 10 }, f.runtime);
      const result = provider(identity), rejection = expect(result).rejects.toThrow('unavailable');
      const child = f.children[0].child; child.emit('spawn'); await flush();
      await vi.advanceTimersByTimeAsync(10); await rejection;
      expect(f.runtime.kill).toHaveBeenCalledOnce();
      expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      child.emit('close', null, 'SIGKILL'); await flush();
    } finally { vi.useRealTimers(); }
  });
  it('rejects cleanup failure even after a valid successful command has closed', async () => {
    const f = fixture();
    vi.mocked(f.runtime.kill).mockImplementation(() => { throw new Error('private kill error'); });
    const provider = commandUsageProvider(plan, { signal: new AbortController().signal }, f.runtime);
    const result = provider(identity), rejection = expect(result).rejects.toThrow(/^Quota reader unavailable$/);
    const child = f.children[0].child; child.emit('spawn'); await flush();
    child.stdout.emit('data', JSON.stringify([window])); child.emit('close', 0); await rejection;
  });
  it('keeps the deadline active through cleanup after an early stdin failure', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); vi.mocked(f.runtime.kill).mockImplementation(() => {});
      const provider = commandUsageProvider(plan, { signal: new AbortController().signal, timeoutMs: 10 }, f.runtime);
      const result = provider(identity), rejection = expect(result).rejects.toThrow('unavailable');
      const child = f.children[0].child; child.stdin.destroy(); child.emit('spawn'); await flush();
      await vi.advanceTimersByTimeAsync(10); await rejection;
      expect(f.runtime.kill).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
      child.emit('close', 1); await flush();
    } finally { vi.useRealTimers(); }
  });
  it('times out and reaps a hung command using its configured deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), provider = commandUsageProvider(plan, { signal: new AbortController().signal, timeoutMs: 10 }, f.runtime);
      const result = provider(identity); const rejection = expect(result).rejects.toThrow('unavailable');
      f.children[0].child.emit('spawn'); await flush(); await vi.advanceTimersByTimeAsync(10);
      await rejection; expect(f.runtime.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

it('times out a stuck build, reaps it, and leaves the worker available for the server retry', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const executor = commandWorkerExecutor({ build: plan, buildTimeoutMs: 50, runners: { 'custom-runner': plan } }, f.runtime);
    const worker = new AbortController();
    const result = executor.build(job, worker.signal);
    const failed = expect(result).rejects.toThrow('Worker build failed');
    f.children[0].child.emit('spawn'); await flush();
    await vi.advanceTimersByTimeAsync(49);
    expect(f.runtime.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await failed;
    expect(f.runtime.kill).toHaveBeenCalledOnce();
    expect(worker.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('reaps a timed-out build before allowing its failure to settle', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); vi.mocked(f.runtime.kill).mockImplementation(() => {});
    const executor = commandWorkerExecutor({ build: plan, buildTimeoutMs: 50, runners: { 'custom-runner': plan } }, f.runtime);
    const result = executor.build(job, new AbortController().signal);
    let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
    const failed = expect(result).rejects.toThrow('Worker build failed');
    f.children[0].child.emit('spawn'); await flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.runtime.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    f.children[0].child.emit('close', null, 'SIGKILL'); await failed;
    expect(settled).toBe(true);
  } finally { vi.useRealTimers(); }
});
it('removes the deadline when a build succeeds and never applies it to the body', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const executor = commandWorkerExecutor({ build: plan, buildTimeoutMs: 50, runners: { 'custom-runner': plan } }, f.runtime);
    const signal = new AbortController().signal, result = executor.build(job, signal);
    f.children[0].child.emit('spawn'); await flush();
    f.children[0].child.stdout.emit('data', '{"build":"image"}'); f.children[0].child.emit('close', 0, null);
    expect(await result).toBe('image'); expect(vi.getTimerCount()).toBe(0);
    const body = executor.start(job, 'image', signal); f.children[1].child.emit('spawn'); await body.spawned;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runtime.kill).toHaveBeenCalledOnce();
    await body.stop();
  } finally { vi.useRealTimers(); }
});
for (const buildTimeoutMs of [0, -1, 1.5, Infinity, 3_600_001]) it(`rejects invalid build deadline ${buildTimeoutMs}`, () => {
  const f = fixture();
  expect(() => commandWorkerExecutor({ build: plan, buildTimeoutMs, runners: {} }, f.runtime)).toThrow('build deadline');
  expect(f.runtime.spawn).not.toHaveBeenCalled();
});

it('selects an exact account and harness command without borrowing another account environment', async () => {
  const f = fixture(), selected = { ...plan, command: '/private/run-a', args: ['--json'], env: { PROFILE: 'only-a' } };
  const config = { build: plan, runners: { 'custom-runner': { ...plan, env: { PROFILE: 'shared' } } },
    accountRunners: { sub: { 'custom-runner': selected }, other: { 'custom-runner': { ...plan, env: { PROFILE: 'only-b' } } } } };
  const executor = commandWorkerExecutor(config, f.runtime);
  selected.env.PROFILE = 'mutated-after-configuration'; selected.command = '/wrong'; selected.args.push('--wrong'); config.accountRunners.sub = { 'custom-runner': { ...selected, command: '/wrong-map' } };
  const body = executor.start(job, 'image', new AbortController().signal);
  expect(f.runtime.spawn).toHaveBeenCalledWith({ ...plan, command: '/private/run-a', env: { PROFILE: 'only-a', LOOM_BODY_SCRATCH: expect.any(String) } });
  f.children[0].child.emit('spawn'); await body.spawned;
  await body.release(); expect(JSON.parse(f.children[0].input()).job).toMatchObject({ model: 'custom-model', account: 'sub', harness: 'custom-runner' });
  f.children[0].child.emit('close', 0, null); await body.stop();
  const other = executor.start({ ...job, account: 'other' }, 'image', new AbortController().signal);
  expect(f.runtime.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ env: { PROFILE: 'only-b', LOOM_BODY_SCRATCH: expect.any(String) } }));
  f.children[1].child.emit('spawn'); await other.spawned; f.children[1].child.emit('close', 0, null); await other.stop();
  await expect(executor.build({ ...job, account: 'missing' }, new AbortController().signal)).rejects.toThrow('configured runner for account');
  expect(() => executor.start({ ...job, harness: 'missing' }, 'image', new AbortController().signal)).toThrow('configured runner for account');
  expect(f.runtime.spawn).toHaveBeenCalledTimes(2);
});

it('keeps account secrets out of a successful builder environment', async () => {
  const f = fixture(), executor = commandWorkerExecutor({ build: plan, runners: {}, accountRunners: { sub: { 'custom-runner': { ...plan, env: { ACCOUNT_SECRET: 'runner-only' } } } } }, f.runtime);
  const pending = executor.build(job, new AbortController().signal), child = f.children[0];
  child.child.emit('spawn'); await flush(); child.child.stdout.emit('data', '{"build":"image"}'); child.child.emit('close', 0, null);
  expect(await pending).toBe('image'); expect(f.runtime.spawn).toHaveBeenCalledExactlyOnceWith(plan);
  expect(JSON.stringify(vi.mocked(f.runtime.spawn).mock.calls)).not.toContain('runner-only');
});
it('refuses inherited account and harness entries', async () => {
  const f = fixture(), accountRunners = Object.create({ sub: { 'custom-runner': plan } });
  accountRunners.own = Object.create({ 'custom-runner': plan });
  const executor = commandWorkerExecutor({ build: plan, runners: { 'custom-runner': plan }, accountRunners }, f.runtime);
  for (const account of ['sub', 'own', 'constructor', '__proto__']) await expect(executor.build({ ...job, account }, new AbortController().signal)).rejects.toThrow('configured runner');
  expect(f.runtime.spawn).not.toHaveBeenCalled();
});

it('selects each distinct harness within the same account', async () => {
  const f = fixture(), executor = commandWorkerExecutor({ build: plan, runners: {}, accountRunners: { sub: {
    first: { ...plan, command: '/first', env: { PROFILE: 'first-only' } }, second: { ...plan, command: '/second', env: { PROFILE: 'second-only' } },
  } } }, f.runtime);
  for (const [index, harness] of ['first', 'second'].entries()) {
    const body = executor.start({ ...job, harness }, 'image', new AbortController().signal);
    expect(f.runtime.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ command: '/'+harness, env: { PROFILE: harness+'-only', LOOM_BODY_SCRATCH: expect.any(String) } }));
    f.children[index].child.emit('spawn'); await body.spawned; f.children[index].child.emit('close', 0, null); await body.stop();
  }
});

it('passes a credential only to an explicitly opted-in fixed child stdin and discards both output streams', async () => {
  const f = fixture(), token = Buffer.from('body_'+'a'.repeat(64)), raw = token.toString(), executor = commandWorkerExecutor({ build: plan, runners: { 'custom-runner': { ...plan, bodyBootstrap: true } } }, f.runtime);
  const body = executor.start(job, 'image', new AbortController().signal), child = f.children[0];
  child.child.emit('spawn'); await body.spawned; expect(child.input()).toBe(''); expect(body.acceptsBootstrap).toBe(true);
  child.child.stdout.emit('data', 'early diagnostic');
  await body.release({ origin: 'https://loom.example', job: job.id, token });
  expect(JSON.parse(child.input())).toEqual({ job, build: 'image', bootstrap: { origin: 'https://loom.example', job: job.id, token: raw } });
  expect(JSON.stringify(vi.mocked(f.runtime.spawn).mock.calls)).not.toContain(raw);
  child.child.stdout.emit('data', raw); child.child.stderr.emit('data', raw); child.child.emit('close', 0);
  expect(await body.exited).toMatchObject({ exitCode: 0, logTail: '' }); await body.stop(); token.fill(0);
});
it('never sends a bootstrap to an ordinary envelope child', async () => {
  const f = fixture(), body = f.executor.start(job, 'image', new AbortController().signal), child = f.children[0]; child.child.emit('spawn'); await body.spawned;
  expect(body.acceptsBootstrap).toBe(false);
  await expect(async () => body.release({ origin: 'https://loom.example', job: job.id, token: Buffer.from('body_'+'a'.repeat(64)) })).rejects.toThrow('Private body input mode differs');
  expect(child.input()).toBe(''); await body.stop();
});

it('selects private bootstrap from the exact account and harness rather than a shared default', async () => {
  const f = fixture(), executor = commandWorkerExecutor({ build: plan, runners: { 'custom-runner': { ...plan, bodyBootstrap: true } }, accountRunners: {
    sub: { 'custom-runner': { ...plan, bodyBootstrap: true }, other: { ...plan, bodyBootstrap: false } }, ordinary: { 'custom-runner': plan },
  } }, f.runtime);
  for (const [account, harness, privateMode] of [['sub', 'custom-runner', true], ['sub', 'other', false], ['ordinary', 'custom-runner', false]] as const) {
    const assignment = { ...job, account, harness }, body = executor.start(assignment, 'image', new AbortController().signal), child = f.children.at(-1)!; child.child.emit('spawn'); await body.spawned;
    expect(body.acceptsBootstrap).toBe(privateMode);
    const token = Buffer.from('body_'+'a'.repeat(64)); if (privateMode) await body.release({ origin: 'https://loom.example', job: assignment.id, token }); else await body.release();
    const value = JSON.parse(child.input()); expect(value.job).toEqual(assignment); expect(Boolean(value.bootstrap)).toBe(privateMode); await body.stop(); token.fill(0);
  }
});

it('clears retained stdout and both tails, then disables private output capture', () => {
  const retained = commandOutput(); retained.stdout('before', 6); retained.stderr('diagnostic');
  expect(retained.value()).toBe('before'); expect(retained.tail()).toBe('beforediagnostic'); retained.discard();
  expect(retained.value()).toBe(''); expect(retained.tail()).toBe('');
  retained.stdout('PRIVATE_BODY_TOKEN', 18); retained.stderr('PRIVATE_BODY_TOKEN');
  expect(retained.value()).toBe(''); expect(retained.tail()).toBe('');
});

describe('what the executor records for the worker after it', () => {
  function recorded() {
    const notes: { pid: number; entry: object; scratch?: string; forgotten: boolean }[] = [], tidied: unknown[] = [];
    const left = { scratch: vi.fn(() => '/state/body-one'), close: vi.fn(),
      note: vi.fn((pid: number, entry: object, scratch?: string) => { const note = { pid, entry, scratch, forgotten: false }; notes.push(note); return () => { note.forgotten = true; }; }),
      reap: vi.fn(async (tidy?: (left: { pid: number; born: string | null; job: string; harness?: string; account?: string }, scratch: string | undefined) => void) => {
        // As the real record does: tidying is best effort for each thing left.
        for (const [found, scratch] of [[{ pid: 9, born: 'then', job: 'old', harness: 'agy', account: 'sub' }, '/state/body-old'], [{ pid: 8, born: 'then', job: 'old-build' }, undefined],
          [{ pid: 7, born: 'then', job: 'gone', harness: 'agy', account: 'removed-account' }, '/state/body-gone']] as const) try { tidy?.(found, scratch); } catch { /* next */ }
        return { ended: 2, unverified: 1 };
      }) };
    const f = fixture();
    const open = vi.fn((_dir: string) => left);
    const executor = commandWorkerExecutor({ build: plan, runners: {}, accountRunners: { sub: { 'custom-runner': { ...plan, command: '/worker/run' }, agy: { ...plan, env: { HOME: '/home/sub' } } } }, state: '/state' }, f.runtime, open);
    return { ...f, executor, left, open, notes, tidied };
  }
  it('holds the worker\'s state directory from when it is made until it is closed, and none when none is named', () => {
    const f = recorded();
    expect(f.open).toHaveBeenCalledExactlyOnceWith('/state'); expect(f.left.close).not.toHaveBeenCalled();
    f.executor.close!(); expect(f.left.close).toHaveBeenCalledOnce();
    const open = vi.fn(); commandWorkerExecutor({ build: plan, runners: {} }, f.runtime, open).close!(); expect(open).not.toHaveBeenCalled();
  });
it('notes a build and a body as soon as each has a process, and forgets each once it is reaped', async () => {
    const f = recorded();
    const built = f.executor.build(job, new AbortController().signal);
    expect(f.notes).toMatchObject([{ pid: 123, entry: { job: 'j' }, scratch: undefined, forgotten: false }]);
    f.children[0].child.emit('spawn'); await flush();
    f.children[0].child.stdout.emit('data', Buffer.from('{"build":"image"}')); f.children[0].child.emit('close', 0, null);
    expect(await built).toBe('image'); expect(f.notes[0].forgotten).toBe(true);
    const body = f.executor.start(job, 'image', new AbortController().signal);
    expect(vi.mocked(f.runtime.spawn).mock.calls[1][0].env.LOOM_BODY_SCRATCH).toBe('/state/body-one');
    expect(f.notes[1]).toMatchObject({ pid: 123, entry: { job: 'j', harness: 'custom-runner', account: 'sub' }, scratch: '/state/body-one', forgotten: false });
    f.children[1].child.emit('spawn'); await body.spawned; expect(f.notes[1].forgotten).toBe(false);
    f.children[1].child.emit('close', 0, null); await body.exited;
    expect(f.notes[1].forgotten).toBe(true);
  });
  it('does not run a body it could not record', async () => {
    const f = recorded(); f.left.note.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => f.executor.start(job, 'image', new AbortController().signal)).toThrow('disk full');
    expect(f.runtime.kill).toHaveBeenCalledOnce();
  });
  it('ends what was left through the record, and tidies each left body as its harness would have', async () => {
    const leftovers = vi.spyOn(await import('./body-harnesses.js'), 'harnessLeftovers').mockImplementation(() => {});
    try {
      const f = recorded();
      expect(await f.executor.endLeft!(new AbortController().signal)).toEqual({ unverified: 1 });
      // The build had no scratch directory, and the account of the third has no runner here any more.
      expect(leftovers).toHaveBeenCalledExactlyOnceWith('agy', '/state/body-old', { HOME: '/home/sub' });
      expect(f.runtime.spawn).not.toHaveBeenCalled();
      expect(await fixture().executor.endLeft!(new AbortController().signal)).toEqual({ unverified: 0 });
    } finally { leftovers.mockRestore(); }
  });
});

describe('a body\'s scratch directory', () => {
  const scratchOf = (f: ReturnType<typeof fixture>) => vi.mocked(f.runtime.spawn).mock.calls.at(-1)![0].env.LOOM_BODY_SCRATCH;
  it('is private to the body, named in its environment, and removed once the body has exited', async () => {
    const { existsSync, statSync, writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const f = fixture(), body = f.executor.start(job, 'image', new AbortController().signal), child = f.children[0].child;
    const scratch = scratchOf(f);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    expect(vi.mocked(f.runtime.spawn).mock.calls[0][0]).toMatchObject({ command: '/worker/run', env: { PATH: '/usr/bin' } });
    writeFileSync(scratch + '/tools-file', 'BEARER');
    child.emit('spawn'); await body.spawned; child.emit('close', 0, null); await body.exited;
    expect(existsSync(scratch)).toBe(false);
  });
  it('is removed when the body is killed and never got to tidy up, and when it could not be launched', async () => {
    const { existsSync, writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const f = fixture(), abort = new AbortController(), body = f.executor.start(job, 'image', abort.signal);
    const scratch = scratchOf(f); writeFileSync(scratch + '/tools-file', 'BEARER');
    f.children[0].child.emit('spawn'); await body.spawned;
    abort.abort(); await body.stop();
    expect(f.runtime.kill).toHaveBeenCalled(); expect(existsSync(scratch)).toBe(false);
    const failing = fixture(); let made: string | undefined;
    vi.mocked(failing.runtime.spawn).mockImplementation(plan => { made = plan.env.LOOM_BODY_SCRATCH; throw new Error('cannot spawn'); });
    expect(() => failing.executor.start(job, 'image', new AbortController().signal)).toThrow('cannot spawn');
    expect(made && existsSync(made)).toBe(false);
  });
});
