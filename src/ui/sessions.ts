/**
 * The page's browser sessions, kept on disk so a restart doesn't sign anyone
 * out, and shared by every loom-http process on the machine (a household
 * runs one per address). Before this they lived in memory, and every
 * restart (a deploy, a reboot) ended them all.
 *
 * What's kept, in `ui-sessions.json` (0600, beside household.json):
 *   - each session under the sha256 of its id, never the id itself, so the
 *     file can't be replayed as cookies;
 *   - when it was issued, and the digest of the token it was opened with
 *     (a session still dies with its token: rotate or revoke it and they stop);
 * one-time sign-in links (`loom token link`), also by hash: single use, and
 * gone after their few minutes whether used or not;
 * and in `ui-cookie.key` (0600), the key that binds an anti-forgery token to
 * its session, so a form opened before a restart still posts after it.
 *
 * Writes are read-modify-write under a lock file and land by rename.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface Session { issuedAt: number; secret: Buffer }

interface Stored { issuedAt: number; secret: string }
interface Link { expires: number; secret: string }
/** A WebAuthn credential (docs/specs/passkeys.md): signs in as the token digest that added it. */
export interface Passkey {
  id: string;
  publicKey: string;
  alg: number;
  counter: number;
  label: string;
  created: number;
  lastUsed?: number;
  secret: string;
}
interface Challenge { expires: number; purpose: 'register' | 'login'; secret?: string }
interface File {
  v: 1;
  sessions: Record<string, Stored>;
  links?: Record<string, Link>;
  passkeys?: Record<string, Passkey>;
  challenges?: Record<string, Challenge>;
  /** "Since you last looked": when Home was last opened, and the boundary it shows. */
  seen?: { at: number; since: number };
}

/** Away for at least this long, and the "new since" boundary moves up to when you last looked. */
export const SEEN_GAP_S = 15 * 60;

export const MAX_PASSKEYS = 20;

export const MAX_SESSIONS = 50;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

const hashId = (id: string) => createHash('sha256').update(id).digest('hex');

export class SessionStore {
  private readonly file: string;
  private readonly lockFile: string;
  readonly key: Buffer;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'ui-sessions.json');
    this.lockFile = join(dir, 'ui-sessions.lock');
    this.key = this.loadKey(join(dir, 'ui-cookie.key'));
  }

  private loadKey(path: string): Buffer {
    try {
      const k = readFileSync(path);
      if (k.length === 32) return k;
    } catch { /* first run */ }
    const k = randomBytes(32);
    try {
      // wx: if another process wrote one first, use theirs.
      writeFileSync(path, k, { mode: 0o600, flag: 'wx' });
      return k;
    } catch {
      return readFileSync(path);
    }
  }

  private read(): File {
    try {
      const f = JSON.parse(readFileSync(this.file, 'utf-8')) as File;
      if (f && f.v === 1 && typeof f.sessions === 'object') return f;
    } catch { /* missing or torn: no sessions */ }
    return { v: 1, sessions: {} };
  }

  private withLock<T>(fn: (f: File) => T): T {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(this.lockFile, 'wx', 0o600);
      } catch {
        // A holder that died leaves its lock; one this old is gone.
        try { if (Date.now() - statSync(this.lockFile).mtimeMs > LOCK_STALE_MS) rmSync(this.lockFile, { force: true }); } catch { /* raced */ }
        if (Date.now() > deadline) throw new Error('ui sessions are locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      writeSync(fd, String(process.pid));
      const f = this.read();
      const out = fn(f);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
      renameSync(tmp, this.file);
      return out;
    } finally {
      closeSync(fd);
      rmSync(this.lockFile, { force: true });
    }
  }

  /** A new session for this token digest; returns the cookie's id. The oldest go past the cap. */
  create(secret: Buffer, nowS = Math.floor(Date.now() / 1000)): string {
    const id = randomBytes(32).toString('hex');
    this.withLock((f) => {
      f.sessions[hashId(id)] = { issuedAt: nowS, secret: secret.toString('hex') };
      const keys = Object.keys(f.sessions).sort((a, b) => f.sessions[a].issuedAt - f.sessions[b].issuedAt);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete f.sessions[k];
    });
    return id;
  }

  get(id: string): Session | null {
    const s = this.read().sessions[hashId(id)];
    return s ? { issuedAt: s.issuedAt, secret: Buffer.from(s.secret, 'hex') } : null;
  }

  /** A one-time sign-in code for this token digest, good for `ttlS` seconds. */
  createLink(secret: Buffer, ttlS: number, nowS = Math.floor(Date.now() / 1000)): string {
    const code = randomBytes(32).toString('hex');
    this.withLock((f) => {
      f.links ??= {};
      for (const [k, l] of Object.entries(f.links)) if (l.expires <= nowS) delete f.links[k];
      f.links[hashId(code)] = { expires: nowS + ttlS, secret: secret.toString('hex') };
    });
    return code;
  }

  /** Spend a sign-in code: its token digest if it's live and unexpired, and it's gone either way. */
  useLink(code: string, nowS = Math.floor(Date.now() / 1000)): Buffer | null {
    if (!existsSync(this.file)) return null;
    return this.withLock((f) => {
      const l = f.links?.[hashId(code)];
      if (!l) return null;
      delete f.links![hashId(code)];
      return l.expires > nowS ? Buffer.from(l.secret, 'hex') : null;
    });
  }

  /**
   * A one-time WebAuthn challenge (base64url), good for `ttlS` seconds; one
   * for registering also carries the token digest of the session asking.
   */
  createChallenge(purpose: Challenge['purpose'], secret: Buffer | null, ttlS = 300, nowS = Math.floor(Date.now() / 1000)): string {
    const challenge = randomBytes(32).toString('base64url');
    this.withLock((f) => {
      f.challenges ??= {};
      for (const [k, c] of Object.entries(f.challenges)) if (c.expires <= nowS) delete f.challenges[k];
      // A flood of unauthenticated sign-in attempts can't grow the file without bound.
      const keys = Object.keys(f.challenges).sort((a, b) => f.challenges![a].expires - f.challenges![b].expires);
      for (const k of keys.slice(0, Math.max(0, keys.length - 99))) delete f.challenges[k];
      f.challenges[hashId(challenge)] = { expires: nowS + ttlS, purpose, ...(secret ? { secret: secret.toString('hex') } : {}) };
    });
    return challenge;
  }

  /** Spend a challenge: it's gone either way; null unless it was this purpose and unexpired. */
  useChallenge(challenge: string, purpose: Challenge['purpose'], nowS = Math.floor(Date.now() / 1000)): { secret: Buffer | null } | null {
    if (!existsSync(this.file)) return null;
    return this.withLock((f) => {
      const c = f.challenges?.[hashId(challenge)];
      if (!c) return null;
      delete f.challenges![hashId(challenge)];
      if (c.expires <= nowS || c.purpose !== purpose) return null;
      return { secret: c.secret ? Buffer.from(c.secret, 'hex') : null };
    });
  }

  passkeys(): Passkey[] {
    return Object.values(this.read().passkeys ?? {}).sort((a, b) => a.created - b.created);
  }

  passkey(id: string): Passkey | null {
    return this.read().passkeys?.[id] ?? null;
  }

  addPasskey(p: Passkey): void {
    this.withLock((f) => {
      f.passkeys ??= {};
      if (f.passkeys[p.id]) throw new Error('that passkey is already added');
      if (Object.keys(f.passkeys).length >= MAX_PASSKEYS) throw new Error(`at most ${MAX_PASSKEYS} passkeys; remove one first`);
      f.passkeys[p.id] = p;
    });
  }

  /** Record a sign-in: the new counter (refusing one that didn't go up) and when. */
  usePasskey(id: string, counter: number, nowS = Math.floor(Date.now() / 1000)): Passkey | null {
    return this.withLock((f) => {
      const p = f.passkeys?.[id];
      if (!p) return null;
      // A counter that didn't go up, when either side has one, means the key was copied.
      if ((counter !== 0 || p.counter !== 0) && counter <= p.counter) return null;
      p.counter = counter;
      p.lastUsed = nowS;
      return { ...p };
    });
  }

  removePasskey(id: string): boolean {
    if (!existsSync(this.file)) return false;
    return this.withLock((f) => {
      if (!f.passkeys?.[id]) return false;
      delete f.passkeys[id];
      return true;
    });
  }

  /**
   * Home was opened now: the boundary to draw new items against. It moves up
   * to the last visit only after SEEN_GAP_S away, so a reload or a quick trip
   * to another page doesn't wipe the new dots. The first visit ever has none.
   */
  lookedAt(nowS = Math.floor(Date.now() / 1000)): number {
    return this.withLock((f) => {
      const was = f.seen;
      const since = !was ? nowS : nowS - was.at >= SEEN_GAP_S ? was.at : was.since;
      f.seen = { at: nowS, since };
      return since;
    });
  }

  delete(id: string): void {
    if (!existsSync(this.file)) return;
    this.withLock((f) => { delete f.sessions[hashId(id)]; });
  }
}

const stores = new Map<string, SessionStore>();

/** The store for a directory (one per process per directory). */
export function sessionStore(dir: string): SessionStore {
  let s = stores.get(dir);
  if (!s) { s = new SessionStore(dir); stores.set(dir, s); }
  return s;
}
