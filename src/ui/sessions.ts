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
import { createToken, firstOwner, HouseholdError, loadTokens, memberOf, type Household } from '../household.js';

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
  /** Push for Your call (push.ts): the server's VAPID keys, each browser's subscription, what's been announced. */
  push?: PushState;
  /** The Inbox: which items the owner has opened (an item's key → when), so they're no longer unread. */
  opened?: Record<string, number>;
  /**
   * Another member's own `seen` and `opened` (docs/specs/owners.md): one member's reading doesn't
   * read it for another. The first household owner keeps the household's `seen` and `opened` above.
   */
  members?: Record<string, { seen?: { at: number; since: number }; opened?: Record<string, number> }>;
}

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
interface PushState {
  vapid?: { publicKey: string; privateKey: string };
  /** By endpoint; `session` is the session it was made in, and it goes with it. */
  /** member: whose device it is (docs/specs/owners.md); none is the first household owner's. */
  subs?: Record<string, { session: string; sub: PushSub; at: number; member?: string }>;
  /** Ask keys already announced, with when they were last seen; an ask is announced once. */
  pushed?: Record<string, number>;
  /** When a process last took the watch: three listeners, one of them checks each minute. */
  tickAt?: number;
}

/** Away for at least this long, and the "new since" boundary moves up to when you last looked. */
export const SEEN_GAP_S = 15 * 60;
/** Where a reader's `seen` and `opened` live: the household's for the first owner (no reader), else their own. */
function readerOf(f: File, reader: string | undefined): { seen?: { at: number; since: number }; opened?: Record<string, number> } {
  if (!reader) return f;
  f.members ??= {};
  return (f.members[reader] ??= {});
}

/** The Inbox remembers this many opened items; past it, the longest-opened are forgotten. */
export const OPENED_MAX = 500;

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
  lookedAt(nowS = Math.floor(Date.now() / 1000), reader?: string): number {
    return this.withLock((f) => {
      const r = readerOf(f, reader);
      const was = r.seen;
      const since = !was ? nowS : nowS - was.at >= SEEN_GAP_S ? was.at : was.since;
      r.seen = { at: nowS, since };
      return since;
    });
  }

  /** lookedAt's answer without moving it: a live refresh of an open page isn't a new look. */
  seenSince(nowS = Math.floor(Date.now() / 1000), reader?: string): number {
    return this.withLock((f) => {
      const was = readerOf(f, reader).seen;
      return !was ? nowS : nowS - was.at >= SEEN_GAP_S ? was.at : was.since;
    });
  }

  /** The Inbox opened this item: it isn't unread any more (for this reader). */
  markOpened(key: string, nowS = Math.floor(Date.now() / 1000), reader?: string): void {
    this.withLock((f) => {
      const r = readerOf(f, reader);
      r.opened ??= {};
      r.opened[key] = nowS;
      const keys = Object.keys(r.opened);
      if (keys.length > OPENED_MAX) {
        for (const k of keys.sort((a, b) => r.opened![a] - r.opened![b]).slice(0, keys.length - OPENED_MAX)) delete r.opened[k];
      }
    });
  }

  /** The items this reader's Inbox has opened. */
  openedKeys(reader?: string): Set<string> {
    if (!existsSync(this.file)) return new Set();
    return this.withLock((f) => new Set(Object.keys(readerOf(f, reader).opened ?? {})));
  }

  /** The VAPID key pair, made the first time it's asked for (`make` is web-push's generator). */
  pushKeys(make: () => { publicKey: string; privateKey: string }): { publicKey: string; privateKey: string } {
    return this.withLock((f) => {
      f.push ??= {};
      f.push.vapid ??= make();
      return f.push.vapid;
    });
  }

  /** This browser's subscription, for the session it's signed in with. */
  addPushSub(session: string, sub: PushSub, nowS = Math.floor(Date.now() / 1000), member?: string): void {
    const key = hashId(session);
    this.withLock((f) => {
      if (!f.sessions[key]) return;
      f.push ??= {};
      const subs = (f.push.subs ??= {});
      subs[sub.endpoint] = { session: key, sub, at: nowS, ...(member ? { member } : {}) };
      // A household has a handful of devices; past 20, the oldest go.
      const all = Object.entries(subs).sort((a, b) => b[1].at - a[1].at);
      for (const [ep] of all.slice(20)) delete subs[ep];
    });
  }

  removePushSub(endpoint: string): void {
    this.withLock((f) => { if (f.push?.subs) delete f.push.subs[endpoint]; });
  }

  /**
   * Take this minute's watch, if no other process has (loom runs as three
   * listeners). Returns the live subscriptions and what's been announced, or
   * null when another process has the watch.
   */
  takePushWatch(everyS: number, nowS = Math.floor(Date.now() / 1000)): { subs: Array<PushSub & { member?: string }>; pushed: Record<string, number> } | null {
    return this.withLock((f) => {
      f.push ??= {};
      if (f.push.tickAt && nowS - f.push.tickAt < everyS - 5) return null;
      f.push.tickAt = nowS;
      // A subscription whose session ended goes with it.
      const subs = f.push.subs ?? {};
      for (const [ep, s] of Object.entries(subs)) if (!f.sessions[s.session]) delete subs[ep];
      return { subs: Object.values(subs).map((s) => ({ ...s.sub, ...(s.member ? { member: s.member } : {}) })), pushed: { ...(f.push.pushed ?? {}) } };
    });
  }

  /** Record the asks there are now: each stays announced while it's present, and a day after it's gone. */
  markPushed(present: string[], nowS = Math.floor(Date.now() / 1000)): void {
    this.withLock((f) => {
      f.push ??= {};
      const p = (f.push.pushed ??= {});
      for (const k of present) p[k] = nowS;
      for (const [k, at] of Object.entries(p)) if (nowS - at > 86_400) delete p[k];
    });
  }

  delete(id: string): void {
    if (!existsSync(this.file)) return;
    const key = hashId(id);
    this.withLock((f) => {
      delete f.sessions[key];
      // Signing out stops this browser's notifications too.
      for (const [ep, s] of Object.entries(f.push?.subs ?? {})) if (s.session === key) delete f.push!.subs![ep];
    });
  }
}

const stores = new Map<string, SessionStore>();

/** The store for a directory (one per process per directory). */
export function sessionStore(dir: string): SessionStore {
  let s = stores.get(dir);
  if (!s) { s = new SessionStore(dir); stores.set(dir, s); }
  return s;
}

/** The owner token a page sign-in link's sessions belong to: revoking it ends them all. */
export const LINK_TOKEN = 'page sign-in links';

/**
 * A one-time sign-in link's code (`loom token link`, and Passkeys' "Make a one-time sign-in link"),
 * for a member (docs/specs/owners.md): its session is theirs. The first household owner's links
 * use the household's link token, as before; another member's, a link token of their own.
 */
export function signinLink(h: Household, ttlS: number, member?: string): string {
  const m = member === undefined ? firstOwner(h) : memberOf(h, member);
  if (!m) throw new HouseholdError(`no member named ${member} in this household`);
  const first = m.person === firstOwner(h).person;
  const label = first ? LINK_TOKEN : `${LINK_TOKEN} · ${m.person}`;
  let record = loadTokens(h.home).find((t) => t.label === label && !t.revoked && (first ? t.member === undefined || t.member === m.person : t.member === m.person));
  if (!record) record = createToken(h, { role: { kind: 'owner', ...(first ? {} : { member: m.person }) }, label }).record;
  return sessionStore(h.home).createLink(Buffer.from(record.sha256, 'hex'), ttlS);
}
