import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { migrateHouseholdTables } from './schema.js';
import { HouseholdRows } from './rows.js';
import { HouseholdDatabase } from './document.js';
import { loadHousehold } from '../../household.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(raw: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'loom-household-document-')); homes.push(home);
  const source = JSON.stringify(raw) + '\n';
  writeFileSync(join(home, 'household.json'), source);
  const lease = openDb(home);
  migrateHouseholdTables(lease.db);
  const store = new HouseholdDatabase(lease.db);
  return { ...lease, home, source, store, import: () => lease.db.transaction(() => store.replace(home, raw)).immediate() };
}

it('preserves raw unknown fields, order, legacy ownership and omitted defaults across readonly reopen', () => {
  const raw = JSON.parse('{"v":1,"agents":["mark","art","mark"],"owner":"Jonathan","relay":{"art":["mark"]},"__proto__":{"kept":true},"future":{"enabled":false}}');
  const f = fixture(raw);
  try {
    expect(f.store.document()).toBeUndefined();
    f.import();
    expect(f.store.document()).toEqual(raw);
    expect(f.store.household(f.home)).toEqual(loadHousehold(f.home));
    expect(f.store.household(f.home)).toMatchObject({ default: 'mark', members: [{ person: 'jonathan', role: 'owner', agents: '*' }], tz: 'UTC', commsDays: 14 });
    expect(new HouseholdRows(f.db, 'members').entries()).toEqual([]);
    expect(new HouseholdRows(f.db, 'agents').entries()).toEqual([['art', 'art'], ['mark', 'mark']]);
    f.close();
    const db = new Database(join(f.home, 'loom.db'), { readonly: true, fileMustExist: true });
    try {
      const store = new HouseholdDatabase(db);
      expect(store.document()).toEqual(raw);
      expect(store.household(f.home)).toMatchObject({ agents: ['mark', 'art', 'mark'], default: 'mark' });
      expect(() => store.change(f.home, r => { r.owner = 'other'; })).toThrow();
    } finally { db.close(); }
    expect(readFileSync(join(f.home, 'household.json'), 'utf8')).toBe(f.source);
  } finally { f.close(); }
});

it('keeps explicit members field-for-field and atomically changes keyed rows without touching JSON', () => {
  const raw = { v: 1, agents: ['art', 'mark'], default: 'art', members: [
    { person: 'jonathan', role: 'owner', agents: '*', projects: ['pond'], future: null },
    { person: 'mark', role: 'owner', agents: ['mark', 'mark'] },
  ], icons: { art: 'fish' } };
  const f = fixture(raw);
  try {
    f.import();
    expect(f.store.document()).toEqual(raw);
    expect(new HouseholdRows(f.db, 'members').get('mark')).toEqual(raw.members[1]);
    expect(f.store.household(f.home)?.members[1].agents).toEqual(['mark']);
    const result = f.store.change(f.home, r => {
      r.agents = ['art']; r.members = [raw.members[0]]; r.default = 'art'; r.icons = { art: 'new' };
      return 'changed';
    });
    expect(result).toBe('changed');
    expect(f.store.document()).toEqual({ ...raw, agents: ['art'], members: [raw.members[0]], icons: { art: 'new' } });
    expect(new HouseholdRows(f.db, 'members').get('mark')).toBeUndefined();
    expect(new HouseholdRows(f.db, 'agents').get('mark')).toBeUndefined();
    expect(readFileSync(join(f.home, 'household.json'), 'utf8')).toBe(f.source);
    expect(loadHousehold(f.home)?.agents).toEqual(['art', 'mark']);
  } finally { f.close(); }
});

it('requires caller transaction and rolls back partial multi-concern changes, then retries', () => {
  const raw = { v: 1, agents: ['art'], owner: 'jonathan' };
  const f = fixture(raw);
  try {
    expect(() => f.store.replace(f.home, raw)).toThrow('requires a transaction');
    f.import();
    f.db.exec("CREATE TRIGGER fail_member BEFORE INSERT ON household_members BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    const next = { ...raw, agents: ['art', 'mark'], members: [{ person: 'jonathan', role: 'owner', agents: '*' }] };
    expect(() => f.db.transaction(() => f.store.replace(f.home, next)).immediate()).toThrow('interrupted');
    expect(f.store.document()).toEqual(raw);
    expect(new HouseholdRows(f.db, 'agents').get('mark')).toBeUndefined();
    f.db.exec('DROP TRIGGER fail_member');
    f.db.transaction(() => f.store.replace(f.home, next)).immediate();
    expect(f.store.document()).toEqual(next);
    expect(() => f.store.change(f.home, r => { r.default = 'missing'; })).toThrow('not one of the agents');
    expect(f.store.document()).toEqual(next);
    expect(() => f.store.change(f.home, r => { r.owner = 'changed'; throw new Error('caller failed'); })).toThrow('caller failed');
    expect(f.store.document()).toEqual(next);
  } finally { f.close(); }
});

it('uses only the supplied schema without creating or migrating it', () => {
  const db = new Database(':memory:');
  try {
    const store = new HouseholdDatabase(db);
    expect(() => store.document()).toThrow('no such table');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  } finally { db.close(); }
});

it('fails closed if a referenced metadata row is missing', () => {
  const f = fixture({ v: 1, agents: ['art'], members: [{ person: 'jonathan', role: 'owner', agents: '*' }] });
  try {
    f.import();
    new HouseholdRows(f.db, 'members').remove('jonathan');
    expect(() => f.store.document()).toThrow('missing household row: jonathan');
  } finally { f.close(); }
});
