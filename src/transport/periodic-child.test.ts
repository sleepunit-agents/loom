import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PeriodicOwner } from './periodic-owner.js';
import { runPieceBin } from '../ui/pieces.js';

it('a provider surviving owner SIGKILL keeps command exclusion across different scheduler jobs until it exits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-child-'));
  const path = join(home, 'provider');
  writeFileSync(path, `#!${process.execPath}
const fs=require('node:fs'), p=${JSON.stringify(home)};
if(fs.existsSync(p+'/active')) fs.appendFileSync(p+'/overlap','bad');
fs.writeFileSync(p+'/active','yes');fs.appendFileSync(p+'/starts','start\\n');
const t=setInterval(()=>{if(fs.existsSync(p+'/release')){clearInterval(t);fs.unlinkSync(p+'/active');console.log('done');}},20);
`); chmodSync(path, 0o755);
  const env = { PATH: '/usr/bin:/bin', LOOM_HOME: home };
  const ownerURL = new URL('./periodic-owner.ts', import.meta.url).href;
  const runnerURL = new URL('../ui/pieces.ts', import.meta.url).href;
  const code = `import {PeriodicOwner} from ${JSON.stringify(ownerURL)};import {runPieceBin} from ${JSON.stringify(runnerURL)};const owner=new PeriodicOwner(${JSON.stringify(home)},()=>{});owner.setEligible(true);await owner.run('probe',()=>runPieceBin(${JSON.stringify(path)},['ui'],${JSON.stringify(env)},{timeoutMs:10000}));await owner.close();`;
  const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'inherit'] });
  const successor = new PeriodicOwner(home, () => {});
  try {
    await expect.poll(() => existsSync(join(home, 'active')), { timeout: 5000 }).toBe(true);
    const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
    successor.setEligible(true); expect(successor.active).toBe(true);
    let result: Awaited<ReturnType<typeof runPieceBin>> | undefined;
    await successor.run('different scheduler job', async () => { result = await runPieceBin(path, ['ui'], env, { timeoutMs: 5000 }); });
    expect(result).toMatchObject({ ok: false, reason: 'busy' });
    expect(readFileSync(join(home, 'starts'), 'utf8')).toBe('start\n');
    writeFileSync(join(home, 'release'), 'yes');
    await expect.poll(() => existsSync(join(home, 'active')), { timeout: 5000 }).toBe(false);
    // The old guardian releases on exit, after the provider's final marker.
    await expect.poll(async () => {
      await successor.run('different scheduler job', async () => { result = await runPieceBin(path, ['ui'], env, { timeoutMs: 5000 }); });
      return result?.ok;
    }, { timeout: 5000 }).toBe(true);
    expect(existsSync(join(home, 'overlap'))).toBe(false);
  } finally {
    parent.kill('SIGKILL'); writeFileSync(join(home, 'release'), 'yes');
    await successor.close(); rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

it('the guardian kills an uncooperative provider on its own deadline after parent death and releases exclusion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-deadline-'));
  const path = join(home, 'provider');
  writeFileSync(path, `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(home, 'pid'))},String(process.pid));setInterval(()=>{},100);
`); chmodSync(path, 0o755);
  const code = `import {PeriodicOwner} from ${JSON.stringify(new URL('./periodic-owner.ts', import.meta.url).href)};import {runPieceBin} from ${JSON.stringify(new URL('../ui/pieces.ts', import.meta.url).href)};const o=new PeriodicOwner(${JSON.stringify(home)},()=>{});o.setEligible(true);await o.run('deadline',()=>runPieceBin(${JSON.stringify(path)},[],{LOOM_HOME:${JSON.stringify(home)}},{timeoutMs:2000}));await o.close();`;
  const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: 'ignore' });
  try {
    await expect.poll(() => existsSync(join(home, 'pid')), { timeout: 5000 }).toBe(true);
    const pid = Number(readFileSync(join(home, 'pid'), 'utf8'));
    const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
    const lock = join(home, 'periodic-jobs', readdirSync(join(home, 'periodic-jobs')).find(p => p.endsWith('.db'))!);
    const available = () => { const db = new Database(lock, { timeout: 0 }); try { db.exec('BEGIN EXCLUSIVE'); return true; } catch { return false; } finally { db.close(); } };
    expect(available()).toBe(false);
    await expect.poll(available, { timeout: 5000 }).toBe(true);
    // Orphaned exits may remain as init's zombies, but no provider may still execute.
    const executing = () => { try { return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } };
    expect(executing()).toBe(false);
  } finally { parent.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }); }
}, 12_000);

it.each(['answer too large', 'line too long', 'stopped'])('cancels a background provider immediately on %s', async reason => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-cancel-')), path = join(home, 'provider');
  writeFileSync(path, `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(home, 'pid'))},String(process.pid));process.stdout.on('error',()=>{});process.stdout.write(${JSON.stringify(reason === 'stopped' ? 'stop\n' : 'x'.repeat(1024))});setInterval(()=>{},100);
`); chmodSync(path, 0o755);
  const owner = new PeriodicOwner(home, () => {}); owner.setEligible(true);
  try {
    let result;
    await owner.run('cancel', async () => { result = await runPieceBin(path, [], { LOOM_HOME: home }, { timeoutMs: 8000, maxBytes: 128,
      ...(reason === 'answer too large' ? {} : { onLine: () => 'stop' as const }) }); });
    expect(result).toMatchObject({ ok: false, reason });
    const pid = Number(readFileSync(join(home, 'pid'), 'utf8'));
    await expect.poll(() => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return true; } }, { timeout: 2000 }).toBe(true);
  } finally { await owner.close(); rmSync(home, { recursive: true, force: true }); }
});

it('holds exclusion while terminating a descendant left behind by an exited provider', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-descendant-')), path = join(home, 'provider');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(join(home, 'descendant'))},String(process.pid));setInterval(()=>{},100);`;
  writeFileSync(path, `#!${process.execPath}
const fs=require('node:fs'),{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(home, 'descendant'))})){clearInterval(t);c.unref();console.log('done');}},10);
`); chmodSync(path, 0o755);
  const owner = new PeriodicOwner(home, () => {}); owner.setEligible(true);
  try {
    let result;
    await owner.run('descendant', async () => { result = await runPieceBin(path, [], { LOOM_HOME: home }, { timeoutMs: 5000 }); });
    expect(result).toMatchObject({ ok: true });
    const pid = Number(readFileSync(join(home, 'descendant'), 'utf8'));
    const lock = join(home, 'periodic-jobs', readdirSync(join(home, 'periodic-jobs')).find(p => p.endsWith('.db'))!);
    const db = new Database(lock, { timeout: 0 });
    try { db.exec('BEGIN EXCLUSIVE'); } finally { db.close(); }
    try { expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')).toBe(true); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  } finally { await owner.close(); rmSync(home, { recursive: true, force: true }); }
});

it('runs the compiled provider runner and guardian without a source loader', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-compiled-')), path = join(home, 'provider');
  writeFileSync(path, `#!${process.execPath}\nconsole.log('compiled');\n`); chmodSync(path, 0o755);
  const owner = new URL('../../dist/transport/periodic-owner.js', import.meta.url).href;
  const runner = new URL('../../dist/ui/pieces.js', import.meta.url).href;
  const code = `import {PeriodicOwner} from ${JSON.stringify(owner)};import {runPieceBin} from ${JSON.stringify(runner)};const o=new PeriodicOwner(${JSON.stringify(home)},()=>{},e=>{console.error(e);process.exitCode=1;});o.setEligible(true);await o.run('compiled',async()=>{const r=await runPieceBin(${JSON.stringify(path)},[],{LOOM_HOME:${JSON.stringify(home)}},{timeoutMs:5000});if(!r.ok||r.stdout.trim()!=='compiled')throw Error(JSON.stringify(r));});await o.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr!.on('data', b => { error += b; });
  try { const [exit] = await once(child, 'exit'); expect(exit, error).toBe(0); }
  finally { child.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }); }
}, 10_000);
