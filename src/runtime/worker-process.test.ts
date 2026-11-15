import Database from 'better-sqlite3';
import { createDataSchema } from '../core/data/database.js';
import { members, modelAccounts } from '../core/data/schema.js';
import { refreshAccountWindows, readAccountWindows, currentAccountCapacity } from './account-windows.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { commandUsageProvider, commandWorkerExecutor, type ProcessRuntime, type WorkerCommand } from './worker-process.js';
import type { WorkerAssignment } from './worker.js';
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
  it('preserves UTF-8 build identities split between output chunks', async () => {
    const f = fixture(), result = f.executor.build(job, new AbortController().signal), child = f.children[0].child;
    child.emit('spawn'); await flush();
    const bytes = Buffer.from('{"build":"image:é"}'), split = bytes.indexOf(Buffer.from('é')) + 1;
    child.stdout.emit('data', bytes.subarray(0, split)); child.stdout.emit('data', bytes.subarray(split));
    child.emit('close', 0, null); expect(await result).toBe('image:é');
  });
  it('holds body input until release and preserves model/account/harness independently', async () => {
    const f = fixture(), body = f.executor.start(job, 'image@sha', new AbortController().signal);
    const child = f.children[0]; child.child.emit('spawn'); await body.spawned;
    expect(child.input()).toBe(''); await body.release();
    expect(JSON.parse(child.input())).toEqual({ job, build: 'image@sha' });
    await expect(body.release()).rejects.toThrow('unavailable');
    child.child.stderr.emit('data', 'error '); child.child.stdout.emit('data', 'result'); child.child.emit('close', 9, null);
    expect(await body.exited).toEqual({ exitCode: 9, logTail: 'error result' });
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
    expect(spawn).toHaveBeenLastCalledWith('/worker/build', ['--json'], {
      cwd: '/worker', env: { PATH: '/usr/bin' }, shell: false, detached: true, stdio: 'pipe',
    });
    fake.emit('spawn'); await body.spawned; fake.emit('close', 0, null); await body.exited;
    // Fake has no real group: mock process.kill so cleanup launches no processes.
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try { await body.stop(); expect(kill).toHaveBeenCalledWith(-123, 'SIGKILL'); } finally { kill.mockRestore(); }
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
