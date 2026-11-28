import * as brokerModule from './kit-broker.js';
import {houseCliSource} from './worker-mounts.js';
import {defaultWorkerState} from './worker-left.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { plainContext } from './house-context.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { containerWorkerExecutor } from './worker-container.js';
import { BuildTimeError, workOnce, type WorkerAssignment } from './worker.js';
import { coreImage, houseCommit, houseImage } from './house-image.js';
import { coreDefinition, coreWeek, noHousefile, NO_HOUSEFILE } from './house-core.js';
import { turnsOf, workerTurns } from './worker-turns.js';
import { DAY_MS } from '../core/day.js';
import { holdAlone, type Alone } from './worker-alone.js';
import { houseRepository, houseSource } from './house-source.js';
import { HOUSE_ENV } from './house-layout.js';
import type { DockerEngine } from './docker-engine.js';
import { WorkerStop } from './worker-stop.js';

const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await new Promise<void>(resolve => process.nextTick(resolve)); for (let n = 0; n < 30; n++) await Promise.resolve(); };
const job: WorkerAssignment = { id: 'job', box: 'box', agent: 'art', conversation: 'cv', model: 'model', account: 'account', harness: 'harness', brief: 'private-input', house: { repository: 'https://example.com/org/house.git', file: 'house/Housefile', branch: 'next' } };
const id = 'a'.repeat(64);
/** The commit the job's branch is at, the image that makes, and what that image says about itself. */
/** The core house this worker builds houses on: its definition, the moment, and the image those two name. */
const coreDigest = 'e'.repeat(64), moment = Date.UTC(2026, 10, 17, 12), core = coreImage(coreDigest, coreWeek(moment));
const coreContext = () => { const tar = new PassThrough(); tar.end('core'); return tar; };
const commit = 'c'.repeat(40), built = houseImage(job.house, commit, core), imageId = `sha256:${'b'.repeat(64)}`;
const houseLabels = { 'loom.house': '2', 'loom.house.harnesses': 'harness unlisted claude', 'io.buildah.version': '1.39' };
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
    if (inspecting(path)) return { Mounts: [...programReport()] };
    if (path.includes('/wait?')) {
      signal.addEventListener('abort', () => wait.reject(new Error('aborted')), { once: true }); return wait.promise;
    }
    return undefined;
  });
  // What is asked about images, kept apart: the house's image is there and says how a body starts in it.
  const images = vi.fn(async (method: string, path: string, _body: unknown, _signal: AbortSignal): Promise<unknown> =>
    method === 'GET' && path.startsWith('/images/json') ? [] : method === 'GET' ? { Id: imageId, Config: { WorkingDir: '/an/image/of/its/own', Labels: houseLabels } } : undefined);
  const build = vi.fn(async (_path: string, context: NodeJS.ReadableStream, _signal: AbortSignal) => { context.resume(); });
  const attach = vi.fn(async (_id: string, _signal: AbortSignal): Promise<Duplex> => socket);
  const whole: DockerEngine = { attach, build, json: (method, path, body, signal) => path.startsWith('/images/') || path.startsWith('/build/') ? images(method, path, body, signal) : json(method, path, body, signal) };
  const source = { fetch: vi.fn(async (_house: WorkerAssignment['house'], _credential: Uint8Array | undefined, _signal: AbortSignal) => commit),
    context: vi.fn((_house: WorkerAssignment['house'], _commit: string, _signal: AbortSignal) => { const tar = new PassThrough(); tar.end('tar'); return tar; }) };
  const config = { box: 'box', container: { socket: engineSock, setupTimeoutMs: 100, cleanupTimeoutMs: 50 } };
  // Each test's worker has the engine to itself without asking the machine: the tests of that ask it themselves.
  const deps = { engine: whole, source, program: programDirectory, core: { digest: coreDigest, context: vi.fn(coreContext) }, now: () => moment, alone: vi.fn(async (_wanted: readonly Alone[]) => () => {}) };
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
  expect(f.engine.build).not.toHaveBeenCalled(); expect(f.source.context).not.toHaveBeenCalled();
  expect(f.engine.attach).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(f.engine.json.mock.calls.map(call => call[1])).toEqual(['/containers/create?name=loom-unique', `/containers/${id}/json`, `/containers/${id}/start`, `/containers/${id}/wait?condition=not-running`]);
  expect(control.started).toHaveBeenCalledWith('job', built, expect.any(AbortSignal)); expect(f.writes).toEqual([]);
  // The image by the id it was inspected under; tini as PID 1 passing signals to the body's process group,
  // its node, the worker's body program, the harness's body file, the image's working directory. No
  // environment but where scratch files go: the rest is the image's. The match is exact, so the body runs as
  // the image's user, in the engine's own private user namespace: no User, UsernsMode or capability is asked.
  expect(f.engine.json.mock.calls[0][2]).toEqual({ Image: imageId, Entrypoint: ['/usr/bin/tini', '-g', '--', '/usr/local/bin/node'], Cmd: ['/opt/loom/dist/body.js', '/etc/loom/body/harness.json'], WorkingDir: '/home/agent/repo',
    Env: ['LOOM_BODY_SCRATCH=/tmp', 'HOME=/home/agent', 'LOOM_HOUSE_REPOSITORY=https://example.com/org/house.git', 'LOOM_HOUSE_BRANCH=next', `LOOM_HOUSE_COMMIT=${commit}`, 'LOOM_BODY_OWN_HARNESS=0'], Tty: false, ExposedPorts: {},
    Labels: { 'loom.job': 'job', 'loom.agent': 'art', 'loom.box': 'box' }, AttachStdin: true, AttachStdout: true, AttachStderr: true, OpenStdin: true, StdinOnce: true,
    HostConfig: { AutoRemove: false, Privileged: false, Runtime: 'runc', PublishAllPorts: false, LogConfig: { Type: 'none', Config: {} }, PortBindings: {}, Mounts: [...programAsked()], DeviceRequests: [] } });
  ack.resolve(); await flush(); expect(JSON.parse(f.writes[0])).toEqual({ job, build: built, bootstrap: handed });
  const bytes = Buffer.concat([frame('hello €'), frame(' error', 2)]);
  for (const byte of bytes) f.socket.push(Buffer.from([byte]));
  f.socket.push(null); f.wait.resolve({ StatusCode: 17 }); await flush();
  expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
  expect(control.finish).not.toHaveBeenCalled(); removed.resolve(undefined);
  // The body was given a credential, so what it printed is not kept: it reports for itself.
  expect(await run).toBe('finished'); expect(control.finish).toHaveBeenCalledWith('job', 17, '', 'body');
});
it('applies only approved GPU, TCP listeners', async () => {
  const f = fixture();
  const body = f.start({ ...job, run: { gpu: true, nestedContainers: false, ports: [{ address: '127.0.0.1', port: 8080 }, { address: '::1', port: 8080 }] } });
  await body.spawned;
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ ExposedPorts: { '8080/tcp': {} }, HostConfig: {
    DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }],
    PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }, { HostIp: '::1', HostPort: '8080' }] },
    Mounts: [...programAsked()] } });
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
    expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Env: ['LOOM_BODY_SCRATCH=/tmp', 'HOME=/home/agent', 'LOOM_HOUSE_REPOSITORY=https://example.com/org/house.git', 'LOOM_HOUSE_BRANCH=next', `LOOM_HOUSE_COMMIT=${commit}`, 'LOOM_BODY_OWN_HARNESS=0'] }); await body.stop();
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
    expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Image: imageId, Entrypoint: ['/usr/bin/tini', '-g', '--', '/usr/local/bin/node'], Cmd: ['/opt/loom/dist/body.js', file] });
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
beforeAll(()=>vi.stubEnv('TMPDIR',houseRoot));
afterAll(()=>vi.unstubAllEnvs());
afterAll(() => rmSync(houseRoot, { recursive: true, force: true }));
const houseDirectory = (name: string) => { const path = join(houseRoot, name); mkdirSync(path, { recursive: true }); return path; };
/** A directory laid out as an install of the worker is: the body program, and every package it depends on in its own node_modules. */
function install(name: string, change: (path: string) => void = () => {}) {
  const path = houseDirectory(name);
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: '@example/loom', dependencies: { zod: '^4', '@scope/package': '^1' } }));
  mkdirSync(join(path, 'dist'), { recursive: true }); writeFileSync(join(path, 'dist', 'body.js'), ''); writeFileSync(join(path,'dist','index.js'),'');
  mkdirSync(join(path, 'node_modules', 'zod'), { recursive: true }); mkdirSync(join(path, 'node_modules', '@scope', 'package'), { recursive: true });
  mkdirSync(join(path,'assets/house-bin'),{recursive:true});
  writeFileSync(join(path,'assets/house-bin/loom'),'#!/bin/sh\n',{mode:0o755});
  change(path); return path;
}
const programDirectory = install('install/loom');
/** The worker's own directory, as every body's container must be reported to have it. */
function programReport(source=programDirectory,state=defaultWorkerState('box')) {
  return [reported(source,'/opt/loom',false),reported(houseCliSource(state),'/usr/local/bin/loom',false)];
}
const programAsked = (source=programDirectory) => [
  {Type:'bind',Source:source,Target:'/opt/loom',ReadOnly:true},
  {Type:'bind',Source:houseCliSource(defaultWorkerState('box')),Target:'/usr/local/bin/loom',ReadOnly:true},
];
const loginA = houseDirectory('logins/a'), loginB = houseDirectory('logins/b'), stamps = houseDirectory('stamps'), mirror = houseDirectory('mirror');
// The engine's own socket and its socket for nested containers must be real sockets (worker-mounts.ts).
// Nothing connects to either: every test here gives the executor a fake engine.
const nestedSock = join(houseDirectory('engine'), 'nested.sock'), engineSock = join(houseDirectory('engine'), 'engine.sock');
const sockets: Server[] = [];
beforeAll(async () => { for (const path of [nestedSock, engineSock]) await new Promise<void>(done => sockets.push(createServer().listen(path, done))); });
afterAll(() => { for (const server of sockets) server.close(); });
const accountLogins = { account: { harness: { source: loginA } }, other: { harness: { source: loginB } } };
const houseMounts = [{ source: stamps, target: 'house/stamps', readOnly: false }, { source: mirror, target: 'house/mirror' }];
/** What an engine reports of a bind mount it made. */
function reported(Source: string, Destination: string, RW: boolean) { return { Type: 'bind', Source, Destination, Mode: '', RW, Propagation: 'rprivate' }; }
const expectedReport = [reported(loginA, '/run/loom/login/harness', true), reported(stamps, '/home/agent/house/stamps', true), reported(mirror, '/home/agent/house/mirror', false)];
function house(inspected: unknown = expectedReport, container: Record<string, unknown> = { mounts: { art: houseMounts } }, logins: typeof accountLogins | null = accountLogins) {
  const f = fixture(), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => inspecting(path) ? Promise.resolve({ Mounts: Array.isArray(inspected) ? [...programReport(), ...inspected] : inspected }) : original(method, path, body, signal));
  const executor = containerWorkerExecutor({ ...f.config, ...(logins ? { accountLogins: logins } : {}), container: { ...f.config.container, ...container } }, { ...f.deps, name: () => 'house' });
  return { ...f, executor };
}
type Spec = { HostConfig: { Runtime: string; Mounts: unknown[] } };

it('tells a body the place its harness keeps sessions is its own unless a mount is, holds, or is inside that place', async () => {
  const claude = { ...job, harness: 'claude' };
  const env = async (f: ReturnType<typeof house>, assignment = claude) => { const body = f.executor.start(assignment, built, f.abort.signal); await body.spawned; const spec = f.engine.json.mock.calls.find(call => String(call[1]).startsWith('/containers/create'))![2] as { Env: string[] }; await body.stop();
    // Always said, one way or the other, and once: the worker's value holds over an image's `ENV LOOM_BODY_OWN_HARNESS=1`.
    const said = spec.Env.filter(entry => entry.startsWith('LOOM_BODY_OWN_HARNESS=')); expect(said).toHaveLength(1); expect(['LOOM_BODY_OWN_HARNESS=1', 'LOOM_BODY_OWN_HARNESS=0']).toContain(said[0]);
    return said[0] === 'LOOM_BODY_OWN_HARNESS=1'; };
  const logins = { account: { claude: { source: loginA } }, other: { claude: { source: loginB } } } as unknown as typeof accountLogins;
  const withMounts = (mounts: { source: string; target: string; readOnly?: boolean }[]) =>
    house([reported(loginA, '/run/loom/login/claude', true), ...mounts.map(mount => reported(mount.source, `/home/agent/${mount.target}`, mount.readOnly === false))], { mounts: { art: mounts } }, logins);
  // The usual house: the account's sign-in mounted writable at its own place, the agent's directories elsewhere
  // under the home. The harness's own directory is the container's, so the body may keep a session there.
  expect(await env(withMounts(houseMounts))).toBe(true);
  expect(await env(withMounts([]))).toBe(true);
  // An agent's mount at that place, inside it, or holding it (read-only too: it is still not the body's own).
  for (const target of ['.claude', '.claude/projects', '.claude/projects/-home-agent-repo']) {
    expect(await env(withMounts([{ source: stamps, target, readOnly: false }])), target).toBe(false);
    expect(await env(withMounts([{ source: mirror, target }])), target).toBe(false);
  }
  // A place beside it, with a name that only starts the same, is not it.
  expect(await env(withMounts([{ source: stamps, target: '.claude-notes', readOnly: false }]))).toBe(true);
  // A harness with no sessions place in the layout is told it is not, too.
  expect(await env(house(), job)).toBe(false);
});

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
  expect((f.engine.json.mock.calls[0][2] as Spec).HostConfig.Mounts).toEqual([...programAsked(),
    { Type: 'bind', Source: loginA, Target: '/run/loom/login/harness', ReadOnly: false },
    { Type: 'bind', Source: stamps, Target: '/home/agent/house/stamps', ReadOnly: false },
    { Type: 'bind', Source: mirror, Target: '/home/agent/house/mirror', ReadOnly: true }]);
  // Nothing sent to the engine for this job names the other account's directory.
  expect(JSON.stringify(f.engine.json.mock.calls)).not.toContain(loginB);
  expect(f.engine.attach).toHaveBeenCalledOnce(); await body.stop();
  const other = house([reported(loginB, '/run/loom/login/harness', true), ...expectedReport.slice(1)]);
  const second = other.executor.start({ ...job, account: 'other' }, built, other.abort.signal); await second.spawned;
  expect((other.engine.json.mock.calls[0][2] as Spec).HostConfig.Mounts).toContainEqual({ Type: 'bind', Source: loginB, Target: '/run/loom/login/harness', ReadOnly: false });
  expect(JSON.stringify(other.engine.json.mock.calls)).not.toContain(loginA); await second.stop();
});
it('gives every body the fixed mounts when no sign-in map is configured', async () => {
  const f = house(expectedReport.slice(1), { mounts: { art: houseMounts } }, null);
  const body = f.executor.start({ ...job, account: 'anyone' }, built, f.abort.signal); await body.spawned;
  expect((f.engine.json.mock.calls[0][2] as Spec).HostConfig.Mounts).toEqual([
    ...programAsked(),
    { Type: 'bind', Source: stamps, Target: '/home/agent/house/stamps', ReadOnly: false },
    { Type: 'bind', Source: mirror, Target: '/home/agent/house/mirror', ReadOnly: true }]);
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
  ['another account\'s directory at the sign-in target', [reported(loginB, '/run/loom/login/harness', true), ...expectedReport.slice(1)]],
  ['its sign-in directory at another place', [reported(loginA, '/elsewhere', true), ...expectedReport.slice(1)]],
  ['a read-only mount made writable', [...expectedReport.slice(0, 2), reported(mirror, '/home/agent/house/mirror', true)]],
  ['a writable mount made read-only', [reported(loginA, '/run/loom/login/harness', false), ...expectedReport.slice(1)]],
  ['a mount that does not say whether it is writable', [...expectedReport.slice(0, 2), { Type: 'bind', Source: mirror, Destination: '/home/agent/house/mirror' }]],
  ['a volume where a bind mount was asked for', [...expectedReport.slice(0, 2), { ...reported(mirror, '/home/agent/house/mirror', false), Type: 'volume' }]],
  ['one mount reported twice in place of another', [expectedReport[0], expectedReport[1], expectedReport[1]]],
  ['something that is not a mount', [...expectedReport.slice(0, 2), null]],
  ['no list of mounts', null],
])('removes the container without starting it when the engine reports %s', async (_what, inspected) => {
  const f = house(inspected), body = f.executor.start(job, built, f.abort.signal);
  await expect(body.spawned).rejects.toThrow('Unexpected container storage'); await body.stop();
  expect(f.engine.attach).not.toHaveBeenCalled(); expect(f.engine.json.mock.calls.some(call => call[1].endsWith('/start'))).toBe(false);
  expect(f.engine.json).toHaveBeenLastCalledWith('DELETE', `/containers/${id}?force=1&v=1`, undefined, expect.any(AbortSignal));
});
it.each(['/var/run/docker.sock', '/run/docker.sock'])('removes a container when the engine adds an unrequested socket at %s', async target => {
  const f = house([...expectedReport, reported(nestedSock, target, true)]);
  const body = f.executor.start(job, built, f.abort.signal);
  await expect(body.spawned).rejects.toThrow('Unexpected container storage'); await body.stop();
  expect(f.engine.attach).not.toHaveBeenCalled();
});
it('still runs the build of a nested job on a machine with no nested socket, and fails it when its body is started', async () => {
  const f = fixture(), nested = { ...job, run: { gpu: false, nestedContainers: true, ports: [] } };
  expect(await f.executor.build(nested, f.abort.signal)).toBe(built);
  expect(() => f.start(nested)).toThrow('Nested containers unavailable'); expect(f.engine.json).not.toHaveBeenCalled();
});
it('does not make a worker whose engine socket is not a socket, or that a mount would carry into a body', () => {
  const f = fixture();
  for (const container of [{ socket: '/loom-test/no.sock' }, { socket: 'relative.sock' }, { socket: join(houseRoot, 'engine') },
    { mounts: { art: [{ source: join(houseRoot, 'engine'), target: 'house/run' }] } }, { mounts: { art: [{ source: houseRoot, target: 'house/all' }] } }])
    expect(() => containerWorkerExecutor({ ...f.config, container: { ...f.config.container, ...container } }, { ...f.deps })).toThrow(expect.objectContaining({ stage: 'mounts' }));
  // Nor one whose mounts reach its own records or its token, or name one directory twice.
  for (const patch of [{ state: join(stamps, 'state') }, { tokenFile: join(mirror, 'token') }, { container: { ...f.config.container, mounts: { art: [...houseMounts, { source: stamps, target: '/again' }] } } }])
    expect(() => containerWorkerExecutor({ ...f.config, container: { ...f.config.container, mounts: { art: houseMounts } }, ...patch }, { ...f.deps })).toThrow(expect.objectContaining({ stage: 'mounts' }));
  expect(f.engine.json).not.toHaveBeenCalled();
});
it('does not make a worker whose nested socket is not a socket, or is a way into a mounted directory', () => {
  const f = fixture();
  for (const container of [{ nestedSocket: '/loom-test/no.sock' }, { nestedSocket: join(houseRoot, 'logins') }, { nestedSocket: loginA },
    { nestedSocket: nestedSock, mounts: { art: [{ source: join(houseRoot, 'engine'), target: 'house/engine' }] } }])
    expect(() => containerWorkerExecutor({ ...f.config, accountLogins, container: { ...f.config.container, ...container } }, { ...f.deps })).toThrow(expect.objectContaining({ stage: 'mounts' }));
  expect(f.engine.json).not.toHaveBeenCalled();
});
it('accepts the mounts it asked for in whatever order the engine lists them', async () => {
  const f = house([...expectedReport].reverse()), body = f.executor.start(job, built, f.abort.signal);
  await body.spawned; expect(f.engine.attach).toHaveBeenCalledOnce(); await body.stop();
});
it('puts no mount path in what the worker itself says: a failed start\'s report, a finished job\'s report, the envelope, the labels, the environment', async () => {
  const paths = [houseRoot, '/run/loom/login', 'house/stamps', 'house/mirror', '/opt/loom'];
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
  for (const patch of [{ accountLogins: { account: { harness: { source: join(houseRoot, 'missing') } } } },
    { container: { ...f.config.container, mounts: { art: [{ source: 'relative', target: 'house/x' }] } } },
    { accountLogins, container: { ...f.config.container, mounts: { art: [{ source: mirror, target: '/run/loom/login/harness' }] } } }])
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
/** The house's image is not on the engine until it is built. The core house is there, as on a machine that has built a house before. */
async function unbuilt(f: ReturnType<typeof fixture>) {
  const gone = await missingImage(), there = f.engine.images.getMockImplementation()!; let made = false;
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && !path.startsWith('/images/json') && !path.startsWith(`/images/${core}/`) && !made) throw gone; return there(method, path, body, signal); });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); made = true; });
  return { built: () => { made = true; } };
}
const controlFor = (assignment: WorkerAssignment) => ({ next: vi.fn(async () => assignment), started: vi.fn(async () => {}), heartbeat: vi.fn(async () => true), finish: vi.fn(async () => {}), enrollBody: vi.fn(async () => ({ ...bootstrap(), job: assignment.id })) });
const once = (f: ReturnType<typeof fixture>, control: ReturnType<typeof controlFor>, schedule = { every: (_ms: number, _callback: () => void) => () => {} }) =>
  workOnce({ box: 'box', control, executor: f.executor, signal: f.abort.signal, schedule });

it('builds a house that is not on the engine from the commit\'s own files and its Housefile, then removes what is no longer needed', async () => {
  const f = fixture(); await unbuilt(f);
  expect(await f.executor.build(job, f.abort.signal)).toBe(built); await flush();
  expect(f.source.context).toHaveBeenCalledExactlyOnceWith(job.house, commit, expect.any(AbortSignal), undefined);
  expect(f.engine.build).toHaveBeenCalledOnce();
  const [path, context] = f.engine.build.mock.calls[0];
  expect(Object.fromEntries(new URL(path, 'http://engine').searchParams)).toEqual({ t: built, dockerfile: 'house/Housefile', buildargs: JSON.stringify({ LOOM_CORE: core }), q: '1', rm: '1', forcerm: '1' });
  expect(context).toBe(f.source.context.mock.results[0].value);
  // Asked whether it is there, and whether the core house is; built, asked again; then the old ones and the leftovers are seen to.
  expect(f.engine.images.mock.calls.map(call => `${call[0]} ${decodeURIComponent(call[1])}`)).toEqual([`GET /images/${built}/json`, `GET /images/${core}/json`, `GET /images/${built}/json`,
    'GET /images/json?filters={"reference":["localhost/loom-house-*"]}', 'GET /images/json?filters={"reference":["localhost/loom-core"]}', 'POST /images/prune?filters={"dangling":["true"],"until":["24h"]}', 'POST /build/prune?filters={"until":["168h"]}']);
  // The next job of the same house at the same commit finds it.
  expect(await f.executor.build({ ...job, id: 'second' }, f.abort.signal)).toBe(built); expect(f.engine.build).toHaveBeenCalledOnce();
});
it('builds one image once for two jobs that want it at the same moment', async () => {
  const f = fixture(), gone = await missingImage(), release = deferred<void>(); let made = false;
  const there = f.engine.images.getMockImplementation()!;
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && !path.startsWith('/images/json') && !path.startsWith(`/images/${core}/`) && !made) throw gone; return there(method, path, body, signal); });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); await release.promise; made = true; });
  const first = f.executor.build(job, f.abort.signal), second = f.executor.build({ ...job, id: 'second', agent: 'mark' }, f.abort.signal);
  await flush(); expect(f.engine.build).toHaveBeenCalledOnce();
  release.resolve(); expect(await Promise.all([first, second])).toEqual([built, built]); expect(f.engine.build).toHaveBeenCalledOnce();
});
it('names the image by the house, its commit and the core house alone, so a new loom with the same core rebuilds nothing', async () => {
  const f = fixture(), newer = install('install/loom-next');
  const deployed = containerWorkerExecutor(f.config, { ...f.deps, program: newer, name: () => 'next' }), original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, body, signal) => inspecting(path) ? Promise.resolve({ Mounts: programReport(newer) }) : original(method, path, body, signal));
  expect(await f.executor.build(job, f.abort.signal)).toBe(built); expect(await deployed.build(job, f.abort.signal)).toBe(built);
  expect(f.engine.build).not.toHaveBeenCalled();
  // The new program reaches the body as a mount of the same image.
  const body = deployed.start(job, built, f.abort.signal); await body.spawned;
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Image: imageId, HostConfig: { Mounts: programAsked(newer) } });
  await body.stop();
});
it('gives the repository\'s secret to the fetch and to nothing the engine is told', async () => {
  const f = fixture(); await unbuilt(f);
  const secret = new TextEncoder().encode('repository-secret-value');
  const control = { ...controlFor(job), repositoryInput: vi.fn(async () => secret) };
  const run = once(f, control); await flush();
  expect(f.source.fetch).toHaveBeenCalledExactlyOnceWith(job.house, secret, expect.any(AbortSignal));
  expect(JSON.stringify([f.engine.json.mock.calls, f.engine.images.mock.calls, f.engine.build.mock.calls.map(call => call[0]), f.source.context.mock.calls])).not.toMatch(/repository-secret-value|cmVwb3NpdG9yeS1zZWNyZXQ/);
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
  f.engine.images.mockImplementation(async () => ({ Id: imageId, Config: { WorkingDir: '/an/image/of/its/own', Labels: houseLabels } }));
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
  f.engine.images.mockImplementation(async () => ({ Id: imageId, Config: { WorkingDir: '/an/image/of/its/own', Labels: houseLabels } }));
  f.source.fetch.mockResolvedValue(commit);
  expect(await f.executor.build({ ...job, id: 'again' }, f.abort.signal)).toBe(built);
});
it.each([
  ['says nothing about how a body starts', 'loom.house', { 'io.buildah.version': '1.39' }, {}], ['does not serve the job\'s harness', 'loom.house.harnesses', { ...houseLabels, 'loom.house.harnesses': 'unlisted' }, {}],
  ['is of the earlier contract', 'loom.house', { 'loom.house': '1', 'loom.house.node': '/usr/local/bin/node', 'loom.house.body.harness': '/etc/loom/body/harness.json' }, {}],
  ['does not say which harnesses it serves', 'loom.house.harnesses', { 'loom.house': '2' }, {}], ['declares a volume', 'VOLUME', houseLabels, { Volumes: { '/data': {} } }],
])('fails only that job, with the house\'s own exit code and the rule it breaks, when its image %s', async (_what, rule, labels, config) => {
  const f = fixture();
  f.engine.images.mockImplementation(async () => ({ Id: imageId, Config: { Labels: labels, ...config } }));
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
  const markState = houseDirectory('mark/state'), mounts = { art: houseMounts, mark: [{ source: markState, target: 'house/stamps', readOnly: false }] };
  for (const [agent, own, others] of [['art', [stamps, mirror], [markState]], ['mark', [markState], [stamps, mirror]], ['someone-new', [], [stamps, mirror, markState]]] as const) {
    const f = fixture(), original = f.engine.json.getMockImplementation()!;
    f.engine.json.mockImplementation((method, path, body, signal) => inspecting(path)
      ? Promise.resolve({ Mounts: [...programReport(), ...own.map(source => reported(source, source === mirror ? '/home/agent/house/mirror' : '/home/agent/house/stamps', source !== mirror))] }) : original(method, path, body, signal));
    const executor = containerWorkerExecutor({ ...f.config, container: { ...f.config.container, mounts } }, { ...f.deps, name: () => 'agent' });
    const body = executor.start({ ...job, agent }, built, f.abort.signal); await body.spawned;
    const asked = (f.engine.json.mock.calls[0][2] as Spec).HostConfig.Mounts as { Source: string }[];
    expect(asked.map(mount => mount.Source)).toEqual([programDirectory,houseCliSource(defaultWorkerState('box')), ...own]);
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
  ['has no CLI entry point', (path:string)=>rmSync(join(path,'dist/index.js'))],
  ['has an unreadable CLI entry point', (path:string)=>chmodSync(join(path,'dist/index.js'),0o600)],
  ['has an unreadable CLI script', (path:string)=>chmodSync(join(path,'assets/house-bin/loom'),0o111)],
  ['has an untraversable launcher directory', (path:string)=>chmodSync(join(path,'assets/house-bin'),0o700)],
  ['has no packaged house CLI', (path:string)=>rmSync(join(path,'assets/house-bin/loom'))],
  ['has a non-executable house CLI', (path:string)=>chmodSync(join(path,'assets/house-bin/loom'),0o644)],
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
  expect(await executor.build({ ...job, id: 'other' }, f.abort.signal)).toBe(houseImage(job.house, 'd'.repeat(40), core)); expect(listings).toBe(1);
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
it('does not hold another house\'s job behind a first build: the other job finds its image and runs to its end meanwhile', async () => {
  const f = fixture(), gone = await missingImage(), there = f.engine.images.getMockImplementation()!, turns = workerTurns({ accounts: 1 }), release = deferred<void>(); let made = false;
  const slow = { ...job, id: 'slow', agent: 'mark', account: 'other-account', house: { repository: 'https://example.com/mark/house.git', file: 'Housefile', branch: 'main' } };
  const slowImage = houseImage(slow.house, commit, core);
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && path.includes(slowImage) && !made) throw gone; return there(method, path, body, signal); });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); await release.promise; made = true; });
  const building = controlFor(slow), ready = controlFor(job);
  const first = workOnce({ box: 'box', control: building, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  await flush(); expect(f.engine.build).toHaveBeenCalledOnce(); expect(building.started).not.toHaveBeenCalled();
  // A second slot takes a job of a house whose image is there.
  const second = workOnce({ box: 'box', control: ready, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  await flush(); expect(ready.started).toHaveBeenCalledExactlyOnceWith('job', built, expect.any(AbortSignal));
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  expect(await second).toBe('finished'); expect(ready.finish).toHaveBeenCalledExactlyOnceWith('job', 0, '', 'body');
  // The first is still building, and still its worker's.
  expect(building.finish).not.toHaveBeenCalled(); expect(f.engine.build).toHaveBeenCalledOnce();
  f.abort.abort(); release.resolve(); expect(await first).toBe('abandoned');
});
it('builds once for two jobs of one house, and a Stop on one of them ends that one alone', async () => {
  const f = fixture(), gone = await missingImage(), there = f.engine.images.getMockImplementation()!, turns = workerTurns({ accounts: 1 }), release = deferred<void>(); let made = false;
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && !path.startsWith('/images/json') && !path.startsWith(`/images/${core}/`) && !made) throw gone; return there(method, path, body, signal); });
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
  expect(kept.started).toHaveBeenCalledExactlyOnceWith('kept', built, expect.any(AbortSignal)); expect(f.engine.build).toHaveBeenCalledOnce();
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  expect(await second).toBe('finished'); expect(kept.finish).toHaveBeenCalledExactlyOnceWith('kept', 0, '', 'body');
});
it('with one body at a time on an account, gives its sign-in directory to one container: the second job\'s is not made until the first body has ended', async () => {
  const f = house(), turns = workerTurns({ accounts: 1 });
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
it('with room for several bodies on an account, runs two jobs on it together, each container with the account\'s one sign-in directory', async () => {
  const f = house(), turns = workerTurns({ accounts: 4 });
  const one = controlFor({ ...job, id: 'one' }), two = controlFor({ ...job, id: 'two' });
  const first = workOnce({ box: 'box', control: one, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  const second = workOnce({ box: 'box', control: two, executor: f.executor, signal: f.abort.signal, turns, schedule: { every: () => () => {} } });
  await flush();
  const created = f.engine.json.mock.calls.filter(call => call[1].startsWith('/containers/create'));
  expect(created).toHaveLength(2); for (const call of created) expect(JSON.stringify(call[2])).toContain(loginA);
  expect(one.started).toHaveBeenCalledOnce(); expect(two.started).toHaveBeenCalledOnce();
  f.abort.abort(); await Promise.all([first, second]);
});

// Holds and upkeep: what a job wants is not removed under it, and every way out of a job lets go.
/** An engine with these house images on it, oldest first, that says which were removed and can hold a removal or a listing back. */
function stocked(f: ReturnType<typeof fixture>, images: string[]) {
  // The core house is there with them, as on a machine that has built a house before.
  const present = new Set([core, ...images]), removed: string[] = [], there = f.engine.images.getMockImplementation()!;
  const gate = { listing: undefined as Promise<void> | undefined, removal: undefined as Promise<void> | undefined, leftovers: 0 };
  f.engine.images.mockImplementation(async (method, path, body, signal) => {
    if (method === 'GET' && path.startsWith('/images/json')) {
      // Two listings: the house images, which a test may hold up, and the core houses.
      const cores = decodeURIComponent(path).includes('"localhost/loom-core"'); if (!cores) await gate.listing;
      return [...present].filter(name => name.startsWith('localhost/loom-core:') === cores).map((name, index) => ({ RepoTags: [name], Created: index + 1 }));
    }
    if (method === 'DELETE') { await gate.removal; const name = path.slice('/images/'.length); present.delete(name); removed.push(name); return undefined; }
    if (method === 'POST') { gate.leftovers++; return undefined; }
    const name = decodeURIComponent(path.slice('/images/'.length, -'/json'.length));
    if (!present.has(name)) throw await missingImage();
    return there(method, path, body, signal);
  });
  f.engine.build.mockImplementation(async (path, context) => { context.resume(); present.add(new URL(path, 'http://engine').searchParams.get('t')!); });
  return { present, removed, gate };
}
const at = (letter: string, house = job.house) => houseImage(house, letter.repeat(40), core);
/** Build a commit of the job's house that is not there yet, which starts an upkeep. */
const buildNew = async (f: ReturnType<typeof fixture>, letter: string, id = `job-${letter}`) => {
  f.source.fetch.mockResolvedValueOnce(letter.repeat(40));
  // Built for a job that is then over without a body: nobody holds the image afterwards.
  const image = await f.executor.build({ ...job, id }, f.abort.signal); f.executor.discard!({ ...job, id }, image); return image;
};

it('does not remove an image a job holds, however far beyond the counts it falls, and removes it once the job is over', async () => {
  const f = fixture(), engine = stocked(f, [at('1'), at('2'), at('3')]), listed = deferred<void>();
  // A job is given the oldest image there is, and has not started its body yet.
  f.source.fetch.mockResolvedValueOnce('1'.repeat(40));
  expect(await f.executor.build({ ...job, id: 'holder' }, f.abort.signal)).toBe(at('1'));
  // A newer commit is built. Its upkeep waits for the engine's listing; the two this worker has used stay, the rest go.
  engine.gate.listing = listed.promise; await buildNew(f, '4'); await flush(); expect(engine.removed).toEqual([]);
  listed.resolve(); engine.gate.listing = undefined; await flush();
  expect(engine.removed).toEqual([at('3'), at('2')]);
  // Two more are built. The held image is now the fourth newest of its house: it stays all the same, and counts for nothing else's place.
  await buildNew(f, '5'); await flush(); await buildNew(f, '6'); await flush();
  expect(engine.removed).toEqual([at('3'), at('2'), at('4')]); expect(engine.present.has(at('1'))).toBe(true);
  // The job's body starts from it, and ends. The next upkeep takes it: two of the house, and no more.
  const body = f.executor.start({ ...job, id: 'holder' }, at('1'), f.abort.signal); await body.spawned; await body.stop();
  await buildNew(f, '7'); await flush();
  expect([...engine.present].filter(name => name !== core).sort()).toEqual([at('6'), at('7')]);
});
it('waits for a removal that is under way before asking whether that image is there, and then builds it again', async () => {
  const f = fixture(), engine = stocked(f, [at('1'), at('2'), at('3')]), removal = deferred<void>();
  engine.gate.removal = removal.promise;
  await buildNew(f, '4'); await flush();
  // The first of the old ones to go is being removed this moment. A job wants exactly that one.
  f.source.fetch.mockResolvedValueOnce('2'.repeat(40));
  let got: string | undefined; const wanted = f.executor.build({ ...job, id: 'back' }, f.abort.signal).then(image => { got = image; });
  await flush(); expect(got).toBeUndefined(); expect(f.engine.build).toHaveBeenCalledOnce();
  // The removal is answered: the image is gone, the job finds it gone and it is built again. It is not found there and lost a moment later.
  removal.resolve(); await wanted;
  expect(got).toBe(at('2')); expect(f.engine.build).toHaveBeenCalledTimes(2); expect(engine.present.has(at('2'))).toBe(true);
});
it.each([
  'stopped while it waits its turn', 'cancelled once it has built', 'refused at once when its body is started', 'refused by its image when its body is started', 'run to its end',
] as const)('lets go of a job\'s image when the job is %s, so that it can be removed when it is old', async how => {
  const f = fixture(), engine = stocked(f, [at('1'), at('2'), at('3')]), turns = workerTurns({ accounts: 1 });
  // The branch is at its oldest commit, whose image is there: the job is given it.
  const old = { ...job, id: 'old', ...(how === 'refused at once when its body is started' ? { run: { gpu: false, nestedContainers: true, ports: [] } } : {}),
    ...(how === 'refused by its image when its body is started' ? { harness: 'no-such-harness' } : {}) };
  const control = controlFor(old); let pulse = () => {};
  // Another body has the account, so the job waits once it has built.
  const waits = how === 'stopped while it waits its turn' || how === 'cancelled once it has built';
  const holder = waits ? await turns.take(turnsOf(job), f.abort.signal) : undefined;
  const cancel = new AbortController();
  f.source.fetch.mockResolvedValueOnce('1'.repeat(40));
  const run = workOnce({ box: 'box', control, executor: f.executor, signal: AbortSignal.any([f.abort.signal, cancel.signal]), turns,
    schedule: { every: (_ms, callback) => { pulse = callback; return () => {}; } } });
  await flush();
  if (waits) { expect(f.source.fetch).toHaveBeenCalledOnce(); expect(control.started).not.toHaveBeenCalled(); expect(f.engine.json).not.toHaveBeenCalled(); }
  if (how === 'cancelled once it has built') cancel.abort();
  if (how === 'stopped while it waits its turn') { control.heartbeat.mockResolvedValue(false); pulse(); }
  if (how === 'run to its end') { f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); }
  const result = await run; holder?.();
  expect(result).toBe(waits ? 'abandoned' : 'finished');
  // While the job had it, an upkeep would have kept it. Now two newer commits are built: it is the third newest
  // this worker has used, nobody holds it, and the upkeep takes it.
  await buildNew(f, '4'); await flush(); await buildNew(f, '5'); await flush();
  expect([...engine.present].filter(name => name !== core).sort()).toEqual([at('4'), at('5')]); expect(engine.removed).toContain(at('1'));
});
it('asks the engine to forget what builds left behind only when no other build is running', async () => {
  const f = fixture(), engine = stocked(f, []), slow = deferred<void>();
  const other = { ...job, id: 'other', house: { ...job.house, repository: 'https://example.com/other/house.git' } };
  const quick = f.engine.build.getMockImplementation()!;
  f.engine.build.mockImplementation(async (path, context, signal) => { if (path.includes(encodeURIComponent(houseImage(other.house, commit, core)))) await slow.promise; return quick(path, context, signal); });
  // Two houses are built at once. The first to finish looks after the disk while the other is still building:
  // it removes old house images, and leaves alone what has no name, which may be the other build's own layers.
  const building = f.executor.build(other, f.abort.signal); await flush();
  await f.executor.build(job, f.abort.signal); await flush();
  expect(f.engine.images.mock.calls.some(call => call[1].startsWith('/images/json'))).toBe(true); expect(engine.gate.leftovers).toBe(0);
  // The other finishes with nothing else building: now the leftovers are asked gone, unnamed images and build cache.
  slow.resolve(); await building; await flush();
  expect(engine.gate.leftovers).toBe(2);
  expect(f.engine.images.mock.calls.filter(call => call[0] === 'POST').map(call => call[1].split('?')[0])).toEqual(['/images/prune', '/build/prune']);
});
it('keeps the image it has just built because it is the newest it knows, and keeps two of a house in all when nobody holds any', async () => {
  const f = fixture(), gone = await missingImage(), there = f.engine.images.getMockImplementation()!, removed: string[] = [];
  // A branch moved back, and the engine built from its cache: by the engine's own clock the new image is the oldest there is.
  const building = at('1'), others = [at('7'), at('8'), at('9')]; let made = false;
  const listing = deferred<void>();
  f.engine.images.mockImplementation(async (method, path, body, signal) => {
    if (method === 'GET' && path.startsWith('/images/json')) { await listing.promise; return [{ RepoTags: [building], Created: 1 }, ...others.map((name, index) => ({ RepoTags: [name], Created: 10 + index }))]; }
    if (method === 'DELETE') { removed.push(path.slice('/images/'.length)); return undefined; }
    if (method === 'GET' && path.includes(building) && !made) throw gone;
    return there(method, path, body, signal);
  });
  f.engine.build.mockImplementation(async (_path, context) => { context.resume(); made = true; });
  // Its one job is cancelled while the build runs: nobody holds the image when the upkeep that follows the build looks.
  const cancel = new AbortController(); f.source.fetch.mockResolvedValueOnce('1'.repeat(40));
  const wanted = f.executor.build({ ...job, id: 'gone' }, cancel.signal).catch(error => error as Error);
  cancel.abort(); expect(await wanted).toBeInstanceOf(Error); await flush();
  listing.resolve(); await flush();
  // Two of the house stay and no more: the one just built, which this worker knows to be the newest, and the
  // newest of those it never touched. Nothing is kept for having been built a moment ago.
  expect(removed).toEqual([at('8'), at('7')]);
});
it('does not remove an image whose build is still being finished, though no job holds it and two newer ones have been used since', async () => {
  const f = fixture(), gone = await missingImage(), there = f.engine.images.getMockImplementation()!, removed: string[] = [];
  // The first build has made its image on the engine and has not yet been told so.
  const finishing = at('1'), checked = deferred<void>(), made: string[] = [];
  f.engine.images.mockImplementation(async (method, path, body, signal) => {
    if (method === 'GET' && path.startsWith('/images/json')) return made.map((name, index) => ({ RepoTags: [name], Created: index + 1 }));
    if (method === 'DELETE') { const name = path.slice('/images/'.length); removed.push(name); made.splice(made.indexOf(name), 1); return undefined; }
    const name = decodeURIComponent(path.slice('/images/'.length, -'/json'.length));
    if (!made.includes(name)) throw gone;
    // The engine has the first image; the answer that says so is still on its way.
    if (name === finishing) await checked.promise;
    return there(method, path, body, signal);
  });
  f.engine.build.mockImplementation(async (path, context) => { context.resume(); made.push(new URL(path, 'http://engine').searchParams.get('t')!); });
  const cancel = new AbortController(); f.source.fetch.mockResolvedValueOnce('1'.repeat(40));
  const first = f.executor.build({ ...job, id: 'first' }, cancel.signal).catch(error => error as Error);
  await flush(); cancel.abort(); expect(await first).toBeInstanceOf(Error);
  // Two newer commits are built and looked after. The first image is now the third this worker has used, and nobody holds it.
  for (const letter of ['8', '9']) { await buildNew(f, letter); await flush(); }
  expect(removed).toEqual([]); expect(made).toContain(finishing);
  // Its build is told, and is over. It is an image like any other from then on: the next upkeep takes it.
  checked.resolve(); await flush();
  await buildNew(f, '7'); await flush();
  expect(removed).toEqual([at('8'), finishing]);
});
it('fails only that job, as a failed build, when the house\'s files cannot be written into a context', async () => {
  const f = fixture(), gone = await missingImage();
  const there = f.engine.images.getMockImplementation()!;
  f.engine.images.mockImplementation(async (method, path, body, signal) => { if (method === 'GET' && !path.startsWith(`/images/${core}/`)) throw gone; return there(method, path, body, signal); });
  // The engine reads what it is given; a context that fails part of the way fails the build.
  f.engine.build.mockImplementation((_path, context) => new Promise<void>((_resolve, reject) => { context.once('error', () => reject(new Error('Docker build failed'))); context.resume(); }));
  f.source.context.mockImplementation(() => { const tar = new PassThrough(); queueMicrotask(() => tar.destroy(new Error('House has a file that is too large: private-name'))); return tar; });
  const control = controlFor(job);
  expect(await once(f, control)).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 22, 'Worker could not start the body: build failed', 'worker');
});
it('is not made when its body program is a link to one outside the directory it mounts', () => {
  const f = fixture(), elsewhere = houseDirectory('elsewhere/dist'); writeFileSync(join(elsewhere, 'body.js'), '');
  const linkedFile = install('broken/linked-body', path => { rmSync(join(path, 'dist', 'body.js')); symlinkSync(join(elsewhere, 'body.js'), join(path, 'dist', 'body.js')); });
  const linkedDirectory = install('broken/linked-dist', path => { rmSync(join(path, 'dist'), { recursive: true }); symlinkSync(elsewhere, join(path, 'dist')); });
  for (const program of [linkedFile, linkedDirectory]) expect(() => containerWorkerExecutor(f.config, { ...f.deps, program })).toThrow(expect.objectContaining({ stage: 'program' }));
});

// The core house: what every house is built on, built by the worker itself.
/** An engine that has only what was built on it, and says of each image that it is a house. */
function bare(f: ReturnType<typeof fixture>) {
  const present = new Set<string>(), there = f.engine.images.getMockImplementation()!, order: string[] = [];
  f.engine.images.mockImplementation(async (method, path, body, signal) => {
    if (method === 'GET' && path.startsWith('/images/json')) { const cores = decodeURIComponent(path).includes('"localhost/loom-core"'); return [...present].filter(name => name.startsWith('localhost/loom-core:') === cores).map((name, index) => ({ RepoTags: [name], Created: index })); }
    if (method === 'DELETE') { present.delete(path.slice('/images/'.length)); return undefined; }
    if (method === 'GET' && !present.has(decodeURIComponent(path.slice('/images/'.length, -'/json'.length)))) throw await missingImage();
    return there(method, path, body, signal);
  });
  f.engine.build.mockImplementation(async (path, context) => { context.resume(); const name = new URL(path, 'http://engine').searchParams.get('t')!; order.push(name); present.add(name); });
  return { present, order };
}
it('builds the core house first on a machine that has never built one, from its own definition and with no argument, and builds it once', async () => {
  const f = fixture(), engine = bare(f);
  expect(await f.executor.build(job, f.abort.signal)).toBe(built); await flush();
  expect(engine.order).toEqual([core, built]);
  const [corePath, coreGiven] = f.engine.build.mock.calls[0], [housePath] = f.engine.build.mock.calls[1];
  // The core: the worker's own files, no argument, nothing of the job or its repository.
  expect(Object.fromEntries(new URL(corePath, 'http://engine').searchParams)).toEqual({ t: core, dockerfile: 'Housefile', q: '1', rm: '1', forcerm: '1' });
  expect(coreGiven).toBe(f.deps.core.context.mock.results[0].value);
  // The house: the core's name as its one build argument.
  expect(JSON.parse(new URL(housePath, 'http://engine').searchParams.get('buildargs')!)).toEqual({ LOOM_CORE: core });
  // Another agent's house is built on the same core, which is not built again.
  const other = { ...job, id: 'other', agent: 'mark', house: { repository: 'https://example.com/mark/house.git', file: 'Housefile', branch: 'main' } };
  expect(await f.executor.build(other, f.abort.signal)).toBe(houseImage(other.house, commit, core));
  expect(engine.order).toEqual([core, built, houseImage(other.house, commit, core)]); expect(f.deps.core.context).toHaveBeenCalledOnce();
});
it('builds the core house once for two houses that want it at the same moment', async () => {
  const f = fixture(), engine = bare(f), release = deferred<void>(), quick = f.engine.build.getMockImplementation()!;
  f.engine.build.mockImplementation(async (path, context, signal) => { if (path.includes(encodeURIComponent(core))) await release.promise; return quick(path, context, signal); });
  const other = { ...job, id: 'other', agent: 'mark', house: { repository: 'https://example.com/mark/house.git', file: 'Housefile', branch: 'main' } };
  const first = f.executor.build(job, f.abort.signal), second = f.executor.build(other, f.abort.signal);
  await flush(); expect(f.engine.build).toHaveBeenCalledOnce();
  release.resolve(); await Promise.all([first, second]);
  expect(engine.order.filter(name => name === core)).toEqual([core]); expect(engine.order).toHaveLength(3);
});
it('builds a house again on the new core when a week turns or the definition changes, and never under a job that has its image', async () => {
  const f = fixture(), engine = bare(f); let time = moment;
  const executor = containerWorkerExecutor(f.config, { ...f.deps, now: () => time, name: () => 'unique' });
  expect(await executor.build(job, f.abort.signal)).toBe(built);
  // A body is running in the house as it was built this week.
  const body = executor.start(job, built, f.abort.signal); await body.spawned;
  // The same week, days later: nothing is built.
  time = Date.UTC(2026, 10, 22, 23, 59); expect(await executor.build({ ...job, id: 'later' }, f.abort.signal)).toBe(built); executor.discard!({ ...job, id: 'later' }, built);
  expect(engine.order).toEqual([core, built]);
  // Monday: the next job's house is built on that week's core, at the same commit.
  time = Date.UTC(2026, 10, 23, 0, 0);
  const nextCore = coreImage(coreDigest, '2026w48'), next = houseImage(job.house, commit, nextCore);
  expect(await executor.build({ ...job, id: 'monday' }, f.abort.signal)).toBe(next); executor.discard!({ ...job, id: 'monday' }, next); await flush();
  expect(engine.order).toEqual([core, built, nextCore, next]);
  // The running body's image, and the core it was built on, are still there: the upkeep after that build removed neither.
  expect([...engine.present].sort()).toEqual([core, nextCore, built, next].sort());
  expect(f.engine.json.mock.calls.some(call => call[0] === 'DELETE')).toBe(false);
  await body.stop();
  // A new loom with another definition of the core: every house is built again on it, once.
  const changed = containerWorkerExecutor(f.config, { ...f.deps, core: { digest: 'f'.repeat(64), context: vi.fn(coreContext) }, now: () => time });
  const newCore = coreImage('f'.repeat(64), '2026w48');
  expect(await changed.build(job, f.abort.signal)).toBe(houseImage(job.house, commit, newCore));
  expect(engine.order.slice(4)).toEqual([newCore, houseImage(job.house, commit, newCore)]);
});
it('removes a core house once no house image that is kept was built on it', async () => {
  const f = fixture(), engine = bare(f); let time = moment;
  const executor = containerWorkerExecutor(f.config, { ...f.deps, now: () => time });
  const one = await executor.build(job, f.abort.signal); executor.discard!(job, one); await flush();
  // Three weeks on, with a new commit each week: two images of the house are kept, and with them their two cores.
  for (const [week, letter] of [[1, 'd'], [2, 'e'], [3, 'f']] as const) {
    time = moment + week * 7 * DAY_MS; f.source.fetch.mockResolvedValueOnce(letter.repeat(40));
    const image = await executor.build({ ...job, id: letter }, f.abort.signal); executor.discard!({ ...job, id: letter }, image); await flush();
  }
  expect([...engine.present].sort()).toEqual([coreImage(coreDigest, '2026w49'), coreImage(coreDigest, '2026w50'),
    houseImage(job.house, 'e'.repeat(40), coreImage(coreDigest, '2026w49')), houseImage(job.house, 'f'.repeat(40), coreImage(coreDigest, '2026w50'))].sort());
});
it.each([
  ['cannot be built', 22, 'Worker could not start the body: build failed', (f: ReturnType<typeof fixture>) => { f.engine.build.mockImplementation(async path => { if (path.includes(encodeURIComponent(core))) throw new Error('Docker build failed: private words'); }); }],
  ['is built as something that is no house', 22, 'Worker could not start the body: build failed', (f: ReturnType<typeof fixture>, present: Set<string>) => {
    const there = f.engine.images.getMockImplementation()!;
    f.engine.images.mockImplementation(async (method, path, body, signal) => method === 'GET' && path.startsWith(`/images/${core}/`) && present.has(core) ? { Id: imageId, Config: { Labels: { 'loom.house': '1' } } } : there(method, path, body, signal));
  }],
])('fails only that job, as a failed build, when the core house %s', async (_what, code, said, arrange) => {
  const f = fixture(), engine = bare(f); arrange(f, engine.present);
  const control = controlFor(job);
  expect(await once(f, control)).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', code, said, 'worker');
  // No house was built on it, and no container was asked for.
  expect(engine.order.filter(name => name !== core)).toEqual([]); expect(f.engine.json).not.toHaveBeenCalled();
  // What was built and is no house does not stay on the engine under the core's name.
  expect(engine.present.has(core)).toBe(false);
});
it('holds the core house\'s build to the build limit, reports the job all the while, and fails it as out of time', async () => {
  vi.useFakeTimers();
  const f = fixture(); bare(f);
  // The core's build never returns; a house's would.
  const stuck = vi.fn((path: string, context: NodeJS.ReadableStream, _signal: AbortSignal) => { context.resume(); return path.includes(encodeURIComponent(core)) ? new Promise<void>(() => {}) : Promise.resolve(); });
  f.engine.build.mockImplementation(stuck);
  const executor = containerWorkerExecutor({ ...f.config, buildTimeoutMs: 20 * 60_000 }, { ...f.deps });
  const control = controlFor(job); let pulse = () => {};
  const run = workOnce({ box: 'box', control, executor, signal: f.abort.signal, schedule: { every: (_ms, callback) => { pulse = callback; return () => {}; } } });
  for (let report = 1; report <= 76; report++) { await vi.advanceTimersByTimeAsync(15_000); pulse(); await flush(); }
  expect(control.heartbeat).toHaveBeenCalledTimes(76); expect(control.heartbeat.mock.calls.every(call => call[1] === 'starting')).toBe(true);
  expect(control.finish).not.toHaveBeenCalled(); expect(stuck).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await run).toBe('finished');
  expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 32, 'Worker could not start the body: the build ran out of time', 'worker');
  expect(stuck.mock.calls[0][2].aborted).toBe(true);
  executor.close!(); expect(vi.getTimerCount()).toBe(0);
});
it('builds the pinned copy-only review source and keeps it out of the ordinary body launcher', async () => {
  const f = fixture(), engine = bare(f), review = { ...job, coldReview: { change: 'github:org/house#7', headCommit: commit },
    house: { ...job.house, file: '' } };
  expect(() => f.executor.build({ ...review, coldReview: { ...review.coldReview, headCommit: '' } }, f.abort.signal)).toThrow();
  expect(() => f.executor.build({ ...review, program: namedProgram }, f.abort.signal)).toThrow();
  expect(() => f.executor.build({ ...review, house: job.house }, f.abort.signal)).toThrow();
  expect(() => f.executor.build(review, f.abort.signal, Buffer.from('fixture'))).toThrow();
  expect(f.source.fetch).not.toHaveBeenCalled();
  f.source.fetch.mockResolvedValueOnce('d'.repeat(40));
  await expect(f.executor.build(review, f.abort.signal)).rejects.toThrow('Worker build failed');
  expect(f.engine.images).not.toHaveBeenCalled();
  const image = await f.executor.build(review, f.abort.signal);
  expect(f.source.fetch).toHaveBeenLastCalledWith(review.house, undefined, expect.any(AbortSignal), commit);
  expect(image).toBe(houseImage(review.house, commit, core));
  expect(engine.order).toEqual([core, image]);
  expect(new URL(f.engine.build.mock.calls[1][0], 'http://engine').searchParams.get('dockerfile')).toBe(NO_HOUSEFILE);
  expect(f.source.context).toHaveBeenCalledWith(review.house, commit, expect.any(AbortSignal), noHousefile());
  const builds = f.engine.build.mock.calls.length;
  f.source.fetch.mockResolvedValueOnce('d'.repeat(40));
  await expect(f.executor.build(review, f.abort.signal)).rejects.toThrow('Worker build failed');
  expect(f.engine.build).toHaveBeenCalledTimes(builds);
  expect(() => f.executor.start(review, image, f.abort.signal)).toThrow('isolated reviewer');
  expect(f.engine.json).not.toHaveBeenCalled();
});
it('gives an agent with no Housefile the core house with its repository copied in', async () => {
  const f = fixture(), engine = bare(f);
  const plain = { ...job, id: 'plain', house: { ...job.house, file: '' } }, image = houseImage(plain.house, commit, core);
  expect(await f.executor.build(plain, f.abort.signal)).toBe(image);
  expect(engine.order).toEqual([core, image]);
  // The worker's own three lines, beside the directory the commit's files are written into: never among what is copied.
  const [path] = f.engine.build.mock.calls[1], apart = f.source.context.mock.calls[0][3] as { directory: string; beside: { name: string; data: Buffer } };
  expect(new URL(path, 'http://engine').searchParams.get('dockerfile')).toBe('Housefile'); expect(NO_HOUSEFILE).toBe('Housefile');
  expect([apart.directory, apart.beside.name]).toEqual(['repository', 'Housefile']);
  expect(apart.beside.data.toString()).toBe('ARG LOOM_CORE\nFROM ${LOOM_CORE}\nCOPY repository/ /home/agent/repo/\n');
  // It is a house like any other from there: the core's labels are its own, and a body starts in it.
  const body = f.executor.start(plain, image, f.abort.signal); await body.spawned;
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ Image: imageId, WorkingDir: '/home/agent/repo' }); await body.stop();
});
it('still runs a house whose Housefile does not start from the core, when its image meets the contract by itself', async () => {
  const f = fixture(), engine = bare(f), there = f.engine.images.getMockImplementation()!;
  // What this house's own Housefile made: the two labels, and nothing of the core's.
  f.engine.images.mockImplementation(async (method, path, body, signal) => method === 'GET' && path.startsWith(`/images/${built}/`) && engine.present.has(built)
    ? { Id: imageId, Config: { Labels: { 'loom.house': '2', 'loom.house.harnesses': 'harness' } } } : there(method, path, body, signal));
  const control = controlFor(job), run = once(f, control); await flush();
  // The build is given the core's name like every build; a Housefile that names it nowhere leaves it unused.
  expect(new URL(f.engine.build.mock.calls[1][0], 'http://engine').searchParams.get('dockerfile')).toBe('house/Housefile');
  expect(control.started).toHaveBeenCalledExactlyOnceWith('job', built, expect.any(AbortSignal));
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 }); expect(await run).toBe('finished'); expect(control.finish).toHaveBeenCalledExactlyOnceWith('job', 0, '', 'body');
});
it('is not made when the directory it is installed in has no definition of the core house', () => {
  const f = fixture();
  // The install the other tests use has none: they hand the worker a definition.
  expect(() => containerWorkerExecutor(f.config, { engine: f.deps.engine, source: f.deps.source, program: programDirectory })).toThrow(expect.objectContaining({ stage: 'core' }));
  const withCore = install('install/with-core', path => { mkdirSync(join(path, 'house', 'core', 'body'), { recursive: true }); writeFileSync(join(path, 'house', 'core', 'Housefile'), 'FROM scratch\n'); writeFileSync(join(path, 'house', 'core', 'body', 'claude.json'), '{}\n'); });
  expect(() => containerWorkerExecutor(f.config, { engine: f.deps.engine, source: f.deps.source, program: withCore })).not.toThrow();
  expect(coreDefinition(join(withCore, 'house', 'core')).digest).toMatch(/^[0-9a-f]{64}$/);
  expect(f.engine.images).not.toHaveBeenCalled();
});

// What a body is told of its house.
const envOf = (f: ReturnType<typeof fixture>, call = 0) => Object.fromEntries(((f.engine.json.mock.calls.filter(made => made[1].startsWith('/containers/create'))[call][2] as { Env: string[] }).Env).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
it('tells every body the repository, the branch and the exact commit its house was built from, whatever the image says', async () => {
  expect(HOUSE_ENV).toEqual({ repository: 'LOOM_HOUSE_REPOSITORY', branch: 'LOOM_HOUSE_BRANCH', commit: 'LOOM_HOUSE_COMMIT' });
  const f = fixture(), there = f.engine.images.getMockImplementation()!;
  // An image whose own ENV names the same three: an engine gives a container's own variables over an image's.
  f.engine.images.mockImplementation(async (method, path, body, signal) => method === 'GET' && !path.startsWith('/images/json')
    ? { Id: imageId, Config: { Labels: houseLabels, Env: ['LOOM_HOUSE_COMMIT=' + 'f'.repeat(40), 'LOOM_HOUSE_BRANCH=of-the-image', 'LOOM_HOUSE_REPOSITORY=https://example.com/elsewhere.git', 'HOME=/root', 'LOOM_BODY_OWN_HARNESS=1'] } } : there(method, path, body, signal));
  const body = f.start(); await body.spawned;
  // And an image that says for itself that its harness directory is the body's own: the worker says, here that it is not.
  expect(envOf(f)).toEqual({ LOOM_BODY_SCRATCH: '/tmp', HOME: '/home/agent', LOOM_HOUSE_REPOSITORY: 'https://example.com/org/house.git', LOOM_HOUSE_BRANCH: 'next', LOOM_HOUSE_COMMIT: commit, LOOM_BODY_OWN_HARNESS: '0' });
  // Each once, and set by the worker on the container: nothing of the image's is copied into what it asks for.
  const asked = (f.engine.json.mock.calls[0][2] as { Env: string[] }).Env;
  expect(asked.filter(entry => entry.startsWith('LOOM_HOUSE_'))).toHaveLength(3); expect(asked.join()).not.toContain('of-the-image');
  await body.stop();
});
it('tells a body the commit of the image it runs in, not where the branch is now', async () => {
  const f = fixture(), older = houseImage(job.house, 'a'.repeat(40), core);
  // The image name carries the commit it was built from, and that is all the worker goes by.
  expect(houseCommit(older)).toBe('a'.repeat(40)); expect(houseCommit(built)).toBe(commit);
  expect(() => houseCommit('localhost/loom-core:' + 'e'.repeat(16) + '-2026w47')).toThrow('Invalid house image');
  // The job was given an image built when its branch was at an older commit; the branch has moved on since.
  f.source.fetch.mockResolvedValue('d'.repeat(40));
  const body = f.executor.start(job, older, f.abort.signal); await body.spawned;
  expect(envOf(f)).toMatchObject({ LOOM_HOUSE_COMMIT: 'a'.repeat(40), LOOM_HOUSE_BRANCH: 'next' });
  expect(f.source.fetch).not.toHaveBeenCalled(); await body.stop();
});
it('tells a body in a house with no Housefile the same three', async () => {
  const f = fixture(), plain = { ...job, id: 'plain', house: { repository: 'https://example.com/mark/house.git', file: '', branch: 'main' } };
  const image = await f.executor.build(plain, f.abort.signal), body = f.executor.start(plain, image, f.abort.signal); await body.spawned;
  expect(envOf(f)).toMatchObject({ LOOM_HOUSE_REPOSITORY: 'https://example.com/mark/house.git', LOOM_HOUSE_BRANCH: 'main', LOOM_HOUSE_COMMIT: commit });
  await body.stop();
});
it.each(['https://user:secret-token@example.com/org/house.git', 'https://token@example.com/org/house.git', 'https://example.com/org/house.git?token=secret', 'ssh://git@example.com/org/house.git', '/srv/house.git', 'https://example.com/a\nLOOM_HOUSE_COMMIT=x'])
('never tells a body an address that could hold a credential, and starts no container for it (%s)', async repository => {
  const f = fixture(), strange = { ...job, house: { ...job.house, repository } };
  expect(houseRepository(repository)).toBe(false);
  expect(() => f.executor.start(strange, built, f.abort.signal)).toThrow('Invalid house repository');
  expect(f.engine.json).not.toHaveBeenCalled(); expect(f.engine.images).not.toHaveBeenCalled();
  // A source says what it fetches; the worker's own fetches https and nothing else.
  expect(houseSource({ directory: join(houseRoot, 'unused-mirrors') }).fetches!(repository)).toBe(false);
  expect(houseSource({ directory: join(houseRoot, 'unused-mirrors') }).fetches!('https://example.com/org/house.git')).toBe(true);
});

// One worker on an engine and on a sign-in directory.
/** An engine with no container of an earlier worker's on it. */
function nothingLeft(f: ReturnType<typeof fixture>) { const original = f.engine.json.getMockImplementation()!; f.engine.json.mockImplementation((method, path, body, signal) => path.startsWith('/containers/json') ? Promise.resolve([]) : original(method, path, body, signal)); return f; }
it('holds its engine and every sign-in directory to itself before it ends anything or takes any work, and lets go when it closes', async () => {
  const f = nothingLeft(fixture()), logins = { one: { harness: { source: loginA } }, 'an account': { harness: { source: loginB } } };
  const config = { ...f.config, accountLogins: logins }, held: string[][] = []; let released = 0;
  const alone = vi.fn(async (wanted: readonly Alone[]) => { held.push(wanted.map(one => `${one.key}=${one.path}`)); return () => { released++; }; });
  const executor = containerWorkerExecutor(config, { ...f.deps, alone });
  // Nothing is asked of the machine until the worker starts its work.
  expect(alone).not.toHaveBeenCalled();
  await executor.endLeft!(f.abort.signal);
  // The engine where its socket really is, and each sign-in directory, by the key that names it.
  expect(held).toEqual([[`container.socket=${realpathSync(engineSock)}`, `accountLogins.one.harness.source=${loginA}`, `accountLogins."an account".harness.source=${loginB}`]]);
  // Asked once, however much work follows.
  await executor.build({ ...job, account: 'one' }, f.abort.signal); await executor.endLeft!(f.abort.signal); expect(alone).toHaveBeenCalledOnce();
  executor.close!(); await flush(); expect(released).toBe(1);
});
it('stops a second worker on the same engine, and one on another engine with the same sign-in directory, naming the key; and builds nothing', async () => {
  const f = nothingLeft(fixture());
  // Two real holds, in one process as in two: the first worker has the engine and an account's sign-in.
  const first = containerWorkerExecutor({ ...f.config, accountLogins: { account: { harness: { source: loginA } } } }, { ...f.deps, alone: holdAlone });
  await first.endLeft!(f.abort.signal);
  const second = containerWorkerExecutor({ ...f.config, state: undefined }, { ...f.deps, alone: holdAlone });
  await expect(second.endLeft!(f.abort.signal)).rejects.toMatchObject({ stage: 'shared', key: 'container.socket' });
  // A worker that did not ask to end what was left is refused all the same when it is given a job, as a failed build.
  await expect(second.build(job, f.abort.signal)).rejects.toThrow('Worker build failed'); expect(f.engine.build).not.toHaveBeenCalled(); expect(f.source.fetch).not.toHaveBeenCalled();
  const elsewhere = containerWorkerExecutor({ ...f.config, container: { ...f.config.container, socket: nestedSock }, accountLogins: { 'their name for it': { harness: { source: loginA } } } }, { ...f.deps, alone: holdAlone });
  await expect(elsewhere.endLeft!(f.abort.signal)).rejects.toMatchObject({ stage: 'shared', key: 'accountLogins."their name for it".harness.source' });
  // The first worker stops in good order: the next one has the machine.
  first.close!(); await flush(); await new Promise(resolve => setTimeout(resolve, 20));
  const next = containerWorkerExecutor({ ...f.config, accountLogins: { account: { harness: { source: loginA } } } }, { ...f.deps, alone: holdAlone });
  await expect(next.endLeft!(f.abort.signal)).resolves.toBeDefined(); next.close!(); second.close!(); elsewhere.close!(); await flush();
});
it('starts and ends a body without touching anything inside its account\'s sign-in directory', async () => {
  // What a harness's program keeps there, the lock it renews under among it.
  const login = houseDirectory('logins/untouched-by-the-worker');
  for (const name of ['.credentials.json', '.oauth_refresh.lock', 'auth.json']) writeFileSync(join(login, name), 'not read', { mode: 0o600 });
  const seen = () => readdirSync(login).sort().map(name => { const found = statSync(join(login, name)); return [name, found.mtimeMs, found.atimeMs, found.size]; });
  const before = seen(), f = nothingLeft(house([reported(login, '/run/loom/login/harness', true)], {}, { account: { harness: { source: login } } } as unknown as typeof accountLogins));
  await f.executor.endLeft!(f.abort.signal);
  const image = await f.executor.build(job, f.abort.signal), body = f.executor.start(job, image, f.abort.signal);
  await body.spawned; await body.stop(); f.executor.close!(); await flush();
  expect(seen()).toEqual(before);
});

const mappedEngineInfo = {version:{APIVersion:'5.4.2'},host:{cgroupControllers:['cpu','pids','memory'],security:{rootless:true},
      idMappings:{uidmap:[{container_id:0,host_id:20000,size:40000}],gidmap:[{container_id:0,host_id:20000,size:40000}]}}};

it('mounts a job-only kit socket and gives the body no worker credential, even with a shell',async()=>{
  const f=fixture(),state=mkdtempSync(join(houseRoot,'kit-state-'));
  const broker=vi.spyOn(brokerModule,'kitBroker');
  const executor=containerWorkerExecutor({...f.config,state,container:{...f.config.container,podmanHelperSubid:32767}},{...f.deps,kitAccess:{url:'https://root.invalid',runner:'machine-only'}});
  const original=f.engine.json.getMockImplementation()!;
  let path='';
  f.engine.json.mockImplementation(async(method,url,body,signal)=>{
    if(url.endsWith('/libpod/info')) return mappedEngineInfo;
    if(url.endsWith('/libpod/containers/create')) throw new Error('Fixture stops before helper launch');
    if(url.startsWith('/containers/create')){
      const mounts=(body as {HostConfig:{Mounts:{Source:string;Target:string;ReadOnly:boolean}[]}}).HostConfig.Mounts;
      const socket=mounts.find(m=>m.Target==='/run/loom/kit.sock');
      expect(socket?.ReadOnly).toBe(true);path=socket!.Source;
    }
    if(inspecting(url))return {Mounts:[...programReport(programDirectory,state),reported(path,'/run/loom/kit.sock',false)]};
    return original(method,url,body,signal);
  });
  const body=executor.start(job,built,f.abort.signal);
  try{
    await body.spawned;expect(statSync(path).isSocket()).toBe(true);
    await body.release(bootstrap());
    expect(JSON.parse(f.writes[0])).toEqual({job,build:built,bootstrap:handed,kitSocket:true});
    expect(JSON.stringify(f.engine.json.mock.calls)).not.toContain('machine-only');
    expect(f.writes[0]).not.toContain('machine-only');
    await expect(broker.mock.calls[0][0].run({image:imageId,entrypoint:'/home/agent/repo/probe',argv:[],
      secrets:{},signal:f.abort.signal,onStarted:()=>{}})).rejects.toThrow('Fixture stops before helper launch');
    expect(f.engine.json.mock.calls.filter(call=>call[1].endsWith('/libpod/containers/create'))).toHaveLength(1);
  }finally{broker.mockRestore();await body.stop();await executor.close?.();}
  expect(()=>statSync(path)).toThrow();
});

const namedProgram = { repository: job.house.repository, commit, image:imageId, program:'tools/observe', name: 'observe', args: ['literal; argument'], timeoutMs: 5000, secrets: { KIT_WEATHER:'weather' }, state: { last: 1 } };
function programFixture() {
  const f = fixture();
  const original = f.engine.json.getMockImplementation()!;
  f.engine.json.mockImplementation((method, path, data, signal) => inspecting(path)
    ? Promise.resolve({ Mounts: [] }) : original(method, path, data, signal));
  return f;
}
it('runs a named program only after acknowledgement, with declared input and no model or host access', async () => {
  const f = programFixture(), ack = deferred<void>(), bytes = Buffer.from('private weather credential');
  const assignment = { ...job, harness: 'program', program: namedProgram, accountChoices: 2,
    run: { gpu: true, nestedContainers: false, ports: [{ address: '127.0.0.1', port: 9000 }] } };
  const control = { next: async () => assignment, started: vi.fn(() => ack.promise), heartbeat: async () => true,
    finish: vi.fn(async () => {}), enrollBody: vi.fn(), programInputs: vi.fn(async () => new Map([['KIT_WEATHER', bytes]])) };
  const run = workOnce({ box: job.box, control, executor: f.executor, signal: f.abort.signal });
  await flush();
  expect(control.enrollBody).not.toHaveBeenCalled();
  expect(control.programInputs).toHaveBeenCalledWith(job.id, ['KIT_WEATHER'], expect.any(AbortSignal));
  expect(f.engine.json.mock.calls.some(call => call[1].endsWith('/start'))).toBe(false);
  expect(f.engine.json.mock.calls[0][2]).toMatchObject({ User:'65534:65534', Cmd: ['/home/agent/repo/tools/observe'], HostConfig: { Mounts: [], Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true } });
  expect(JSON.stringify(f.engine.json.mock.calls[0][2])).not.toContain('private weather credential');
  ack.resolve(); await flush();
  expect(JSON.parse(f.writes[0])).toEqual({ argv:namedProgram.args, timeoutMs:namedProgram.timeoutMs, input:{version:1,state:{last:1}}, bindings:{KIT_WEATHER:Buffer.from('private weather credential').toString('base64')} });
  expect(bytes.every(byte => byte === 0)).toBe(true);
  const result = {version: 1, wake: false, state: {last: 2}};
  f.socket.push(frame('private weather credential', 2)); f.socket.push(frame(JSON.stringify(result)));
  f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
  expect(await run).toBe('finished');
  expect(control.finish).toHaveBeenCalledWith(job.id, 0, '', 'runner', result);
});
it('prepares a scheduled helper using its worker namespace setting', async () => {
  const f = programFixture();
  const executor = containerWorkerExecutor({...f.config,container:{...f.config.container,podmanHelperSubid:32767}},f.deps);
  f.engine.json.mockImplementation(async (_method,path) => {
    if (path.endsWith('/libpod/info')) return mappedEngineInfo;
    if (path.endsWith('/libpod/containers/create')) throw new Error('Fixture stops before helper launch');
  });
  const body = executor.start({...job,program:namedProgram},built,f.abort.signal);
  try {
    await expect(body.spawned).rejects.toThrow('Fixture stops before helper launch');
    expect(f.engine.json.mock.calls.filter(call=>call[1].endsWith('/libpod/containers/create'))).toHaveLength(1);
  } finally { await body.stop(); }
});
it('ends and removes a program at its deadline', async () => {
  vi.useFakeTimers();
  const f = programFixture(), body = f.start({ ...job, program: { ...namedProgram, timeoutMs: 20, secrets: {} } });
  await body.spawned;
  await body.releaseProgram!({});
  await vi.advanceTimersByTimeAsync(20);
  await expect(body.exited).rejects.toThrow();
  await body.stop();
  expect(f.engine.json.mock.calls.at(-1)?.[1]).toBe(`/containers/${id}?force=1&v=1`);
});
it('erases and rejects an incomplete or extra secret plan before starting the program', async () => {
  const f = programFixture(), bytes = Buffer.from('something private');
  const control = { next: async () => ({ ...job, program: namedProgram }), started: vi.fn(),
    heartbeat: async () => true, finish: vi.fn(), programInputs: async () => new Map([['extra', bytes]]) };
  expect(await workOnce({ box: job.box, control, executor: f.executor, signal: f.abort.signal })).toBe('finished');
  expect(control.started).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]); expect(bytes.every(byte => byte === 0)).toBe(true);
});

it.each(['oversize', 'secret', 'invalid utf8', 'nonzero'])('keeps %s program stdout out of logs and finish reports', async reason => {
  const f = programFixture();
  const control = { next: async () => ({...job, program: namedProgram}), started: async () => {},
    heartbeat: async () => true, finish: vi.fn(), programInputs: async () => new Map([['KIT_WEATHER', Buffer.from('private weather credential')]]) };
  const run = workOnce({ box: job.box, control, executor: f.executor, signal: f.abort.signal });
  await flush();
  let output: Buffer;
  if (reason === 'oversize') output = frame('x'.repeat(1024 * 1024));
  else if (reason === 'invalid utf8') {
    output = frame('{"version":1,"wake":true,"line":"x"}');
    output[output.length - 3] = 0xff;
  } else output = frame('{"version":1,"wake":false,"state":"private weather credential"}');
  f.socket.push(output); f.socket.push(null); f.wait.resolve({StatusCode: reason === 'nonzero' ? 17 : 0});
  expect(await run).toBe('finished');
  const [id, code, words, by, result] = control.finish.mock.calls[0];
  expect(id).toBe(job.id); expect(code).not.toBe(0); expect(words).not.toContain('private weather credential');
  expect(by).toBe(reason === 'nonzero' ? 'runner' : 'worker'); expect(result).toBeUndefined();
});

it.each(['repository','commit','image'] as const)('refuses a scheduled %s mismatch before private inputs are fetched',async field=>{
  const f=programFixture();
  const other={repository:'https://example.com/other.git',commit:'d'.repeat(40),image:'sha256:'+'f'.repeat(64)};
  const assignment={...job,program:{...namedProgram,[field]:other[field]}};
  const control={next:async()=>assignment,started:vi.fn(),heartbeat:async()=>true,finish:vi.fn(),
    programInputs:vi.fn(),enrollBody:vi.fn()};
  expect(await workOnce({box:job.box,control,executor:f.executor,signal:f.abort.signal})).toBe('finished');
  expect(control.programInputs).not.toHaveBeenCalled();
  expect(control.started).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
it('reads why its body failed from the one line the body writes for it, and nothing else of what the body prints', async () => {
  const f = fixture(), raw = 'body_' + 'a'.repeat(64), token = Buffer.from(raw);
  const body = f.start(); await body.spawned; await body.release({ origin: 'https://loom.example', job: job.id, token });
  // On its error output, split across frames; a line that is not exactly a failure is no failure.
  f.socket.push(frame('loom-job-failure {"reason":"max-turns"}\n', 1));
  f.socket.push(frame('Body stopped: invalid input or unavailable execution\nloom-job-failure {"reason":"usage-limit","resets', 2));
  f.socket.push(frame('At":"2026-11-28T01:00:00.000Z"}\nloom-job-failure {"reason":"usage-limit","note":"PRIVATE"}\nloom-job-failure {"reason":"PRIVATE"}\n', 2));
  f.socket.push(null); f.wait.resolve({ StatusCode: 14 });
  expect(await body.exited).toEqual({ exitCode: 14, logTail: '', signalled: false, failure: { reason: 'usage-limit', resetsAt: '2026-11-28T01:00:00.000Z' } });
  await body.stop(); token.fill(0);
});
it.each([[true, { reason: 'out-of-memory' }], [false, { reason: 'killed', signal: 'SIGKILL' }]] as const)('says for a body a signal ended whether the engine saw the memory killer (%s)', async (OOMKilled, failure) => {
  const f = fixture(), base = f.engine.json.getMockImplementation()!;
  const body = f.start(); await body.spawned;
  f.engine.json.mockImplementation(async (method, path, sent, signal) => inspecting(path) ? { State: { OOMKilled } } : base(method, path, sent, signal));
  f.socket.push(null); f.wait.resolve({ StatusCode: 137 });
  expect(await body.exited).toEqual({ exitCode: 29, logTail: '', signalled: true, failure }); await body.stop();
});

/** A frozen review (conversation.review): its copy, written by `build`, mounted read-only by `start`. */
const reviewHead = '1'.repeat(40), reviewBase = '2'.repeat(40);
const frozenJob: WorkerAssignment = { ...job, review: true, frozenReview: { repository: 'acme/app', head: reviewHead, base: reviewBase } };
function frozenFixture(engineSaysWritable = false) {
  const f = fixture(), state = mkdtempSync(join(houseRoot, 'frozen-state-')), copy = join(state, 'reviews', frozenJob.id);
  const source = { ...f.source,
    fetch: vi.fn(async (_house: WorkerAssignment['house'], _credential: Uint8Array | undefined, _signal: AbortSignal, requested?: string) => requested ?? commit),
    context: vi.fn((_house: WorkerAssignment['house'], at: string, _signal: AbortSignal) => at === reviewHead
      ? plainContext([{ name: 'src/pump.ts', data: Buffer.from('export const rate = 2;\n') }]) : (() => { const tar = new PassThrough(); tar.end('tar'); return tar; })()),
    diff: vi.fn(async () => ({ bytes: Buffer.from('diff --git a/src/pump.ts b/src/pump.ts\n-export const rate = 1;\n+export const rate = 2;\n'), cut: false })) };
  const original = f.engine.json.getMockImplementation()!;
  const created: { HostConfig: { Mounts: { Type: string; Source: string; Target: string; ReadOnly: boolean }[] }; Env: string[] }[] = [];
  f.engine.json.mockImplementation(async (method, url, body, signal) => {
    if (url.startsWith('/containers/create')) created.push(body as typeof created[number]);
    // What the engine reports it made. A frozen review's copy must be reported read-only, or the body is not started.
    if (inspecting(url)) return { Mounts: [...programReport(programDirectory, state), reported(loginA, '/run/loom/login/harness', true), reported(copy, '/review', engineSaysWritable)] };
    return original(method, url, body, signal);
  });
  const executor = containerWorkerExecutor({ ...f.config, state, accountLogins, container: { ...f.config.container, mounts: { art: houseMounts } } },
    { ...f.deps, source, name: () => 'frozen', kitAccess: { url: 'https://root.invalid', runner: 'machine-only' } });
  return { ...f, state, copy, source, executor, created };
}
it('gives a frozen review its exact commit read-only at /review, none of its agent\'s mounts and no kit, and the copy\'s fingerprint before and after', async () => {
  const f = frozenFixture(), credential = new TextEncoder().encode('house-fetch-secret');
  const image = await f.executor.build(frozenJob, f.abort.signal, credential);
  // Both pinned commits by their full ids, with the house's own fetch credential, which goes to git and nowhere else.
  expect(f.source.fetch).toHaveBeenCalledWith({ repository: 'https://github.com/acme/app.git', file: '', branch: 'main' }, credential, expect.any(AbortSignal), reviewBase);
  expect(f.source.fetch).toHaveBeenCalledWith({ repository: 'https://github.com/acme/app.git', file: '', branch: 'main' }, credential, expect.any(AbortSignal), reviewHead);
  expect(readFileSync(join(f.copy, 'tree/src/pump.ts'), 'utf8')).toBe('export const rate = 2;\n');
  expect(readFileSync(join(f.copy, 'change.diff'), 'utf8')).toContain('+export const rate = 2;');
  const body = f.executor.start(frozenJob, image, f.abort.signal);
  try {
    await body.spawned;
    const [spec] = f.created, mounts = spec.HostConfig.Mounts;
    expect(mounts).toContainEqual({ Type: 'bind', Source: f.copy, Target: '/review', ReadOnly: true });
    // Nothing of the agent's own: neither of its fixed mounts, nor a kit socket. Its sign-in, as every body has.
    expect(mounts.map(m => m.Target)).toEqual(['/opt/loom', '/usr/local/bin/loom', '/run/loom/login/harness', '/review']);
    expect(spec.Env.some(entry => /SECRET|TOKEN|GH_|GITHUB/.test(entry))).toBe(false);
    expect(JSON.stringify(f.engine.json.mock.calls)).not.toMatch(/house-fetch-secret|machine-only/);
    await body.release(bootstrap());
    // No kit was offered or reported for it.
    expect(JSON.parse(f.writes[0])).toEqual({ job: frozenJob, build: image, bootstrap: handed });
    f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
    const ended = await body.exited;
    expect(ended.reviewTree?.head).toBe(reviewHead);
    expect(ended.reviewTree?.before).toMatch(/^[0-9a-f]{64}$/); expect(ended.reviewTree?.after).toBe(ended.reviewTree?.before);
  } finally { await body.stop(); }
  // The copy is removed with the body.
  expect(existsSync(f.copy)).toBe(false);
});
it('does not start a frozen review whose copy the engine reports writable, and reports a copy changed under it', async () => {
  const writable = frozenFixture(true), image = await writable.executor.build(frozenJob, writable.abort.signal);
  const refused = writable.executor.start(frozenJob, image, writable.abort.signal);
  await expect(refused.spawned).rejects.toThrow('Unexpected container storage'); await refused.stop();
  expect(writable.engine.json.mock.calls.some(call => String(call[1]).endsWith('/start'))).toBe(false);
  // Read-only in the container, but not to this machine's own user: a change made beside the body is seen.
  const f = frozenFixture(), built2 = await f.executor.build(frozenJob, f.abort.signal), body = f.executor.start(frozenJob, built2, f.abort.signal);
  try {
    await body.spawned; await body.release(bootstrap());
    chmodSync(join(f.copy, 'tree/src/pump.ts'), 0o644); writeFileSync(join(f.copy, 'tree/src/pump.ts'), 'export const rate = 3;\n');
    f.socket.push(null); f.wait.resolve({ StatusCode: 0 });
    const ended = await body.exited;
    expect(ended.reviewTree?.after).not.toBe(ended.reviewTree?.before);
  } finally { await body.stop(); }
  // Without its copy, a frozen review is not started at all.
  const none = frozenFixture();
  expect(() => none.executor.start(frozenJob, built, none.abort.signal)).toThrow('Review copy unavailable');
  expect(none.created).toEqual([]);
});
