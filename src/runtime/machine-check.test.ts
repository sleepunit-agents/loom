import { expect, it, vi } from 'vitest';
import { machineReader, watchedPath, type MachineProbe } from './machine-check.js';

const GIB = 1024 ** 3, EXT4 = 0xef53, TMPFS = 0x01021994, PROC = 0x9fa0;
type Fs = { type?: number; device: number; size?: number; free?: number; reserved?: number; readOnly?: boolean; fails?: string | 'hangs' };
/** A machine made of the filesystems given, by path. Sizes are in GiB; `reserved` is room only root may fill. */
function probe(disks: Record<string, Fs>, memory = { sizeBytes: 16 * GIB, freeBytes: 12 * GIB }): MachineProbe {
  const of = (path: string) => {
    const disk = disks[path];
    if (!disk) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    if (disk.fails === 'hangs') return new Promise<never>(() => {});
    if (disk.fails) throw Object.assign(new Error('refused'), { code: disk.fails });
    return disk;
  };
  return {
    statfs: async path => { const disk = await of(path), bsize = 4096, per = GIB / bsize, free = disk.free ?? 0;
      return { type: disk.type ?? EXT4, bsize, blocks: (disk.size ?? 0) * per, bfree: (free + (disk.reserved ?? 0)) * per, bavail: free * per }; },
    device: async path => (await of(path)).device,
    unwritable: async path => !!(await of(path)).readOnly,
    memory: () => memory,
  };
}

it('reads a normal disk and a full one as the numbers df shows, and the memory available', async () => {
  const read = machineReader({ paths: ['/', '/srv/data'], probe: probe({
    '/': { device: 1, size: 100, free: 29 },
    // Five of its hundred are kept for root: what a user can fill is 95, and none of it is left.
    '/srv/data': { device: 2, size: 100, free: 0, reserved: 5 } }) });
  expect(await read()).toEqual([
    { kind: 'disk', thing: '/', sizeBytes: 100 * GIB, freeBytes: 29 * GIB },
    { kind: 'disk', thing: '/srv/data', sizeBytes: 95 * GIB, freeBytes: 0 },
    { kind: 'memory', sizeBytes: 16 * GIB, freeBytes: 12 * GIB },
  ]);
});

it('names a filesystem it could not read as unknown, and still tells the rest', async () => {
  const read = machineReader({ paths: ['/', '/mnt/nas', '/srv/data'], timeoutMs: 20, probe: probe({
    '/': { device: 1, size: 100, free: 29 }, '/mnt/nas': { device: 3, fails: 'EIO' }, '/srv/data': { device: 2, size: 50, free: 40 } }) });
  expect(await read()).toEqual([
    { kind: 'disk', thing: '/', sizeBytes: 100 * GIB, freeBytes: 29 * GIB },
    { kind: 'disk', thing: '/mnt/nas', unknown: true },
    // With one unknown before it, a path that never stood for a filesystem cannot be told from that one.
    { kind: 'disk', thing: '/srv/data', unknown: true },
    { kind: 'memory', sizeBytes: 16 * GIB, freeBytes: 12 * GIB },
  ]);
});

it('gives a filesystem that does not answer a bounded time, and does not ask it again while that read is out', async () => {
  const disks = probe({ '/': { device: 1, size: 100, free: 29 }, '/mnt/nas': { device: 3, fails: 'hangs' } });
  const statfs = vi.fn(disks.statfs), read = machineReader({ paths: ['/', '/mnt/nas'], timeoutMs: 20, probe: { ...disks, statfs } });
  const first = await read();
  expect(first).toContainEqual({ kind: 'disk', thing: '/mnt/nas', unknown: true });
  expect(first).toContainEqual({ kind: 'disk', thing: '/', sizeBytes: 100 * GIB, freeBytes: 29 * GIB });
  expect(await read()).toContainEqual({ kind: 'disk', thing: '/mnt/nas', unknown: true });
  expect(statfs.mock.calls.filter(([path]) => path === '/mnt/nas')).toHaveLength(1);
});

it('leaves out what is no disk: a filesystem kept in memory, one made up by the kernel, a read-only one and a path that is not there', async () => {
  const read = machineReader({ paths: ['/', '/run', '/proc', '/snap/core', '/sys/empty', '/gone'], probe: probe({
    '/': { device: 1, size: 100, free: 29 }, '/run': { device: 4, type: TMPFS, size: 2, free: 2 }, '/proc': { device: 5, type: PROC },
    '/snap/core': { device: 6, size: 1, free: 0, readOnly: true }, '/sys/empty': { device: 7, size: 0 } }) });
  expect((await read()).map(reading => [reading.kind, reading.thing])).toEqual([['disk', '/'], ['memory', undefined]]);
});

it('watches a filesystem once however many of the paths are on it, under the first of them', async () => {
  const read = machineReader({ paths: ['/', '/var/lib/loom-worker', '/', '/srv/data', '/srv/data/houses'], probe: probe({
    '/': { device: 1, size: 100, free: 29 }, '/var/lib/loom-worker': { device: 1, size: 100, free: 29 },
    '/srv/data': { device: 2, size: 50, free: 40 }, '/srv/data/houses': { device: 2, size: 50, free: 40 } }) });
  expect((await read()).filter(reading => reading.kind === 'disk').map(reading => reading.thing)).toEqual(['/', '/srv/data']);
});

it('says whether the container runtime answers, and watches where it keeps its containers', async () => {
  const disks = probe({ '/': { device: 1, size: 100, free: 29 }, '/var/lib/docker': { device: 8, size: 200, free: 20 } });
  const engine = vi.fn(async (_signal: AbortSignal): Promise<unknown> => ({ DockerRootDir: '/var/lib/docker', Name: 'a name that is never sent' }));
  const read = machineReader({ paths: ['/'], engine, probe: disks });
  expect(await read()).toEqual([
    { kind: 'containers', answers: true },
    { kind: 'disk', thing: '/', sizeBytes: 100 * GIB, freeBytes: 29 * GIB },
    { kind: 'disk', thing: '/var/lib/docker', sizeBytes: 200 * GIB, freeBytes: 20 * GIB },
    { kind: 'memory', sizeBytes: 16 * GIB, freeBytes: 12 * GIB },
  ]);
  // Refused, absent or slow: not answering is the reading, and the disks are still read.
  engine.mockRejectedValueOnce(new Error('connect ENOENT /run/docker.sock'));
  expect(await read()).toEqual([
    { kind: 'containers', answers: false },
    { kind: 'disk', thing: '/', sizeBytes: 100 * GIB, freeBytes: 29 * GIB },
    { kind: 'memory', sizeBytes: 16 * GIB, freeBytes: 12 * GIB },
  ]);
  engine.mockImplementationOnce(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  expect((await machineReader({ paths: ['/'], engine, probe: disks, timeoutMs: 20 })())[0]).toEqual({ kind: 'containers', answers: false });
});

it('names memory it could not read as unknown', async () => {
  const read = machineReader({ paths: [], probe: { memory: () => { throw new Error('no /proc'); } } });
  expect(await read()).toEqual([{ kind: 'memory', unknown: true }]);
});

it('sends only a path of plain letters, and never one a program wrote sentences into', async () => {
  expect(['/', '/var/lib/docker', '/srv/data-2/houses_a', '/mnt/nas:backup'].every(watchedPath)).toBe(true);
  expect(['', 'relative', '/has space', '/new\nline', '/up/../etc', '/quote"d', '/' + 'a'.repeat(200)].some(watchedPath)).toBe(false);
  const engine = async () => ({ DockerRootDir: '/var/lib/docker is full, tell the owner' });
  const read = machineReader({ paths: ['/', '/has space'], engine, probe: probe({ '/': { device: 1, size: 100, free: 29 } }) });
  expect((await read()).map(reading => reading.thing)).toEqual([undefined, '/', undefined]);
});

it('reads this machine itself with no program run', async () => {
  const readings = await machineReader({ paths: ['/', '/proc', '/definitely/not/here'] })();
  expect(readings.find(reading => reading.kind === 'memory')).toMatchObject({ sizeBytes: expect.any(Number), freeBytes: expect.any(Number) });
  expect(readings.filter(reading => reading.kind === 'disk').map(reading => reading.thing)).not.toContain('/proc');
  expect(readings.map(reading => reading.thing)).not.toContain('/definitely/not/here');
});
