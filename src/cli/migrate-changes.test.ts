import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createFoundation } from '../core/app.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { SharingDatabase } from '../core/household/sharing.js';
import { acquireHttpLock } from '../transport/http-lock.js';
import { change } from '../pieces/changes/fixture.js';
import { loadChanges } from '../pieces/changes/store.js';
import { migrateChanges } from './migrate-changes.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
  for (const map of [{ agents: { stranger: { logins: [], branches: [] } }, ownerLogins: [] }, { agents: { art: { logins: [], branches: [''] } }, ownerLogins: [] }, []]) {
    writeFileSync(f.attribution, JSON.stringify(map));
    expect(await migrateChanges(f.args, f.io)).toBe(1);
    const app = createFoundation({ home: f.home });
    try { expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name='changes_changes'").get()).toBeUndefined(); }
    finally { app.close(); }
  }
  expect(await migrateChanges(['--from', f.source], f.io)).toBe(2);
  expect(await migrateChanges([...f.args, '--unknown'], f.io)).toBe(2);
});
