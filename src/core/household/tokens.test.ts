import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { migrateHouseholdTables } from './schema.js';
import { HouseholdRows } from './rows.js';
import { TokenDatabase } from './tokens.js';
import { loadTokens, parseHouseholdDocument, parseTokenDocument, TokenResolver } from '../../household.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const record = (token: string, role = 'owner') => ({ label: token, role, sha256: digest(token), created: '2026-11-12T00:00:00Z' });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-token-db-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const lease = openDb(home); cleanups.push(lease.close);
  migrateHouseholdTables(lease.db);
  const store = new TokenDatabase(lease.db);
  const h = parseHouseholdDocument(home, { v: 1, agents: ['art', 'ada'], owner: 'jonathan' });
  return { home, db: lease.db, store, h };
}

it('round trips ordered duplicate digests, credentials and unknown fields, matching legacy usage semantics', () => {
  const f = fixture();
  const raw = { v: 1, future: { keep: true }, tokens: [
    { ...record('second', 'agent:ada'), future: ['x'], last_used: 'ignored' },
    { ...record('first'), member: 'jonathan', passkey: 'ab'.repeat(32), from: 'browser', from_sha256: 'cd'.repeat(32) },
    { ...record('second', 'peer:visitor'), expires: '2030-01-01T00:00:00Z', revoked: 'old' },
  ] };
  const used = { [digest('second')]: '2026-11-12T01:00:00Z', orphan: 'retained' };
  const source = JSON.stringify(raw);
  writeFileSync(join(f.home, 'tokens.json'), source, { mode: 0o600 });
  writeFileSync(join(f.home, 'tokens.used.json'), JSON.stringify(used), { mode: 0o600 });
  f.db.transaction(() => f.store.replace(raw, used))();
  expect(f.store.document()).toEqual(raw);
  expect(f.store.used()).toEqual(used);
  expect(f.store.list()).toEqual(loadTokens(f.home));
  expect(readFileSync(join(f.home, 'tokens.json'), 'utf8')).toBe(source);
  const reopened = new Database(join(f.home, 'loom.db'), { readonly: true });
  try { expect(new TokenDatabase(reopened).document()).toEqual(raw); } finally { reopened.close(); }
});

it('resolves by digest with the old files absent and sees revocation on another connection immediately', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  const f = fixture();
  f.db.transaction(() => f.store.replace({ v: 1, tokens: [
    { ...record('owner'), member: 'jonathan' }, record('agent', 'agent:ada'), record('gone', 'agent:missing'),
    record('runtime', 'runtime:runtime'), { ...record('review', 'review:runtime'), expires: '2026-11-12T13:00:00Z' },
    record('bad-review', 'review:runtime'), { ...record('expired'), expires: '2026-11-12T11:00:00Z' },
    { ...record('duplicate'), revoked: 'before' }, record('duplicate', 'agent:art'),
  ] }, {}))();
  // Unrelated undecodable rows prove the request does not enumerate token or usage tables.
  new HouseholdRows(f.db, 'token_use').put('valid-unrelated', 'original-usage');
  f.db.pragma('ignore_check_constraints = ON');
  f.db.prepare("INSERT INTO household_tokens VALUES ('unrelated', 'not-json')").run();
  f.db.prepare("INSERT INTO household_token_use VALUES ('unrelated', 'not-json')").run();
  f.db.pragma('ignore_check_constraints = OFF');
  const resolver = new TokenResolver(f.h, { persistence: f.store, runtimePieces: () => ['runtime'] });
  expect(resolver.resolve('owner')).toEqual({ kind: 'owner', member: 'jonathan' });
  expect(resolver.ownerMember(digest('owner'))?.person).toBe('jonathan');
  expect(resolver.resolve('agent')).toMatchObject({ kind: 'agent', agent: 'ada' });
  expect(resolver.resolve('runtime')).toMatchObject({ kind: 'runtime', piece: 'runtime' });
  expect(resolver.resolve('review')).toMatchObject({ kind: 'review', piece: 'runtime' });
  expect(resolver.resolve('duplicate')).toMatchObject({ kind: 'agent', agent: 'art' });
  for (const token of ['gone', 'bad-review', 'expired', 'unknown']) expect(resolver.resolve(token)).toBeNull();
  expect(new HouseholdRows(f.db, 'token_use').get(digest('owner'))).toBe('2026-11-12T12:00:00.000Z');
  expect(new HouseholdRows(f.db, 'token_use').get('valid-unrelated')).toBe('original-usage');
  expect(f.db.prepare("SELECT body FROM household_token_use WHERE id = 'unrelated'").get()).toEqual({ body: 'not-json' });
  const second = new Database(join(f.home, 'loom.db'));
  try {
    new HouseholdRows(second, 'tokens').put(digest('owner'), [{ ...record('owner'), revoked: 'now' }]);
    expect(resolver.resolve('owner')).toBeNull();
    expect(resolver.ownerDigestLive(digest('owner'))).toBe(false);
  } finally { second.close(); }
  expect(() => f.store.list()).toThrow();
  expect(existsSync(join(f.home, 'tokens.json'))).toBe(false);
  expect(existsSync(join(f.home, 'tokens.used.json'))).toBe(false);
});

it('rolls back callback writes and partial token changes, then retries atomically', () => {
  const f = fixture();
  const original = { v: 1, tokens: [record('a'), record('b')] };
  f.db.transaction(() => f.store.replace(original, { old: 'usage' }))();
  expect(() => f.store.replace(original, {})).toThrow('requires a transaction');
  expect(() => f.store.change(() => {
    f.store.touch('callback', 'written'); throw new Error('callback failure');
  })).toThrow('callback failure');
  expect(f.store.used()).toEqual({ old: 'usage' });
  f.db.exec(`CREATE TRIGGER refuse_token BEFORE UPDATE ON household_tokens WHEN NEW.id = '${digest('b')}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  const change = () => f.store.change(tokens => {
    f.store.touch('callback', 'written');
    tokens[0].revoked = 'now'; tokens[1].revoked = 'now';
  });
  expect(change).toThrow('injected failure');
  expect(f.store.document()).toEqual(original);
  expect(f.store.used()).toEqual({ old: 'usage' });
  f.db.exec('DROP TRIGGER refuse_token'); change();
  expect(f.store.list().every(t => t.revoked === 'now')).toBe(true);
  expect(f.store.used()).toEqual({ old: 'usage', callback: 'written' });
});

it('uses the supplied schema only and rejects malformed documents before writing', () => {
  const bare = new Database(':memory:');
  try {
    expect(() => new TokenDatabase(bare).document()).toThrow('no such table');
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  } finally { bare.close(); }
  const f = fixture();
  expect(f.store.document()).toBeUndefined();
  expect(() => f.store.change(() => {})).toThrow('not been imported');
  for (const raw of [null, { v: 2, tokens: [] }, { v: 1, tokens: [{ ...record('x'), sha256: 'bad' }] }]) {
    expect(() => parseTokenDocument(raw)).toThrow();
    expect(() => f.db.transaction(() => f.store.replace(raw, {}))()).toThrow();
  }
  expect(f.store.document()).toBeUndefined();
  f.db.transaction(() => f.store.replace({ v: 1, tokens: [record('x')] }, {}))();
  new HouseholdRows(f.db, 'tokens').remove(digest('x'));
  expect(() => f.store.document()).toThrow('missing household token row');
});

it('keeps usage writes separate, throttled, and applies current household and runtime policy', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  const f = fixture();
  const original = { v: 1, tokens: [record('owner'), record('agent', 'agent:ada'), record('runtime', 'runtime:runtime')] };
  f.db.transaction(() => f.store.replace(original, {}))();
  let h = f.h;
  let pieces = ['runtime'];
  const resolver = new TokenResolver(() => h, { persistence: f.store, runtimePieces: () => pieces });
  expect(resolver.resolve('owner')).toEqual({ kind: 'owner', member: 'jonathan' });
  const first = f.store.used()[digest('owner')];
  vi.advanceTimersByTime(59_999); resolver.resolve('owner');
  expect(f.store.used()[digest('owner')]).toBe(first);
  vi.advanceTimersByTime(1); resolver.resolve('owner');
  expect(f.store.used()[digest('owner')]).toBe('2026-11-12T12:01:00.000Z');
  expect(f.store.document()).toEqual(original);
  h = { ...h, agents: ['art'], members: [] };
  expect(resolver.resolve('owner')).toBeNull();
  expect(resolver.ownerMember(digest('owner'))).toBeUndefined();
  expect(resolver.resolve('agent')).toBeNull();
  pieces = [];
  expect(resolver.resolve('runtime')).toBeNull();
  expect(existsSync(join(f.home, 'tokens.used.json'))).toBe(false);
});

it('keeps replacement inside the caller import transaction, including other concerns and receipt', () => {
  const f = fixture();
  const before = { v: 1, original: true, tokens: [record('old')] };
  f.db.transaction(() => f.store.replace(before, { old: 'usage' }))();
  const next = { v: 1, replacement: true, tokens: [record('new')] };
  const members = new HouseholdRows(f.db, 'members');
  const receipts = new HouseholdRows(f.db, 'imports');
  const importAll = (interrupt: boolean) => f.db.transaction(() => {
    members.put('jonathan', { person: 'jonathan', role: 'owner' });
    f.store.replace(next, { next: 'usage' });
    receipts.put('household', { checksums: ['synthetic'], compared: true });
    if (interrupt) throw new Error('interrupted before commit');
  })();
  expect(() => importAll(true)).toThrow('interrupted before commit');
  expect(f.store.document()).toEqual(before);
  expect(f.store.used()).toEqual({ old: 'usage' });
  expect(f.store.records(digest('new'))).toEqual([]);
  expect(members.entries()).toEqual([]);
  expect(receipts.entries()).toEqual([]);
  importAll(false);
  expect(f.store.document()).toEqual(next);
  expect(f.store.used()).toEqual({ next: 'usage' });
  expect(f.store.records(digest('old'))).toEqual([]);
  expect(members.get('jonathan')).toEqual({ person: 'jonathan', role: 'owner' });
  expect(receipts.get('household')).toEqual({ checksums: ['synthetic'], compared: true });
});
