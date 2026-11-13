import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../core/db/index.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdDatabase } from '../core/household/document.js';
import { HouseholdRows } from '../core/household/rows.js';
import { continuityTarget, readContinuityHousehold } from './household.js';
import { householdOf, contextFromHome } from '../household.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const h = mkdtempSync(join(tmpdir(), 'loom-stdio-household-')); homes.push(h); return h; }
function fixture() {
  const h = home();
  for (const agent of ['art', 'mark']) mkdirSync(join(h, 'agents', agent), { recursive: true });
  const lease = openDb(h);
  migrateHouseholdTables(lease.db);
  lease.db.transaction(() => new HouseholdDatabase(lease.db).replace(h, {
    v: 1, agents: ['art', 'mark'], default: 'mark', members: [
      { person: 'jonathan', role: 'owner', agents: '*' },
      { person: 'pollock', role: 'owner', agents: ['mark'] },
    ],
  }))();
  lease.close(); // No daemon or writable app connection survives the fixture.
  return h;
}

it('reads two agents, default, ownership and commons paths with no old files or running daemon', () => {
  const h = fixture();
  const before = readFileSync(join(h, 'loom.db'));
  const files = readdirSync(h).sort();
  expect(readContinuityHousehold(h)).toMatchObject({
    agent: 'mark', contextDir: join(h, 'agents/mark'),
    household: { default: 'mark', members: [
      { person: 'jonathan', agents: '*' }, { person: 'pollock', agents: ['mark'] },
    ] }, knowledgePath: join(h, 'commons/knowledge.db'), peoplePath: join(h, 'commons/people.db'),
  });
  for (const agent of ['art', 'mark']) expect(continuityTarget({ home: h, agent })).toMatchObject({
    contextDir: join(h, 'agents', agent), metadata: { agent },
  });
  expect(readFileSync(join(h, 'loom.db'))).toEqual(before);
  expect(readdirSync(h).filter(name => !['loom.db-wal', 'loom.db-shm'].includes(name)).sort()).toEqual(files);
  // The old path never discovers the new DB, even with valid rows present.
  expect(householdOf(join(h, 'agents/art'))).toBeNull();
  expect(contextFromHome({ LOOM_HOME: h })).toBeUndefined();
});

it('opts in explicitly and ignores contradictory or malformed old JSON', () => {
  const h = fixture();
  writeFileSync(join(h, 'household.json'), 'invalid old JSON');
  expect(readContinuityHousehold(h).agent).toBe('mark');
  expect(() => readContinuityHousehold(h, 'ghost')).toThrow('not in the household');
  expect(() => readContinuityHousehold(h, '../art')).toThrow('not in the household');
});

it('keeps explicit standalone contexts independent of any app database', () => {
  const standalone = home();
  writeFileSync(join(standalone, 'IDENTITY.md'), 'Standalone');
  const files = readdirSync(standalone);
  expect(continuityTarget({ contextDir: standalone })).toEqual({ contextDir: standalone, metadata: null });
  expect(continuityTarget({ home: join(standalone, 'missing-home'), contextDir: standalone })).toEqual({ contextDir: standalone, metadata: null });
  expect(readdirSync(standalone)).toEqual(files);
  expect(() => continuityTarget({})).toThrow('explicit');
});

it('resolves household/context aliases, rejects unknown in-house contexts, and respects explicit context precedence', () => {
  const h = fixture(), aliases = home();
  symlinkSync(h, join(aliases, 'home'));
  symlinkSync(join(h, 'agents/art'), join(aliases, 'default'));
  expect(continuityTarget({ home: join(aliases, 'home'), agent: 'mark', contextDir: join(aliases, 'default') }))
    .toMatchObject({ contextDir: join(h, 'agents/art'), metadata: { agent: 'art' } });
  mkdirSync(join(h, 'agents/ghost'));
  expect(() => continuityTarget({ home: h, contextDir: join(h, 'agents/ghost') })).toThrow('not in the household');
  expect(() => continuityTarget({ home: h, contextDir: join(h, 'agents/typo') })).toThrow();
});

it('refuses missing, empty, malformed and incomplete metadata without creating or repairing app data', () => {
  const h = home();
  expect(() => readContinuityHousehold(h)).toThrow();
  expect(readdirSync(h)).toEqual([]);
  const db = new Database(join(h, 'loom.db'));
  db.close();
  expect(() => readContinuityHousehold(h)).toThrow('no such table');
  const initialized = fixture();
  const writable = new Database(join(initialized, 'loom.db'));
  new HouseholdRows(writable, 'members').remove('jonathan');
  writable.close();
  expect(() => readContinuityHousehold(initialized)).toThrow('missing household row: jonathan');
});

it('takes a fresh snapshot on each call instead of retaining ownership or default metadata', () => {
  const h = fixture();
  expect(readContinuityHousehold(h).agent).toBe('mark');
  const writer = openDb(h);
  new HouseholdDatabase(writer.db).change(h, raw => { raw.default = 'art'; });
  writer.close();
  expect(readContinuityHousehold(h).agent).toBe('art');
});

it('sees committed WAL changes while a writer remains open without changing app state', () => {
  const h = fixture();
  const writer = openDb(h);
  try {
    new HouseholdDatabase(writer.db).change(h, raw => { raw.default = 'art'; });
    expect(readContinuityHousehold(h).agent).toBe('art');
    const before = new HouseholdDatabase(writer.db).document();
    expect(readContinuityHousehold(h, 'mark').agent).toBe('mark');
    expect(new HouseholdDatabase(writer.db).document()).toEqual(before);
  } finally { writer.close(); }
});
