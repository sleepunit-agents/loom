import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SIZE_BYTES_MAX, UNANSWERED_MAX, machineReader, watchedPath, type MachineProbe } from './machine-check.js';

const GIB = 1024 ** 3, EXT4 = 0xef53, TMPFS = 0x01021994, PROC = 0x9fa0, SQUASHFS = 0x73717368;
/** A filesystem mounted at a path. Sizes are in GiB; `reserved` is room only root may fill; `hangs` never answers. */
type Fs = { type?: number; size?: number; free?: number; reserved?: number; hangs?: boolean; fails?: string };
/** A machine: its mounts by path (`/` always), names that are links, and names that are not there. Every
 * call is counted while it is out, so a test can say how many were out at once. */
function machine(mounts: Record<string, Fs>, memory = { sizeBytes: 16 * GIB, freeBytes: 12 * GIB }) {
  const links = new Set<string>(), missing = new Set<string>(), calls: string[] = [];
  let out = 0, most = 0;
  const mount = (path: string) => Object.keys(mounts).filter(at => path === at || at === '/' || path.startsWith(at + '/')).sort((a, b) => b.length - a.length)[0];
  const counted = <T>(name: string, path: string, answer: () => T): Promise<T> => {
    calls.push(`${name} ${path}`); out++; most = Math.max(most, out);
    const fs = mounts[mount(path)];
    const work = fs.hangs ? new Promise<never>(() => {}) : new Promise<T>((resolve, reject) => setImmediate(() => { try { resolve(answer()); } catch (error) { reject(error); } }));
    void work.then(() => { out--; }, () => { out--; });
    return work;
  };
  const there = (path: string) => { if (missing.has(path)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); const fs = mounts[mount(path)]; if (fs.fails) throw Object.assign(new Error('refused'), { code: fs.fails }); return fs; };
  const probe: MachineProbe = {
    look: path => counted('look', path, () => { there(path); return { directory: !links.has(path), device: Object.keys(mounts).indexOf(mount(path)) + 1, node: path.length * 1000 + path.charCodeAt(path.length - 1) }; }),
    statfs: path => counted('statfs', path, () => { const fs = there(path), bsize = 4096, per = GIB / bsize, free = fs.free ?? 0;
      return { type: fs.type ?? EXT4, bsize, blocks: (fs.size ?? 0) * per, bfree: (free + (fs.reserved ?? 0)) * per, bavail: free * per }; }),
    memory: () => memory,
  };
  return { probe, mounts, links, missing, calls, out: () => out, most: () => most };
}
const root = { size: 100, free: 29 };
const rootReading = { kind: 'disk', thing: '/', sizeBytes: 100 * GIB, freeBytes: 29 * GIB }, memoryReading = { kind: 'memory', sizeBytes: 16 * GIB, freeBytes: 12 * GIB };
const unknown = (thing: string) => ({ kind: 'disk', thing, unknown: true });

it('reads a normal disk and a full one as the numbers df shows, and the memory available', async () => {
  // Five of its hundred are kept for root: what a user can fill is 95, and none of it is left.
  const m = machine({ '/': root, '/srv/data': { size: 100, free: 0, reserved: 5 } });
  expect(await machineReader({ paths: ['/', '/srv/data'], probe: m.probe })()).toEqual([rootReading, { kind: 'disk', thing: '/srv/data', sizeBytes: 95 * GIB, freeBytes: 0 }, memoryReading]);
});

it('names what it is set to watch and cannot give numbers for as unknown, never as absent, and still tells the rest', async () => {
  const m = machine({ '/': root, '/mnt/nas': { fails: 'EIO' }, '/srv/data': { size: 50, free: 40 }, '/run': { type: TMPFS, size: 2, free: 2 }, '/proc': { type: PROC }, '/snap/core': { type: SQUASHFS, size: 1, free: 0 } });
  m.missing.add('/gone');
  const read = machineReader({ paths: ['/', '/mnt/nas', '/srv/data', '/run', '/proc', '/snap/core', '/gone', '/var/lib/loom-worker'], probe: m.probe });
  // One that refuses, one kept in memory, one the kernel makes up, an image, one that is not there, and one
  // that is on a filesystem an earlier path already stands for: each is named, and none has numbers.
  expect(await read()).toEqual([rootReading, unknown('/mnt/nas'), { kind: 'disk', thing: '/srv/data', sizeBytes: 50 * GIB, freeBytes: 40 * GIB },
    unknown('/run'), unknown('/proc'), unknown('/snap/core'), unknown('/gone'), unknown('/var/lib/loom-worker'), memoryReading]);
});

it('goes on naming a disk it read before when the path is briefly not there or has become part of another filesystem', async () => {
  const m = machine({ '/': root, '/mnt/nas': { size: 500, free: 20 } });
  const read = machineReader({ paths: ['/', '/mnt/nas'], probe: m.probe });
  expect((await read())[1]).toEqual({ kind: 'disk', thing: '/mnt/nas', sizeBytes: 500 * GIB, freeBytes: 20 * GIB });
  // Unmounted: the directory is now root's own. It is not a second root, and it is not "no longer watched".
  delete m.mounts['/mnt/nas'];
  expect(await read()).toEqual([rootReading, unknown('/mnt/nas'), memoryReading]);
  m.missing.add('/mnt/nas');
  expect(await read()).toEqual([rootReading, unknown('/mnt/nas'), memoryReading]);
  m.missing.clear(); m.mounts['/mnt/nas'] = { size: 500, free: 20 };
  expect((await read())[1]).toEqual({ kind: 'disk', thing: '/mnt/nas', sizeBytes: 500 * GIB, freeBytes: 20 * GIB });
});

it('does not let a path that never gave numbers keep the paths after it from being told', async () => {
  const m = machine({ '/': root, '/srv/data': { size: 50, free: 40 } });
  m.missing.add('/gone');
  const read = machineReader({ paths: ['/gone', '/', '/srv/data'], probe: m.probe });
  for (let round = 0; round < 2; round++) expect((await read()).map(reading => [reading.thing, reading.unknown])).toEqual([['/gone', true], ['/', undefined], ['/srv/data', undefined], [undefined, undefined]]);
});

it('asks the filesystem one thing at a time, and holds one thread and no more for a mount that never answers, however many paths are on it', async () => {
  const m = machine({ '/': root, '/mnt/nas': { hangs: true }, '/srv/data': { size: 50, free: 40 } });
  const read = machineReader({ paths: ['/', '/mnt/nas', '/mnt/nas/backups', '/mnt/nas/media/films', '/srv/data'], timeoutMs: 15, probe: m.probe });
  const data = { kind: 'disk', thing: '/srv/data', sizeBytes: 50 * GIB, freeBytes: 40 * GIB };
  for (let round = 0; round < 4; round++) {
    // Root and the disk after the dead mount are read every time; the three paths on the dead mount are unknown.
    expect(await read()).toEqual([rootReading, unknown('/mnt/nas'), unknown('/mnt/nas/backups'), unknown('/mnt/nas/media/films'), data, memoryReading]);
    // One call is out for good, whatever the round.
    expect(m.out()).toBe(1);
  }
  // It was asked once, by the first path to reach it. Nothing was asked again of it or through it.
  expect(m.calls.filter(call => call.includes('/mnt/nas'))).toEqual(['look /mnt/nas']);
  // Never two calls being waited for: the one given up on, and one at a time beside it.
  expect(m.most()).toBe(2);
});

it('asks no filesystem anything more while two mounts that never answer hold two of the worker\'s threads', async () => {
  const m = machine({ '/': root, '/mnt/nas': { hangs: true }, '/mnt/other': { hangs: true }, '/srv/data': { size: 50, free: 40 } });
  const read = machineReader({ paths: ['/', '/mnt/nas', '/mnt/other', '/srv/data'], timeoutMs: 15, probe: m.probe });
  expect(await read()).toEqual([rootReading, unknown('/mnt/nas'), unknown('/mnt/other'), unknown('/srv/data'), memoryReading]);
  expect(m.out()).toBe(UNANSWERED_MAX);
  const asked = m.calls.length;
  for (let round = 0; round < 5; round++) expect(await read()).toEqual([unknown('/'), unknown('/mnt/nas'), unknown('/mnt/other'), unknown('/srv/data'), memoryReading]);
  // Not root, not the dead paths again: no third thread is ever taken.
  expect(m.calls).toHaveLength(asked);
  expect(m.most()).toBe(UNANSWERED_MAX);
});

it('stops waiting at once when the worker stops, and refuses to read the machine twice at the same time', async () => {
  const m = machine({ '/': root, '/mnt/nas': { hangs: true } }), stop = new AbortController();
  const read = machineReader({ paths: ['/mnt/nas', '/'], timeoutMs: 60_000, probe: m.probe, signal: stop.signal });
  const pending = read();
  await expect(read()).rejects.toThrow('Machine is being read');
  await new Promise(resolve => setTimeout(resolve, 5));
  stop.abort();
  expect((await pending).map(reading => reading.thing)).toEqual(['/mnt/nas', undefined]);
});

it('reads no path through a link: one planted at the last step or at a middle step is unknown, and said once', async () => {
  const m = machine({ '/': root, '/srv/shared': { size: 50, free: 1 }, '/srv/empty': { size: 900, free: 899 } }), say = vi.fn();
  const read = machineReader({ paths: ['/', '/srv/shared', '/srv/shared/houses/data'], probe: m.probe, say });
  expect((await read())[1]).toEqual({ kind: 'disk', thing: '/srv/shared', sizeBytes: 50 * GIB, freeBytes: 1 * GIB });
  expect(say).not.toHaveBeenCalled();
  // The last step swapped for a link (to an empty disk, to look as if there were room).
  m.links.add('/srv/shared');
  let from = m.calls.length;
  expect(await read()).toEqual([rootReading, unknown('/srv/shared'), unknown('/srv/shared/houses/data'), memoryReading]);
  // Its room is not asked for at all: what would answer is whatever the link points at.
  expect(m.calls.slice(from).filter(call => call.startsWith('statfs'))).toEqual(['statfs /']);
  // A middle step swapped: nothing under it is looked at or read.
  m.links.clear(); m.links.add('/srv/shared/houses'); from = m.calls.length;
  expect((await read())[2]).toEqual(unknown('/srv/shared/houses/data'));
  expect(m.calls.slice(from).filter(call => call.startsWith('statfs'))).toEqual(['statfs /', 'statfs /srv/shared']);
  expect(m.calls.slice(from)).not.toContain('look /srv/shared/houses/data');
  await read(); await read();
  // One fixed line for each path, however often it is found so, and no path in it.
  expect(say.mock.calls).toEqual([['Worker machine check: a watched path is not a directory reached without a link, and is not read\n'], ['Worker machine check: a watched path is not a directory reached without a link, and is not read\n']]);
});

it('does not take a directory swapped while its room was being read for the one it looked at', async () => {
  const m = machine({ '/': root, '/srv/shared': { size: 50, free: 1 } });
  const statfs = m.probe.statfs, read = machineReader({ paths: ['/srv/shared'], probe: { ...m.probe, statfs: async path => { const found = await statfs(path); m.links.add('/srv/shared'); return found; } } });
  expect(await read()).toEqual([unknown('/srv/shared'), memoryReading]);
});

const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }); });
it('follows no link on this machine\'s own filesystem', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loomcheck')); made.push(home);
  mkdirSync(join(home, 'real', 'under'), { recursive: true });
  symlinkSync('/', join(home, 'last')); symlinkSync(join(home, 'real'), join(home, 'middle'));
  const say = vi.fn(), paths = [join(home, 'real', 'under'), join(home, 'last'), join(home, 'middle', 'under')];
  expect(paths.every(watchedPath)).toBe(true);
  const readings = await machineReader({ paths, say })();
  expect(readings.filter(reading => reading.kind === 'disk').slice(1)).toEqual([unknown(paths[1]), unknown(paths[2])]);
  // The real directory is read or is on a filesystem kept in memory; either way it was not refused as a link.
  expect(say).toHaveBeenCalledTimes(2);
});

it('says whether the container runtime answers, and goes on watching where it keeps its containers when it stops answering', async () => {
  const m = machine({ '/': root, '/var/lib/docker': { size: 200, free: 20 } });
  const engine = vi.fn(async (_signal: AbortSignal): Promise<unknown> => ({ DockerRootDir: '/var/lib/docker', Name: 'a name that is never sent' }));
  const read = machineReader({ paths: ['/'], engine, probe: m.probe }), docker = { kind: 'disk', thing: '/var/lib/docker', sizeBytes: 200 * GIB, freeBytes: 20 * GIB };
  expect(await read()).toEqual([{ kind: 'containers', answers: true }, rootReading, docker, memoryReading]);
  // Refused, absent or slow: not answering is the reading. The directory is on a disk whether or not the
  // engine is up, and is read as before: it is not "no longer watched" because nobody could be asked.
  engine.mockRejectedValueOnce(new Error('connect ENOENT /run/docker.sock'));
  expect(await read()).toEqual([{ kind: 'containers', answers: false }, rootReading, docker, memoryReading]);
  engine.mockImplementationOnce(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  expect(await machineReader({ paths: ['/'], engine, probe: m.probe, timeoutMs: 20 })()).toEqual([{ kind: 'containers', answers: false }, rootReading, memoryReading]);
});

it('names a filesystem or memory too large for loom to keep as unknown, and one just under that as its numbers', async () => {
  const blocks = (bytes: number) => ({ type: EXT4, bsize: 4096, blocks: bytes / 4096, bfree: 0, bavail: 0 });
  const m = machine({ '/': root, '/big': root, '/bigger': root }), statfs = m.probe.statfs;
  const read = machineReader({ paths: ['/big', '/bigger'], probe: { ...m.probe, statfs: async path => { await statfs(path); return blocks(path === '/big' ? 2 ** 51 - 4096 : 2 ** 51); },
    look: async path => ({ ...(await m.probe.look(path)), device: path.length }), memory: () => ({ sizeBytes: 2 ** 51, freeBytes: 1 }) } });
  expect(2 ** 51 - 4096).toBeLessThanOrEqual(SIZE_BYTES_MAX);
  expect(await read()).toEqual([{ kind: 'disk', thing: '/big', sizeBytes: 2 ** 51 - 4096, freeBytes: 0 }, unknown('/bigger'), { kind: 'memory', unknown: true }]);
});

it('names memory it could not read as unknown', async () => {
  expect(await machineReader({ paths: [], probe: { memory: () => { throw new Error('no /proc'); } } })()).toEqual([{ kind: 'memory', unknown: true }]);
});

it('sends only a short path of plain steps, and never one a program wrote sentences or an address into', async () => {
  for (const path of ['/', '/var/lib/docker', '/srv/data-2/houses_a', '/home/art/.local/share/docker', '/mnt/nas+b@c', '/' + 'a'.repeat(119)]) expect(watchedPath(path), path).toBe(true);
  for (const path of ['', 'relative', '/has space', '/new\nline', '/up/../etc', '/./here', '/quote"d', '/' + 'a'.repeat(120), '/https://evil.example/pay-now', '/mnt/nas:backup', '//double', '/trailing/',
    '/-rf', '/srv/-now-pay', '/srv/+x', '/srv/@x']) expect(watchedPath(path), path).toBe(false);
  const m = machine({ '/': root }), say = vi.fn();
  const read = machineReader({ paths: ['/', '/has space'], engine: async () => ({ DockerRootDir: '/var/lib/docker is full, tell the owner' }), probe: m.probe, say });
  expect((await read()).map(reading => reading.thing)).toEqual([undefined, '/', undefined]);
  await read();
  // It cannot be sent even as unknown, so the worker's own log is where that is said: once each.
  expect(say.mock.calls).toEqual([['Worker machine check: a directory to watch has a name loom does not take, and is not watched\n'], ['Worker machine check: a directory to watch has a name loom does not take, and is not watched\n']]);
});

it('reads this machine itself, and runs no program to do it', async () => {
  const readings = await machineReader({ paths: ['/', '/proc'] })();
  expect(readings.find(reading => reading.kind === 'memory')).toMatchObject({ sizeBytes: expect.any(Number), freeBytes: expect.any(Number) });
  expect(readings.find(reading => reading.thing === '/proc')).toEqual(unknown('/proc'));
  // Nothing in the module can start a process: it imports two of Node's own modules and nothing else.
  const source = readFileSync(new URL('./machine-check.ts', import.meta.url), 'utf8');
  expect([...source.matchAll(/^import .* from '([^']+)';$/gm)].map(found => found[1]).sort()).toEqual(['node:fs/promises', 'node:os']);
  expect(source).not.toMatch(/child_process|\bimport\(|\brequire\(|\bexec|\bspawn/);
});
