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
interface File { v: 1; sessions: Record<string, Stored>; links?: Record<string, Link> }

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
