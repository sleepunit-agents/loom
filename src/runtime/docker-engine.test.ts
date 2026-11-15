import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:http', () => ({ request: mocked.request }));
import { dockerEngine } from './docker-engine.js';
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
