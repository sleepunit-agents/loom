import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { migrateHouseholdTables } from './schema.js';
import { HouseholdRows } from './rows.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-household-rows-')); homes.push(home);
  const lease = openDb(home);
  migrateHouseholdTables(lease.db);
  return { home, ...lease };
}

describe('household database substrate (no cutover)', () => {
  it('keeps legacy files untouched and applies the schema idempotently', () => {
    const f = fixture();
    try {
      const legacy = '{"v":1,"agents":["art"],"default":"art"}\n';
      writeFileSync(join(f.home, 'household.json'), legacy);
      migrateHouseholdTables(f.db);
      expect(readFileSync(join(f.home, 'household.json'), 'utf8')).toBe(legacy);
      expect(readdirSync(f.home).sort()).toEqual(['household.json', 'loom.db', 'loom.db-shm', 'loom.db-wal']);
      expect(f.db.prepare("SELECT count(*) AS n FROM core_migrations WHERE piece='household'").get()).toEqual({ n: 1 });
    } finally { f.close(); }
  });
  it('round-trips every concern without interpreting its optional fields', () => {
    const f = fixture();
    const examples = {
      settings: { default: 'art', relays: { art: ['mark'] }, tz: 'America/Chicago' },
      agents: { name: 'art', ordinal: 0 },
      members: { person: 'jonathan', role: 'owner', agents: '*', projects: ['pond'] },
      projects: { slug: 'pond', name: 'Pond', repositories: ['org/pond'], members: ['jonathan'], agents: ['art'] },
      tokens: { sha256: 'ab'.repeat(32), role: 'owner', revoked: 'yesterday' },
      token_use: '2026-11-12T12:00:00Z',
      sessions: { secret: 'ab'.repeat(32), issuedAt: 1 },
      links: { secret: 'ab'.repeat(32), expires: 2 },
      challenges: { purpose: 'register', expires: 2, secret: 'ab'.repeat(32) },
      passkeys: { id: 'credential', publicKey: 'AAECA/8=', counter: 0 },
      push: { vapid: { publicKey: 'public', privateKey: 'private' }, removed: ['digest'], tickAt: 2 },
      readers: { prefs: { sound: false }, opened: { 'task:1': 123 }, seen: { at: 123, since: 100 }, done: [] },
      piece_settings: { enabled: false, argv: ['one', 'two'] },
      imports: { checksums: { 'tokens.json': 'digest' }, counts: { tokens: 1 } },
    };
    try {
      const tables = (f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'household_%'").all() as { name: string }[]).map(r => r.name).sort();
      expect(tables).toEqual(Object.keys(examples).map(k => `household_${k}`).sort());
      for (const [concern, value] of Object.entries(examples)) {
        const rows = new HouseholdRows(f.db, concern as keyof typeof examples);
        rows.put('entity', value);
        expect(rows.entries()).toEqual([['entity', value]]);
      }
      const prepare = vi.spyOn(f.db, 'prepare');
      expect(() => new HouseholdRows(f.db, 'sessions; DROP TABLE household_tokens' as never)).toThrow('unknown household concern');
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    } finally { f.close(); }
  });
  it('decodes only the requested session row', () => {
    const f = fixture();
    try {
      const sessions = new HouseholdRows(f.db, 'sessions');
      sessions.put('first', { secret: 'one' });
      sessions.put('second', { secret: 'two' });
      const parse = vi.spyOn(JSON, 'parse');
      try {
        expect(sessions.get('second')).toEqual({ secret: 'two' });
        expect(parse.mock.calls).toEqual([['{"secret":"two"}']]);
      } finally { parse.mockRestore(); }
    } finally { f.close(); }
  });
  it('preserves credential bytes, bindings, absent fields, and used-link tombstones across reopen', () => {
    const f = fixture();
    const secret = 'ab'.repeat(32);
    const session = { issuedAt: 123, secret, signedInAt: 100, via: 'passkey', agent: true };
    const credential = { id: 'credential_-', publicKey: 'AAECA/8=', counter: 42, alg: -7, secret, tokenLabel: 'key' };
    new HouseholdRows(f.db, 'sessions').put('cd'.repeat(32), session);
    new HouseholdRows(f.db, 'passkeys').put(credential.id, credential);
    new HouseholdRows(f.db, 'links').put('spent', { used: true, secret, expires: 999 });
    f.close();
    const db = new Database(join(f.home, 'loom.db'), { readonly: true, fileMustExist: true });
    try {
      expect(new HouseholdRows(db, 'sessions').get('cd'.repeat(32))).toEqual(session);
      expect(new HouseholdRows(db, 'sessions').get('unknown')).toBeUndefined();
      expect(new HouseholdRows(db, 'passkeys').get(credential.id)).toEqual(credential);
      expect(new HouseholdRows(db, 'links').get('spent')).toEqual({ used: true, secret, expires: 999 });
      expect(() => new HouseholdRows(db, 'tokens').put('x', {})).toThrow();
    } finally { db.close(); }
  });
  it('rolls back changes across concerns and nested transactions', () => {
    const f = fixture();
    try {
      const tokens = new HouseholdRows(f.db, 'tokens');
      const sessions = new HouseholdRows(f.db, 'sessions');
      expect(() => tokens.transaction(() => {
        tokens.put('token', { sha256: 'digest', member: 'jonathan' });
        sessions.transaction(() => sessions.put('session', { secret: 'digest' }));
        throw new Error('interrupted');
      })).toThrow('interrupted');
      expect(tokens.entries()).toEqual([]);
      expect(sessions.entries()).toEqual([]);
      tokens.transaction(() => {
        tokens.put('outer', { kept: true });
        try {
          sessions.transaction(() => {
            tokens.put('inner', { discarded: true });
            sessions.put('inner', { discarded: true });
            throw new Error('inner failure');
          });
        } catch { /* outer work continues */ }
        expect(tokens.get('inner')).toBeUndefined();
        expect(sessions.get('inner')).toBeUndefined();
      });
      expect(tokens.get('outer')).toEqual({ kept: true });
      tokens.put('__proto__', { label: 'safe key' });
      expect(tokens.get('__proto__')).toEqual({ label: 'safe key' });
      expect(tokens.remove('__proto__')).toBe(true);
      expect(tokens.remove('__proto__')).toBe(false);
    } finally { f.close(); }
  });
});
