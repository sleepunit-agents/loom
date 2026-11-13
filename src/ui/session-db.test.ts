import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../core/db/index.js';
import { migrateHouseholdTables } from '../core/household/schema.js';
import { HouseholdRows } from '../core/household/rows.js';
import { SessionDatabase } from './session-db.js';
import { MAX_SESSIONS, SEEN_EVERY_S, SessionStore, type SessionFile } from './sessions.js';

const digest = Buffer.alloc(32, 7);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

describe('session database persistence before activation', () => {
  let home: string, db: Db, lease: ReturnType<typeof openDb>, persistence: SessionDatabase;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-session-db-'));
    lease = openDb(home); db = lease.db;
    migrateHouseholdTables(db);
    persistence = new SessionDatabase(db);
  });
  afterEach(() => { lease.close(); rmSync(home, { recursive: true, force: true }); });
  const passkey = { id: 'credential', publicKey: 'AA-_exact', alg: -7, counter: 4, label: 'phone', created: 900,
    secret: digest.toString('hex'), tokenLabel: 'own passkey' };

  it('round trips all fields, unknown fields and omitted fields, without credential normalization', () => {
    const raw = {
      v: 1, sessions: { [hash('cookie')]: { issuedAt: 1000, secret: digest.toString('hex'), signedInAt: 950, device: 'Safari on iPhone', label: 'original', via: 'passkey', agent: true, future: 'kept' } },
      links: { [hash('link')]: { expires: 1200, secret: digest.toString('hex'), label: 'old link', signedInAt: 950 } },
      challenges: { [hash('challenge')]: { purpose: 'register', expires: 1200, secret: digest.toString('hex') } },
      passkeys: { credential: passkey }, prefs: { look: '000h', mode: 'light', tiling: false, at: 3 },
      seen: { at: 2, since: 1 }, opened: { abc: 2 }, done: [],
      members: { pollock: { prefs: { look: 'lowlight' }, opened: { xyz: 3 }, future: true }, '__proto__': {} },
      push: { vapid: { publicKey: 'public', privateKey: 'private' }, subs: { 'https://push.invalid/a': {
        session: hash('cookie'), token: digest.toString('hex'), sub: { endpoint: 'https://push.invalid/a', keys: { p256dh: 'key', auth: 'auth' } }, at: 1,
      } }, removed: ['old-endpoint'], pushed: { ask: 1 }, tickAt: 2, future: ['kept'] }, future: { raw: [1, null, false] },
    } as unknown as SessionFile;
    db.transaction(() => persistence.replace(raw))();
    expect(persistence.read()).toEqual(raw);
    expect(new HouseholdRows(db, 'push').entries().map(([id]) => id)).toEqual(['state', 'sub:https://push.invalid/a']);
    expect(new HouseholdRows(db, 'readers').get('pollock')).toEqual(raw.members!.pollock);
    expect(() => persistence.replace(raw)).toThrow('requires a transaction');
    const store = new SessionStore(home, persistence);
    expect(store.get('cookie')).toEqual({ issuedAt: 1000, signedInAt: 950, secret: digest, agent: true });
    expect(store.prefs()).toMatchObject({ look: 'daylight', oneWindow: true });
    store.setPrefs({ sound: true }, undefined, 4);
    expect(persistence.read().prefs).toEqual({ ...raw.prefs, sound: true, at: 4 });
    expect(persistence.read().members).toEqual(raw.members);
    expect(persistence.read().passkeys).toEqual(raw.passkeys);
    for (const minimal of [{ v: 1, sessions: {} }, { v: 1, sessions: {}, links: {}, members: {}, push: { subs: {} } }] as SessionFile[]) {
      db.transaction(() => persistence.replace(minimal))();
      expect(persistence.read()).toEqual(minimal);
    }
  });

  it('session/link/challenge/passkey verification decodes only its keyed row', () => {
    const s = new SessionStore(home, persistence);
    const id = s.create(digest, 1000), link = s.createLink(digest, 100, 1000);
    const challenge = s.createChallenge('register', digest, 100, 1000);
    s.addPasskey(passkey);
    db.pragma('ignore_check_constraints = ON');
    for (const table of ['sessions', 'links', 'challenges', 'passkeys']) db.prepare(`INSERT INTO household_${table} VALUES (?, ?)`).run('unrelated', 'invalid-json');
    db.pragma('ignore_check_constraints = OFF');
    const read = vi.spyOn(persistence, 'read').mockImplementation(() => { throw new Error('whole store read'); });
    expect(s.get(id)).toEqual({ issuedAt: 1000, secret: digest });
    expect(s.peekLink(link, 1001)).toEqual(digest);
    expect(s.hasChallenge(challenge, 'register', 1001)).toBe(true);
    expect(s.passkey(passkey.id)).toEqual(passkey);
    s.touch(id, 1001);
    s.touch(id, 1001 + SEEN_EVERY_S - 1);
    expect(persistence.get('sessions', hash(id))?.seenAt).toBe(1001);
    s.touch(id, 1001 + SEEN_EVERY_S);
    expect(persistence.get('sessions', hash(id))?.seenAt).toBe(1001 + SEEN_EVERY_S);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    for (const table of ['sessions', 'links', 'challenges', 'passkeys']) db.prepare(`DELETE FROM household_${table} WHERE id = ?`).run('unrelated');
    expect(existsSync(join(home, 'ui-sessions.json'))).toBe(false);
  });

  it('persists every binding across connection close and reopening, without the JSON file', () => {
    const s = new SessionStore(home, persistence), key = s.key;
    const cookie = s.create(digest, 1000, { via: 'passkey', signedInAt: 900 });
    const link = s.createLink(digest, 100, 1000, 'label', 900, true);
    const challenge = s.createChallenge('register', digest, 100, 1000);
    s.addPasskey(passkey);
    s.setPrefs({ sound: false }, 'pollock', 1000);
    s.markOpened('private', 1000, 'pollock');
    expect(s.pushKeys(() => ({ publicKey: 'pub', privateKey: 'priv' }))).toEqual({ publicKey: 'pub', privateKey: 'priv' });
    expect(s.addPushSub(cookie, { endpoint: 'https://push.invalid/a', keys: { auth: 'a', p256dh: 'b' } }, 1000, 'pollock')).toBe('added');
    const expected = persistence.read();
    lease.close(); lease = openDb(home); db = lease.db; persistence = new SessionDatabase(db);
    const after = new SessionStore(home, persistence);
    expect(persistence.read()).toEqual(expected);
    expect(after.key).toEqual(key);
    expect(after.get(cookie)).toEqual({ issuedAt: 1000, signedInAt: 900, secret: digest });
    expect(after.spendLink(link, 1001)).toEqual({ secret: digest, label: 'label', signedInAt: 900, agent: true });
    expect(new SessionStore(home, persistence).useLink(link, 1001)).toBeNull();
    expect(after.useChallenge(challenge, 'register', 1001)).toEqual({ secret: digest });
    expect(after.useChallenge(challenge, 'register', 1001)).toBeNull();
    expect(after.usePasskey('credential', 4, 1001)).toBeNull();
    expect(after.usePasskey('credential', 5, 1001)).toEqual({ ...passkey, counter: 5, lastUsed: 1001 });
    expect(after.prefs('pollock')).toMatchObject({ sound: false });
    expect(after.openedKeys('pollock')).toEqual(new Set(['private']));
    expect(after.openedKeys()).toEqual(new Set());
    expect(after.pushDevices('pollock')).toHaveLength(1);
    expect(after.pushKeys(() => { throw new Error('must keep VAPID'); })).toEqual({ publicKey: 'pub', privateKey: 'priv' });
    expect(after.revoke(after.refOf(cookie))).toBe(true);
    expect(after.get(cookie)).toBeNull();
    expect(after.pushDevices('pollock')).toEqual([]);
    expect(after.removePasskey('credential')).toBe(true);
    expect(after.passkeys()).toEqual([]);
    expect(existsSync(join(home, 'ui-sessions.json'))).toBe(false);
  });

  it('uses only the selected persistence, leaving existing JSON unchanged', () => {
    const source = JSON.stringify({ v: 1, sessions: { [hash('old-cookie')]: { issuedAt: 1000, secret: digest.toString('hex') } } });
    writeFileSync(join(home, 'ui-sessions.json'), source);
    const json = new SessionStore(home);
    const sql = new SessionStore(home, persistence);
    expect(json.get('old-cookie')).not.toBeNull();
    expect(sql.get('old-cookie')).toBeNull();
    const id = sql.create(digest, 1000);
    expect(json.get(id)).toBeNull();
    expect(readFileSync(join(home, 'ui-sessions.json'), 'utf8')).toBe(source);
  });

  it('rolls all concerns back if interrupted, and permits a complete retry', () => {
    const before: SessionFile = { v: 1, sessions: {} };
    db.transaction(() => persistence.replace(before))();
    expect(() => persistence.change(f => {
      f.sessions[hash('cookie')] = { issuedAt: 1000, secret: digest.toString('hex') };
      f.passkeys = { credential: passkey };
      throw new Error('interrupted');
    })).toThrow('interrupted');
    expect(persistence.read()).toEqual(before);
    // Failure after one table has already been written also rolls it back.
    db.exec("CREATE TRIGGER abort_passkeys BEFORE INSERT ON household_passkeys BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    expect(() => persistence.change(f => { f.sessions[hash('cookie')] = { issuedAt: 1000, secret: digest.toString('hex') }; f.passkeys = { credential: passkey }; })).toThrow('interrupted');
    expect(persistence.read()).toEqual(before);
    db.exec('DROP TRIGGER abort_passkeys');
    persistence.change(f => { f.sessions[hash('cookie')] = { issuedAt: 1000, secret: digest.toString('hex') }; f.passkeys = { credential: passkey }; });
    expect(new SessionStore(home, persistence).get('cookie')).not.toBeNull();
    expect(persistence.read().passkeys).toEqual({ credential: passkey });
  });

  it.each(['link', 'challenge'] as const)('holds a write transaction from reading through consuming a %s', (kind) => {
    const first = new SessionStore(home, persistence);
    const code = kind === 'link' ? first.createLink(digest, 100, 1000) : first.createChallenge('register', digest, 100, 1000);
    const other = new Database(join(home, 'loom.db'), { timeout: 0 });
    try {
      const second = new SessionStore(home, new SessionDatabase(other));
      const read = persistence.read.bind(persistence);
      const intercept = vi.spyOn(persistence, 'read').mockImplementationOnce(() => {
        const value = read();
        // Interleave another connection after the first has read, before it
        // deletes. Without an enclosing write transaction both could spend it.
        expect(db.inTransaction).toBe(true);
        expect(() => kind === 'link' ? second.spendLink(code, 1001) : second.useChallenge(code, 'register', 1001)).toThrow(/locked/);
        return value;
      });
      expect(kind === 'link' ? first.spendLink(code, 1001) : first.useChallenge(code, 'register', 1001)).toEqual({ secret: digest });
      intercept.mockRestore();
      expect(kind === 'link' ? second.spendLink(code, 1001) : second.useChallenge(code, 'register', 1001)).toBeNull();
    } finally { other.close(); }
  });

  it('uses the supplied connection even when migration metadata and a home path are absent', () => {
    const memory = new Database(':memory:');
    try {
      // The table layout is already installed; no migration metadata survives.
      // An adapter that tries to open or migrate a home cannot use this store.
      memory.exec('CREATE TABLE core_migrations (piece TEXT, number INTEGER, sql TEXT, PRIMARY KEY(piece, number))');
      migrateHouseholdTables(memory);
      memory.exec('DROP TABLE core_migrations');
      const supplied = new SessionDatabase(memory);
      supplied.change(f => { f.sessions.known = { issuedAt: 1, secret: digest.toString('hex') }; });
      expect(supplied.get('sessions', 'known')).toEqual({ issuedAt: 1, secret: digest.toString('hex') });
      expect(new HouseholdRows(memory, 'sessions').get('known')).toEqual({ issuedAt: 1, secret: digest.toString('hex') });
      memory.close();
      expect(() => supplied.read()).toThrow(/not open/);
    } finally { if (memory.open) memory.close(); }
  });

  it('a busy database never delays last-use bookkeeping or loses another reader choice', () => {
    const s = new SessionStore(home, persistence), id = s.create(digest, 1000);
    const other = new Database(join(home, 'loom.db'), { timeout: 0 });
    try {
      other.exec('BEGIN IMMEDIATE');
      s.touch(id, 2000);
      expect(persistence.get('sessions', hash(id))?.seenAt).toBeUndefined();
      expect(() => s.setPrefs({ sound: true }, 'pollock', 1000)).toThrow(/locked/);
      other.exec('ROLLBACK');
      s.setPrefs({ sound: false }, 'pollock', 1000);
      s.touch(id, 2000);
      expect(persistence.get('sessions', hash(id))?.seenAt).toBe(2000);
      expect(s.prefs('pollock')).toMatchObject({ sound: false });
    } finally { if (other.inTransaction) other.exec('ROLLBACK'); other.close(); }
  });

  it('restricts a formerly public database and its already-open sidecars before use', () => {
    lease.close();
    const older = new Database(join(home, 'loom.db'));
    try {
      older.pragma('journal_mode = WAL');
      older.exec('CREATE TABLE legacy (id TEXT)');
      for (const suffix of ['', '-wal', '-shm']) chmodSync(join(home, 'loom.db') + suffix, 0o666);
      lease = openDb(home); db = lease.db;
      for (const suffix of ['', '-wal', '-shm']) expect(statSync(join(home, 'loom.db') + suffix).mode & 0o777).toBe(0o600);
    } finally { older.close(); }
  });

  it('caps sessions with the same preference for people over agents, and never stores cookie/link ids', () => {
    const s = new SessionStore(home, persistence);
    const agent = s.create(digest, 1000, { agent: true });
    const ids = Array.from({ length: MAX_SESSIONS }, (_, i) => s.create(digest, 1001 + i));
    expect(s.get(agent)).toBeNull();
    expect(s.get(ids[0])).not.toBeNull();
    expect(s.list()).toHaveLength(MAX_SESSIONS);
    const link = s.createLink(digest, 100, 1000);
    const rows = JSON.stringify(persistence.read());
    expect(rows).not.toContain(ids[0]); expect(rows).not.toContain(link);
    expect(new HouseholdRows(db, 'sessions').get(hash(ids[0]))).toEqual({ issuedAt: 1001, secret: digest.toString('hex') });
    expect(statSync(join(home, 'loom.db')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'loom.db-wal')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'loom.db-shm')).mode & 0o777).toBe(0o600);
  });
});
