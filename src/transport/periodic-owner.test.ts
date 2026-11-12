import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { OWNER_RETRY_MS, PeriodicOwner } from './periodic-owner.js';

it('elects one of three listeners, drains retirement, and transfers without overlapping jobs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-'));
  const elected = [0, 0, 0];
  const owners = elected.map((_, i) => new PeriodicOwner(home, () => { elected[i]++; }));
  try {
    owners.forEach(o => o.setEligible(true));
    expect(owners.map(o => o.active)).toEqual([true, false, false]);
    let finish!: () => void;
    let started = 0;
    const work = owners[0].run('slow', async () => { started++; await new Promise<void>(r => { finish = r; }); });
    await Promise.resolve();
    expect(owners[0].run('slow', () => { started++; })).toBe(work);
    owners[0].setEligible(false);
    await owners[0].run('late', () => { throw new Error('retired work ran'); });
    owners[1].setEligible(true);
    expect(owners[1].active).toBe(false); // A retiring owner's admitted pass still owns the file lock.
    finish(); await work;
    await expect.poll(() => owners[1].active || owners[2].active, { timeout: OWNER_RETRY_MS * 4 }).toBe(true);
    expect(owners.filter(o => o.active)).toHaveLength(1);
    expect(started).toBe(1);
    expect(elected.reduce((a, b) => a + b)).toBe(2);
  } finally { await Promise.all(owners.map(o => o.close())); rmSync(home, { recursive: true, force: true }); }
});

it('takes over an OS lock after the owner is killed, without deleting its lock file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-kill-'));
  // A real independent process holds exactly the same SQLite lock as the worker. No mocked lock or stale PID.
  const require = createRequire(import.meta.url);
  const script = join(home, 'hold.cjs');
  writeFileSync(script, `const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});\nconst db = new D(process.argv[2]); db.exec('BEGIN EXCLUSIVE'); process.send('locked'); setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [script, join(home, 'periodic-owner.db')], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const owner = new PeriodicOwner(home, () => undefined);
  try {
    await once(child, 'message');
    owner.setEligible(true);
    expect(owner.active).toBe(false);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await expect.poll(() => owner.active, { timeout: OWNER_RETRY_MS * 4 }).toBe(true);
  } finally { child.kill('SIGKILL'); await owner.close(); rmSync(home, { recursive: true, force: true }); }
});
