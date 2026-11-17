import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:http', () => ({ request: mocked.request }));
import { dockerEngine, LISTING_MAX } from './docker-engine.js';
function fixture() {
  const req = Object.assign(new EventEmitter(), { end: vi.fn() });
  const response = Object.assign(new PassThrough(), { statusCode: 200 });
  mocked.request.mockImplementation((_options, callback) => { if (callback) queueMicrotask(() => callback(response)); return req; });
  const engine = dockerEngine('/explicit/docker.sock'), abort = new AbortController();
  return { req, response, engine, abort };
}
beforeEach(() => { mocked.request.mockReset(); });
it('uses only the explicitly selected local socket with JSON and exact content length', async () => {
  const f = fixture(), pending = f.engine.json('POST', '/containers/create?name=loom-unique', { Image: 'image', Env: ['SECRET=€'] }, f.abort.signal);
  await Promise.resolve(); f.response.end('{"Id":"abc"}');
  expect(await pending).toEqual({ Id: 'abc' });
  const data = JSON.stringify({ Image: 'image', Env: ['SECRET=€'] });
  expect(mocked.request).toHaveBeenCalledWith({ socketPath: '/explicit/docker.sock', method: 'POST', path: '/containers/create?name=loom-unique', signal: f.abort.signal,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, expect.any(Function));
  expect(f.req.end).toHaveBeenCalledExactlyOnceWith(data);
});
for (const status of [204, 404]) it(`accepts acknowledged removal ${status} without retry`, async () => {
  const f = fixture(); f.response.statusCode = status;
  const pending = f.engine.json('DELETE', '/containers/id?force=1&v=1', undefined, f.abort.signal);
  await Promise.resolve(); f.response.end(status === 404 ? '{"message":"gone"}' : '');
  expect(await pending).toBeUndefined(); expect(mocked.request).toHaveBeenCalledOnce();
});
for (const failure of ['status', 'json', 'large', 'request', 'response', 'aborted']) it(`rejects ${failure} without returning daemon diagnostics or retrying`, async () => {
  const f = fixture();
  const pending = f.engine.json('POST', '/containers/create', {}, f.abort.signal), failed = expect(pending).rejects.toThrow();
  await Promise.resolve();
  if (failure === 'status') { f.response.statusCode = 500; f.response.end('{"message":"private"}'); }
  if (failure === 'json') f.response.end('invalid');
  if (failure === 'large') f.response.end('x'.repeat(65_537));
  if (failure === 'request') f.req.emit('error', new Error('offline'));
  if (failure === 'response') f.response.destroy(new Error('offline'));
  if (failure === 'aborted') f.response.emit('aborted');
  await failed;
  if (failure === 'status') await expect(pending).rejects.not.toThrow('private');
  expect(mocked.request).toHaveBeenCalledOnce();
});
it('requires HTTP upgrade and preserves pre-read output for the executor', async () => {
  const f = fixture(), stream = new PassThrough(), pending = f.engine.attach('id/unsafe', f.abort.signal);
  f.req.emit('upgrade', { statusCode: 101 }, stream, Buffer.from('frame'));
  expect(await pending).toBe(stream); expect(stream.read()).toEqual(Buffer.from('frame'));
  expect(mocked.request).toHaveBeenCalledWith(expect.objectContaining({ socketPath: '/explicit/docker.sock', signal: f.abort.signal,
    path: '/containers/id%2Funsafe/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=0', headers: { Connection: 'Upgrade', Upgrade: 'tcp' } }));
  stream.destroy();
});
it('rejects ordinary non-upgraded attach responses and upgrade failures', async () => {
  for (const upgrade of [false, true]) {
    mocked.request.mockClear();
    const f = fixture(), stream = new PassThrough(), pending = f.engine.attach('id', f.abort.signal), failed = expect(pending).rejects.toThrow();
    if (upgrade) { f.req.emit('upgrade', { statusCode: 500 }, stream, Buffer.alloc(0)); expect(stream.destroyed).toBe(true); }
    else f.req.emit('response', stream);
    await failed; expect(mocked.request).toHaveBeenCalledOnce(); stream.destroy();
  }
});
for (const socket of ['relative', '/bad\0path']) it('rejects malformed socket before connecting', () => {
  expect(() => dockerEngine(socket)).toThrow(); expect(mocked.request).not.toHaveBeenCalled();
});

for (const stage of ['request', 'response', 'attach']) it(`settles cancellation of pending ${stage} without a transport retry`, async () => {
  const f = fixture();
  // Fake Node request models the documented http.request(signal) contract.
  // No socket/server/daemon is opened. Forwarding or error-listener regressions
  // leave this promise pending or fail to observe the abort.
  mocked.request.mockImplementation((options, callback) => {
    options.signal.addEventListener('abort', () => f.req.emit('error', new Error('Aborted')), { once: true });
    if (stage === 'response') queueMicrotask(() => callback(f.response));
    return f.req;
  });
  const pending = stage === 'attach' ? f.engine.attach('id', f.abort.signal)
    : f.engine.json('DELETE', '/containers/id?force=1', undefined, f.abort.signal);
  const failed = expect(pending).rejects.toThrow('Aborted');
  await Promise.resolve(); f.abort.abort(); await failed; expect(mocked.request).toHaveBeenCalledOnce();
  f.response.destroy();
});

// Building an image: the context is streamed up as it comes, and the engine's talk is read and dropped.
function buildFixture() {
  const sent: Buffer[] = [];
  const req = Object.assign(new PassThrough(), { destroyed: false });
  req.on('data', (chunk: Buffer) => sent.push(chunk));
  const response = Object.assign(new PassThrough(), { statusCode: 200 });
  mocked.request.mockImplementation((_options, callback) => { if (callback) queueMicrotask(() => callback(response)); return req; });
  return { req, response, sent, engine: dockerEngine('/explicit/docker.sock'), abort: new AbortController(), context: new PassThrough() };
}
it('streams a build context to the engine as a tar and waits for the engine to finish', async () => {
  const f = buildFixture(); let done = false;
  const pending = f.engine.build('/build?t=name&dockerfile=Housefile', f.context, f.abort.signal).then(() => { done = true; });
  f.context.write('tar-'); f.context.end('bytes'); await new Promise(resolve => setImmediate(resolve));
  expect(Buffer.concat(f.sent).toString()).toBe('tar-bytes');
  expect(mocked.request).toHaveBeenCalledExactlyOnceWith({ socketPath: '/explicit/docker.sock', method: 'POST', path: '/build?t=name&dockerfile=Housefile', signal: f.abort.signal,
    headers: { 'Content-Type': 'application/x-tar' } }, expect.any(Function));
  f.response.write('{"stream":"Step 1/2"}\n'); f.response.write('{"stream":"x'.padEnd(200_000, 'y') + '"}\n'); await new Promise(resolve => setImmediate(resolve));
  expect(done).toBe(false);
  f.response.end('{"aux":{"ID":"sha256:abc"}}\n'); await pending; expect(done).toBe(true);
});
for (const failure of ['an error line', 'an error detail split across chunks', 'a refusing status', 'a broken context', 'a broken answer', 'a broken request']) it(`fails a build over ${failure}, without the engine's words`, async () => {
  const f = buildFixture();
  if (failure === 'a refusing status') f.response.statusCode = 500;
  const pending = f.engine.build('/build?t=name', f.context, f.abort.signal), failed = expect(pending).rejects.toThrow(/^Docker (build|request) failed$/);
  await Promise.resolve();
  if (failure === 'an error line') { f.context.end(); f.response.end('{"stream":"ok"}\n{"error":"private: no such file /secret/path"}\n'); }
  if (failure === 'an error detail split across chunks') { f.context.end(); f.response.write('{"stream":"ok"}\n{"errorDe'); f.response.end('tail":{"message":"private"}}'); }
  if (failure === 'a refusing status') { f.context.end(); f.response.end('{"message":"private"}'); }
  if (failure === 'a broken context') f.context.destroy(new Error('private git failure'));
  if (failure === 'a broken answer') { f.context.end(); f.response.destroy(new Error('offline')); }
  if (failure === 'a broken request') f.req.emit('error', new Error('offline'));
  await failed;
});

it('reads a longer answer only for a call that says how long it may be', async () => {
  const long = JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ Id: String(index), Labels: { text: 'x'.repeat(4_000) } })));
  expect(long.length).toBeGreaterThan(65_536); expect(long.length).toBeLessThan(LISTING_MAX);
  const refused = fixture(), failed = expect(refused.engine.json('GET', '/images/json', undefined, refused.abort.signal)).rejects.toThrow();
  await Promise.resolve(); refused.response.end(long); await failed;
  const taken = fixture(), pending = taken.engine.json('GET', '/images/json', undefined, taken.abort.signal, LISTING_MAX);
  await Promise.resolve(); taken.response.end(long); expect(await pending).toHaveLength(40);
  const over = fixture(), tooLong = expect(over.engine.json('GET', '/images/json', undefined, over.abort.signal, LISTING_MAX)).rejects.toThrow();
  await Promise.resolve(); over.response.end('x'.repeat(LISTING_MAX + 1)); await tooLong;
  expect(LISTING_MAX).toBe(4_194_304);
});
it('ends the context it was reading when a build fails, so what feeds it is not left waiting', async () => {
  for (const failure of ['status', 'line']) {
    const f = buildFixture(); if (failure === 'status') f.response.statusCode = 500;
    const failed = expect(f.engine.build('/build?t=name', f.context, f.abort.signal)).rejects.toThrow();
    await Promise.resolve(); f.context.write('some of it');
    f.response.end(failure === 'line' ? '{"error":"private"}\n' : '{"message":"private"}'); await failed;
    expect(f.context.destroyed).toBe(true);
  }
});
