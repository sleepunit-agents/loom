import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeriodicOwner } from './periodic-owner.js';
import { startHttpServer } from './http-server.js';
import { runBackupTick } from '../backup-tick.js';
import type { Household } from '../household.js';

it('HTTP scoped factories cannot claim periodic ownership', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-scoped-owner-'));
  const contender = new PeriodicOwner(home, () => {});
  const server = await startHttpServer({ contextDir: home, host: '127.0.0.1', port: 0, tokens: { test: 'art' }, createServer: () => { throw new Error('no requests'); } });
  try { server.setBackgroundActive(true); contender.setEligible(true); expect(contender.active).toBe(true); }
  finally { await contender.close(); await server.close(); rmSync(home, { recursive: true, force: true }); }
});
it('a supervised HTTP standby remains ineligible until supervisor activation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-standby-owner-'));
  const prior = process.env.LOOM_WORKER_SOCKET, connected = Object.getOwnPropertyDescriptor(process, 'connected');
  process.env.LOOM_WORKER_SOCKET = join(home, 'worker.sock');
  Object.defineProperty(process, 'connected', { value: true, configurable: true });
  let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  const contender = new PeriodicOwner(home, () => {});
  try {
    server = await startHttpServer({ contextDir: home, host: '127.0.0.1', port: 0, token: 'test' });
    contender.setEligible(true); expect(contender.active).toBe(true);
    contender.setEligible(false); server.setBackgroundActive(true);
    contender.setEligible(true); expect(contender.active).toBe(false);
  } finally {
    await contender.close(); await server?.close();
    if (prior === undefined) delete process.env.LOOM_WORKER_SOCKET; else process.env.LOOM_WORKER_SOCKET = prior;
    if (connected) Object.defineProperty(process, 'connected', connected); else Reflect.deleteProperty(process, 'connected');
    rmSync(home, { recursive: true, force: true });
  }
});
it('an admitted detached backup drains before retirement releases the HTTP owner', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-backup-owner-'));
  const entry = join(home, 'backup.cjs');
  writeFileSync(entry, `const fs=require('node:fs'),p=${JSON.stringify(home)};fs.writeFileSync(p+'/started','yes');const t=setInterval(()=>{if(fs.existsSync(p+'/finish')){clearInterval(t);}},20);`);
  const owner = new PeriodicOwner(home, () => {}), successor = new PeriodicOwner(home, () => {});
  owner.setEligible(true);
  const work = runBackupTick(owner, { home } as Household, {}, { entry, wanted: () => true });
  try {
    await expect.poll(() => existsSync(join(home, 'started'))).toBe(true);
    owner.setEligible(false); successor.setEligible(true); expect(successor.active).toBe(false);
    writeFileSync(join(home, 'finish'), 'yes'); await work;
    await expect.poll(() => successor.active).toBe(true);
  } finally { writeFileSync(join(home, 'finish'), 'yes'); await work; await owner.close(); await successor.close(); rmSync(home, { recursive: true, force: true }); }
});
