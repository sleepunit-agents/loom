import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { commandWorkerExecutor, type ProcessRuntime, type WorkerCommand } from './worker-process.js';
import type { WorkerAssignment } from './worker.js';
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
  it('rejects failed, malformed and oversized build output', async () => {
    for (const output of ['not json', '{}', '{"build":" "}', 'x'.repeat(70_000)]) {
      const f = fixture(), built = f.executor.build(job, new AbortController().signal);
      f.children[0].child.emit('spawn'); await flush();
      f.children[0].child.stdout.emit('data', output); f.children[0].child.emit('close', 0, null);
      await expect(built).rejects.toThrow(); expect(f.runtime.kill).toHaveBeenCalled();
    }
  });
  it('rejects unavailable harnesses before a build, and reports spawn failure', async () => {
    const f = fixture(); await expect(f.executor.build({ ...job, harness: 'unknown' }, new AbortController().signal)).rejects.toThrow('configured runner');
    expect(f.runtime.spawn).not.toHaveBeenCalled();
    const built = f.executor.build(job, new AbortController().signal);
    f.children[0].child.emit('error', new Error('ENOENT')); f.children[0].child.emit('close', -2, null);
    await expect(built).rejects.toThrow('could not start'); expect(f.runtime.kill).toHaveBeenCalled();
  });
});
