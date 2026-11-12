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
it('full standalone HTTP listeners share elected manifest work and retirement suppresses provider calls', async () => {
  const { request } = await import('node:http');
  const { chmodSync, readFileSync } = await import('node:fs');
  const { piecesMoved } = await import('../ui/live.js');
  const { withLog } = await import('../collections/log.js');
  const home = mkdtempSync(join(tmpdir(), 'loom-standalone-manifests-'));
  const path = join(home, 'loom-probe');
  writeFileSync(path, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(home, 'calls'))},'call\\n');console.log(JSON.stringify({v:2,tile:{label:'Probe',value:'one'}}));`); chmodSync(path, 0o755);
  const priorHome = process.env.LOOM_HOME, priorPath = process.env.PATH;
  process.env.LOOM_HOME = home; process.env.PATH = `${home}:/usr/bin:/bin`;
  const first = await startHttpServer({ contextDir: home, host: '127.0.0.1', port: 0, token: 'test' });
  const follower = await startHttpServer({ contextDir: home, host: '127.0.0.1', port: 0, token: 'test' });
  const stream = request(`http://127.0.0.1:${follower.port}/events`, { headers: { authorization: 'Bearer test' } }, res => res.resume());
  stream.on('error', () => {}); stream.end();
  try {
    await expect.poll(() => withLog(home, db => db.prepare('SELECT count(*) AS n FROM manifest_answers').get())).toEqual({ n: 1 });
    const calls = () => readFileSync(join(home, 'calls'), 'utf8');
    expect(calls()).toBe('call\n');
    first.setBackgroundActive(false); follower.setBackgroundActive(false);
    piecesMoved(home, path); await new Promise(r => setTimeout(r, 100));
    expect(calls()).toBe('call\n');
    follower.setBackgroundActive(true); piecesMoved(home, path);
    await expect.poll(calls).toBe('call\ncall\n');
  } finally {
    stream.destroy(); await first.close(); await follower.close();
    if (priorHome === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = priorHome;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
