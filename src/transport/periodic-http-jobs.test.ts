import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from './http-server.js';
import { loadHousehold } from '../household.js';
import { PeriodicOwner } from './periodic-owner.js';

const jobs = vi.hoisted(() => ({ push: vi.fn(async () => {}), needs: vi.fn(async () => {}), backup: vi.fn(), entry: '' }));
vi.mock('../ui/handler.js', async original => ({ ...await original<typeof import('../ui/handler.js')>(), pushWatch: jobs.push }));
vi.mock('../needs-resolve.js', async original => ({ ...await original<typeof import('../needs-resolve.js')>(), resolveNeeds: jobs.needs }));
vi.mock('../backup-tick.js', async original => {
  const actual = await original<typeof import('../backup-tick.js')>();
  return { ...actual, runBackupTick: (...args: Parameters<typeof actual.runBackupTick>) => { jobs.backup(); return actual.runBackupTick(args[0], args[1], args[2], { wanted: () => true, entry: jobs.entry }); } };
});

it.each(['retire', 'close'].flatMap(mode => ['push', 'needs', 'backup'].map(last => ({ mode, last }))))('HTTP $mode retains ownership with $last finishing last', async ({ mode, last }) => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-jobs-'));
  mkdirSync(join(home, 'agents', 'art'), { recursive: true });
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  const h = loadHousehold(home)!;
  jobs.entry = join(home, 'backup.cjs');
  writeFileSync(jobs.entry, `const fs=require('node:fs'),p=${JSON.stringify(home)};fs.writeFileSync(p+'/started','yes');const t=setInterval(()=>{if(fs.existsSync(p+'/release'))clearInterval(t);},10);`);
  let releasePush!: () => void, releaseNeeds!: () => void;
  const push = new Promise<void>(r => { releasePush = r; }), needs = new Promise<void>(r => { releaseNeeds = r; });
  jobs.push.mockReset().mockImplementation(() => push); jobs.needs.mockReset().mockImplementation(() => needs); jobs.backup.mockClear();
  const callbacks: Array<{ f: () => void; ms: number }> = [];
  const interval = globalThis.setInterval;
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((f: () => void, ms: number) => { callbacks.push({ f, ms }); return interval(f, ms); }) as typeof setInterval);
  const prior = process.env.LOOM_HOME; process.env.LOOM_HOME = home;
  const contender = new PeriodicOwner(home, () => {});
  let first: Awaited<ReturnType<typeof startHttpServer>> | undefined, follower: typeof first;
  let closing: Promise<void> | undefined;
  try {
    first = await startHttpServer({ contextDir: join(home, 'agents', 'art'), household: h, host: '127.0.0.1', port: 0, token: 'test' });
    follower = await startHttpServer({ contextDir: join(home, 'agents', 'art'), household: h, host: '127.0.0.1', port: 0, token: 'test' });
    const timers = callbacks.filter(c => c.ms === 60_000 || c.ms === 600_000);
    for (const c of timers) c.f();
    await expect.poll(() => existsSync(join(home, 'started'))).toBe(true);
    expect(jobs.push).toHaveBeenCalledTimes(1); expect(jobs.needs).toHaveBeenCalledTimes(1); expect(jobs.backup).toHaveBeenCalledTimes(1);
    follower.setBackgroundActive(false);
    if (mode === 'retire') first.setBackgroundActive(false); else closing = first.close();
    contender.setEligible(true); expect(contender.active).toBe(false);
    for (const c of timers) c.f();
    expect(jobs.push).toHaveBeenCalledTimes(1); expect(jobs.needs).toHaveBeenCalledTimes(1); expect(jobs.backup).toHaveBeenCalledTimes(1);
    const releases = { push: releasePush, needs: releaseNeeds, backup: () => { writeFileSync(join(home, 'release'), 'yes'); } };
    for (const [name, release] of Object.entries(releases)) if (name !== last) release();
    await new Promise(resolve => setTimeout(resolve, 100));
    contender.setEligible(true); // Try now, while this particular job is still blocked.
    expect(contender.active).toBe(false);
    releases[last as keyof typeof releases]();
    await expect.poll(() => contender.active).toBe(true);
    await closing;
  } finally {
    releasePush(); releaseNeeds(); writeFileSync(join(home, 'release'), 'yes');
    await contender.close(); await closing; await first?.close(); await follower?.close();
    spy.mockRestore(); if (prior === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = prior;
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
