import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { clearPieceCache, pieceManifests } from './pieces.js';

let root: string, env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watch-fresh-'));
  mkdirSync(join(root, 'bin'));
  const cli = join(root, 'bin', 'loom-fixture');
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'), root = ${JSON.stringify(root)};
fs.appendFileSync(root+'/calls', 'call\\n');
const data=JSON.parse(fs.readFileSync(root+'/data','utf8'));
if(data.fail)process.exit(1);
const emit=()=>{console.log(JSON.stringify({v:2,owners:2,asks:[],agents:{art:{readings:[],jobs:[{id:'t-1',text:'Task',status:'running',run:data.run}]}}}));};
if(data.wait){fs.writeFileSync(root+'/started','yes');const timer=setInterval(()=>{if(fs.existsSync(root+'/release')){clearInterval(timer);emit();}},10);}else emit();
`);
  chmodSync(cli, 0o755);
  env = { ...process.env, LOOM_HOME: root, PATH: join(root, 'bin') + delimiter + process.env.PATH };
  clearPieceCache();
});
afterEach(() => { clearPieceCache(); rmSync(root, { recursive: true, force: true }); });
const report = (run: string, extra = {}) => writeFileSync(join(root, 'data'), JSON.stringify({ run, ...extra }));
const runOf = (r: Awaited<ReturnType<typeof pieceManifests>>) => r.pieces.find(p => p.piece === 'fixture')?.manifest.agents?.art.jobs?.[0].run;
const calls = () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').length;
it('awaits a new producer result instead of the cached page value; overlapping requests share that producer', async () => {
  report('A');
  expect(runOf(await pieceManifests(env))).toBe('A');
  report('B', { wait: true });
  const first = pieceManifests(env, Date.now(), true);
  await expect.poll(() => existsSync(join(root, 'started'))).toBe(true);
  const second = pieceManifests(env, Date.now(), true);
  expect(runOf(await pieceManifests(env))).toBe('A'); // page may retain A while the program waits
  expect(calls()).toBe(2);
  writeFileSync(join(root, 'release'), 'yes');
  expect(runOf(await first)).toBe('B');
  expect(runOf(await second)).toBe('B');
  expect(calls()).toBe(2);
});
it('does not return a cached successful page value when the new producer fails', async () => {
  report('A'); expect(runOf(await pieceManifests(env))).toBe('A');
  report('B', { fail: true });
  const current = await pieceManifests(env, Date.now(), true);
  expect(runOf(current)).toBeUndefined();
  expect(current.skipped.some(p => p.piece === 'fixture')).toBe(true);
  expect(calls()).toBe(2);
});
