import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createFoundation } from '../core/app.js';
import * as foundation from '../core/app.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { SharingDatabase } from '../core/household/sharing.js';
import { acquireHttpLock } from '../transport/http-lock.js';
import { change } from '../pieces/changes/fixture.js';
import { loadChanges } from '../pieces/changes/store.js';
import { migrateChanges } from './migrate-changes.js';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'changes-cli-')); dirs.push(home);
  const source = join(home, 'source.json'), attribution = join(home, 'attribution.json');
  writeFileSync(source, JSON.stringify({ v: 1, changes: [change({ project: 'forged' })] }));
  writeFileSync(attribution, JSON.stringify({ agents: { art: { logins: ['art-bot'], branches: [] } }, ownerLogins: [], taskOwner: 'jonathan' }));
  const io = { stdout: vi.fn(), stderr: vi.fn(), stdin: Readable.from([]), stdinIsTTY: false, env: { LOOM_HOME: home } };
  const args = ['--from', source, '--attribution', attribution];
  const seed = () => {
    const app = createFoundation({ home });
    try {
      migrateHouseholdTables(app.db);
      app.db.transaction(() => {
        new HouseholdDatabase(app.db).replace(home, { v: 1, agents: ['art'], owner: 'Jonathan' });
        new SharingDatabase(app.db, home).create({ slug: 'pond', name: 'Pond', repositories: ['acme/app'], members: [], agents: ['art'] });
      })();
    } finally { app.close(); }
  };
  return { home, source, attribution, io, args, seed };
}
it('takes the real stopped-home lock, then uses imported household projects and repeats without changing records', async () => {
  const f = fixture(); f.seed();
  const release = acquireHttpLock(f.home);
  try { expect(await migrateChanges(f.args, f.io)).toBe(1); }
  finally { release(); }
  expect(await migrateChanges(f.args, f.io)).toBe(0);
  expect(JSON.parse(f.io.stdout.mock.calls.at(-1)![0])).toMatchObject({ imported: true, changes: 1 });
  expect(await migrateChanges(f.args, f.io)).toBe(0);
  expect(JSON.parse(f.io.stdout.mock.calls.at(-1)![0])).toMatchObject({ imported: false });
  const app = createFoundation({ home: f.home });
  try { expect(loadChanges(app.db)).toMatchObject([{ project: 'pond', agent: 'art' }]); }
  finally { app.close(); }
});
it('rejects missing household, unknown agents and malformed attribution without creating Changes tables', async () => {
  const f = fixture();
  expect(await migrateChanges(f.args, f.io)).toBe(1); f.seed();
  for (const map of [{ agents: { stranger: { logins: [], branches: [] } }, ownerLogins: [] }, { agents: {}, ownerLogins: [], taskOwner: 'stranger' }, { agents: { art: { logins: [], branches: [''] } }, ownerLogins: [] }, []]) {
    writeFileSync(f.attribution, JSON.stringify(map));
    expect(await migrateChanges(f.args, f.io)).toBe(1);
    const app = createFoundation({ home: f.home });
    try { expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name='changes_changes'").get()).toBeUndefined(); }
    finally { app.close(); }
  }
  expect(await migrateChanges(['--from', f.source], f.io)).toBe(2);
  expect(await migrateChanges([...f.args, '--unknown'], f.io)).toBe(2);
});
it('never echoes accidental credentials or malformed source contents in refusals', async () => {
  const f = fixture(); f.seed();
  const secret = 'ghp_PRIVATE_ACCIDENTAL_ARGUMENT';
  for (const args of [[...f.args, secret], [...f.args, `--${secret}`]]) {
    expect(await migrateChanges(args, f.io)).toBe(2);
  }
  writeFileSync(f.source, secret);
  expect(await migrateChanges(f.args, f.io)).toBe(1);
  expect(f.io.stderr.mock.calls.flat().join('')).not.toContain(secret);
  expect(f.io.stdout).not.toHaveBeenCalled();
});
it('holds ownership through database close and releases it after validation or import failures', async () => {
  const f = fixture(); f.seed();
  const actual = foundation.createFoundation;
  const closes = vi.fn();
  vi.spyOn(foundation, 'createFoundation').mockImplementation(options => {
    const app = actual(options);
    return { ...app, close() {
      expect(app.db.open).toBe(true);
      expect(() => acquireHttpLock(f.home)).toThrow('already running');
      app.close(); closes();
    } };
  });
  writeFileSync(f.attribution, 'invalid');
  expect(await migrateChanges(f.args, f.io)).toBe(1);
  const validationRelease = acquireHttpLock(f.home); validationRelease();
  writeFileSync(f.attribution, JSON.stringify({ agents: {}, ownerLogins: [] }));
  expect(await migrateChanges(f.args, f.io)).toBe(0);
  expect(closes).toHaveBeenCalledTimes(2);
  let release = acquireHttpLock(f.home); release();
  writeFileSync(f.source, JSON.stringify({v:1,changes:[change({title:'Different source'})]}));
  writeFileSync(f.attribution, 'invalid');
  expect(await migrateChanges(f.args, f.io)).toBe(1);
  release = acquireHttpLock(f.home); release();
  writeFileSync(f.attribution, JSON.stringify({ agents: {}, ownerLogins: [] }));
  writeFileSync(f.source, 'invalid');
  expect(await migrateChanges(f.args, f.io)).toBe(1);
  expect(closes).toHaveBeenCalledTimes(4);
  release = acquireHttpLock(f.home); release();
});
it('repeats identical source without revalidating changed household or attribution, while refusing changed bytes', async () => {
  const f=fixture();f.seed();
  expect(await migrateChanges(f.args,f.io)).toBe(0);
  const app=createFoundation({home:f.home});
  try {app.db.transaction(()=>new HouseholdDatabase(app.db).replace(f.home,{v:1,agents:['replacement'],owner:'Jonathan'}))();}
  finally {app.close();}
  for(const map of [{agents:{stranger:{logins:[],branches:[]}},ownerLogins:[]},'invalid JSON']) {
    writeFileSync(f.attribution,typeof map==='string'?map:JSON.stringify(map));
    expect(await migrateChanges(f.args,f.io)).toBe(0);
    expect(JSON.parse(f.io.stdout.mock.calls.at(-1)![0])).toMatchObject({imported:false,changes:1});
  }
  const check=createFoundation({home:f.home});
  try {expect(loadChanges(check.db)).toMatchObject([{project:'pond',agent:'art'}]);}
  finally {check.close();}
  writeFileSync(f.source,JSON.stringify({v:1,changes:[change({title:'Different bytes'})]}));
  expect(await migrateChanges(f.args,f.io)).toBe(1);
});
