import { afterEach, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { containerWorkerExecutor } from './worker-container.js';
import { workOnce, type WorkerAssignment } from './worker.js';
import { WorkerStop } from './worker-stop.js';
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await new Promise<void>(resolve => process.nextTick(resolve)); for (let n = 0; n < 30; n++) await Promise.resolve(); };
const plan = { command: '/runner', args: ['--fixed'], cwd: '/work', env: { SECRET: 'local-value' } };
const job: WorkerAssignment = { id: 'job', box: 'box', agent: 'art', conversation: 'cv', model: 'model', account: 'account', harness: 'harness', brief: 'private-input', house: { repository: 'r', file: 'f', branch: 'next' } };
const id = 'a'.repeat(64);
function frame(text: string, stream = 1) { const bytes = Buffer.from(text); const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(bytes.length, 4); return Buffer.concat([header, bytes]); }
function fixture() {
  const writes: string[] = [], wait = deferred<unknown>();
  const socket = new Duplex({ allowHalfOpen: true, read() {}, write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } });
  const engine = { attach: vi.fn(async (_id: string, _signal: AbortSignal): Promise<Duplex> => socket), json: vi.fn(async (_method: string, path: string, _body: unknown, signal: AbortSignal): Promise<unknown> => {
    if (signal.aborted) throw new Error('aborted');
    if (path.startsWith('/containers/create')) return { Id: id };
    if (path.endsWith('/json')) return { Mounts: [] };
    if (path.includes('/wait?')) {
      signal.addEventListener('abort', () => wait.reject(new Error('aborted')), { once: true }); return wait.promise;
    }
    return undefined;
  }) };
  const builder = { build: vi.fn(async () => 'image:built'), start: vi.fn() };
  const config = { box: 'box', build: structuredClone(plan), runners: { harness: structuredClone(plan) }, container: { socket: '/configured/docker.sock', setupTimeoutMs: 100, cleanupTimeoutMs: 50 } };
  const executor = containerWorkerExecutor(config, { engine, builder, name: () => 'unique' });
  const abort = new AbortController();
  const start = (assignment = job) => executor.start(assignment, 'image:built', abort.signal);
  return { engine, builder, executor, config, abort, socket, writes, wait, start };
}
afterEach(() => vi.useRealTimers());
it('runs the fixed in-image command with no ambient authority, releasing input only after running acknowledgement', async () => {
  const f = fixture(), ack = deferred<void>(), removed = deferred<unknown>();
  const original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => method === 'DELETE' ? removed.promise : original(method, path, body, signal));
  const control = { next: vi.fn(async () => job), started: vi.fn(() => ack.promise), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}) };
  const run = workOnce({ box: 'box', control, executor: f.executor, signal: f.abort.signal, schedule: { every: () => () => {} } });
  await flush();
  expect(f.builder.build).toHaveBeenCalledWith(job, expect.any(AbortSignal)); expect(f.builder.start).not.toHaveBeenCalled();
  expect(f.engine.attach).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(f.engine.json.mock.calls.map(call => call[1])).toEqual(['/containers/create?name=loom-unique', `/containers/${id}/json`, `/containers/${id}/start`, `/containers/${id}/wait?condition=not-running`]);
  expect(control.started).toHaveBeenCalledWith('job', 'image:built'); expect(f.writes).toEqual([]);
  const spec = f.engine.json.mock.calls[0][2];
  expect(spec).toEqual(expect.objectContaining({ Image: 'image:built', Entrypoint: ['/runner'], Cmd: ['--fixed'], WorkingDir: '/work', Env: ['LOOM_BODY_SCRATCH=/tmp', 'SECRET=local-value'], Tty: false,
    Labels: { 'loom.job': 'job', 'loom.agent': 'art', 'loom.box': 'box' }, AttachStdin: true, AttachStdout: true, AttachStderr: true, OpenStdin: true, StdinOnce: true,
    HostConfig: { AutoRemove: false, Privileged: false, Runtime: 'runc', PublishAllPorts: false, LogConfig: { Type: 'none', Config: {} }, PortBindings: {}, Mounts: [], DeviceRequests: [] } }));
  ack.resolve(); await flush(); expect(JSON.parse(f.writes[0])).toEqual({ job, build: 'image:built' });
  const bytes = Buffer.concat([frame('hello €'), frame(' error', 2)]);
  for (const byte of bytes) f.socket.push(Buffer.from([byte]));
  f.socket.push(null); f.wait.resolve({ StatusCode: 17 }); await flush();
  expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
  expect(control.finish).not.toHaveBeenCalled(); removed.resolve(undefined);
  expect(await run).toBe('finished'); expect(control.finish).toHaveBeenCalledWith('job', 17, 'hello € error');
});
it('applies only approved GPU, TCP listeners and explicitly configured nested socket', async () => {
  const f = fixture();
  const original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => path.endsWith('/json') ? Promise.resolve({ Mounts: [{ Type: 'bind', Source: '/allowed/nested.sock', Destination: '/var/run/docker.sock' }] }) : original(method, path, body, signal));
  const executor = containerWorkerExecutor({ ...f.config, container: { ...f.config.container, nestedSocket: '/allowed/nested.sock' } }, { engine: f.engine, builder: f.builder, name: () => 'capabilities' });
  const body = executor.start({ ...job, run: { gpu: true, nestedContainers: true, ports: [{ address: '127.0.0.1', port: 8080 }, { address: '::1', port: 8080 }] } }, 'image', f.abort.signal);
  await body.spawned;
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ ExposedPorts: { '8080/tcp': {} }, HostConfig: {
    DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }],
    PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }, { HostIp: '::1', HostPort: '8080' }] },
    Mounts: [{ Type: 'bind', Source: '/allowed/nested.sock', Target: '/var/run/docker.sock' }] } });
  await body.stop();
});
for (const run of [ { gpu: false, nestedContainers: true, ports: [] },
  { gpu: false, nestedContainers: false, ports: [{ address: 'host:flag', port: 80 }] },
  { gpu: false, nestedContainers: false, ports: [{ address: '127.0.0.1', port: 65_536 }] } ]) {
  it('rejects unavailable nested authority and malformed listeners before any Docker call', () => {
    const f = fixture(); expect(() => f.start({ ...job, run })).toThrow(); expect(f.engine.json).not.toHaveBeenCalled();
  });
}
it('uses a snapshotted assignment/config and does not repeat or release after cancellation', async () => {
  const f = fixture(), assignment = structuredClone(job), body = f.start(assignment);
  assignment.brief = 'changed'; f.config.runners.harness.env.SECRET = 'changed';
  await body.spawned; await body.release(); expect(JSON.parse(f.writes[0]).job.brief).toBe('private-input');
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Env: ['LOOM_BODY_SCRATCH=/tmp', 'SECRET=local-value'] });
  await expect(body.release()).rejects.toThrow(); const first = body.stop(); expect(body.stop()).toBe(first); await first;
  await expect(body.release()).rejects.toThrow(); expect(f.writes).toHaveLength(1);
  expect(f.engine.json.mock.calls.filter(call => call[0] === 'DELETE')).toHaveLength(1);
});
it('cancels stuck setup at its deadline, never starts after cancellation, and removes by unique name', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.engine.json.mockImplementation(async (method, _path, _body, signal) => {
    if (method === 'DELETE') return;
    return new Promise((_yes, no) => signal.addEventListener('abort', () => no(new Error('aborted')), { once: true }));
  });
  const body = f.start(); const failed = expect(body.spawned).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(100); await failed; await body.stop();
  expect(f.engine.attach).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', '/containers/loom-unique?force=1&v=1', undefined, expect.any(AbortSignal));
  expect(vi.getTimerCount()).toBe(0);
});
it('removes a created container after attach or start failure without releasing input', async () => {
  for (const stage of ['attach', 'start']) {
    const f = fixture();
    if (stage === 'attach') f.engine.attach.mockRejectedValue(new Error('private daemon error'));
    else { const original = f.engine.json.getMockImplementation()!; f.engine.json.mockImplementation((method, path, body, signal) => path.endsWith('/start') ? Promise.reject(new Error('start failed')) : original(method, path, body, signal)); }
    const body = f.start(); await expect(body.spawned).rejects.toThrow(); await body.stop();
    expect(f.writes).toEqual([]); expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
  }
});
it('fails boundedly when wait acknowledges exit but output never drains', async () => {
  vi.useFakeTimers(); const f = fixture(), body = f.start(); await body.spawned;
  const failed = expect(body.exited).rejects.toThrow(); f.wait.resolve({ StatusCode: 0 }); await flush();
  await vi.advanceTimersByTimeAsync(50); await failed; await body.stop(); expect(vi.getTimerCount()).toBe(0);
});
it('fails boundedly when output ends but no authoritative exit arrives', async () => {
  vi.useFakeTimers(); const f = fixture(), body = f.start(); await body.spawned;
  const failed = expect(body.exited).rejects.toThrow(); f.socket.push(null); await flush();
  await vi.advanceTimersByTimeAsync(50); await failed; await body.stop(); expect(vi.getTimerCount()).toBe(0);
});
for (const bytes of [Buffer.from([1, 0]), Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]), frame('incomplete').subarray(0, 10)]) {
  it('rejects truncated or invalid output frames', async () => {
    const f = fixture(), body = f.start(); await body.spawned; const failed = expect(body.exited).rejects.toThrow();
    f.socket.push(bytes); f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); await failed; await body.stop();
  });
}
it('retains only the output tail and treats invalid wait output as failure', async () => {
  const f = fixture(), body = f.start(); await body.spawned;
  f.socket.push(frame('x'.repeat(100_000) + 'end')); f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  expect(await body.exited).toEqual({ exitCode: 0, logTail: 'x'.repeat(16_381) + 'end' }); await body.stop();
  const bad = fixture(), other = bad.start(); await other.spawned;
  bad.socket.push(null); bad.wait.resolve({ StatusCode: 0, Error: { Message: 'failed' } });
  await expect(other.exited).rejects.toThrow(); await other.stop();
});
it('stops the slot without a terminal report when container removal is uncertain', async () => {
  const f = fixture(), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => method === 'DELETE' ? Promise.reject(new Error('uncertain removal')) : original(method, path, body, signal));
  const control = { next: vi.fn(async () => job), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}) };
  const run = workOnce({ box: 'box', control, executor: f.executor, signal: f.abort.signal, schedule: { every: () => () => {} } });
  await flush(); f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  await expect(run).rejects.toThrow('uncertain removal'); expect(control.finish).not.toHaveBeenCalled();
  expect(control.next).toHaveBeenCalledOnce(); expect(f.engine.json.mock.calls.filter(call => call[0] === 'DELETE')).toHaveLength(1);
});

it('starts removal on cancellation while the running acknowledgement is still pending', async () => {
  const f = fixture(), ack = deferred<void>();
  const control = { next: vi.fn(async () => job), started: vi.fn(() => ack.promise), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}) };
  const run = workOnce({ box: 'box', control, executor: f.executor, signal: f.abort.signal, schedule: { every: () => () => {} } });
  await flush(); expect(control.started).toHaveBeenCalledOnce(); f.abort.abort(); await flush();
  expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
  expect(f.writes).toEqual([]); expect(f.socket.destroyed).toBe(true); expect(control.finish).not.toHaveBeenCalled();
  ack.resolve(); expect(await run).toBe('abandoned'); expect(f.writes).toEqual([]);
});
it('does not delete an existing container when creation is explicitly rejected', async () => {
  const { DockerResponseError } = await import('./docker-engine.js');
  const f = fixture(); f.engine.json.mockRejectedValue(new DockerResponseError(409));
  const body = f.start(); await expect(body.spawned).rejects.toThrow(); await body.stop();
  expect(f.engine.json).toHaveBeenCalledOnce(); expect(f.engine.attach).not.toHaveBeenCalled();
});

for (const Mounts of [[{ Type: 'volume', Source: '/docker/volume', Destination: '/work' }], [{ Type: 'bind', Source: '/host', Destination: '/work' }], undefined]) {
  it('rejects image volumes, unrequested host mounts and missing inspection before executing image code', async () => {
    const f = fixture(), original = f.engine.json.getMockImplementation()!;
    f.engine.json.mockImplementation((method, path, body, signal) => path.endsWith('/json') ? Promise.resolve({ Mounts }) : original(method, path, body, signal));
    const body = f.start(); await expect(body.spawned).rejects.toThrow('Unexpected container storage'); await body.stop();
    expect(f.engine.attach).not.toHaveBeenCalled(); expect(f.engine.json.mock.calls.some(call => call[1].endsWith('/start'))).toBe(false);
    expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
  });
}
it('does not copy ambient worker credentials into container environment overrides', async () => {
  const f = fixture(); vi.stubEnv('WORKER_ONLY_SECRET', 'ambient-private');
  try {
    const body = f.start(); await body.spawned;
    // Docker can retain baked image values; this list contains only configured
    // overrides and never copies worker process.env or the loom bearer token.
    expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Env: ['LOOM_BODY_SCRATCH=/tmp', 'SECRET=local-value'] }); await body.stop();
  } finally { vi.unstubAllEnvs(); }
});
it('keeps running without a body timeout after both setup and cleanup intervals', async () => {
  vi.useFakeTimers(); const f = fixture(), body = f.start(); await body.spawned; await body.release();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.engine.json.mock.calls.some(call => call[0] === 'DELETE')).toBe(false); expect(f.socket.destroyed).toBe(false);
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); expect(await body.exited).toEqual({ exitCode: 0, logTail: '' });
  await body.stop(); expect(vi.getTimerCount()).toBe(0);
});
it('generates distinct names for real attempts and uses the confirmed identity for cleanup', async () => {
  const f = fixture();
  const executor = containerWorkerExecutor(f.config, { engine: f.engine, builder: f.builder });
  const first = executor.start(job, 'image', f.abort.signal); await first.spawned; await first.stop();
  // A fresh stream for the second attempt; no OS processes or daemon involved.
  const other = fixture(), secondExecutor = containerWorkerExecutor(other.config, { engine: other.engine, builder: other.builder });
  const second = secondExecutor.start(job, 'image', other.abort.signal); await second.spawned; await second.stop();
  const names = [f.engine.json.mock.calls[0][1], other.engine.json.mock.calls[0][1]];
  expect(names[0]).toMatch(/^\/containers\/create\?name=loom-[a-f0-9-]+$/); expect(names[1]).not.toBe(names[0]);
  for (const engine of [f.engine, other.engine]) expect(engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
});
for (const configured of [true, false]) it(`bounds independent removal with ${configured ? 'configured' : 'default'} deadline after cancellation`, async () => {
  vi.useFakeTimers(); const f = fixture(), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => method === 'DELETE'
    ? new Promise((_yes, no) => { expect(signal.aborted).toBe(false); signal.addEventListener('abort', () => no(new Error('cleanup deadline')), { once: true }); })
    : original(method, path, body, signal));
  const config = { ...f.config, container: configured ? f.config.container : { socket: '/configured/socket' } };
  const executor = containerWorkerExecutor(config, { engine: f.engine, builder: f.builder });
  const control = { next: vi.fn(async () => job), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}) };
  const run = workOnce({ box: 'box', control, executor, signal: f.abort.signal, schedule: { every: () => () => {} } });
  await flush(); f.abort.abort(); await flush(); const failed = expect(run).rejects.toThrow('cleanup deadline');
  const ms = configured ? 50 : 30_000; await vi.advanceTimersByTimeAsync(ms - 1);
  expect(control.finish).not.toHaveBeenCalled(); expect(control.next).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); await failed; expect(vi.getTimerCount()).toBe(0);
});
it('uses the default setup deadline of thirty seconds', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.engine.json.mockImplementation(async (method, _path, _body, signal) => method === 'DELETE' ? undefined
    : new Promise((_yes, no) => signal.addEventListener('abort', () => no(new Error('aborted')), { once: true })));
  const executor = containerWorkerExecutor({ ...f.config, container: { socket: '/configured/socket' } }, { engine: f.engine, builder: f.builder });
  const body = executor.start(job, 'image', f.abort.signal); let rejected = false; void body.spawned.catch(() => { rejected = true; });
  await vi.advanceTimersByTimeAsync(29_999); expect(rejected).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await expect(body.spawned).rejects.toThrow(); await body.stop(); expect(vi.getTimerCount()).toBe(0);
});
for (const stage of ['attach', 'start']) it(`bounds delayed create and stalled ${stage} with the same setup clock`, async () => {
  vi.useFakeTimers(); const f = fixture(), created = deferred<unknown>(), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => path.startsWith('/containers/create') ? created.promise
    : stage === 'start' && path.endsWith('/start') ? new Promise((_yes, no) => signal.addEventListener('abort', () => no(new Error('aborted')), { once: true }))
    : original(method, path, body, signal));
  if (stage === 'attach') f.engine.attach.mockImplementation(async (_id, signal) => new Promise((_yes, no) => signal.addEventListener('abort', () => no(new Error('aborted')), { once: true })));
  const body = f.start(); const failed = expect(body.spawned).rejects.toThrow(); await vi.advanceTimersByTimeAsync(70); created.resolve({ Id: id }); await flush();
  await vi.advanceTimersByTimeAsync(29); expect(f.engine.json.mock.calls.some(call => call[0] === 'DELETE')).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await failed; await body.stop(); expect(f.writes).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});

it('selects only the assigned account runner for container argv and environment', async () => {
  const f = fixture(), selected = { command: '/account-runner', args: ['--profile-a'], cwd: '/work', env: { ACCOUNT_PROFILE: 'a' } };
  const executor = containerWorkerExecutor({ ...f.config, accountRunners: { [job.account]: { [job.harness]: selected } } }, { engine: f.engine, builder: f.builder, name: () => 'account' });
  selected.env.ACCOUNT_PROFILE = 'mutated'; selected.command = '/wrong'; selected.args.push('--wrong');
  const body = executor.start(job, 'image', f.abort.signal); await body.spawned;
  const spec = f.engine.json.mock.calls[0][2];
  expect(spec).toMatchObject({ Entrypoint: ['/account-runner'], Cmd: ['--profile-a'], Env: ['LOOM_BODY_SCRATCH=/tmp', 'ACCOUNT_PROFILE=a'] });
  expect(f.writes).toEqual([]); await body.release();
  expect(JSON.parse(f.writes[0]).job).toMatchObject({ account: job.account, model: job.model, harness: job.harness });
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); await body.exited; await body.stop();
  const count = f.engine.json.mock.calls.length;
  expect(() => executor.start({ ...job, account: 'missing' }, 'image', f.abort.signal)).toThrow('configured runner for account');
  expect(() => executor.build({ ...job, account: 'missing' }, f.abort.signal)).toThrow('configured runner for account');
  expect(f.builder.build).not.toHaveBeenCalled(); expect(f.engine.json).toHaveBeenCalledTimes(count);
});
it('uses each account and harness binding in the actual Docker specification', async () => {
  const accounts = { a: { first: { ...plan, command: '/a-first', env: { PROFILE: 'a-first' } }, second: { ...plan, command: '/a-second', env: { PROFILE: 'a-second' } } },
    b: { first: { ...plan, command: '/b-first', env: { PROFILE: 'b-first' } } } };
  for (const [account, harness] of [['a', 'first'], ['a', 'second'], ['b', 'first']]) {
    const f = fixture(), executor = containerWorkerExecutor({ ...f.config, accountRunners: accounts }, { engine: f.engine, builder: f.builder, name: () => 'selection' });
    const body = executor.start({ ...job, account, harness }, 'image', f.abort.signal); await body.spawned;
    expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Entrypoint: [`/${account}-${harness}`], Env: ['LOOM_BODY_SCRATCH=/tmp', `PROFILE=${account}-${harness}`] });
    await body.release(); f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); await body.exited; await body.stop();
  }
});

it('keeps bootstrap bytes out of Docker metadata and discards credential-bearing attach output', async () => {
  const f = fixture(), raw = 'body_'+'a'.repeat(64), token = Buffer.from(raw);
  const executor = containerWorkerExecutor({ ...f.config, runners: { harness: { ...plan, bodyBootstrap: true } } }, { engine: f.engine, builder: f.builder, name: () => 'private' });
  const body = executor.start(job, 'image', f.abort.signal); await body.spawned; expect(f.writes).toEqual([]); expect(body.acceptsBootstrap).toBe(true);
  await body.release({ origin: 'https://loom.example', job: job.id, token });
  expect(JSON.parse(f.writes[0])).toEqual({ job, build: 'image', bootstrap: { origin: 'https://loom.example', job: job.id, token: raw } });
  expect(JSON.stringify(f.engine.json.mock.calls)).not.toContain(raw); f.socket.push(frame(raw)); f.socket.push(frame(raw, 2)); f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  expect(await body.exited).toEqual({ exitCode: 0, logTail: '' }); await body.stop(); token.fill(0);
});

it('selects each account/harness private mode for the actual container stdin envelope', async () => {
  for (const [account, harness, privateMode] of [['account', 'harness', true], ['account', 'ordinary', false], ['other', 'harness', false]] as const) {
    const f = fixture(), executor = containerWorkerExecutor({ ...f.config, runners: { harness: { ...plan, bodyBootstrap: true } }, accountRunners: {
      account: { harness: { ...plan, bodyBootstrap: true }, ordinary: plan }, other: { harness: plan },
    } }, { engine: f.engine, builder: f.builder, name: () => 'binding' });
    const assignment = { ...job, account, harness }, body = executor.start(assignment, 'image', f.abort.signal); await body.spawned; expect(body.acceptsBootstrap).toBe(privateMode);
    const token = Buffer.from('body_'+'a'.repeat(64)); if (privateMode) await body.release({ origin: 'https://loom.example', job: assignment.id, token }); else await body.release();
    const value = JSON.parse(f.writes[0]); expect(value.job).toEqual(assignment); expect(Boolean(value.bootstrap)).toBe(privateMode); await body.stop(); token.fill(0);
  }
});

it('before taking work, removes every container labelled as a job of this machine, a few at a time, after the builder ends its own', async () => {
  const f = fixture(), left = ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(12)], order: string[] = [];
  const builder = { ...f.builder, endLeft: vi.fn(async () => { order.push('builder'); return { unverified: 2 }; }) };
  f.engine.json.mockImplementation(async (method: string, path: string) => {
    order.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET') return left.slice(0, 2).map(Id => ({ Id, Labels: { 'loom.job': 'old' } }));
    left.splice(left.indexOf(path.split('/')[2].split('?')[0]), 1); return undefined;
  });
  const executor = containerWorkerExecutor(f.config, { engine: f.engine, builder });
  expect(await executor.endLeft!(f.abort.signal)).toEqual({ unverified: 2 });
  expect(left).toEqual([]);
  expect(order).toEqual(['builder', 'GET /containers/json', `DELETE /containers/${'b'.repeat(64)}`, `DELETE /containers/${'c'.repeat(64)}`,
    'GET /containers/json', `DELETE /containers/${'d'.repeat(12)}`, 'GET /containers/json']);
  const [, listed] = f.engine.json.mock.calls[0];
  expect(Object.fromEntries(new URL(listed, 'http://docker').searchParams)).toEqual({ all: '1', limit: '8', filters: JSON.stringify({ label: ['loom.job', 'loom.box=box'] }) });
  expect(f.engine.json.mock.calls.filter(([method]) => method === 'DELETE').every(([, path]) => path.endsWith('?force=1&v=1'))).toBe(true);
});
it('does not start beside containers it cannot list or cannot get rid of', async () => {
  const f = fixture();
  f.engine.json.mockResolvedValueOnce({ message: 'not a list' });
  await expect(f.executor.endLeft!(f.abort.signal)).rejects.toThrow('Invalid container list');
  f.engine.json.mockResolvedValueOnce([{ Id: '../../etc' }]);
  await expect(f.executor.endLeft!(f.abort.signal)).rejects.toThrow('Invalid container identity');
  f.engine.json.mockImplementation(async (method: string) => method === 'GET' ? [{ Id: 'e'.repeat(64) }] : undefined);
  await expect(f.executor.endLeft!(f.abort.signal)).rejects.toThrow(new WorkerStop('left'));
  f.engine.json.mockRejectedValue(new Error('docker is down'));
  await expect(f.executor.endLeft!(f.abort.signal)).rejects.toThrow('docker is down');
});
