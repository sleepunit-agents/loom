import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
const fakes = vi.hoisted(() => ({ lock: vi.fn(), create: vi.fn(), run: vi.fn() }));
vi.mock('../transport/http-lock.js', () => ({ acquireHttpLock: fakes.lock }));
vi.mock('../core/app.js', () => ({ createFoundation: fakes.create }));
vi.mock('../pieces/clock/importer.js', () => ({ importClock: fakes.run }));
import { migrateClock } from './migrate-clock.js';
afterEach(() => vi.resetAllMocks());
const io = () => ({ stdout: vi.fn(), stderr: vi.fn(), stdin: Readable.from([]), stdinIsTTY: false, env: { LOOM_HOME: '/fixture/home' } });
it('refuses a running home before opening the destination', async () => {
  fakes.lock.mockImplementation(() => { throw new Error('daemon already running'); });
  expect(await migrateClock(['--from','/fixture/source'], io())).toBe(1);
  expect(fakes.create).not.toHaveBeenCalled(); expect(fakes.run).not.toHaveBeenCalled();
});
it.each([false,true])('holds the home lock throughout import and releases it on failure=%s', async failure => {
  const release = vi.fn(), close = vi.fn(), db = {};
  fakes.lock.mockReturnValue(release); fakes.create.mockReturnValue({ db, close });
  fakes.run.mockImplementation(() => { expect(release).not.toHaveBeenCalled(); if (failure) throw new Error('interrupted'); return { ok: true }; });
  expect(await migrateClock(['--from','/fixture/source'], io())).toBe(failure ? 1 : 0);
  expect(close).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  expect(fakes.lock).toHaveBeenCalledWith('/fixture/home');
});

