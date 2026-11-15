import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInAccount } from './account-signin.js';
import type { ProcessRuntime, WorkerCommand } from './worker-process.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const plan: WorkerCommand = { command: '/private/signin', args: ['--json'], cwd: '/private', env: { HOME: '/private/account' } };
const identity = { account: 'a', owner: 'm', provider: 'configured', box: 'b' };
function fixture() {
  let input = '';
  const child = Object.assign(new EventEmitter(), { pid: 42,
    stdin: new Writable({ write(chunk, _encoding, callback) { input += chunk.toString(); callback(); } }),
    stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams;
  const runtime: ProcessRuntime = { spawn: vi.fn(() => child), kill: vi.fn() };
  const abort = new AbortController();
  return { child, runtime, abort, input: () => input,
    start: () => signInAccount(plan, identity, { signal: abort.signal, timeoutMs: 100 }, runtime),
    end: (text = '{"signedIn":true}', code: number | null = 0) => {
      child.stdout.emit('data', Buffer.from(text)); child.emit('exit', code); child.emit('close', code);
    } };
}
async function flush() { await new Promise<void>(resolve => process.nextTick(resolve)); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('worker private sign-in command (no actual processes)', () => {
  it('passes fixed command and identity only; accepts completion after group cleanup', async () => {
    const f = fixture();
    const result = signInAccount(plan, { ...identity, credential: 'never pass' } as typeof identity,
      { signal: f.abort.signal }, f.runtime);
    f.child.emit('spawn'); await flush();
    expect(f.runtime.spawn).toHaveBeenCalledWith(plan);
    expect(f.runtime.spawn).not.toHaveBeenCalledWith(expect.objectContaining({ env: process.env }));
    expect(JSON.parse(f.input())).toEqual(identity);
    f.child.stderr.emit('data', Buffer.from('private credential'));
    f.end(); await expect(result).resolves.toBeUndefined();
    expect(f.runtime.kill).toHaveBeenCalledOnce();
  });
  it.each(['{}', '{"signedIn":false}', '{"signedIn":true,"token":"private"}', 'null', '[]', 'bad', 'x'.repeat(1025)])('rejects invalid acknowledgement %# without disclosing it', async text => {
    const f = fixture(), result = f.start();
    f.child.emit('spawn'); await flush(); f.end(text);
    await expect(result).rejects.toThrow(/^Account sign-in failed$/);
    expect(f.runtime.spawn).toHaveBeenCalledOnce();
  });
  it.each([1, null])('rejects non-successful process exit %s', async code => {
    const f = fixture(), result = f.start(); f.child.emit('spawn'); await flush(); f.end(undefined, code);
    await expect(result).rejects.toThrow('Account sign-in failed');
  });
  it('does not succeed when kill emits close synchronously then throws', async () => {
    const f = fixture(), result = f.start(); f.child.emit('spawn'); await flush();
    vi.mocked(f.runtime.kill).mockImplementation(() => { f.child.emit('close', 0); throw new Error('private'); });
    f.child.stdout.emit('data', '{"signedIn":true}'); f.child.emit('exit', 0);
    await expect(result).rejects.toThrow(/^Account sign-in failed$/);
    expect(f.runtime.spawn).toHaveBeenCalledOnce();
  });
  it('bounds inherited-pipe cleanup and keeps cancellation failures generic', async () => {
    vi.useFakeTimers();
    const f = fixture(), result = f.start(), rejected = expect(result).rejects.toThrow(/^Account sign-in failed$/);
    f.child.emit('spawn'); await flush();
    f.child.stdout.emit('data', '{"signedIn":true}'); f.child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(f.child.stdout.destroyed).toBe(true); expect(f.child.stdin.destroyed).toBe(true);
  });
  it.each(['stdin', 'stdout', 'stderr'] as const)('retains deadline after %s error and kills group', async stream => {
    vi.useFakeTimers();
    const f = fixture(), result = f.start(), rejected = expect(result).rejects.toThrow(/^Account sign-in failed$/);
    f.child.emit('spawn'); f.child[stream].emit('error', new Error('private'));
    expect(f.runtime.kill).toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(100); await rejected;
  });
  it('does not send identity after cancellation during spawn setup and kills a later PID', async () => {
    vi.useFakeTimers();
    const f = fixture();
    Object.assign(f.child, { pid: undefined });
    vi.mocked(f.runtime.spawn).mockImplementation(() => { f.abort.abort(); return f.child; });
    const result = f.start(), rejected = expect(result).rejects.toThrow('Account sign-in failed');
    Object.assign(f.child, { pid: 42 }); f.child.emit('spawn');
    expect(f.input()).toBe(''); expect(f.runtime.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100); await rejected;
  });
  it('bounds output before completion and never acknowledges an overflow', async () => {
    const f = fixture(), result = f.start(); f.child.emit('spawn'); await flush();
    f.child.stdout.emit('data', 'x'.repeat(1025));
    expect(f.child.stdout.destroyed).toBe(true); expect(f.runtime.kill).toHaveBeenCalled();
    f.end(); await expect(result).rejects.toThrow('Account sign-in failed');
  });
  it('rejects an already aborted call without launching', async () => {
    const f = fixture(); f.abort.abort(); await expect(f.start()).rejects.toThrow('Account sign-in failed');
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, 300001])('rejects invalid deadline %s without launching', async timeoutMs => {
    const f = fixture(); await expect(signInAccount(plan, identity, { signal: f.abort.signal, timeoutMs }, f.runtime)).rejects.toThrow();
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });
  it('reports spawn failure without private details', async () => {
    const f = fixture(); vi.mocked(f.runtime.spawn).mockImplementation(() => { throw new Error('private command'); });
    await expect(f.start()).rejects.toThrow(/^Account sign-in failed$/);
  });
  it('uses native fixed argv, explicit env, no shell and POSIX process-group kill', async () => {
    const f = fixture();
    vi.mocked(spawn).mockReturnValue(f.child);
    const killed = vi.spyOn(process, 'kill').mockReturnValue(true);
    const result = signInAccount(plan, identity, { signal: f.abort.signal });
    expect(spawn).toHaveBeenCalledWith(plan.command, plan.args, {
      cwd: plan.cwd, env: plan.env, shell: false, detached: true, stdio: 'pipe',
    });
    f.child.emit('spawn'); await flush(); f.end(); await result;
    expect(killed).toHaveBeenCalledExactlyOnceWith(-42, 'SIGKILL');
  });
  it('expires exactly at the default 300-second deadline without retries', async () => {
    vi.useFakeTimers();
    const f = fixture(), result = signInAccount(plan, identity, { signal: f.abort.signal }, f.runtime);
    let settled = false; void result.catch(() => { settled = true; });
    const rejected = expect(result).rejects.toThrow(/^Account sign-in failed$/);
    await vi.advanceTimersByTimeAsync(299999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(f.runtime.spawn).toHaveBeenCalledOnce();
  });
  it('kills a spawn arriving after deadline without sending identity', async () => {
    vi.useFakeTimers();
    const f = fixture(); Object.assign(f.child, { pid: undefined });
    const result = f.start(), rejected = expect(result).rejects.toThrow('Account sign-in failed');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    Object.assign(f.child, { pid: 42 }); f.child.emit('spawn');
    expect(f.input()).toBe(''); expect(f.runtime.kill).toHaveBeenCalledOnce();
  });
  it('never logs private stderr, malformed stdout or spawn exceptions', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'),
      vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
    try {
      const f = fixture(), result = f.start(); f.child.emit('spawn'); await flush();
      f.child.stderr.emit('data', 'private stderr'); f.end('private stdout');
      await expect(result).rejects.toThrow(/^Account sign-in failed$/);
      const g = fixture(); vi.mocked(g.runtime.spawn).mockImplementation(() => { throw new Error('private spawn'); });
      await expect(g.start()).rejects.toThrow(/^Account sign-in failed$/);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it.each(['stdin', 'stdout', 'stderr'] as const)('rejects %s failure despite an otherwise successful acknowledgement', async stream => {
    const f = fixture(), result = f.start(); f.child.emit('spawn'); await flush();
    f.child[stream].emit('error', new Error('private'));
    f.end(); await expect(result).rejects.toThrow(/^Account sign-in failed$/);
    expect(f.runtime.kill).toHaveBeenCalledOnce(); expect(f.runtime.spawn).toHaveBeenCalledOnce();
  });
  it('immediately closes local pipes and kills on cancellation after stdin completion', async () => {
    const f = fixture(), result = f.start(); f.child.emit('spawn'); await flush();
    expect(JSON.parse(f.input())).toEqual(identity);
    f.abort.abort();
    expect(f.child.stdin.destroyed).toBe(true); expect(f.child.stdout.destroyed).toBe(true);
    expect(f.child.stderr.destroyed).toBe(true); expect(f.runtime.kill).toHaveBeenCalledOnce();
    f.end(); await expect(result).rejects.toThrow(/^Account sign-in failed$/);
  });

  it.each([1024, 1025])('checks valid acknowledgement padded to %s bytes at the output limit', async size => {
    const f = fixture(), result = f.start(); f.child.emit('spawn'); await flush();
    f.end('{"signedIn":true}'.padEnd(size));
    if (size === 1024) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow(/^Account sign-in failed$/);
  });

});
