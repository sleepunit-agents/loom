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
 *   - what it was opened on (the browser and system its User-Agent names), the
 *     label its sign-in link had, and when it was last used (to the five
 *     minutes), so the owner can tell their sessions apart and end one alone
 *     (t-1871), by its ref: the first 16 hex of the id's hash;
 * one-time sign-in links (`loom token link`), also by hash: single use, and
 * gone after their few minutes whether used or not;
 * each person's Appearance (the look, light or dark, the ground, sound) and
 * Accessibility (zoom, motion, contrast), so it follows them to every device: a preference they chose, never what they browsed;
 * and in `ui-cookie.key` (0600), the key that binds an anti-forgery token to
 * its session, so a form opened before a restart still posts after it.
 *
 * Writes are read-modify-write under a lock file and land by rename.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createToken, expired, firstOwner, HouseholdError, isLive, loadTokens, memberOf, revokeToken, type Household } from '../household.js';

export interface Session { issuedAt: number; secret: Buffer }

/** How a session signed in: a token pasted, a one-time link, a passkey. */
export type Via = 'token' | 'link' | 'passkey';
interface Stored { issuedAt: number; secret: string; seenAt?: number; device?: string; label?: string; via?: Via }
interface Link { expires: number; secret: string; label?: string }

/** A session as the owner sees it (the Account page, `loom sessions`): never its id, only its ref. */
export interface SessionInfo { ref: string; issuedAt: number; seenAt?: number; device?: string; label?: string; via?: Via; secret: Buffer }
/** How it was opened, beside its token: what the browser said it was, how it signed in, and the label its sign-in link carried. */
interface SessionMeta { device?: string; label?: string; via?: Via }
/** A session's ref: the start of its id's hash, enough to name one among MAX_SESSIONS, useless as a cookie. */
export const REF = /^[0-9a-f]{16}$/;
/** A session's last use is written at most this often (each write is a locked rewrite of the file). */
export const SEEN_EVERY_S = 5 * 60;
/** A sign-in link's label: a few plain words, kept with the session it opens. */
const LABEL_MAX = 60;
/** A label or a device name, as kept: plain words, at most LABEL_MAX characters. */
const cleanLabel = (l: string | undefined) => {
  // Printable words only: no control characters, so a label can't break a terminal's line or the file, and no invisible
  // or direction-changing ones (zero-width, bidi overrides), so it can't pass itself off as another row's words.
  const t = (l ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u061c\u180e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim();
  return t || undefined;
};

/** What a User-Agent says the device is, in a few words ("Chrome on Android", "HeadlessChrome on Linux"); none if it says nothing loom knows. */
export function deviceOf(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  const browser = /HeadlessChrome\//.test(ua) ? 'HeadlessChrome' : /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /^curl\//.test(ua) ? 'curl' : undefined;
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : undefined;
  if (!browser && !system) return undefined;
  return browser && system ? `${browser} on ${system}` : (browser ?? system);
}
/**
 * A WebAuthn credential (docs/specs/passkeys.md). `secret` is the digest of the owner token it signs in as. In a
 * household that's its own token, minted for its person when it's added (`tokenLabel`, t-1969), so revoking any
 * other token (the sign-in links', the one the adding browser used) never stops it; removing the passkey or the
 * person's membership does. Without `tokenLabel` (outside a household, or not yet migrated): the adding session's token.
 */
export interface Passkey {
  id: string;
  publicKey: string;
  alg: number;
  counter: number;
  label: string;
  created: number;
  lastUsed?: number;
  secret: string;
  /** The label of its own owner token (passkeyToken), when it has one. */
  tokenLabel?: string;
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
  members?: Record<string, { seen?: { at: number; since: number }; opened?: Record<string, number>; done?: Done[]; prefs?: Prefs }>;
  /** The first household owner's Appearance (a member's own is under `members`): a preference, never what they browsed. */
  prefs?: Prefs;
  /** What the owner's actions said (their toasts), kept as FYI items in the Inbox (Jonathan, 2026-11-03). */
  done?: Done[];
}

/**
 * A person's Appearance (web/src/look.ts; Jonathan, 2026-11-04: "if every device I login I have to go and change the
 * theme, that sucks"): the look (Neon Noir, Low Light or Daylight), the ground, sound, pixel faces, pixel icons and haptics, and their
 * Accessibility (Allow zoom, Reduce motion, Higher contrast). Only what they chose; kept per member
 * like `seen`, so it follows them to every device they sign in on.
 *
 * `look: '000h'` and `mode` are from before 2026-11-05, when 000h was a look with a light and a dark: a device still
 * running that app may send them, so both are still taken, kept as sent, and 000h is read back as the look nearest it
 * (lookOf: Daylight if its mode was light, else Low Light). Nothing else reads `mode`.
 */
export interface Prefs { look?: Look | '000h'; mode?: 'auto' | 'light' | 'dark'; ground?: 'depth' | 'contours' | 'wash'; sound?: boolean; pixel?: boolean; haptics?: boolean;
  /** Pixel icons (Appearance, web/src/app-icon.tsx): the household's icon set in place of the line icons; off unless turned on. */
  icons?: boolean;
  /** One window at a time (Accessibility, docs/specs/desk-tiling.md, "One window at a time"): the tiled desktop with
   * one app tile at most; opening another sends the one there to the dock. Off unless turned on. */
  oneWindow?: boolean;
  /** Before 2026-11-06, Appearance's "Desktop" (Tiling or One window at a time). Tiling is the only desktop now: still
   * taken and kept, so a device running the older app gets no error, and read back as `oneWindow` (oneWindowOf). */
  tiling?: boolean;
  /** Allow zoom (Accessibility): pinch and double-tap zoom on a phone (web/src/immersion.ts; off unless turned on). */
  zoom?: boolean;
  /** Reduce motion (Accessibility, web/src/access.ts): follow the phone's own setting (the default), or on, or off. */
  motion?: 'follow' | 'on' | 'off';
  /** Higher contrast (Accessibility, web/src/access.ts): follow the phone's prefers-contrast (the default), or on, or off. */
  contrast?: 'follow' | 'on' | 'off';
  /** When it last changed (ms, loom's clock): a device applies only a newer one, so an answer already on its way when a choice was made doesn't undo it. */
  at?: number }
export type Look = 'neon' | 'lowlight' | 'daylight';
/** A kept look as loom serves it now: 000h as the look nearest it, anything else unknown as Neon Noir, none as none
 * (web/src/look.ts lookOf, the same rule; look-migration.test.ts holds the two to each other). */
export function lookOf(look: unknown, mode: unknown): Look | undefined {
  if (look === undefined) return undefined;
  if (look === 'neon' || look === 'lowlight' || look === 'daylight') return look;
  return look === '000h' ? (mode === 'light' ? 'daylight' : 'lowlight') : 'neon';
}
/** Prefs as loom serves them: one who chose "One window at a time" under Appearance's old Desktop (`tiling: false`) and
 * hasn't chosen in Accessibility since has One window at a time on. What's on disk stays as it was. (A device's own copy
 * of the old choice, `loom-tiling` = `off`, is read the same way for first paint: web/src/look.ts oneWindowKept.) */
export function oneWindowOf(p: Prefs): Prefs {
  return p.oneWindow === undefined && p.tiling === false ? { ...p, oneWindow: true } : p;
}
const PREF_VALUES: { [K in Exclude<keyof Prefs, 'at'>]-?: readonly unknown[] } = {
  look: ['neon', 'lowlight', 'daylight', '000h'], mode: ['auto', 'light', 'dark'], ground: ['depth', 'contours', 'wash'], sound: [true, false], pixel: [true, false], icons: [true, false], tiling: [true, false], oneWindow: [true, false], haptics: [true, false], zoom: [true, false],
  motion: ['follow', 'on', 'off'], contrast: ['follow', 'on', 'off'],
};
/** The Appearance fields of a request body (none: empty), or null if any field given isn't one loom keeps. */
export function prefsOf(body: Record<string, unknown>): Prefs | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === '_csrf') continue;
    // Its own keys only: a body's "constructor" or "__proto__" is no Appearance choice.
    if (!Object.hasOwn(PREF_VALUES, k) || !PREF_VALUES[k as keyof typeof PREF_VALUES].includes(v)) return null;
    out[k] = v;
  }
  return out as Prefs;
}

/** One action's outcome, as its toast said it: an FYI item in the Inbox afterwards. */
export interface Done {
  /** When, in seconds. */
  at: number;
  ok: boolean;
  /** The toast's line. */
  text: string;
  /** Who said it: loom, or a piece (its id and its tab's label). */
  source: { id: string; base: string; act?: string };
  sourceLabel?: string;
  /** Where it was done (a loom: or piece link), to go back to. */
  page?: string;
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
/** The Inbox keeps this many of the owner's own outcomes; past it, the oldest go. */
export const DONE_MAX = 50;

/** Where a reader's `seen` and `opened` live: the household's for the first owner (no reader), else their own. */
function readerOf(f: File, reader: string | undefined): { seen?: { at: number; since: number }; opened?: Record<string, number>; done?: Done[]; prefs?: Prefs } {
  if (!reader) return f;
  f.members ??= {};
  return (f.members[reader] ??= {});
}

/** The Inbox remembers this many opened items; past it, the longest-opened are forgotten. */
export const OPENED_MAX = 500;

export const MAX_PASSKEYS = 20;

export const MAX_SESSIONS = 50;
/** How long a session lasts from sign-in (its cookie's Max-Age; handler.ts ends it past this). */
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
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

  /** Read, change and write the file under its lock, waiting up to `waitMs` for it (0: one try, no wait). */
  private withLock<T>(fn: (f: File) => T, waitMs = LOCK_WAIT_MS): T {
    const deadline = Date.now() + waitMs;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(this.lockFile, 'wx', 0o600);
      } catch {
        // A holder that died leaves its lock; one this old is gone.
        try { if (Date.now() - statSync(this.lockFile).mtimeMs > LOCK_STALE_MS) rmSync(this.lockFile, { force: true }); } catch { /* raced */ }
        if (Date.now() >= deadline) throw new Error('ui sessions are locked');
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
  create(secret: Buffer, nowS = Math.floor(Date.now() / 1000), meta: SessionMeta = {}): string {
    const id = randomBytes(32).toString('hex');
    const device = cleanLabel(meta.device);
    const label = cleanLabel(meta.label);
    const via = meta.via && ['token', 'link', 'passkey'].includes(meta.via) ? meta.via : undefined;
    this.withLock((f) => {
      f.sessions[hashId(id)] = { issuedAt: nowS, secret: secret.toString('hex'), ...(device ? { device } : {}), ...(label ? { label } : {}), ...(via ? { via } : {}) };
      const keys = Object.keys(f.sessions).sort((a, b) => f.sessions[a].issuedAt - f.sessions[b].issuedAt);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete f.sessions[k];
    });
    return id;
  }

  get(id: string): Session | null {
    const s = this.read().sessions[hashId(id)];
    return s ? { issuedAt: s.issuedAt, secret: Buffer.from(s.secret, 'hex') } : null;
  }

  /** A one-time sign-in code for this token digest, good for `ttlS` seconds; `label` goes to the session it opens. */
  createLink(secret: Buffer, ttlS: number, nowS = Math.floor(Date.now() / 1000), label?: string): string {
    const code = randomBytes(32).toString('hex');
    const named = cleanLabel(label);
    this.withLock((f) => {
      f.links ??= {};
      for (const [k, l] of Object.entries(f.links)) if (l.expires <= nowS) delete f.links[k];
      f.links[hashId(code)] = { expires: nowS + ttlS, secret: secret.toString('hex'), ...(named ? { label: named } : {}) };
    });
    return code;
  }

  /** Spend a sign-in code: its token digest if it's live and unexpired, and it's gone either way. */
  useLink(code: string, nowS = Math.floor(Date.now() / 1000)): Buffer | null {
    return this.spendLink(code, nowS)?.secret ?? null;
  }

  /** useLink, with the label the link was made with. */
  spendLink(code: string, nowS = Math.floor(Date.now() / 1000)): { secret: Buffer; label?: string } | null {
    if (!existsSync(this.file)) return null;
    return this.withLock((f) => {
      const l = f.links?.[hashId(code)];
      if (!l) return null;
      delete f.links![hashId(code)];
      return l.expires > nowS ? { secret: Buffer.from(l.secret, 'hex'), ...(l.label ? { label: l.label } : {}) } : null;
    });
  }

  /** Every session, the most recently used first (else the most recently signed in), as the owner sees them: refs, never ids. */
  list(): SessionInfo[] {
    if (!existsSync(this.file)) return [];
    return Object.entries(this.read().sessions)
      .map(([k, s]) => ({ ref: k.slice(0, 16), issuedAt: s.issuedAt, ...(s.seenAt ? { seenAt: s.seenAt } : {}), ...(s.device ? { device: s.device } : {}),
        ...(s.label ? { label: s.label } : {}), ...(s.via ? { via: s.via } : {}), secret: Buffer.from(s.secret, 'hex') }))
      .sort((a, b) => (b.seenAt ?? b.issuedAt) - (a.seenAt ?? a.issuedAt));
  }

  /** The ref of the session this cookie id opens (to say "this device"). */
  refOf(id: string): string {
    return hashId(id).slice(0, 16);
  }

  /**
   * The session was used now: noted at most every SEEN_EVERY_S, so a busy page doesn't rewrite the file each request.
   * Under the lock like every write (a write outside it would lose another process's), but one try and no wait: when
   * another process holds it, this request goes on and a later one notes it. Last used is a nicety; a page never
   * waits or fails for it.
   */
  touch(id: string, nowS = Math.floor(Date.now() / 1000)): void {
    const key = hashId(id);
    const s = this.read().sessions[key];
    if (!s || (s.seenAt !== undefined && nowS - s.seenAt < SEEN_EVERY_S)) return;
    try {
      this.withLock((f) => { if (f.sessions[key]) f.sessions[key].seenAt = nowS; }, 0);
    } catch { /* locked: a later request notes it */ }
  }

  /**
   * End one session by its ref (the Account page, `loom sessions revoke`): that browser is signed out at once, and its
   * notifications stop; every other session, its token's too, goes on. False when no session, or more than one, has it.
   */
  revoke(ref: string): boolean {
    if (!REF.test(ref) || !existsSync(this.file)) return false;
    return this.withLock((f) => {
      const keys = Object.keys(f.sessions).filter((k) => k.startsWith(ref));
      if (keys.length !== 1) return false;
      drop(f, keys[0]);
      return true;
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

  /** Move a passkey onto its own token (migratePasskeys): only if it still signs in as `from` and has none yet. */
  bindPasskey(id: string, from: string, to: { secret: string; tokenLabel: string }): boolean {
    if (!existsSync(this.file)) return false;
    return this.withLock((f) => {
      const p = f.passkeys?.[id];
      if (!p || p.tokenLabel || p.secret !== from) return false;
      p.secret = to.secret;
      p.tokenLabel = to.tokenLabel;
      return true;
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

  /** An action's outcome (what its toast said), for this reader's Inbox: newest first, DONE_MAX kept. */
  noteDone(d: Done, reader?: string): void {
    this.withLock((f) => {
      const r = readerOf(f, reader);
      r.done = [d, ...(r.done ?? [])].slice(0, DONE_MAX);
    });
  }

  /** This reader's own outcomes, newest first. */
  doneItems(reader?: string): Done[] {
    if (!existsSync(this.file)) return [];
    return this.withLock((f) => [...(readerOf(f, reader).done ?? [])]);
  }

  /** This reader's Appearance, as they last chose it (none chosen: empty). */
  prefs(reader?: string): Prefs {
    // A read, not a locked write: every page asks it. A torn read (mid-rename can't happen: writes land by rename) is none.
    if (!existsSync(this.file)) return {};
    const f = this.read();
    const p = { ...((reader ? f.members?.[reader]?.prefs : f.prefs) ?? {}) };
    if (p.look) p.look = lookOf(p.look, p.mode);
    return oneWindowOf(p);
  }

  /** Change some of this reader's Appearance; what's not given stays as it was. */
  setPrefs(p: Prefs, reader?: string, nowMs = Date.now()): Prefs {
    return this.withLock((f) => {
      const r = readerOf(f, reader);
      // Strictly later than the last change, even within a millisecond: the version a device compares.
      // Kept as given, 000h too (read back as the look nearest it, prefs()): what's on disk changes only when the person
      // chooses, so going back to an app that knew 000h finds their choice as they made it.
      r.prefs = { ...(r.prefs ?? {}), ...p, at: Math.max(nowMs, (r.prefs?.at ?? 0) + 1) };
      const out = { ...r.prefs };
      if (out.look) out.look = lookOf(out.look, out.mode);
      return oneWindowOf(out);
    });
  }

  /** The items this reader's Inbox has opened. */
  openedKeys(reader?: string): Set<string> {
    return new Set(this.openedAt(reader).keys());
  }

  /** The items this reader's Inbox has opened, and when (epoch seconds): an item's trail says when it was seen. */
  openedAt(reader?: string): Map<string, number> {
    if (!existsSync(this.file)) return new Map();
    return this.withLock((f) => new Map(Object.entries(readerOf(f, reader).opened ?? {})));
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
    this.withLock((f) => drop(f, key));
  }
}

/** A session gone (signed out, or revoked by its ref), and with it this browser's notifications, and no one else's. */
function drop(f: File, key: string): void {
  delete f.sessions[key];
  for (const [ep, s] of Object.entries(f.push?.subs ?? {})) if (s.session === key) delete f.push!.subs![ep];
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

/** A page sign-in links token: the household's, or a member's own (signinLink). */
export function isLinkToken(label: string): boolean {
  return label === LINK_TOKEN || label.startsWith(`${LINK_TOKEN} · `);
}

/** The label of a passkey's own owner token: its person and a short hash of its credential id. */
export function passkeyTokenLabel(person: string, credentialId: string): string {
  return `passkey · ${person} · ${createHash('sha256').update(credentialId).digest('hex').slice(0, 12)}`;
}

/**
 * A passkey's own owner token for `person` (t-1969): the live one under its label, else a new one. Only its digest is
 * kept: nobody ever holds the token itself, so it can't be pasted or leaked; the passkey is the only way to use it.
 * Idempotent, so two listeners (or a start that died between minting and binding) end with the one token.
 */
export function passkeyToken(h: Household, person: string, credentialId: string): { secret: string; tokenLabel: string; minted: boolean } {
  if (!memberOf(h, person)) throw new HouseholdError(`no member named ${person} in this household`);
  const label = passkeyTokenLabel(person, credentialId);
  const find = () => loadTokens(h.home).find((t) => t.label === label && isLive(t));
  let rec = find();
  let minted = false;
  if (!rec) {
    try { rec = createToken(h, { role: { kind: 'owner', member: person }, label }).record; minted = true; } catch (e) { rec = find(); if (!rec) throw e; }
  }
  if (rec.role !== 'owner' || rec.member !== person) throw new HouseholdError(`the token labeled ${JSON.stringify(label)} isn't ${person}'s owner token`);
  return { secret: rec.sha256, tokenLabel: label, minted };
}

/** Revoke a passkey's own token, if it has one and it's live (its passkey was removed, or never added). */
export function revokePasskeyToken(h: Household, tokenLabel: string | undefined): void {
  if (!tokenLabel || !tokenLabel.startsWith('passkey · ')) return;
  try { revokeToken(h, tokenLabel); } catch { /* already revoked, or never written */ }
}

/**
 * Give each passkey made before t-1969 its own token (run at loom-http's start, idempotent): one that signs in as a
 * live owner token, or as the env owner token, moves to a token of its own for that token's person. One whose token
 * is a revoked page sign-in links token moves too: revoking the links (as on 2026-11-07) was never meant to stop a
 * passkey. Any other revoked token's passkeys stay stopped, as do those of a person who's no longer a member.
 * Returns the ids moved.
 */
export function migratePasskeys(h: Household, envOwnerDigestHex?: string): string[] {
  const store = sessionStore(h.home);
  const todo = store.passkeys().filter((p) => !p.tokenLabel);
  if (!todo.length) return [];
  const tokens = loadTokens(h.home);
  const moved: string[] = [];
  for (const p of todo) {
    let person: string | undefined;
    if (envOwnerDigestHex !== undefined && p.secret === envOwnerDigestHex) person = firstOwner(h).person;
    else {
      const rec = tokens.find((t) => t.sha256 === p.secret);
      if (!rec || rec.role !== 'owner' || expired(rec)) continue;
      if (rec.revoked && !isLinkToken(rec.label)) continue;
      person = rec.member ?? firstOwner(h).person;
    }
    if (!memberOf(h, person)) continue;
    const own = passkeyToken(h, person, p.id);
    if (store.bindPasskey(p.id, p.secret, own)) moved.push(p.id);
    else if (own.minted && !store.passkeys().some((k) => k.tokenLabel === own.tokenLabel)) revokePasskeyToken(h, own.tokenLabel);
  }
  return moved;
}

/**
 * A one-time sign-in link's code (`loom token link`, and Passkeys' "Make a one-time sign-in link"),
 * for a member (docs/specs/owners.md): its session is theirs. The first household owner's links
 * use the household's link token, as before; another member's, a link token of their own.
 */
export function signinLink(h: Household, ttlS: number, member?: string, label?: string): string {
  const m = member === undefined ? firstOwner(h) : memberOf(h, member);
  if (!m) throw new HouseholdError(`no member named ${member} in this household`);
  const tokens = loadTokens(h.home).filter((t) => isLive(t) && t.role === 'owner');
  // The household's link token, if it's still this member's (no member: the first owner's); else one of their own.
  const shared = tokens.find((t) => t.label === LINK_TOKEN);
  const sharedIsTheirs = shared && (shared.member === undefined ? m.person === firstOwner(h).person : shared.member === m.person);
  let record = sharedIsTheirs ? shared : tokens.find((t) => t.label === `${LINK_TOKEN} · ${m.person}` && t.member === m.person);
  if (!record) {
    const label = !shared && m.person === firstOwner(h).person ? LINK_TOKEN : `${LINK_TOKEN} · ${m.person}`;
    record = createToken(h, { role: { kind: 'owner', ...(label === LINK_TOKEN ? {} : { member: m.person }) }, label }).record;
  }
  return sessionStore(h.home).createLink(Buffer.from(record.sha256, 'hex'), ttlS, undefined, label);
}
