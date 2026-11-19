import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { DEVICE_MAX, SIZE_BYTES_MAX, WATCHED_PATHS_MAX, machineReader, parseDiskResult, startDiskHelper, watchedPath } from './machine-check.js';

afterEach(() => vi.useRealTimers());
const data = { device: 42, sizeBytes: 100, freeBytes: 29 };
const answer = JSON.stringify(data) + '\n';
const disk = (thing: string) => ({ kind: 'disk', thing, ...data });
const unknown = (thing: string) => ({ kind: 'disk', thing, unknown: true });

class Helper extends EventEmitter {
  pid = 42;
  stdout = new PassThrough();
  unref = vi.fn();
  kill = vi.fn();
  exit(output = answer, code = 0) {
    if (!this.stdout.destroyed) this.stdout.write(output);
    this.emit('exit', code);
    this.emit('close', code);
  }
}
function starters(auto: (path: string) => boolean) {
  const children = new Map<string, Helper>();
  const start = vi.fn((path: string) => {
    const child = new Helper();
    children.set(path, child);
    if (auto(path)) queueMicrotask(() => child.exit());
    return child as unknown as ReturnType<typeof startDiskHelper>;
  });
  return { start, children };
}

it('runs only the fixed script within the build, with one validated argument and no shell', () => {
  const spawn = vi.fn();
  const localBuild = dirname(fileURLToPath(import.meta.url));
  startDiskHelper('/mnt/data', spawn);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, [join(localBuild, 'machine-disk-helper.js'), '/mnt/data'], {
    shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: expect.objectContaining({ NODE_OPTIONS: undefined }),
  });
  for (const path of ['relative', '/mnt/../data', '/mnt/x\n', '/mnt/-flag', '/mnt/a;exit', '/' + 'a'.repeat(120)]) {
    expect(watchedPath(path)).toBe(false);
    expect(() => startDiskHelper(path, spawn)).toThrow('Invalid watched path');
  }
  expect(spawn).toHaveBeenCalledTimes(1);
});

it('runs the emitted helper with the configured path, rejecting links and extra arguments', async () => {
  const build = mkdtempSync(join(tmpdir(), 'loom-disk-test-'));
  try {
    writeFileSync(join(build, 'package.json'), '{"type":"module"}');
    for (const name of ['machine-check', 'machine-disk-helper']) {
      const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      writeFileSync(join(build, `${name}.js`), stripTypeScriptTypes(source));
    }
    const built = await import(pathToFileURL(join(build, 'machine-check.js')).href);
    const link = join(build, 'link');
    symlinkSync('/', link);
    const report = await built.machineReader({ paths: ['/'], timeoutMs: 10_000 })();
    expect(report[0]).toMatchObject({ kind: 'disk', thing: '/', device: expect.any(Number), sizeBytes: expect.any(Number), freeBytes: expect.any(Number) });
    const launch = async (...args: string[]) => {
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [join(build, 'machine-disk-helper.js'), ...args]);
      let output = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      expect(await once(child, 'close')).toEqual([0, null]);
      return output;
    };
    expect(await launch(link)).toBe('{"unknown":true,"reason":"link"}\n');
    expect(await launch('/')).toMatch(/^\{"device":\d+,"sizeBytes":\d+,"freeBytes":\d+\}\n$/);
    expect(await launch('/', '/tmp')).toBe('{"unknown":true}\n');
    expect(await launch('/bad/../path')).toBe('{"unknown":true}\n');
  } finally { rmSync(build, { recursive: true, force: true }); }
});

it('uses strictly one fixed JSON line and the same numeric bounds as the door', () => {
  expect(parseDiskResult(answer)).toEqual(data);
  expect(parseDiskResult(JSON.stringify({ device: DEVICE_MAX, sizeBytes: SIZE_BYTES_MAX, freeBytes: SIZE_BYTES_MAX }) + '\n'))
    .toEqual({ device: DEVICE_MAX, sizeBytes: SIZE_BYTES_MAX, freeBytes: SIZE_BYTES_MAX });
  expect(parseDiskResult('{"unknown":true,"reason":"link"}\n')).toEqual({ unknown: true, reason: 'link' });
  for (const output of [answer.trim(), answer + answer, answer + '\n', ' ' + answer, 'no\n', 'null\n',
    '{"device":1,"device":2,"sizeBytes":4,"freeBytes":3}\n',
    ...[{ device: -1 }, { device: DEVICE_MAX + 1 }, { device: 1.5 }, { sizeBytes: 0 }, { freeBytes: -1 },
      { sizeBytes: SIZE_BYTES_MAX + 1 }, { freeBytes: 101 }, { words: 'full' }, { freeBytes: '1' }]
      .map(change => JSON.stringify({ ...data, ...change }) + '\n')]) {
    expect(parseDiskResult(output), output).toEqual({ unknown: true });
  }
});

it('keeps a timed-out helper by its exact path, reads healthy siblings and retries only after exit', async () => {
  vi.useFakeTimers();
  const hanging = '/mnt/nas', healthy = '/mnt/data';
  let recovered = false;
  const { start, children } = starters(path => path !== hanging || recovered);
  const controller = new AbortController();
  const read = machineReader({ paths: [hanging, healthy], start, timeoutMs: 50, signal: controller.signal });
  const first = read();
  expect(start.mock.calls).toEqual([[hanging], [healthy]]);
  await vi.advanceTimersByTimeAsync(50);
  expect(await first).toMatchObject([unknown(hanging), disk(healthy), { kind: 'memory' }]);
  const asleep = children.get(hanging)!;
  expect(asleep.unref).toHaveBeenCalledOnce();
  expect(asleep.stdout.destroyed).toBe(true);
  expect(asleep.kill).not.toHaveBeenCalled();
  expect(await read()).toMatchObject([unknown(hanging), disk(healthy), { kind: 'memory' }]);
  expect(start.mock.calls).toEqual([[hanging], [healthy], [healthy]]);
  recovered = true;
  asleep.exit();
  expect(await read()).toMatchObject([disk(hanging), disk(healthy), { kind: 'memory' }]);
  expect(start.mock.calls).toEqual([[hanging], [healthy], [healthy], [hanging], [healthy]]);
});

it('bounds all live helpers by configured paths, detaches their pipes, and kills live children on stop', async () => {
  vi.useFakeTimers();
  const { start, children } = starters(() => false);
  const signal = new AbortController();
  const paths = Array.from({ length: WATCHED_PATHS_MAX + 1 }, (_, i) => `/disk${i}`);
  const read = machineReader({ paths: [...paths, paths[0]], start, timeoutMs: 50, signal: signal.signal });
  const pending = read();
  await read();
  expect(start).toHaveBeenCalledTimes(WATCHED_PATHS_MAX);
  signal.abort();
  expect(await pending).toMatchObject([...paths.slice(0, WATCHED_PATHS_MAX).map(unknown), { kind: 'memory' }]);
  for (const child of children.values()) {
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(child.stdout.destroyed).toBe(true);
  }
  await read();
  expect(start).toHaveBeenCalledTimes(WATCHED_PATHS_MAX);
});

it('logs start failures once, treats failed and malformed helpers as unknown, and retries failed starts', async () => {
  const { start } = starters(() => false), say = vi.fn();
  start.mockImplementationOnce(() => { throw new Error('private spawn detail'); });
  start.mockImplementationOnce(() => {
    const child = new Helper();
    delete (child as { pid?: number }).pid;
    queueMicrotask(() => child.emit('error', new Error('private ENOENT')));
    return child as unknown as ReturnType<typeof startDiskHelper>;
  });
  start.mockImplementationOnce(() => {
    const child = new Helper();
    queueMicrotask(() => child.exit(answer, 1));
    return child as unknown as ReturnType<typeof startDiskHelper>;
  });
  start.mockImplementationOnce(() => {
    const child = new Helper();
    queueMicrotask(() => child.exit('x'.repeat(257)));
    return child as unknown as ReturnType<typeof startDiskHelper>;
  });
  start.mockImplementationOnce(() => {
    const child = new Helper();
    queueMicrotask(() => child.exit());
    return child as unknown as ReturnType<typeof startDiskHelper>;
  });
  const read = machineReader({ paths: ['/'], start, say });
  for (let i = 0; i < 4; i++) expect((await read())[0]).toEqual(unknown('/'));
  expect((await read())[0]).toEqual(disk('/'));
  expect(say).toHaveBeenCalledExactlyOnceWith('Worker machine check: a disk helper could not be started\n');
});

it('reports every configured alias and asks only whether the engine answers, including after a restart', async () => {
  const { start } = starters(() => true);
  const engine = vi.fn(async (_signal: AbortSignal) => ({ DockerRootDir: '/engine-controlled' }));
  const config = { paths: ['/', '/var/lib/runtime'], engine, start };
  expect(await machineReader(config)()).toMatchObject([{ kind: 'containers', answers: true }, disk('/'), disk('/var/lib/runtime'), { kind: 'memory' }]);
  engine.mockRejectedValue(new Error('engine down'));
  expect(await machineReader(config)()).toMatchObject([{ kind: 'containers', answers: false }, disk('/'), disk('/var/lib/runtime'), { kind: 'memory' }]);
  expect(engine).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(start.mock.calls).toEqual([['/'], ['/var/lib/runtime'], ['/'], ['/var/lib/runtime']]);
});
