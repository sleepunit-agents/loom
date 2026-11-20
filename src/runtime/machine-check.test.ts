import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { SIZE_BYTES_MAX, WATCHED_PATHS_MAX, machineReader, parseDiskResult, readMemory, startDiskHelper, watchedPath } from './machine-check.js';

const availableMemory = vi.hoisted(() => vi.fn<() => number | undefined>());
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual.default, availableMemory } };
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); availableMemory.mockReset(); });
const data = { sizeBytes: 100, freeBytes: 29 };
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
  const manifestUrl = new URL('../../package.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { bin: { 'loom-worker': string }; files: string[] };
  const worker = manifest.bin['loom-worker'];
  expect(manifest.files).toContain(worker.split('/')[0]);
  const directory = dirname(fileURLToPath(new URL(worker, manifestUrl)));
  const helper = join(directory, 'runtime/machine-disk-helper.js');
  const build = mkdtempSync(join(os.tmpdir(), 'loom-disk-test-'));
  try {
    const built = await import(pathToFileURL(join(directory, 'runtime/machine-check.js')).href);
    const link = join(build, 'link');
    symlinkSync('/', link);
    const report = await built.machineReader({ paths: ['/'], timeoutMs: 10_000 })();
    expect(report[0]).toMatchObject({ kind: 'disk', thing: '/', sizeBytes: expect.any(Number), freeBytes: expect.any(Number) });
    const launch = async (...args: string[]) => {
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [helper, ...args]);
      let output = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      expect(await once(child, 'close')).toEqual([0, null]);
      return output;
    };
    expect(await launch(link)).toBe('{"unknown":true,"reason":"link"}\n');
    expect(await launch('/')).toMatch(/^\{"sizeBytes":\d+,"freeBytes":\d+\}\n$/);
    expect(await launch('/', '/tmp')).toBe('{"unknown":true}\n');
    expect(await launch('/bad/../path')).toBe('{"unknown":true}\n');
    // Substitute only filesystem calls. Any statfs by watched name, or after
    // descriptor identity failed, exits with a distinct failing status.
    writeFileSync(join(build, 'descriptor-fixture.mjs'), `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const { openSync, fstatSync, lstatSync, statfsSync } = fs;
      const watched = '/descriptor-fixture';
      const mode = process.env.LOOM_DISK_FIXTURE;
      let walked = 0, opened;
      fs.lstatSync = (path, options) => {
        const fixture = typeof path === 'string' && path.endsWith(watched);
        const stat = lstatSync(fixture ? '/' : path, options);
        if (fixture) {
          walked++;
          if (mode === 'changed-after' && walked === 2) stat.ino++;
        }
        return stat;
      };
      fs.openSync = (path, flags) => {
        if (typeof path !== 'string' || !path.endsWith(watched)) return openSync(path, flags);
        if (!path.startsWith('/proc/self/fd/') ||
            flags !== (fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)) process.exit(91);
        opened = openSync('/', flags);
        return opened;
      };
      fs.fstatSync = (fd, options) => {
        const stat = fstatSync(fd, options);
        if (fd === opened && mode === 'changed-before') stat.ino++;
        return stat;
      };
      fs.statfsSync = (path, options) => {
        if (!opened || path !== '/proc/self/fd/' + opened || mode === 'changed-before') process.exit(92);
        return statfsSync(path, options);
      };
      syncBuiltinESMExports();
    `);
    const runFixture = async (mode: string) => {
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [
        '--import', join(build, 'descriptor-fixture.mjs'), helper, '/descriptor-fixture',
      ], { env: { ...process.env, LOOM_DISK_FIXTURE: mode } });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      expect(await once(child, 'close')).toEqual([0, null]);
      return output;
    };
    expect(await runFixture('stable')).toMatch(/^\{"sizeBytes":\d+/);
    expect(await runFixture('changed-before')).toBe('{"unknown":true,"reason":"link"}\n');
    expect(await runFixture('changed-after')).toBe('{"unknown":true,"reason":"link"}\n');
  } finally { rmSync(build, { recursive: true, force: true }); }
});

it('uses strictly one fixed JSON line and the same numeric bounds as the door', () => {
  expect(parseDiskResult(answer)).toEqual(data);
  expect(parseDiskResult(JSON.stringify({ sizeBytes: SIZE_BYTES_MAX, freeBytes: SIZE_BYTES_MAX }) + '\n'))
    .toEqual({ sizeBytes: SIZE_BYTES_MAX, freeBytes: SIZE_BYTES_MAX });
  expect(parseDiskResult('{"unknown":true,"reason":"link"}\n')).toEqual({ unknown: true, reason: 'link' });
  for (const output of [answer.trim(), answer + answer, answer + '\n', ' ' + answer, 'no\n', 'null\n',
    '{"sizeBytes":1,"sizeBytes":4,"freeBytes":3}\n',
    ...[{ device: 42 }, { sizeBytes: 0 }, { freeBytes: -1 },
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

it('reports every configured alias and reports HTTP errors separately from no answer, including after a restart', async () => {
  const { start } = starters(() => 200);
  const engine = vi.fn(async (_signal: AbortSignal) => 200);
  const config = { paths: ['/', '/var/lib/runtime'], engine, start };
  expect(await machineReader(config)()).toMatchObject([{ kind: 'containers', engineStatus: 200 }, disk('/'), disk('/var/lib/runtime'), { kind: 'memory' }]);
  engine.mockResolvedValueOnce(503);
  expect(await machineReader(config)()).toMatchObject([{ kind: 'containers', engineStatus: 503 }, disk('/'), disk('/var/lib/runtime'), { kind: 'memory' }]);
  engine.mockRejectedValueOnce(new Error('transport interrupted'));
  expect((await machineReader(config)())[0]).toEqual({ kind: 'containers', unknown: true });
  engine.mockImplementationOnce(signal => new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  expect((await machineReader({ ...config, timeoutMs: 10 })())[0]).toEqual({ kind: 'containers', unknown: true });
  expect(engine).toHaveBeenCalledTimes(4);
  expect(start.mock.calls).toEqual(Array.from({ length: 4 }, () => [['/'], ['/var/lib/runtime']]).flat());
});

it('uses the kernel’s available memory rather than its free pages', async () => {
  vi.spyOn(os, 'totalmem').mockReturnValue(8192 * 1024);
  vi.spyOn(os, 'freemem').mockReturnValue(128 * 1024);
  availableMemory.mockReturnValue(6144 * 1024);
  expect(await readMemory()).toEqual({ kind: 'memory', sizeBytes: 8192 * 1024, freeBytes: 6144 * 1024 });
});

it('falls back to a bounded MemAvailable read and reports unknown without a kernel estimate', async () => {
  vi.spyOn(os, 'totalmem').mockReturnValue(8192 * 1024);
  const file = { read: vi.fn(), close: vi.fn(async () => {}) };
  const open = vi.spyOn(fs, 'open').mockResolvedValue(file as never);
  const meminfo = (text: string) => file.read.mockImplementationOnce(async (buffer: Buffer) => {
    expect(buffer.byteLength).toBe(4096);
    return { bytesRead: buffer.write(text) };
  });
  meminfo('MemTotal: 8192 kB\nMemFree: 128 kB\nMemAvailable: 4096 kB\n');
  expect(await readMemory()).toEqual({ kind: 'memory', sizeBytes: 8192 * 1024, freeBytes: 4096 * 1024 });
  meminfo('MemTotal: 8192 kB\nMemFree: 128 kB\n');
  expect(await readMemory()).toEqual({ kind: 'memory', unknown: true });
  expect(open).toHaveBeenNthCalledWith(2, '/proc/meminfo', 'r');
  expect(file.close).toHaveBeenCalledTimes(2);
});
