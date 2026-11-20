import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { acquireHttpLock } from '../transport/http-lock.js';
import { migrateHousehold } from './migrate-household.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
it('refuses a running destination and releases the gate after successful or failed imports', async () => {
  const root = mkdtempSync(join(tmpdir(),'household-cli-')); roots.push(root);
  const from = join(root,'old'), home = join(root,'new'); mkdirSync(from);
  writeFileSync(join(from,'household.json'),JSON.stringify({v:1,agents:['art'],owner:'jonathan'}));
  let output = '', error = '';
  const io = { stdout: (s:string) => {output += s;}, stderr:(s:string) => {error += s;}, stdin:Readable.from([]),stdinIsTTY:false,env:{} };
  const argv = ['--home',home,'--from',from];
  const release = acquireHttpLock(home);
  try { expect(await migrateHousehold(argv,io)).toBe(1); expect(error).toContain('already running'); } finally {release();}
  expect(await migrateHousehold(argv,io)).toBe(0); expect(JSON.parse(output).imported).toBe(true);
  output = ''; expect(await migrateHousehold(argv,io)).toBe(0); expect(JSON.parse(output).imported).toBe(false);
  writeFileSync(join(from,'household.json'),'bad');
  expect(await migrateHousehold(argv,io)).toBe(1);
  const unlock = acquireHttpLock(home); unlock();
  expect(await migrateHousehold(['--from',from],io)).toBe(2);
});

it('refuses same-home aliases before creating any old-home files', async () => {
  const root = mkdtempSync(join(tmpdir(),'household-same-')); roots.push(root);
  const from = join(root,'old'), alias = join(root,'alias'); mkdirSync(from); symlinkSync(from,alias);
  writeFileSync(join(from,'household.json'),JSON.stringify({v:1,agents:['art']}));
  const io = {stdout:()=>{},stderr:()=>{},stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  expect(await migrateHousehold(['--home',from,'--from',from],io)).toBe(1);
  expect(await migrateHousehold(['--home',alias,'--from',from],io)).toBe(1);
  expect(await migrateHousehold(['--home',join(from,'new'),'--from',from],io)).toBe(1);
  expect(readdirSync(from)).toEqual(['household.json']);
});
