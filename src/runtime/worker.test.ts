import { describe, expect, it, vi } from 'vitest';
import { NoRunnerError, workOnce, type WorkerAssignment, type WorkerBody, type WorkerControl } from './worker.js';
import { WORKER_EXIT } from './job-exit.js';
const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'c', model: 'm', account: 'a', harness: 'h', brief: 'hello', run: { nestedContainers: true, gpu: true, ports: [{ address: '127.0.0.1', port: 8080 }] }, house: { repository: 'r', file: 'Containerfile', branch: 'main' } };
function fixture() {
  const exited = deferred<{ exitCode: number; logTail: string; own?: boolean }>();
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
  it.each([false, true])('hands repository bytes privately to build and erases them after settlement (failure=%s)', async failed => {
    const f = fixture(), bytes = Buffer.from('PRIVATE_REPOSITORY_INPUT');
    const input = deferred<Uint8Array | undefined>();
    f.control.repositoryInput = vi.fn(() => input.promise);
    const run = f.run(); await flush();
    expect(f.executor.build).not.toHaveBeenCalled();
    f.pulse(); await flush(); expect(f.control.heartbeat).toHaveBeenCalledWith('j', 'starting');
    input.resolve(bytes); await flush();
    expect(f.executor.build).toHaveBeenCalledWith(job, expect.any(AbortSignal), bytes);
    expect(bytes.toString()).toBe('PRIVATE_REPOSITORY_INPUT');
    expect(JSON.stringify(job)).not.toContain('PRIVATE_REPOSITORY_INPUT');
    if (failed) f.built.reject(new Error('private build failure'));
    else { f.built.resolve('image'); f.spawned.resolve(); await flush(); f.exited.resolve({ exitCode: 0, logTail: '' }); }
    expect(await run).toBe('finished'); expect(bytes.every(byte => byte === 0)).toBe(true);
  });
  it('erases late repository input after cancellation without building', async () => {
    const f = fixture(), input = deferred<Uint8Array | undefined>(), bytes = Buffer.from('PRIVATE');
    f.control.repositoryInput = vi.fn(() => input.promise);
    const run = f.run(); await flush(); f.abort.abort(); input.resolve(bytes);
    expect(await run).toBe('abandoned'); expect(bytes.every(byte => byte === 0)).toBe(true);
    expect(f.executor.build).not.toHaveBeenCalled(); expect(f.control.finish).not.toHaveBeenCalled();
  });
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
    expect(await run).toBe('finished'); expect(f.control.finish).toHaveBeenCalledWith('j', 17, 'x'.repeat(16_384), 'runner');
    expect(f.body.stop).toHaveBeenCalled(); expect(f.disposed).toHaveBeenCalledOnce();
  });
  it.each([[{ signalled: true }, 'worker'], [{}, 'runner']] as const)('says whose exit code it reports: a signal\'s is its own word, the program\'s own is the program\'s (%j)', async (how, by) => {
    const f = fixture(), run = f.run(); await flush();
    f.built.resolve('image'); await flush(); f.spawned.resolve(); await flush();
    // The same number either way: the worker's word for a body a signal ended, or what a machine's own runner chose to exit with.
    f.exited.resolve({ exitCode: WORKER_EXIT.killed, logTail: '', ...how });
    expect(await run).toBe('finished'); expect(f.control.finish).toHaveBeenCalledExactlyOnceWith('j', WORKER_EXIT.killed, '', by);
  });
  it('leaves retries to the server when a start fails, and says which stage failed', async () => {
    for (const phase of ['input', 'build', 'launch', 'enroll'] as const) {
      const f = fixture();
      if (phase === 'input') f.control.repositoryInput = vi.fn(async () => { throw new Error('private input failure'); });
      if (phase === 'enroll') { f.body.acceptsBootstrap = true; f.control.enrollBody = vi.fn(async () => { throw new Error('uncertain'); }); }
      const run = f.run(); await flush();
      if (phase === 'build') f.built.reject(new Error('bad build'));
      else if (phase !== 'input') { f.built.resolve('image'); await flush(); if (phase === 'launch') f.spawned.reject(new Error('cannot spawn')); else f.spawned.resolve(); }
      expect(await run).toBe('finished');
      expect(f.control.finish).toHaveBeenCalledExactlyOnceWith('j', WORKER_EXIT[phase], `Worker could not start the body: ${phase} failed`, 'worker');
      expect(f.control.started).not.toHaveBeenCalled(); expect(f.control.next).toHaveBeenCalledOnce();
      if (phase === 'input') expect(f.executor.build).not.toHaveBeenCalled(); else expect(f.executor.build).toHaveBeenCalledOnce();
      if (phase === 'launch' || phase === 'enroll') expect(f.body.stop).toHaveBeenCalled();
    }
    expect(new Set(Object.values(WORKER_EXIT)).size).toBe(Object.keys(WORKER_EXIT).length);
  });
  it('ends the attempt, not the worker, when loom does not answer a finish report or a poll', async () => {
    for (const phase of ['start', 'exit'] as const) {
      const f = fixture(); vi.mocked(f.control.finish).mockRejectedValue(new Error('Worker finish failed; outcome may be uncertain'));
      const run = f.run(); await flush();
      if (phase === 'start') f.built.reject(new Error('bad build'));
      else { f.built.resolve('image'); f.spawned.resolve(); await flush(); f.exited.resolve({ exitCode: 0, logTail: '' }); }
      expect(await run).toBe('abandoned'); expect(f.control.finish).toHaveBeenCalledOnce();
      if (phase === 'exit') expect(f.body.stop).toHaveBeenCalled();
      expect(f.disposed).toHaveBeenCalledOnce();
    }
    const f = fixture(); vi.mocked(f.control.next).mockRejectedValue(new Error('Worker next failed; outcome may be uncertain'));
    expect(await f.run()).toBe('abandoned'); expect(f.executor.build).not.toHaveBeenCalled();
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
  it('never releases a body after shutdown while its running acknowledgement is pending', async () => {
    const f = fixture(), acknowledgement = deferred<void>();
    vi.mocked(f.control.started).mockReturnValue(acknowledgement.promise);
    const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush();
    expect(f.control.started).toHaveBeenCalledOnce();
    f.abort.abort();
    acknowledgement.resolve();
    expect(await run).toBe('abandoned');
    expect(f.body.release).not.toHaveBeenCalled();
    expect(f.body.stop).toHaveBeenCalled();
    expect(f.control.finish).not.toHaveBeenCalled();
    expect(f.disposed).toHaveBeenCalledOnce();
  });
  it('reaps a body before reporting an input-release failure to the server', async () => {
    const f = fixture(), reaped = deferred<void>();
    vi.mocked(f.body.release).mockRejectedValue(new Error('stdin gone'));
    vi.mocked(f.body.stop).mockImplementation(() => reaped.promise.then(() => f.exited.resolve({ exitCode: 1, logTail: '', own: false })));
    const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush();
    expect(f.control.finish).not.toHaveBeenCalled();
    reaped.resolve(); expect(await run).toBe('finished');
    expect(f.control.finish).toHaveBeenCalledWith('j', WORKER_EXIT.release, 'Worker lost the body: release failed', 'worker');
  });
  it('reports the code a body ended with by itself before its input could be handed over, not the worker\'s', async () => {
    const f = fixture();
    vi.mocked(f.body.release).mockRejectedValue(new Error('stdin gone'));
    // The body had already left with its own code (16 is a body file it could not read) when the worker reaped it.
    vi.mocked(f.body.stop).mockImplementation(async () => { f.exited.resolve({ exitCode: 16, logTail: 'cannot read body file', own: true }); });
    const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve();
    expect(await run).toBe('finished');
    expect(f.control.finish).toHaveBeenCalledExactlyOnceWith('j', 16, 'cannot read body file', 'runner');
  });
  it('keeps its own release code when the body it could not feed ended cleanly or only when killed', async () => {
    for (const ended of [{ exitCode: 0, logTail: '', own: true }, { exitCode: 137, logTail: '', own: false }]) {
      const f = fixture();
      vi.mocked(f.body.release).mockRejectedValue(new Error('stdin gone'));
      vi.mocked(f.body.stop).mockImplementation(async () => { f.exited.resolve(ended); });
      const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve();
      expect(await run).toBe('finished');
      expect(f.control.finish).toHaveBeenCalledExactlyOnceWith('j', WORKER_EXIT.release, 'Worker lost the body: release failed', 'worker');
    }
  });
  it('names the runner stage when this worker has no command it can run the job on', async () => {
    const f = fixture();
    f.executor.build.mockImplementation(() => { throw new NoRunnerError('Several accounts need a runner each'); });
    expect(await f.run()).toBe('finished');
    expect(f.executor.start).not.toHaveBeenCalled();
    expect(f.control.finish).toHaveBeenCalledExactlyOnceWith('j', WORKER_EXIT.runner, 'Worker could not start the body: runner failed', 'worker');
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

it('enrolls only after build/spawn and hands the private token only after running ACK, then erases it and drops logs', async () => {
  const f = fixture(), token = Buffer.from('body_'+'a'.repeat(64)), enrolled = deferred<import('./body-bootstrap.js').BodyBootstrap>(), ack = deferred<void>();
  f.body.acceptsBootstrap = true; f.control.enrollBody = vi.fn(() => enrolled.promise); vi.mocked(f.control.started).mockReturnValue(ack.promise);
  vi.mocked(f.body.release).mockImplementation(async input => { expect(input?.token.toString()).toBe('body_'+'a'.repeat(64)); });
  const run = f.run(); await flush(); expect(f.control.enrollBody).not.toHaveBeenCalled();
  f.built.resolve('image'); await flush(); expect(f.control.enrollBody).not.toHaveBeenCalled(); f.spawned.resolve(); await flush();
  expect(f.control.enrollBody).toHaveBeenCalledExactlyOnceWith('j', expect.any(AbortSignal)); f.pulse(); await flush(); expect(f.control.heartbeat).toHaveBeenLastCalledWith('j', 'starting');
  enrolled.resolve({ origin: 'https://loom.example', job: 'j', token }); await flush(); expect(f.control.started).toHaveBeenCalledOnce(); expect(f.body.release).not.toHaveBeenCalled(); expect(token[0]).not.toBe(0);
  ack.resolve(); await flush(); expect(f.body.release).toHaveBeenCalledOnce(); expect(token.every(byte => byte === 0)).toBe(true);
  f.exited.resolve({ exitCode: 0, logTail: 'body_'+'a'.repeat(64) }); expect(await run).toBe('finished'); expect(f.control.finish).toHaveBeenCalledWith('j', 0, '', 'body');
  expect(JSON.stringify([job, vi.mocked(f.control.started).mock.calls, vi.mocked(f.control.finish).mock.calls])).not.toContain('body_');
});
for (const phase of ['enroll', 'ack']) it(`does not release a late credential after cancellation during ${phase}`, async () => {
  const f = fixture(), token = Buffer.from('body_'+'a'.repeat(64)), enrolled = deferred<import('./body-bootstrap.js').BodyBootstrap>(), ack = deferred<void>();
  f.body.acceptsBootstrap = true; f.control.enrollBody = vi.fn(() => enrolled.promise); vi.mocked(f.control.started).mockReturnValue(ack.promise);
  const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush();
  if (phase === 'ack') { enrolled.resolve({ origin: 'https://loom.example', job: 'j', token }); await flush(); }
  f.abort.abort(); enrolled.resolve({ origin: 'https://loom.example', job: 'j', token }); ack.resolve();
  expect(await run).toBe('abandoned'); expect(f.body.release).not.toHaveBeenCalled(); expect(f.control.finish).not.toHaveBeenCalled(); expect(token.every(byte => byte === 0)).toBe(true); expect(f.body.stop).toHaveBeenCalled();
});
it('refuses a configured private child when enrollment is unavailable and never releases input', async () => {
  const f = fixture(); f.body.acceptsBootstrap = true;
  const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); expect(await run).toBe('finished');
  expect(f.body.release).not.toHaveBeenCalled(); expect(f.control.started).not.toHaveBeenCalled(); expect(f.body.stop).toHaveBeenCalled();
});

it('erases the owned token immediately on cancellation while a running ACK stays pending', async () => {
  const f = fixture(), token = Buffer.from('body_'+'a'.repeat(64)), ack = deferred<void>();
  f.body.acceptsBootstrap = true; f.control.enrollBody = vi.fn(async () => ({ origin: 'https://loom.example', job: 'j', token })); vi.mocked(f.control.started).mockReturnValue(ack.promise);
  let done = false; const run = f.run().then(result => { done = true; return result; }); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush();
  expect(f.control.started).toHaveBeenCalledOnce(); expect(token[0]).not.toBe(0); f.abort.abort(); await flush();
  expect(done).toBe(false); expect(token.every(byte => byte === 0)).toBe(true); expect(f.body.release).not.toHaveBeenCalled();
  ack.resolve(); expect(await run).toBe('abandoned'); expect(f.control.finish).not.toHaveBeenCalled();
});
it('waits for reaping after uncertain enrollment before reporting a failed start and never retries locally', async () => {
  const f = fixture(), reaped = deferred<void>(); f.body.acceptsBootstrap = true; f.control.enrollBody = vi.fn(async () => { throw Error('private uncertain enrollment'); }); vi.mocked(f.body.stop).mockReturnValue(reaped.promise);
  const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush();
  expect(f.body.stop).toHaveBeenCalled(); expect(f.control.finish).not.toHaveBeenCalled(); expect(f.executor.start).toHaveBeenCalledOnce(); expect(f.control.enrollBody).toHaveBeenCalledOnce();
  reaped.resolve(); expect(await run).toBe('finished'); expect(f.control.finish).toHaveBeenCalledExactlyOnceWith('j', WORKER_EXIT.enroll, 'Worker could not start the body: enroll failed', 'worker');
  expect(f.control.next).toHaveBeenCalledOnce(); expect(f.body.release).not.toHaveBeenCalled(); expect(f.control.started).not.toHaveBeenCalled();
});
it('erases private bytes after stdin failure before any terminal report', async () => {
  const f = fixture(), token = Buffer.from('body_'+'a'.repeat(64)); f.body.acceptsBootstrap = true; f.control.enrollBody = vi.fn(async () => ({ origin: 'https://loom.example', job: 'j', token }));
  vi.mocked(f.body.release).mockRejectedValue(Error('private input failure')); vi.mocked(f.control.finish).mockImplementation(async () => { expect(token.every(byte => byte === 0)).toBe(true); });
  const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); expect(await run).toBe('finished');
  expect(f.control.finish).toHaveBeenCalledExactlyOnceWith('j', WORKER_EXIT.release, 'Worker lost the body: release failed', 'worker'); expect(f.body.stop).toHaveBeenCalled();
});

it('keeps bytes intact until pending private stdin acceptance and then erases the owned token', async () => {
  const f = fixture(), token = Buffer.from('body_'+'a'.repeat(64)), accepted = deferred<void>(); f.body.acceptsBootstrap = true;
  f.control.enrollBody = vi.fn(async () => ({ origin: 'https://loom.example', job: 'j', token })); vi.mocked(f.body.release).mockReturnValue(accepted.promise);
  const run = f.run(); await flush(); f.built.resolve('image'); f.spawned.resolve(); await flush(); expect(f.body.release).toHaveBeenCalledOnce();
  expect(token.toString()).toBe('body_'+'a'.repeat(64)); accepted.resolve(); await flush(); expect(token.every(byte => byte === 0)).toBe(true);
  f.exited.resolve({ exitCode: 0, logTail: '' }); expect(await run).toBe('finished');
});
