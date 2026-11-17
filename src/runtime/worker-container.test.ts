import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { containerWorkerExecutor } from './worker-container.js';
import { BuildTimeError, workOnce, type WorkerAssignment } from './worker.js';
import { houseImage } from './house-image.js';
import { workerTurns } from './worker-turns.js';
import type { DockerEngine } from './docker-engine.js';
import { WorkerStop } from './worker-stop.js';
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await new Promise<void>(resolve => process.nextTick(resolve)); for (let n = 0; n < 30; n++) await Promise.resolve(); };
const job: WorkerAssignment = { id: 'job', box: 'box', agent: 'art', conversation: 'cv', model: 'model', account: 'account', harness: 'harness', brief: 'private-input', house: { repository: 'https://example.com/org/house.git', file: 'house/Housefile', branch: 'next' } };
const id = 'a'.repeat(64);
/** The commit the job's branch is at, the image that makes, and what that image says about itself. */
const commit = 'c'.repeat(40), built = houseImage(job.house, commit), imageId = `sha256:${'b'.repeat(64)}`;
const houseLabels = { 'loom.house': '1', 'loom.house.node': '/usr/local/bin/node', 'loom.house.body.harness': '/etc/loom/body/harness.json', 'loom.house.body.unlisted': '/etc/loom/body/unlisted.json', 'io.buildah.version': '1.39' };
function frame(text: string, stream = 1) { const bytes = Buffer.from(text); const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(bytes.length, 4); return Buffer.concat([header, bytes]); }
/** What loom's body program is handed on stdin with its job: a credential of its own. */
const bootstrap = () => ({ origin: 'https://loom.example', job: job.id, token: Buffer.from('body_' + 'a'.repeat(64)) });
const handed = { origin: 'https://loom.example', job: job.id, token: 'body_' + 'a'.repeat(64) };
/** A container's own inspection, as against an image's. */
const inspecting = (path: string) => /^\/containers\/[^/]+\/json$/.test(path);
function fixture() {
  const writes: string[] = [], wait = deferred<unknown>();
  const socket = new Duplex({ allowHalfOpen: true, read() {}, write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } });
  // What is asked about containers: the calls most tests here are about.
  const json = vi.fn(async (_method: string, path: string, _body: unknown, signal: AbortSignal): Promise<unknown> => {
    if (signal.aborted) throw new Error('aborted');
    if (path.startsWith('/containers/create')) return { Id: id };
    if (inspecting(path)) return { Mounts: [programReport()] };
    if (path.includes('/wait?')) {
      signal.addEventListener('abort', () => wait.reject(new Error('aborted')), { once: true }); return wait.promise;
    }
    return undefined;
  });
  // What is asked about images, kept apart: the house's image is there and says how a body starts in it.
  const images = vi.fn(async (method: string, path: string, _body: unknown, _signal: AbortSignal): Promise<unknown> =>
    method === 'GET' && path.startsWith('/images/json') ? [] : method === 'GET' ? { Id: imageId, Config: { WorkingDir: '/home/agent/house', Labels: houseLabels } } : undefined);
  const build = vi.fn(async (_path: string, context: NodeJS.ReadableStream, _signal: AbortSignal) => { context.resume(); });
  const attach = vi.fn(async (_id: string, _signal: AbortSignal): Promise<Duplex> => socket);
  const whole: DockerEngine = { attach, build, json: (method, path, body, signal) => path.startsWith('/images/') || path.startsWith('/build/') ? images(method, path, body, signal) : json(method, path, body, signal) };
  const source = { fetch: vi.fn(async (_house: WorkerAssignment['house'], _credential: Uint8Array | undefined, _signal: AbortSignal) => commit),
    archive: vi.fn((_house: WorkerAssignment['house'], _commit: string, _signal: AbortSignal) => { const tar = new PassThrough(); tar.end('tar'); return tar; }) };
  const config = { box: 'box', container: { socket: engineSock, setupTimeoutMs: 100, cleanupTimeoutMs: 50 } };
  const deps = { engine: whole, source, program: programDirectory };
  const executor = containerWorkerExecutor(config, { ...deps, name: () => 'unique' });
  const abort = new AbortController();
  const start = (assignment = job) => executor.start(assignment, built, abort.signal);
  return { engine: { json, attach, build, images }, deps, source, executor, config, abort, socket, writes, wait, start };
}
afterEach(() => vi.useRealTimers());
it('fetches the house, finds its image, and runs the worker\'s own body program in it as the image says, releasing input only after running acknowledgement', async () => {
  const f = fixture(), ack = deferred<void>(), removed = deferred<unknown>();
  const original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => method === 'DELETE' ? removed.promise : original(method, path, body, signal));
  const control = { next: vi.fn(async () => job), started: vi.fn(() => ack.promise), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => bootstrap()) };
  const run = workOnce({ box: 'box', control, executor: f.executor, signal: f.abort.signal, schedule: { every: () => () => {} } });
  await flush();
  // The job's own house, with no credential when loom sent none; the image was there, so nothing was built.
  expect(f.source.fetch).toHaveBeenCalledExactlyOnceWith(job.house, undefined, expect.any(AbortSignal));
  expect(f.engine.images.mock.calls.map(call => `${call[0]} ${call[1]}`)).toEqual([`GET /images/${built}/json`, `GET /images/${built}/json`]);
  expect(f.engine.build).not.toHaveBeenCalled(); expect(f.source.archive).not.toHaveBeenCalled();
  expect(f.engine.attach).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(f.engine.json.mock.calls.map(call => call[1])).toEqual(['/containers/create?name=loom-unique', `/containers/${id}/json`, `/containers/${id}/start`, `/containers/${id}/wait?condition=not-running`]);
  expect(control.started).toHaveBeenCalledWith('job', built); expect(f.writes).toEqual([]);
  // The image by the id it was inspected under; its node, the worker's body program, the harness's body
  // file, the image's working directory. No environment but where scratch files go: the rest is the image's.
  expect(f.engine.json.mock.calls[0][2]).toEqual({ Image: imageId, Entrypoint: ['/usr/local/bin/node'], Cmd: ['/opt/loom/dist/body.js', '/etc/loom/body/harness.json'], WorkingDir: '/home/agent/house',
    Env: ['LOOM_BODY_SCRATCH=/tmp'], Tty: false, ExposedPorts: {},
    Labels: { 'loom.job': 'job', 'loom.agent': 'art', 'loom.box': 'box' }, AttachStdin: true, AttachStdout: true, AttachStderr: true, OpenStdin: true, StdinOnce: true,
    HostConfig: { AutoRemove: false, Privileged: false, Runtime: 'runc', PublishAllPorts: false, LogConfig: { Type: 'none', Config: {} }, PortBindings: {}, Mounts: [programAsked()], DeviceRequests: [] } });
  ack.resolve(); await flush(); expect(JSON.parse(f.writes[0])).toEqual({ job, build: built, bootstrap: handed });
  const bytes = Buffer.concat([frame('hello €'), frame(' error', 2)]);
  for (const byte of bytes) f.socket.push(Buffer.from([byte]));
  f.socket.push(null); f.wait.resolve({ StatusCode: 17 }); await flush();
  expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
  expect(control.finish).not.toHaveBeenCalled(); removed.resolve(undefined);
  // The body was given a credential, so what it printed is not kept: it reports for itself.
  expect(await run).toBe('finished'); expect(control.finish).toHaveBeenCalledWith('job', 17, '', 'body');
});
it('applies only approved GPU, TCP listeners and explicitly configured nested socket', async () => {
  const f = fixture();
  const original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => inspecting(path) ? Promise.resolve({ Mounts: [{ Type: 'bind', Source: nestedSock, Destination: '/var/run/docker.sock', RW: true }, programReport()] }) : original(method, path, body, signal));
  const executor = containerWorkerExecutor({ ...f.config, container: { ...f.config.container, nestedSocket: nestedSock } }, { ...f.deps, name: () => 'capabilities' });
  const body = executor.start({ ...job, run: { gpu: true, nestedContainers: true, ports: [{ address: '127.0.0.1', port: 8080 }, { address: '::1', port: 8080 }] } }, built, f.abort.signal);
  await body.spawned;
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ ExposedPorts: { '8080/tcp': {} }, HostConfig: {
    DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }],
    PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }, { HostIp: '::1', HostPort: '8080' }] },
    Mounts: [{ Type: 'bind', Source: nestedSock, Target: '/var/run/docker.sock', ReadOnly: false }, programAsked()] } });
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
  assignment.brief = 'changed'; assignment.harness = 'unlisted'; f.config.container.socket = '/changed';
  await body.spawned; await body.release(bootstrap()); expect(JSON.parse(f.writes[0]).job.brief).toBe('private-input');
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Cmd: ['/opt/loom/dist/body.js', '/etc/loom/body/harness.json'] });
  await expect(body.release(bootstrap())).rejects.toThrow(); const first = body.stop(); expect(body.stop()).toBe(first); await first;
  await expect(body.release(bootstrap())).rejects.toThrow(); expect(f.writes).toHaveLength(1);
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
  expect(await body.exited).toEqual({ exitCode: 0, logTail: 'x'.repeat(16_381) + 'end', signalled: false }); await body.stop();
  const bad = fixture(), other = bad.start(); await other.spawned;
  bad.socket.push(null); bad.wait.resolve({ StatusCode: 0, Error: { Message: 'failed' } });
  await expect(other.exited).rejects.toThrow(); await other.stop();
});
it('stops the slot without a terminal report when container removal is uncertain', async () => {
  const f = fixture(), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => method === 'DELETE' ? Promise.reject(new Error('uncertain removal')) : original(method, path, body, signal));
  const control = { next: vi.fn(async () => job), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => bootstrap()) };
  const run = workOnce({ box: 'box', control, executor: f.executor, signal: f.abort.signal, schedule: { every: () => () => {} } });
  await flush(); f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  await expect(run).rejects.toThrow('uncertain removal'); expect(control.finish).not.toHaveBeenCalled();
  expect(control.next).toHaveBeenCalledOnce(); expect(f.engine.json.mock.calls.filter(call => call[0] === 'DELETE')).toHaveLength(1);
});

it('starts removal on cancellation while the running acknowledgement is still pending', async () => {
  const f = fixture(), ack = deferred<void>();
  const control = { next: vi.fn(async () => job), started: vi.fn(() => ack.promise), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => bootstrap()) };
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
    f.engine.json.mockImplementation((method, path, body, signal) => inspecting(path) ? Promise.resolve({ Mounts }) : original(method, path, body, signal));
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
    expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Env: ['LOOM_BODY_SCRATCH=/tmp'] }); await body.stop();
  } finally { vi.unstubAllEnvs(); }
});
it('keeps running without a body timeout after both setup and cleanup intervals', async () => {
  vi.useFakeTimers(); const f = fixture(), body = f.start(); await body.spawned; await body.release(bootstrap());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.engine.json.mock.calls.some(call => call[0] === 'DELETE')).toBe(false); expect(f.socket.destroyed).toBe(false);
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); expect(await body.exited).toEqual({ exitCode: 0, logTail: '', signalled: false });
  await body.stop(); expect(vi.getTimerCount()).toBe(0);
});
it('generates distinct names for real attempts and uses the confirmed identity for cleanup', async () => {
  const f = fixture();
  const executor = containerWorkerExecutor(f.config, { ...f.deps });
  const first = executor.start(job, built, f.abort.signal); await first.spawned; await first.stop();
  // A fresh stream for the second attempt; no OS processes or daemon involved.
  const other = fixture(), secondExecutor = containerWorkerExecutor(other.config, { ...other.deps });
  const second = secondExecutor.start(job, built, other.abort.signal); await second.spawned; await second.stop();
  const names = [f.engine.json.mock.calls[0][1], other.engine.json.mock.calls[0][1]];
  expect(names[0]).toMatch(/^\/containers\/create\?name=loom-[a-f0-9-]+$/); expect(names[1]).not.toBe(names[0]);
  for (const engine of [f.engine, other.engine]) expect(engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
});
for (const configured of [true, false]) it(`bounds independent removal with ${configured ? 'configured' : 'default'} deadline after cancellation`, async () => {
  vi.useFakeTimers(); const f = fixture(), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => method === 'DELETE'
    ? new Promise((_yes, no) => { expect(signal.aborted).toBe(false); signal.addEventListener('abort', () => no(new Error('cleanup deadline')), { once: true }); })
    : original(method, path, body, signal));
  const config = { ...f.config, container: configured ? f.config.container : { socket: engineSock } };
  const executor = containerWorkerExecutor(config, { ...f.deps });
  const control = { next: vi.fn(async () => job), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => bootstrap()) };
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
  const executor = containerWorkerExecutor({ ...f.config, container: { socket: engineSock } }, { ...f.deps });
  const body = executor.start(job, built, f.abort.signal); let rejected = false; void body.spawned.catch(() => { rejected = true; });
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

it('keeps the body\'s credential out of what the engine is told, and keeps nothing the body prints', async () => {
  const f = fixture(), raw = 'body_' + 'a'.repeat(64), token = Buffer.from(raw);
  const body = f.start(); await body.spawned; expect(f.writes).toEqual([]); expect(body.acceptsBootstrap).toBe(true);
  await body.release({ origin: 'https://loom.example', job: job.id, token });
  expect(JSON.parse(f.writes[0])).toEqual({ job, build: built, bootstrap: { origin: 'https://loom.example', job: job.id, token: raw } });
  expect(JSON.stringify([f.engine.json.mock.calls, f.engine.images.mock.calls])).not.toContain(raw);
  f.socket.push(frame(raw)); f.socket.push(frame(raw, 2)); f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  expect(await body.exited).toEqual({ exitCode: 0, logTail: '', signalled: false }); await body.stop(); token.fill(0);
  // The body program is loom's own: it is never started without its credential.
  const bare = fixture(), other = bare.start(); await other.spawned;
  await expect(other.release()).rejects.toThrow(); expect(bare.writes).toEqual([]); await other.stop();
});
it('starts each harness with the body file the image names for it', async () => {
  for (const [harness, file] of [['harness', '/etc/loom/body/harness.json'], ['unlisted', '/etc/loom/body/unlisted.json']]) {
    const f = fixture(), body = f.start({ ...job, harness }); await body.spawned;
    expect(f.engine.images).toHaveBeenLastCalledWith('GET', `/images/${built}/json`, undefined, expect.any(AbortSignal));
    expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Image: imageId, Entrypoint: ['/usr/local/bin/node'], Cmd: ['/opt/loom/dist/body.js', file] });
    await body.stop();
  }
});

it('before taking work, ends the processes a worker before it recorded, then removes every container labelled as a job of this machine, a few at a time', async () => {
  const f = fixture(), left = ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(12)], order: string[] = [];
  const kept = { reap: vi.fn(async () => { order.push('left'); return { ended: 1, unverified: 2 }; }), note: () => () => {}, scratch: () => '', close: vi.fn() };
  const opened = vi.fn(() => kept);
  f.engine.json.mockImplementation(async (method: string, path: string) => {
    order.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET') return left.slice(0, 2).map(Id => ({ Id, Labels: { 'loom.job': 'old' } }));
    left.splice(left.indexOf(path.split('/')[2].split('?')[0]), 1); return undefined;
  });
  const executor = containerWorkerExecutor({ ...f.config, state: join(houseRoot, 'state') }, { ...f.deps, left: opened });
  expect(opened).toHaveBeenCalledExactlyOnceWith(join(houseRoot, 'state'));
  expect(await executor.endLeft!(f.abort.signal)).toEqual({ unverified: 2 });
  expect(left).toEqual([]);
  expect(order).toEqual(['left', 'GET /containers/json', `DELETE /containers/${'b'.repeat(64)}`, `DELETE /containers/${'c'.repeat(64)}`,
    'GET /containers/json', `DELETE /containers/${'d'.repeat(12)}`, 'GET /containers/json']);
  const [, listed] = f.engine.json.mock.calls[0];
  expect(Object.fromEntries(new URL(listed, 'http://docker').searchParams)).toEqual({ all: '1', limit: '8', filters: JSON.stringify({ label: ['loom.job', 'loom.box=box'] }) });
  expect(f.engine.json.mock.calls.filter(([method]) => method === 'DELETE').every(([, path]) => path.endsWith('?force=1&v=1'))).toBe(true);
  // It gives the state directory up when the worker stops in good order.
  executor.close!(); expect(kept.close).toHaveBeenCalledOnce();
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

it('reports a container whose process a signal ended as killed, the same stage as a body run as a process', async () => {
  const { containerExit } = await import('./job-exit.js');
  // 128 plus the signal: the memory killer and `docker kill` (9), a plain stop (15).
  expect([137, 143].map(containerExit)).toEqual([29, 29]);
  // An exit the process made by itself is passed on as it is.
  expect([0, 1, 14, 128, 200].map(containerExit)).toEqual([0, 1, 14, 128, 200]);
});

// The three additions for houses: the runtime's name, an account's sign-in directory, the fixed mounts.
const houseRoot = mkdtempSync(join(realpathSync(tmpdir()), 'loom-house-'));
afterAll(() => rmSync(houseRoot, { recursive: true, force: true }));
const houseDirectory = (name: string) => { const path = join(houseRoot, name); mkdirSync(path, { recursive: true }); return path; };
/** A directory laid out as an install of the worker is: the body program, and every package it depends on in its own node_modules. */
function install(name: string, change: (path: string) => void = () => {}) {
  const path = houseDirectory(name);
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: '@example/loom', dependencies: { zod: '^4', '@scope/package': '^1' } }));
  mkdirSync(join(path, 'dist'), { recursive: true }); writeFileSync(join(path, 'dist', 'body.js'), '');
  mkdirSync(join(path, 'node_modules', 'zod'), { recursive: true }); mkdirSync(join(path, 'node_modules', '@scope', 'package'), { recursive: true });
  change(path); return path;
}
const programDirectory = install('install/loom');
/** The worker's own directory, as every body's container must be reported to have it. */
function programReport() { return reported(programDirectory, '/opt/loom', false); }
const programAsked = () => ({ Type: 'bind', Source: programDirectory, Target: '/opt/loom', ReadOnly: true });
const loginA = houseDirectory('logins/a'), loginB = houseDirectory('logins/b'), stamps = houseDirectory('stamps'), mirror = houseDirectory('mirror');
// The engine's own socket and its socket for nested containers must be real sockets (worker-mounts.ts).
// Nothing connects to either: every test here gives the executor a fake engine.
const nestedSock = join(houseDirectory('engine'), 'nested.sock'), engineSock = join(houseDirectory('engine'), 'engine.sock');
const sockets: Server[] = [];
beforeAll(async () => { for (const path of [nestedSock, engineSock]) await new Promise<void>(done => sockets.push(createServer().listen(path, done))); });
afterAll(() => { for (const server of sockets) server.close(); });
const accountLogins = { account: { harness: { source: loginA, target: '/home/agent/.claude' } }, other: { harness: { source: loginB, target: '/home/agent/.claude' } } };
const houseMounts = [{ source: stamps, target: '/house/stamps', readOnly: false }, { source: mirror, target: '/house/mirror' }];
/** What an engine reports of a bind mount it made. */
function reported(Source: string, Destination: string, RW: boolean) { return { Type: 'bind', Source, Destination, Mode: '', RW, Propagation: 'rprivate' }; }
const expectedReport = [reported(loginA, '/home/agent/.claude', true), reported(stamps, '/house/stamps', true), reported(mirror, '/house/mirror', false)];
function house(inspected: unknown = expectedReport, container: Record<string, unknown> = { mounts: { art: houseMounts } }, logins: typeof accountLogins | null = accountLogins) {
  const f = fixture(), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => inspecting(path) ? Promise.resolve({ Mounts: Array.isArray(inspected) ? [programReport(), ...inspected] : inspected }) : original(method, path, body, signal));
  const executor = containerWorkerExecutor({ ...f.config, ...(logins ? { accountLogins: logins } : {}), container: { ...f.config.container, ...container } }, { ...f.deps, name: () => 'house' });
  return { ...f, executor };
}
type Spec = { HostConfig: { Runtime: string; Mounts: unknown[] } };

it('asks the engine for runc unless the configuration names crun, and for nothing else', async () => {
  for (const [runtime, sent] of [[undefined, 'runc'], ['runc', 'runc'], ['crun', 'crun']] as const) {
    const f = fixture(), executor = containerWorkerExecutor({ ...f.config, container: { ...f.config.container, ...(runtime ? { runtime } : {}) } }, { ...f.deps, name: () => 'runtime' });
    const body = executor.start(job, built, f.abort.signal); await body.spawned;
    expect((f.engine.json.mock.calls[0][2] as Spec).HostConfig.Runtime).toBe(sent); await body.stop();
  }
  const f = fixture();
  for (const runtime of ['kata', '', 'runc ', 'RUNC', 7])
    expect(() => containerWorkerExecutor({ ...f.config, container: { ...f.config.container, runtime: runtime as 'crun' } }, { ...f.deps })).toThrow('Invalid container runtime');
});
it('mounts the job\'s own sign-in directory read-write and the fixed mounts, and no other account\'s directory', async () => {
  const f = house(), body = f.executor.start(job, built, f.abort.signal); await body.spawned;
  expect((f.engine.json.mock.calls[0][2] as Spec).HostConfig.Mounts).toEqual([programAsked(),
    { Type: 'bind', Source: loginA, Target: '/home/agent/.claude', ReadOnly: false },
    { Type: 'bind', Source: stamps, Target: '/house/stamps', ReadOnly: false },
    { Type: 'bind', Source: mirror, Target: '/house/mirror', ReadOnly: true }]);
  // Nothing sent to the engine for this job names the other account's directory.
  expect(JSON.stringify(f.engine.json.mock.calls)).not.toContain(loginB);
  expect(f.engine.attach).toHaveBeenCalledOnce(); await body.stop();
  const other = house([reported(loginB, '/home/agent/.claude', true), ...expectedReport.slice(1)]);
  const second = other.executor.start({ ...job, account: 'other' }, built, other.abort.signal); await second.spawned;
  expect((other.engine.json.mock.calls[0][2] as Spec).HostConfig.Mounts[1]).toEqual({ Type: 'bind', Source: loginB, Target: '/home/agent/.claude', ReadOnly: false });
  expect(JSON.stringify(other.engine.json.mock.calls)).not.toContain(loginA); await second.stop();
});
it('gives every body the fixed mounts when no sign-in map is configured, beside the nested socket', async () => {
  const f = house([reported(nestedSock, '/var/run/docker.sock', true), ...expectedReport.slice(1)], { mounts: { art: houseMounts }, nestedSocket: nestedSock }, null);
  const body = f.executor.start({ ...job, account: 'anyone', run: { gpu: false, nestedContainers: true, ports: [] } }, built, f.abort.signal); await body.spawned;
  expect((f.engine.json.mock.calls[0][2] as Spec).HostConfig.Mounts).toEqual([
    { Type: 'bind', Source: nestedSock, Target: '/var/run/docker.sock', ReadOnly: false }, programAsked(),
    { Type: 'bind', Source: stamps, Target: '/house/stamps', ReadOnly: false },
    { Type: 'bind', Source: mirror, Target: '/house/mirror', ReadOnly: true }]);
  await body.stop();
});
it('with a sign-in map, fails a job that has no exact entry before the builder, the engine or the body', async () => {
  // The image has a body file for both harnesses, so the only thing missing is a sign-in entry.
  const f = house(), original = f.executor;
  for (const assignment of [{ ...job, account: 'missing' }, { ...job, harness: 'unlisted' }]) {
    expect(() => f.executor.build(assignment, f.abort.signal)).toThrow('configured sign-in directory');
    expect(() => f.executor.start(assignment, built, f.abort.signal)).toThrow('configured sign-in directory');
  }
  expect(f.source.fetch).not.toHaveBeenCalled(); expect(f.engine.images).not.toHaveBeenCalled(); expect(f.engine.json).not.toHaveBeenCalled(); expect(f.engine.attach).not.toHaveBeenCalled();
  // As loom sees it: the runner stage's code and the worker's own words, with no path in them.
  const assignment = { ...job, account: 'missing' };
  const control = { next: vi.fn(async () => assignment), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => bootstrap()) };
  expect(await workOnce({ box: 'box', control, executor: original, signal: f.abort.signal, schedule: { every: () => () => {} } })).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 27, 'Worker could not start the body: runner failed', 'worker');
  expect(control.started).not.toHaveBeenCalled(); expect(f.source.fetch).not.toHaveBeenCalled(); expect(f.engine.images).not.toHaveBeenCalled(); expect(f.engine.json).not.toHaveBeenCalled();
  // The same for an account that has entries, none of them for this job's harness.
  const unlisted = { ...job, harness: 'unlisted' };
  const other = { next: vi.fn(async () => unlisted), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => bootstrap()) };
  expect(await workOnce({ box: 'box', control: other, executor: f.executor, signal: f.abort.signal, schedule: { every: () => () => {} } })).toBe('finished');
  expect(other.finish).toHaveBeenCalledExactlyOnceWith('job', 27, 'Worker could not start the body: runner failed', 'worker');
  expect(other.started).not.toHaveBeenCalled(); expect(f.source.fetch).not.toHaveBeenCalled(); expect(f.engine.images).not.toHaveBeenCalled(); expect(f.engine.json).not.toHaveBeenCalled();
});
it.each([
  ['one more mount than it asked for', [...expectedReport, reported('/host', '/work', true)]],
  ['an image volume beside its own', [...expectedReport, { Type: 'volume', Name: 'v', Source: '/engine/volumes/v/_data', Destination: '/data', RW: true }]],
  ['a mount missing', expectedReport.slice(0, 2)],
  ['none of its mounts', []],
  ['another account\'s directory at the sign-in target', [reported(loginB, '/home/agent/.claude', true), ...expectedReport.slice(1)]],
  ['its sign-in directory at another place', [reported(loginA, '/elsewhere', true), ...expectedReport.slice(1)]],
  ['a read-only mount made writable', [...expectedReport.slice(0, 2), reported(mirror, '/house/mirror', true)]],
  ['a writable mount made read-only', [reported(loginA, '/home/agent/.claude', false), ...expectedReport.slice(1)]],
  ['a mount that does not say whether it is writable', [...expectedReport.slice(0, 2), { Type: 'bind', Source: mirror, Destination: '/house/mirror' }]],
  ['a volume where a bind mount was asked for', [...expectedReport.slice(0, 2), { ...reported(mirror, '/house/mirror', false), Type: 'volume' }]],
  ['one mount reported twice in place of another', [expectedReport[0], expectedReport[1], expectedReport[1]]],
  ['something that is not a mount', [...expectedReport.slice(0, 2), null]],
  ['no list of mounts', null],
])('removes the container without starting it when the engine reports %s', async (_what, inspected) => {
  const f = house(inspected), body = f.executor.start(job, built, f.abort.signal);
  await expect(body.spawned).rejects.toThrow('Unexpected container storage'); await body.stop();
  expect(f.engine.attach).not.toHaveBeenCalled(); expect(f.engine.json.mock.calls.some(call => call[1].endsWith('/start'))).toBe(false);
  expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
});
const nestedReport = () => [reported(nestedSock, '/var/run/docker.sock', true), ...expectedReport];
it.each([
  ['the socket missing', () => expectedReport],
  ['another socket in its place', () => [reported('/run/other.sock', '/var/run/docker.sock', true), ...expectedReport]],
  ['the socket at another place', () => [reported(nestedSock, '/run/docker.sock', true), ...expectedReport]],
  ['the socket read-only', () => [reported(nestedSock, '/var/run/docker.sock', false), ...expectedReport]],
  ['the socket without saying whether it is writable', () => [{ Type: 'bind', Source: nestedSock, Destination: '/var/run/docker.sock' }, ...expectedReport]],
  ['a volume at the socket\'s place', () => [{ ...reported(nestedSock, '/var/run/docker.sock', true), Type: 'volume' }, ...expectedReport]],
  ['one mount more than the socket and its own', () => [...nestedReport(), reported('/host', '/work', true)]],
])('removes a nested job\'s container without starting it when the engine reports %s', async (_what, inspected) => {
  const nestedJob = { ...job, run: { gpu: false, nestedContainers: true, ports: [] } };
  const good = house(nestedReport(), { mounts: { art: houseMounts }, nestedSocket: nestedSock }), fine = good.executor.start(nestedJob, built, good.abort.signal);
  await fine.spawned; await fine.stop();
  const f = house(inspected(), { mounts: { art: houseMounts }, nestedSocket: nestedSock }), body = f.executor.start(nestedJob, built, f.abort.signal);
  await expect(body.spawned).rejects.toThrow('Unexpected container storage'); await body.stop();
  expect(f.engine.attach).not.toHaveBeenCalled(); expect(f.engine.json.mock.calls.some(call => call[1].endsWith('/start'))).toBe(false);
});
it('still runs the build of a nested job on a machine with no nested socket, and fails it when its body is started', async () => {
  const f = fixture(), nested = { ...job, run: { gpu: false, nestedContainers: true, ports: [] } };
  expect(await f.executor.build(nested, f.abort.signal)).toBe(built);
  expect(() => f.start(nested)).toThrow('Nested containers unavailable'); expect(f.engine.json).not.toHaveBeenCalled();
});
it('does not make a worker whose engine socket is not a socket, or that a mount would carry into a body', () => {
  const f = fixture();
  for (const container of [{ socket: '/loom-test/no.sock' }, { socket: 'relative.sock' }, { socket: join(houseRoot, 'engine') },
    { mounts: { art: [{ source: join(houseRoot, 'engine'), target: '/house/run' }] } }, { mounts: { art: [{ source: houseRoot, target: '/house/all' }] } }])
    expect(() => containerWorkerExecutor({ ...f.config, container: { ...f.config.container, ...container } }, { ...f.deps })).toThrow(expect.objectContaining({ stage: 'mounts' }));
  // Nor one whose mounts reach its own records or its token, or name one directory twice.
  for (const patch of [{ state: join(stamps, 'state') }, { tokenFile: join(mirror, 'token') }, { container: { ...f.config.container, mounts: { art: [...houseMounts, { source: stamps, target: '/again' }] } } }])
    expect(() => containerWorkerExecutor({ ...f.config, container: { ...f.config.container, mounts: { art: houseMounts } }, ...patch }, { ...f.deps })).toThrow(expect.objectContaining({ stage: 'mounts' }));
  expect(f.engine.json).not.toHaveBeenCalled();
});
it('does not make a worker whose nested socket is not a socket, or is a way into a mounted directory', () => {
  const f = fixture();
  for (const container of [{ nestedSocket: '/loom-test/no.sock' }, { nestedSocket: join(houseRoot, 'logins') }, { nestedSocket: loginA },
    { nestedSocket: nestedSock, mounts: { art: [{ source: join(houseRoot, 'engine'), target: '/house/engine' }] } }])
    expect(() => containerWorkerExecutor({ ...f.config, accountLogins, container: { ...f.config.container, ...container } }, { ...f.deps })).toThrow(expect.objectContaining({ stage: 'mounts' }));
  expect(f.engine.json).not.toHaveBeenCalled();
});
it('accepts the mounts it asked for in whatever order the engine lists them', async () => {
  const f = house([...expectedReport].reverse()), body = f.executor.start(job, built, f.abort.signal);
  await body.spawned; expect(f.engine.attach).toHaveBeenCalledOnce(); await body.stop();
});
it('puts no mount path in what the worker itself says: a failed start\'s report, a finished job\'s report, the envelope, the labels, the environment', async () => {
  const paths = [houseRoot, '/home/agent/.claude', '/house/stamps', '/house/mirror', '/opt/loom'];
  const said = (control: { finish: ReturnType<typeof vi.fn>; started: ReturnType<typeof vi.fn> }) => JSON.stringify([control.finish.mock.calls, control.started.mock.calls]);
  // A start the worker refused because the engine's mounts were not its own.
  const refused = house([...expectedReport, reported(loginB, '/other', true)]);
  const control = { next: vi.fn(async () => job), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => bootstrap()) };
  expect(await workOnce({ box: 'box', control, executor: refused.executor, signal: refused.abort.signal, schedule: { every: () => () => {} } })).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 23, 'Worker could not start the body: launch failed', 'worker');
  for (const path of paths) expect(said(control)).not.toContain(path);
  // A body that ran: its envelope and the report carry the job, never where its files came from.
  const ran = house(), finished = { next: vi.fn(async () => job), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => bootstrap()) };
  const run = workOnce({ box: 'box', control: finished, executor: ran.executor, signal: ran.abort.signal, schedule: { every: () => () => {} } });
  await flush(); ran.socket.push(frame('done')); ran.socket.push(null); ran.wait.resolve({ StatusCode: 0 });
  // What the body printed is not passed on at all: the body program reports for itself.
  expect(await run).toBe('finished'); expect(finished.finish).toHaveBeenCalledExactlyOnceWith('job', 0, '', 'body');
  for (const path of paths) { expect(said(finished)).not.toContain(path); expect(ran.writes.join('')).not.toContain(path); }
  // Nor do the labels or the environment the engine keeps.
  const spec = ran.engine.json.mock.calls[0][2] as { Labels: unknown; Env: unknown };
  for (const path of paths.slice(0, 4)) expect(JSON.stringify([spec.Labels, spec.Env])).not.toContain(path);
});
it('does not make a worker whose mounts cannot be used, and neither asks the engine anything nor fetches', () => {
  const f = fixture();
  for (const patch of [{ accountLogins: { account: { harness: { source: join(houseRoot, 'missing'), target: '/home/agent/.claude' } } } },
    { container: { ...f.config.container, mounts: { art: [{ source: 'relative', target: '/house/x' }] } } },
    { accountLogins, container: { ...f.config.container, mounts: { art: [{ source: mirror, target: '/home/agent/.claude' }] } } }])
    expect(() => containerWorkerExecutor({ ...f.config, ...patch }, { ...f.deps })).toThrow(expect.objectContaining({ stage: 'mounts' }));
  expect(f.engine.json).not.toHaveBeenCalled(); expect(f.engine.images).not.toHaveBeenCalled(); expect(f.source.fetch).not.toHaveBeenCalled();
});
it('fixes the mounts when the worker is made', async () => {
  const logins = structuredClone(accountLogins), mounts = structuredClone(houseMounts), f = house(expectedReport, { mounts: { art: mounts } }, logins);
  logins.account.harness.source = loginB; mounts[1].readOnly = false; mounts.push({ source: loginB, target: '/stolen' });
  const body = f.executor.start(job, built, f.abort.signal); await body.spawned;
  expect(JSON.stringify(f.engine.json.mock.calls[0][2])).not.toContain(loginB); await body.stop();
});

// One worker, any agent's house: the worker fetches and builds, and the image says how a body starts.
const missingImage = async () => { const { DockerResponseError } = await import('./docker-engine.js'); return new DockerResponseError(404); };
/** An engine that has no image until one is built. */
async function unbuilt(f: ReturnType<typeof fixture>) {
  const gone = await missingImage(), there = f.engine.images.getMockImplementation()!; let made = false;
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && !path.startsWith('/images/json') && !made) throw gone; return there(method, path, body, signal); });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); made = true; });
  return { built: () => { made = true; } };
}
const controlFor = (assignment: WorkerAssignment) => ({ next: vi.fn(async () => assignment), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => ({ ...bootstrap(), job: assignment.id })) });
const once = (f: ReturnType<typeof fixture>, control: ReturnType<typeof controlFor>, schedule = { every: (_ms: number, _callback: () => void) => () => {} }) =>
  workOnce({ box: 'box', control, executor: f.executor, signal: f.abort.signal, schedule });

it('builds a house that is not on the engine from the commit\'s own files and its Housefile, then removes what is no longer needed', async () => {
  const f = fixture(); await unbuilt(f);
  expect(await f.executor.build(job, f.abort.signal)).toBe(built); await flush();
  expect(f.source.archive).toHaveBeenCalledExactlyOnceWith(job.house, commit, expect.any(AbortSignal));
  expect(f.engine.build).toHaveBeenCalledOnce();
  const [path, context] = f.engine.build.mock.calls[0];
  expect(Object.fromEntries(new URL(path, 'http://engine').searchParams)).toEqual({ t: built, dockerfile: 'house/Housefile', q: '1', rm: '1', forcerm: '1' });
  expect(context).toBe(f.source.archive.mock.results[0].value);
  // Asked whether it is there, built, asked again, and then the old ones and the leftovers are seen to.
  expect(f.engine.images.mock.calls.map(call => `${call[0]} ${decodeURIComponent(call[1])}`)).toEqual([`GET /images/${built}/json`, `GET /images/${built}/json`,
    'GET /images/json?filters={"reference":["localhost/loom-house-*"]}', 'POST /images/prune?filters={"dangling":["true"],"until":["24h"]}', 'POST /build/prune?filters={"until":["168h"]}']);
  // The next job of the same house at the same commit finds it.
  expect(await f.executor.build({ ...job, id: 'second' }, f.abort.signal)).toBe(built); expect(f.engine.build).toHaveBeenCalledOnce();
});
it('builds one image once for two jobs that want it at the same moment', async () => {
  const f = fixture(), gone = await missingImage(), release = deferred<void>(); let made = false;
  const there = f.engine.images.getMockImplementation()!;
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && !path.startsWith('/images/json') && !made) throw gone; return there(method, path, body, signal); });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); await release.promise; made = true; });
  const first = f.executor.build(job, f.abort.signal), second = f.executor.build({ ...job, id: 'second', agent: 'mark' }, f.abort.signal);
  await flush(); expect(f.engine.build).toHaveBeenCalledOnce();
  release.resolve(); expect(await Promise.all([first, second])).toEqual([built, built]); expect(f.engine.build).toHaveBeenCalledOnce();
});
it('names the image by the house and its commit alone, so a new loom on the machine rebuilds nothing', async () => {
  const f = fixture(), newer = install('install/loom-next');
  const deployed = containerWorkerExecutor(f.config, { ...f.deps, program: newer, name: () => 'next' }), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => inspecting(path) ? Promise.resolve({ Mounts: [reported(newer, '/opt/loom', false)] }) : original(method, path, body, signal));
  expect(await f.executor.build(job, f.abort.signal)).toBe(built); expect(await deployed.build(job, f.abort.signal)).toBe(built);
  expect(f.engine.build).not.toHaveBeenCalled();
  // The new program reaches the body as a mount of the same image.
  const body = deployed.start(job, built, f.abort.signal); await body.spawned;
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Image: imageId, HostConfig: { Mounts: [{ Type: 'bind', Source: newer, Target: '/opt/loom', ReadOnly: true }] } });
  await body.stop();
});
it('gives the repository\'s secret to the fetch and to nothing the engine is told', async () => {
  const f = fixture(); await unbuilt(f);
  const secret = new TextEncoder().encode('repository-secret-value');
  const control = { ...controlFor(job), repositoryInput: vi.fn(async () => secret) };
  const run = once(f, control); await flush();
  expect(f.source.fetch).toHaveBeenCalledExactlyOnceWith(job.house, secret, expect.any(AbortSignal));
  expect(JSON.stringify([f.engine.json.mock.calls, f.engine.images.mock.calls, f.engine.build.mock.calls.map(call => call[0]), f.source.archive.mock.calls])).not.toMatch(/repository-secret-value|cmVwb3NpdG9yeS1zZWNyZXQ/);
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); expect(await run).toBe('finished');
  // workOnce wipes the bytes once the build has settled.
  expect([...secret].every(byte => byte === 0)).toBe(true);
  expect(JSON.stringify(control.finish.mock.calls)).not.toContain('repository-secret-value');
});
it('goes on reporting a job as starting while its house builds, and fails it with its own reason when the build runs out of time', async () => {
  vi.useFakeTimers();
  const f = fixture(), gone = await missingImage();
  f.engine.images.mockImplementation(async method => { if (method === 'GET') throw gone; return undefined; });
  // A build that never returns, whatever it is told.
  const stuck = vi.fn((_path: string, context: NodeJS.ReadableStream, _signal: AbortSignal) => { context.resume(); return new Promise<void>(() => {}); });
  f.engine.build.mockImplementation(stuck);
  const executor = containerWorkerExecutor({ ...f.config, buildTimeoutMs: 20 * 60_000 }, { ...f.deps });
  const control = controlFor(job); let pulse = () => {};
  const run = workOnce({ box: 'box', control, executor, signal: f.abort.signal, schedule: { every: (_ms, callback) => { pulse = callback; return () => {}; } } });
  // Nineteen minutes of building: a report at every interval, each one sent and answered.
  for (let report = 1; report <= 76; report++) { await vi.advanceTimersByTimeAsync(15_000); pulse(); await flush(); }
  expect(control.heartbeat).toHaveBeenCalledTimes(76); expect(control.heartbeat.mock.calls.every(call => call[1] === 'starting')).toBe(true);
  expect(control.finish).not.toHaveBeenCalled(); expect(stuck).toHaveBeenCalledOnce();
  // The limit: that job fails, saying the build ran out of time. The engine is not waited on.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await run).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 32, 'Worker could not start the body: the build ran out of time', 'worker');
  expect(stuck.mock.calls[0][2].aborted).toBe(true); expect(f.engine.json).not.toHaveBeenCalled();
  // The worker takes its next job, of a house whose image is there.
  f.engine.images.mockImplementation(async () => ({ Id: imageId, Config: { WorkingDir: '/home/agent/house', Labels: houseLabels } }));
  const other = { ...job, id: 'next', agent: 'mark', house: { repository: 'https://example.com/mark/house.git', file: 'Housefile', branch: 'main' } }, next = controlFor(other);
  const second = workOnce({ box: 'box', control: next, executor, signal: f.abort.signal, schedule: { every: () => () => {} } });
  for (let turn = 0; turn < 20 && !f.writes.length; turn++) { await vi.advanceTimersByTimeAsync(0); await flush(); }
  expect(JSON.parse(f.writes[0]).job.id).toBe('next'); f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); await vi.advanceTimersByTimeAsync(0);
  expect(await second).toBe('finished'); expect(next.finish).toHaveBeenCalledExactlyOnceWith('next', 0, '', 'body');
  executor.close!(); expect(vi.getTimerCount()).toBe(0);
});
it('gives a build thirty minutes when the configuration does not say, and a fetch that never returns the same', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.source.fetch.mockImplementation(() => new Promise<string>(() => {}));
  let failure: unknown; const pending = f.executor.build(job, f.abort.signal).catch(error => { failure = error; });
  await vi.advanceTimersByTimeAsync(30 * 60_000 - 1); expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await pending;
  expect(failure).toBeInstanceOf(BuildTimeError); expect(f.source.fetch.mock.calls[0][2].aborted).toBe(true);
  for (const buildTimeoutMs of [0, 3_600_001, 1.5]) expect(() => containerWorkerExecutor({ ...f.config, buildTimeoutMs }, { ...f.deps })).toThrow('Invalid worker build deadline');
});
it.each([
  ['its repository cannot be fetched', (f: ReturnType<typeof fixture>) => { f.source.fetch.mockRejectedValue(new Error('git failed: https://example.com/org/house.git private words')); }],
  ['the engine cannot build it', (f: ReturnType<typeof fixture>) => { f.engine.build.mockRejectedValue(new Error('Docker build failed')); }],
  ['the engine says it built it and has no image', (f: ReturnType<typeof fixture>) => { f.engine.build.mockImplementation(async (_path, context) => { context.resume(); }); }],
])('fails only that job, as a failed build and in its own words, when %s', async (_what, arrange) => {
  const f = fixture(), gone = await missingImage();
  f.engine.images.mockImplementation(async method => { if (method === 'GET') throw gone; return undefined; });
  arrange(f);
  const control = controlFor(job);
  expect(await once(f, control)).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 22, 'Worker could not start the body: build failed', 'worker');
  expect(f.engine.json).not.toHaveBeenCalled(); expect(f.engine.attach).not.toHaveBeenCalled();
  // And the build is not left in the way of the next job that wants the same image.
  f.engine.images.mockImplementation(async () => ({ Id: imageId, Config: { WorkingDir: '/home/agent/house', Labels: houseLabels } }));
  f.source.fetch.mockResolvedValue(commit);
  expect(await f.executor.build({ ...job, id: 'again' }, f.abort.signal)).toBe(built);
});
it.each([
  ['says nothing about how a body starts', 'loom.house', { 'io.buildah.version': '1.39' }, {}], ['names no body file for the job\'s harness', 'loom.house.body.harness', { ...houseLabels, 'loom.house.body.harness': undefined }, {}],
  ['is of a later contract', 'loom.house', { ...houseLabels, 'loom.house': '2' }, {}], ['names a node that is not a plain path', 'loom.house.node', { ...houseLabels, 'loom.house.node': 'node' }, {}],
  ['has no working directory', 'WORKDIR', houseLabels, { WorkingDir: '' }], ['declares a volume', 'VOLUME', houseLabels, { Volumes: { '/data': {} } }],
])('fails only that job, with the house\'s own exit code and the rule it breaks, when its image %s', async (_what, rule, labels, config) => {
  const f = fixture();
  f.engine.images.mockImplementation(async () => ({ Id: imageId, Config: { WorkingDir: '/home/agent/house', Labels: labels, ...config } }));
  const control = controlFor(job);
  expect(await once(f, control)).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 30, `Worker could not start the body: the house image does not meet the image contract (${rule})`, 'worker');
  // Nothing was created, so nothing ran and nothing is left.
  expect(f.engine.json).not.toHaveBeenCalled(); expect(f.engine.attach).not.toHaveBeenCalled(); expect(control.enrollBody).not.toHaveBeenCalled();
});
it('refuses a job it cannot hold to its account: several accounts on the machine and no sign-in directories', async () => {
  const f = fixture(), several = { ...job, accountChoices: 2 };
  expect(() => f.executor.build(several, f.abort.signal)).toThrow('Several accounts need a sign-in directory each');
  expect(() => f.executor.start(several, built, f.abort.signal)).toThrow('Several accounts need a sign-in directory each');
  const control = controlFor(several);
  expect(await once(f, control)).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 27, 'Worker could not start the body: runner failed', 'worker');
  expect(f.source.fetch).not.toHaveBeenCalled(); expect(f.engine.images).not.toHaveBeenCalled();
  // With sign-in directories the account is held by its own directory, however many there are.
  const held = house(), body = held.executor.start(several, built, held.abort.signal); await body.spawned; await body.stop();
});
it('mounts an agent\'s own directories into its bodies and never another agent\'s', async () => {
  const markState = houseDirectory('mark/state'), mounts = { art: houseMounts, mark: [{ source: markState, target: '/house/stamps', readOnly: false }] };
  for (const [agent, own, others] of [['art', [stamps, mirror], [markState]], ['mark', [markState], [stamps, mirror]], ['someone-new', [], [stamps, mirror, markState]]] as const) {
    const f = fixture(), original = f.engine.json.getMockImplementation()!;
    f.engine.json.mockImplementation((method, path, body, signal) => inspecting(path)
      ? Promise.resolve({ Mounts: [programReport(), ...own.map(source => reported(source, source === mirror ? '/house/mirror' : '/house/stamps', source !== mirror))] }) : original(method, path, body, signal));
    const executor = containerWorkerExecutor({ ...f.config, container: { ...f.config.container, mounts } }, { ...f.deps, name: () => 'agent' });
    const body = executor.start({ ...job, agent }, built, f.abort.signal); await body.spawned;
    const asked = (f.engine.json.mock.calls[0][2] as Spec).HostConfig.Mounts as { Source: string }[];
    expect(asked.map(mount => mount.Source)).toEqual([programDirectory, ...own]);
    for (const other of others) expect(JSON.stringify(f.engine.json.mock.calls)).not.toContain(other);
    await body.stop();
  }
});
it.each([
  ['has no body program', (path: string) => rmSync(join(path, 'dist', 'body.js'))],
  ['has no package.json', (path: string) => rmSync(join(path, 'package.json'))],
  ['has a package of its own hoisted out of it', (path: string) => rmSync(join(path, 'node_modules', 'zod'), { recursive: true })],
  ['has a scoped package hoisted out of it', (path: string) => rmSync(join(path, 'node_modules', '@scope'), { recursive: true })],
  ['has its packages linked in from a store', (path: string) => { rmSync(join(path, 'node_modules', 'zod'), { recursive: true }); symlinkSync(houseDirectory('store/zod'), join(path, 'node_modules', 'zod')); }],
  ['has its whole node_modules linked in', (path: string) => { rmSync(join(path, 'node_modules'), { recursive: true }); symlinkSync(houseDirectory('store/modules/zod/..'), join(path, 'node_modules')); }],
  ['has a package.json that is not one', (path: string) => writeFileSync(join(path, 'package.json'), '{"dependencies":["zod"]}')],
])('is not made when the directory it is installed in %s: the body program would not load in a container', (what, change) => {
  const f = fixture(), program = install(`broken/${what.replaceAll(' ', '-')}`, change);
  expect(() => containerWorkerExecutor(f.config, { ...f.deps, program })).toThrow(expect.objectContaining({ stage: 'program' }));
  expect(f.engine.json).not.toHaveBeenCalled(); expect(f.engine.images).not.toHaveBeenCalled(); expect(f.source.fetch).not.toHaveBeenCalled();
});
it('is not made on a machine that has no git, or whose own directory cannot be mounted', () => {
  const f = fixture();
  expect(() => containerWorkerExecutor(f.config, { engine: f.deps.engine, program: programDirectory, git: () => false })).toThrow(expect.objectContaining({ stage: 'git' }));
  expect(() => containerWorkerExecutor(f.config, { ...f.deps, program: join(houseRoot, 'not-installed') })).toThrow(expect.objectContaining({ stage: 'mounts', key: 'the directory the worker is installed in' }));
  expect(f.engine.json).not.toHaveBeenCalled(); expect(f.engine.images).not.toHaveBeenCalled();
});
const pruneLine = 'Worker could not look at its house images: old ones stay until it can\n';
it('looks after the disk once the job has its image, outside the build\'s limit, and says so when it cannot', async () => {
  vi.useFakeTimers();
  const f = fixture(), gone = await missingImage(), there = f.engine.images.getMockImplementation()!, said = vi.fn(); let made = false, listings = 0;
  // An engine whose listing never answers: the build is done, the upkeep hangs.
  f.engine.images.mockImplementation((method, path, body, signal) => {
    if (method === 'GET' && path.startsWith('/images/json')) { listings++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }
    if (method === 'GET' && !made) return Promise.reject(gone);
    return there(method, path, body, signal);
  });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); made = true; });
  const executor = containerWorkerExecutor({ ...f.config, buildTimeoutMs: 1_000 }, { ...f.deps, say: said, name: () => 'upkeep' });
  // The job has its image at once, and runs to its end, while the upkeep is still waiting.
  const control = controlFor(job), run = workOnce({ box: 'box', control, executor, signal: f.abort.signal, schedule: { every: () => () => {} } });
  for (let turn = 0; turn < 20 && !f.writes.length; turn++) { await vi.advanceTimersByTimeAsync(0); await flush(); }
  expect(listings).toBe(1); expect(f.writes).toHaveLength(1);
  // Long past the build's limit: no job failed for it.
  await vi.advanceTimersByTimeAsync(60_000);
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); await vi.advanceTimersByTimeAsync(0);
  expect(await run).toBe('finished'); expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 0, '', 'body'); expect(said).not.toHaveBeenCalled();
  // Another house is built meanwhile: one upkeep at a time, so none is started beside the one waiting.
  made = false; f.source.fetch.mockResolvedValue('d'.repeat(40));
  expect(await executor.build({ ...job, id: 'other' }, f.abort.signal)).toBe(houseImage(job.house, 'd'.repeat(40))); expect(listings).toBe(1);
  // The upkeep has a limit of its own, after which it is given up and said, once, in the worker's own words.
  await vi.advanceTimersByTimeAsync(300_000);
  expect(said).toHaveBeenCalledExactlyOnceWith(pruneLine);
  executor.close!(); expect(vi.getTimerCount()).toBe(0);
});
it('says nothing when the disk was looked after', async () => {
  const f = fixture(), said = vi.fn(); await unbuilt(f);
  const executor = containerWorkerExecutor(f.config, { ...f.deps, say: said });
  await executor.build(job, f.abort.signal); await flush();
  expect(f.engine.images.mock.calls.some(call => call[1].startsWith('/images/json'))).toBe(true); expect(said).not.toHaveBeenCalled();
});
it('never removes an image a job has been given until that job\'s body has ended, and then does', async () => {
  const f = fixture(); await unbuilt(f);
  const other = { ...job, house: { ...job.house, repository: 'https://example.com/other/house.git' } }, held = houseImage(other.house, commit);
  // One job has its image and is about to start; newer commits of its house are then built.
  expect(await f.executor.build(other, f.abort.signal)).toBe(held); await flush();
  const removed: string[] = [], there = f.engine.images.getMockImplementation()!, gone = await missingImage(); let absent = '';
  f.engine.images.mockImplementation(async (method, path, body, signal) => {
    if (method === 'GET' && path.startsWith('/images/json')) return [{ RepoTags: [held], Created: 1 }, ...[2, 3, 4].map(n => ({ RepoTags: [`${held.slice(0, -40)}${String(n).repeat(40)}`], Created: n + 1 }))];
    if (method === 'DELETE') { removed.push(path.slice('/images/'.length)); return undefined; }
    if (method === 'GET' && absent && path.includes(absent)) { absent = ''; throw gone; }
    return there(method, path, body, signal);
  });
  const next = async (letter: string) => { absent = letter.repeat(40); f.source.fetch.mockResolvedValue(absent); await f.executor.build({ ...other, id: `job-${letter}` }, f.abort.signal); await flush(); };
  await next('d');
  // Of that house the two newest stay, and the oldest too, because a job holds it.
  expect(removed).toEqual([`${held.slice(0, -40)}${'2'.repeat(40)}`]);
  // Its body runs and ends: the image is no longer anybody's, and the next upkeep takes it.
  const body = f.executor.start(other, held, f.abort.signal); await body.spawned; await body.stop();
  removed.length = 0; await next('e');
  expect(removed).toEqual([`${held.slice(0, -40)}${'2'.repeat(40)}`, held]);
});

// Several jobs side by side on one worker (worker-turns.ts, and `slots` in worker-program.ts).
it('does not hold another house\'s job behind a first build: the other job finds its image and runs to its end meanwhile', async () => {
  const f = fixture(), gone = await missingImage(), there = f.engine.images.getMockImplementation()!, turns = workerTurns(), release = deferred<void>(); let made = false;
  const slow = { ...job, id: 'slow', agent: 'mark', account: 'other-account', house: { repository: 'https://example.com/mark/house.git', file: 'Housefile', branch: 'main' } };
  const slowImage = houseImage(slow.house, commit);
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && path.includes(slowImage) && !made) throw gone; return there(method, path, body, signal); });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); await release.promise; made = true; });
  const building = controlFor(slow), ready = controlFor(job);
  const first = workOnce({ box: 'box', control: building, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  await flush(); expect(f.engine.build).toHaveBeenCalledOnce(); expect(building.started).not.toHaveBeenCalled();
  // A second slot takes a job of a house whose image is there.
  const second = workOnce({ box: 'box', control: ready, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  await flush(); expect(ready.started).toHaveBeenCalledExactlyOnceWith('job', built);
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  expect(await second).toBe('finished'); expect(ready.finish).toHaveBeenCalledExactlyOnceWith('job', 0, '', 'body');
  // The first is still building, and still its worker's.
  expect(building.finish).not.toHaveBeenCalled(); expect(f.engine.build).toHaveBeenCalledOnce();
  f.abort.abort(); release.resolve(); expect(await first).toBe('abandoned');
});
it('builds once for two jobs of one house, and a Stop on one of them ends that one alone', async () => {
  const f = fixture(), gone = await missingImage(), there = f.engine.images.getMockImplementation()!, turns = workerTurns(), release = deferred<void>(); let made = false;
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && !path.startsWith('/images/json') && !made) throw gone; return there(method, path, body, signal); });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); await release.promise; made = true; });
  const stopped = controlFor({ ...job, id: 'stopped' }), kept = controlFor({ ...job, id: 'kept', account: 'other-account' });
  let pulse = () => {};
  const first = workOnce({ box: 'box', control: stopped, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: (_ms, callback) => { pulse = callback; return () => {}; } } });
  const second = workOnce({ box: 'box', control: kept, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  await flush(); expect(f.engine.build).toHaveBeenCalledOnce(); expect(f.source.fetch).toHaveBeenCalledTimes(2);
  // A Stop on the first job, while both wait on the one build: loom answers its report with "not yours".
  stopped.heartbeat.mockResolvedValue(false); pulse();
  expect(await first).toBe('abandoned'); expect(stopped.finish).not.toHaveBeenCalled();
  // The build is the worker's, not that job's: it was not ended, and the other job gets its image.
  expect(f.engine.build.mock.calls[0][2].aborted).toBe(false); expect(f.abort.signal.aborted).toBe(false);
  release.resolve(); await flush();
  expect(kept.started).toHaveBeenCalledExactlyOnceWith('kept', built); expect(f.engine.build).toHaveBeenCalledOnce();
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  expect(await second).toBe('finished'); expect(kept.finish).toHaveBeenCalledExactlyOnceWith('kept', 0, '', 'body');
});
it('gives one account\'s sign-in directory to one body at a time: the second job\'s container is not made until the first body has ended', async () => {
  const f = house(), turns = workerTurns();
  const one = controlFor({ ...job, id: 'one' }), two = controlFor({ ...job, id: 'two' });
  const first = workOnce({ box: 'box', control: one, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  const second = workOnce({ box: 'box', control: two, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  await flush();
  // One container, with the sign-in directory in it; nothing has been asked of the engine for the other job.
  const created = () => f.engine.json.mock.calls.filter(call => call[1].startsWith('/containers/create'));
  expect(created()).toHaveLength(1); expect(JSON.stringify(created()[0][2])).toContain(loginA);
  expect(one.started).toHaveBeenCalledOnce(); expect(two.started).not.toHaveBeenCalled();
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); expect(await first).toBe('finished');
  // The first body is removed; the second job's container is made only now.
  await flush(); expect(created()).toHaveLength(2);
  // (This fixture has one body's pipes; what becomes of the second body is not what is looked at here.)
  f.abort.abort(); await second;
});
