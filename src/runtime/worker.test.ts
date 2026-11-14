import { describe, expect, it, vi } from 'vitest';
import { workOnce, type WorkerAssignment, type WorkerBody, type WorkerControl } from './worker.js';
const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'c', model: 'm', account: 'a', harness: 'h', brief: 'hello', house: { repository: 'r', file: 'Containerfile', branch: 'main' } };
function fixture() {
  const exited = deferred<{ exitCode: number; logTail: string }>();
  const built = deferred<string>();
  const spawned = deferred<void>();
  const body: WorkerBody = { release: vi.fn(async () => {}), spawned: spawned.promise, exited: exited.promise,
    stop: vi.fn(async () => { exited.resolve({ exitCode: 1, logTail: '' }); }) };
  const control: WorkerControl = { next: vi.fn(async () => job), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}) };
  const executor = { build: vi.fn((_job: WorkerAssignment, signal: AbortSignal) => {
    signal.addEventListener('abort', () => built.reject(new Error('aborted')), { once: true }); return built.promise;
  }), start: vi.fn((_job: WorkerAssignment, _build: string, signal: AbortSignal) => {
    signal.addEventListener('abort', () => { spawned.reject(new Error('aborted')); void body.stop(); }, { once: true }); return body;
  }) };
  const abort = new AbortController();
  let pulse = () => {};
  const disposed = vi.fn();
  const run = () => workOnce({ box: 'b', control, executor, signal: abort.signal,
    schedule: { every: (_ms, callback) => { pulse = callback; return disposed; } } });
  return { control, executor, built, spawned, exited, body, abort, run, pulse: () => pulse(), disposed };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe('worker work plane', () => {
  it('builds before launching, acknowledges actual spawn, reports real exit and bounds logs', async () => {
    const f = fixture(), run = f.run(); await flush();
    expect(f.executor.start).not.toHaveBeenCalled();
    f.pulse(); await flush(); expect(f.control.heartbeat).toHaveBeenCalledWith('j', 'starting');
    f.built.resolve('image:sha'); await flush();
    expect(f.executor.start).toHaveBeenCalledWith(job, 'image:sha', expect.any(AbortSignal));
    expect(f.control.started).not.toHaveBeenCalled(); expect(f.body.release).not.toHaveBeenCalled();
    f.spawned.resolve(); await flush(); expect(f.control.started).toHaveBeenCalledWith('j', 'image:sha');
    f.pulse(); await flush(); expect(f.control.heartbeat).toHaveBeenLastCalledWith('j', 'running');
    f.exited.resolve({ exitCode: 17, logTail: 'x'.repeat(20_000) });
    expect(await run).toBe('finished'); expect(f.control.finish).toHaveBeenCalledWith('j', 17, 'x'.repeat(16_384));
    expect(f.body.stop).toHaveBeenCalled(); expect(f.disposed).toHaveBeenCalledOnce();
  });
  it('leaves retries to the server when building or spawning fails', async () => {
    for (const phase of ['build', 'spawn']) {
      const f = fixture(), run = f.run(); await flush();
      if (phase === 'build') f.built.reject(new Error('bad build'));
      else { f.built.resolve('image'); await flush(); f.spawned.reject(new Error('cannot spawn')); }
      expect(await run).toBe('finished'); expect(f.control.finish).toHaveBeenCalledWith('j', 1, 'Worker build or body launch failed');
      expect(f.control.started).not.toHaveBeenCalled(); expect(f.control.next).toHaveBeenCalledOnce();
      expect(f.executor.build).toHaveBeenCalledOnce();
      if (phase === 'spawn') expect(f.body.stop).toHaveBeenCalled();
    }
  });
  it('serializes starting heartbeats before acknowledging running', async () => {
    const f = fixture(), beat = deferred<boolean>(); vi.mocked(f.control.heartbeat).mockReturnValue(beat.promise);
    const run = f.run(); await flush(); f.pulse(); f.pulse();
    expect(f.control.heartbeat).toHaveBeenCalledOnce();
    f.built.resolve('image'); f.spawned.resolve(); await flush(); expect(f.control.started).not.toHaveBeenCalled();
    beat.resolve(true); await flush(); expect(f.control.started).toHaveBeenCalledOnce();
    f.exited.resolve({ exitCode: 0, logTail: 'done' }); expect(await run).toBe('finished');
  });
  it('kills a running body after terminal rejection or transport loss without a finish or local retry', async () => {
    for (const error of [false, true]) {
      const f = fixture(), run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush();
      if (error) vi.mocked(f.control.heartbeat).mockRejectedValue(new Error('offline'));
      else vi.mocked(f.control.heartbeat).mockResolvedValue(false);
      f.pulse(); expect(await run).toBe('abandoned');
      expect(f.body.stop).toHaveBeenCalled(); expect(f.control.finish).not.toHaveBeenCalled();
      expect(f.executor.start).toHaveBeenCalledOnce();
    }
  });
  it('waits for an in-flight running heartbeat and suppresses finish if authority is rejected', async () => {
    const f = fixture(), beat = deferred<boolean>(), run = f.run(); await flush();
    f.built.resolve('image'); f.spawned.resolve(); await flush();
    vi.mocked(f.control.heartbeat).mockReturnValue(beat.promise); f.pulse();
    f.exited.resolve({ exitCode: 0, logTail: 'done' }); await flush();
    expect(f.control.finish).not.toHaveBeenCalled();
    beat.resolve(false); expect(await run).toBe('abandoned');
    expect(f.control.finish).not.toHaveBeenCalled(); expect(f.body.stop).toHaveBeenCalled();
  });
  it('holds the brief until a pending running acknowledgement succeeds', async () => {
    const f = fixture(), acknowledgement = deferred<void>();
    vi.mocked(f.control.started).mockReturnValue(acknowledgement.promise);
    const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush();
    expect(f.control.started).toHaveBeenCalledOnce(); expect(f.body.release).not.toHaveBeenCalled();
    acknowledgement.resolve(); await flush(); expect(f.body.release).toHaveBeenCalledOnce();
    f.exited.resolve({ exitCode: 0, logTail: '' }); expect(await run).toBe('finished');
  });
  it('does not turn an uncertain running acknowledgement into a failed start', async () => {
    const f = fixture(); vi.mocked(f.control.started).mockRejectedValue(new Error('reply lost'));
    const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve();
    expect(await run).toBe('abandoned'); expect(f.body.stop).toHaveBeenCalled(); expect(f.body.release).not.toHaveBeenCalled(); expect(f.control.finish).not.toHaveBeenCalled();
  });
  it('reaps a body before reporting an input-release failure to the server', async () => {
    const f = fixture(), reaped = deferred<void>();
    vi.mocked(f.body.release).mockRejectedValue(new Error('stdin gone'));
    vi.mocked(f.body.stop).mockImplementation(() => reaped.promise);
    const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush();
    expect(f.control.finish).not.toHaveBeenCalled();
    reaped.resolve(); expect(await run).toBe('finished');
    expect(f.control.finish).toHaveBeenCalledWith('j', 1, 'Worker body failed');
  });
  it('cancels a build on shutdown, without fabricating a failure', async () => {
    const f = fixture(), run = f.run(); await flush(); f.abort.abort();
    expect(await run).toBe('abandoned'); expect(f.executor.start).not.toHaveBeenCalled(); expect(f.control.finish).not.toHaveBeenCalled();
  });
  it('does nothing for an idle worker and rejects a foreign assignment before execution', async () => {
    const f = fixture(); vi.mocked(f.control.next).mockResolvedValueOnce(undefined);
    expect(await f.run()).toBe('idle'); expect(f.executor.build).not.toHaveBeenCalled();
    vi.mocked(f.control.next).mockResolvedValueOnce({ ...job, box: 'other' });
    await expect(f.run()).rejects.toThrow('another worker'); expect(f.executor.build).not.toHaveBeenCalled();
  });
});
