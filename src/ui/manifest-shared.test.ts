import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withLog } from '../collections/log.js';
import { PeriodicOwner } from '../transport/periodic-owner.js';
import { configureManifestBackground, piecesMoved } from './live.js';
import { manifestDemand, invalidateManifest } from './manifest-shared.js';
import { CACHE_MS, STALE_MAX_MS, pieceManifests, refreshPieceManifests, sharePieceManifests, sharedPiecePrints } from './pieces.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-manifest-shared-')); dirs.push(home);
  const bin = join(home, 'bin'); mkdirSync(bin);
  const path = join(bin, 'loom-probe');
  const source = (label: string) => `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(home, 'calls'))}, 'call\\n');
if (fs.existsSync(${JSON.stringify(join(home, 'fail'))})) process.exit(1);
console.log(JSON.stringify({v:2,scope:true,owners:2,tile:{label:${JSON.stringify(label)},value:(process.env.LOOM_SCOPE||'')+':'+(process.env.LOOM_OWNER_SCOPE||'')}}));
`;
  writeFileSync(path, source('Probe')); chmodSync(path, 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: home, LOOM_SCOPE: 'art', LOOM_OWNER_SCOPE: 'art,mark', PRIVATE_ENV: 'answer-env-sentinel', VIEWER_ID: 'answer-viewer-sentinel' };
  return { home, path, env, source, calls: () => readFileSync(join(home, 'calls'), 'utf8').trim().split('\n').length };
}
it('unions follower-only scope demand, drops disconnects and expires dead listeners without storing env', () => {
  const { home, env } = fixture();
  expect(manifestDemand(home, 'follower', [{ ...env, SECRET: 'private-env-sentinel', VIEWER_ID: 'private-viewer-sentinel' }], 100)).toEqual([{ LOOM_SCOPE: 'art', LOOM_OWNER_SCOPE: 'art,mark' }]);
  const stored = withLog(home, db => db.serialize()).toString('utf8');
  expect(stored).not.toContain('private-env-sentinel'); expect(stored).not.toContain('private-viewer-sentinel');
  expect(manifestDemand(home, 'owner', [], 200)).toHaveLength(1);
  expect(manifestDemand(home, 'follower', [], 201)).toEqual([]);
  manifestDemand(home, 'dead', [env], 300);
  expect(manifestDemand(home, 'owner', [], 30_300)).toEqual([]);
});
it('a separate owner process supplies scoped manifests to follower reads without a provider call', async () => {
  const { home, path, env, calls, source } = fixture();
  const stop = sharePieceManifests(home);
  const owner = (scope = env.LOOM_SCOPE, owners = env.LOOM_OWNER_SCOPE) => {
    const code = `import {sharePieceManifests,refreshPieceManifests} from ${JSON.stringify(new URL('./pieces.ts', import.meta.url).href)}; const env=${JSON.stringify({ ...env, LOOM_SCOPE: scope, LOOM_OWNER_SCOPE: owners })}; sharePieceManifests(env.LOOM_HOME); await refreshPieceManifests(env);`;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
  };
  try {
    owner(); expect(calls()).toBe(1);
    const stored = withLog(home, db => db.serialize()).toString('utf8');
    expect(stored).not.toContain('answer-env-sentinel'); expect(stored).not.toContain('answer-viewer-sentinel');
    expect([...sharedPiecePrints(env).values()][0]).toContain('art:art,mark');
    expect((await pieceManifests(env)).pieces[0].manifest.tile?.value).toBe('art:art,mark');
    expect(calls()).toBe(1);
    // A follower-only owner scope is distinct even when the agent scope is identical.
    const other = { ...env, LOOM_OWNER_SCOPE: 'art' };
    expect([...sharedPiecePrints(other).values()]).toEqual(['']);
    owner('art', 'art');
    expect([...sharedPiecePrints(other).values()][0]).toContain('art:art');
    expect(calls()).toBe(2);
    // A producer's hint invalidates shared answers. A new independent owner cannot hydrate the old answer.
    invalidateManifest(home, path); owner();
    sharedPiecePrints(env); expect(calls()).toBe(3);
    // Installing a new executable changes its identity, even within the freshness window.
    writeFileSync(path, source('Installed'));
    expect([...sharedPiecePrints(env).values()]).toEqual(['']);
    owner();
    expect([...sharedPiecePrints(env).values()][0]).toContain('Installed');
    expect(calls()).toBe(4);
  } finally { stop(); }
}, 30_000);

it('a late answer invalidated in flight cannot publish under the new shared generation', async () => {
  const { home, path, env, calls } = fixture();
  writeFileSync(path, `#!${process.execPath}
const fs=require('node:fs'),p=${JSON.stringify(home)};
const value=fs.existsSync(p+'/new')?'new':'old';fs.appendFileSync(p+'/calls','call\\n');
const t=setInterval(()=>{if(fs.existsSync(p+'/release')){clearInterval(t);console.log(JSON.stringify({v:2,tile:{label:'Probe',value}}));}},10);
`);
  const off = sharePieceManifests(home);
  try {
    const running = refreshPieceManifests(env);
    await expect.poll(() => existsSync(join(home, 'calls'))).toBe(true);
    writeFileSync(join(home, 'new'), 'yes'); invalidateManifest(home, path);
    writeFileSync(join(home, 'release'), 'yes'); await running;
    expect(withLog(home, db => db.prepare('SELECT * FROM manifest_answers').all())).toEqual([]);
    await refreshPieceManifests(env); expect(calls()).toBe(2);
    expect([...sharedPiecePrints(env).values()][0]).toContain('new');
  } finally { off(); }
});
it('shared failures preserve good-answer age, expire stale answers and recover on a new hint', async () => {
  const { home, path, env } = fixture(); const off = sharePieceManifests(home);
  try {
    await refreshPieceManifests(env);
    const start = Date.now(); writeFileSync(join(home, 'fail'), 'yes');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start + CACHE_MS + 1);
    await refreshPieceManifests(env);
    expect([...sharedPiecePrints(env).values()][0]).toContain('Probe');
    vi.setSystemTime(start + STALE_MAX_MS + 1); await refreshPieceManifests(env);
    expect([...sharedPiecePrints(env).values()]).toEqual(['']);
    unlinkSync(join(home, 'fail')); invalidateManifest(home, path); await refreshPieceManifests(env);
    expect([...sharedPiecePrints(env).values()][0]).toContain('Probe');
  } finally { off(); }
});
it('a second registration and its disposal leave the elected manifest owner running', async () => {
  const { home, path, env, calls } = fixture();
  const owner = new PeriodicOwner(home, () => {}), follower = new PeriodicOwner(home, () => {});
  owner.setEligible(true);
  manifestDemand(home, 'remote', [env]);
  const first = configureManifestBackground(home, env, owner), second = configureManifestBackground(home, env, follower);
  try {
    await expect.poll(() => existsSync(join(home, 'calls'))).toBe(true);
    await second(); piecesMoved(home, path);
    await expect.poll(calls, { timeout: 10_000 }).toBe(2);
  } finally { await owner.close(); await follower.close(); await second(); await first(); }
}, 15_000);
