import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
const fakes = vi.hoisted(() => ({ lock: vi.fn(), create: vi.fn(), run: vi.fn() }));
vi.mock('../transport/http-lock.js', () => ({ acquireHttpLock: fakes.lock }));
vi.mock('../core/app.js', () => ({ createFoundation: fakes.create }));
vi.mock('../pieces/tasks/importer.js', () => ({ importTasks: fakes.run }));
import { migrateTasks } from './migrate-tasks.js';
afterEach(() => vi.resetAllMocks());
const io = () => ({ stdout: vi.fn(), stderr: vi.fn(), stdin: Readable.from([]), stdinIsTTY: false, env: { LOOM_HOME: '/fixture/home' } });
it('refuses a running home before opening the destination', async () => {
  fakes.lock.mockImplementation(() => { throw new Error('daemon already running'); });
  expect(await migrateTasks(['--from','/fixture/source'], io())).toBe(1);
  expect(fakes.create).not.toHaveBeenCalled(); expect(fakes.run).not.toHaveBeenCalled();
});
it.each([false,true])('holds the home lock throughout import and releases it on failure=%s', async failure => {
  const release = vi.fn(), close = vi.fn(), db = {};
  fakes.lock.mockReturnValue(release); fakes.create.mockReturnValue({ db, close });
  fakes.run.mockImplementation(() => { expect(release).not.toHaveBeenCalled(); if (failure) throw new Error('interrupted'); return { ok: true }; });
  expect(await migrateTasks(['--from','/fixture/source'], io())).toBe(failure ? 1 : 0);
  expect(close).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  expect(fakes.lock).toHaveBeenCalledWith('/fixture/home');
});

it('loads and forwards the coordinator epic-project map; malformed map fails with lock released', async () => {
  const dir = mkdtempSync(join(tmpdir(),'loom-task-map-')), path = join(dir,'map.json');
  const release = vi.fn(), close = vi.fn(); fakes.lock.mockReturnValue(release); fakes.create.mockReturnValue({ db: {}, close }); fakes.run.mockReturnValue({ ok: true });
  try {
    writeFileSync(path, JSON.stringify({ 't-1': 'pond' }));
    expect(await migrateTasks(['--from','/fixture/source','--projects',path], io())).toBe(0);
    expect(fakes.run.mock.calls[0][3]).toEqual({ projects: { 't-1': 'pond' } });
    writeFileSync(path, '[]'); fakes.create.mockClear(); release.mockClear();
    expect(await migrateTasks(['--from','/fixture/source','--projects',path], io())).toBe(1);
    expect(fakes.create).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
