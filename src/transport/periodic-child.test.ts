import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PeriodicOwner } from './periodic-owner.js';
import { runPieceBin } from '../ui/pieces.js';

it('a provider surviving owner SIGKILL keeps its own lock until it exits; takeover never invokes it twice', async () => {
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
    await successor.run('probe', async () => { result = await runPieceBin(path, ['ui'], env, { timeoutMs: 5000 }); });
    expect(result).toMatchObject({ ok: false, exit: 75 });
    expect(readFileSync(join(home, 'starts'), 'utf8')).toBe('start\n');
    writeFileSync(join(home, 'release'), 'yes');
    await expect.poll(() => existsSync(join(home, 'active')), { timeout: 5000 }).toBe(false);
    // The old guardian releases on exit, after the provider's final marker.
    await expect.poll(async () => {
      await successor.run('probe', async () => { result = await runPieceBin(path, ['ui'], env, { timeoutMs: 5000 }); });
      return result?.ok;
    }, { timeout: 5000 }).toBe(true);
    expect(existsSync(join(home, 'overlap'))).toBe(false);
  } finally {
    parent.kill('SIGKILL'); writeFileSync(join(home, 'release'), 'yes');
    await successor.close(); rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
