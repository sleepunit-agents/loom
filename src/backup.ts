/**
 * The nightly backup (docs/specs/keeping-watch.md, "1. The nightly backup"): each night loom
 * exports the household (src/bundle.ts), encrypted to the owner's keys and the machine's own
 * drill key, drills a restore of it, and writes it to a target the owner set: a git repo it
 * force-pushes as one commit, or a directory. Setup shows the last run; a failed or missed one
 * is an Inbox alert, and the owner's alert command (LOOM_ALERT_COMMAND) hears of it.
 *
 *   settings   household.json `backup` (nothing secret)
 *   drill key  $LOOM_HOME/backup/drill.key (0600, never in a bundle, never a setting)
 *   state      $LOOM_HOME/backup/state.json (the runs, the last good one, the alerts said)
 *   git clone  $LOOM_HOME/backup/repo.git (bare: nothing is checked out)
 *
 * Credentials: a git target pushes with the git credentials of the user loom runs as; loom keeps
 * none. Core never asks a piece for authority (docs/specs/household.md, "Where core ends").
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, linkSync, realpathSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { drillBundle as realDrill, exportBundle as realExport, type DrillReport, type Manifest } from './bundle.js';
import { findProgram } from './programs.js';
import { listPieces } from './cli/pieces.js';
import { agentDir, loadHousehold, rawHousehold, writeHouseholdKey, type Household } from './household.js';

export class BackupError extends Error {}

export const DIR = 'backup';
/** A file the git host takes (GitHub refuses one over 100 MB). */
export const SPLIT_AT = 90 * 1000 * 1000;
/** git's http.postBuffer for the push, at most: git allocates all of it, so it's sized to the night's push (below). */
export const POST_BUFFER_MAX = 512 * 1024 * 1024;
/** The push's buffer: what's new tonight (the bundle) and room for the rest, never over the cap. */
export const postBufferFor = (bytes: number) => Math.min(POST_BUFFER_MAX, Math.max(1, Math.ceil(bytes)) + 16 * 1024 * 1024);
/** No good run in this long, while the backup is set: it's missed. */
export const MISSED_MS = 26 * 3600_000;
/** A condition still going: the alert command hears of it again this often. */
export const REMIND_MS = 6 * 3600_000;
/** A lock older than this is stale whatever its pid says (a run takes minutes). */
const LOCK_STALE_MS = 6 * 3600_000;
const RUNS_KEPT = 30;
const MARKER = '.loom-backup';
const MARKER_TEXT = 'Written by loom (docs/specs/keeping-watch.md): its nightly backup. loom replaces what it wrote here each night.\n';
const BRANCH = 'main';

export type Target = { kind: 'git'; url: string } | { kind: 'path'; dir: string };
export interface BackupSettings { target: Target; recipients: string[]; at: string; tz: string; keep: number; required: string[] }

export interface BackupRun {
  at: string; ok: boolean; why?: string; scheduled?: boolean; ms?: number;
  name?: string; bytes?: number; parts?: number; commit?: string;
  drill?: { ok: boolean; tries: number; differences?: string[] };
  pieces?: string[]; missing?: string[];
}
export interface BackupState {
  v: 1; runs: BackupRun[]; lastGood?: BackupRun; lastStart?: string; setAt?: string;
  /** The alert command was told of these, and when (so a lasting one is said again every REMIND_MS, and its end once). */
  said?: { failed?: string; missed?: string; broken?: string };
  /** The last time it came back from a failure or a miss: an FYI in the Inbox for a week. */
  recovered?: { at: string; text: string };
}

// ─── Settings ────────────────────────────────────────────────────────────────

const RECIPIENT = /^(age1[0-9a-z]{20,}|ssh-(ed25519|rsa) [A-Za-z0-9+/=]{20,}( [^\n]{0,100})?)$/;
const AT = /^([01]\d|2[0-3]):[0-5]\d$/;
const GIT_URL = /^(https:\/\/[^\s]+|ssh:\/\/[^\s]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+|file:\/\/\/[^\s]+|\/[^\s]+)$/;

function validTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** A target as the owner writes it: `git:<url>` or `path:<absolute dir>`. */
export function parseTarget(s: string): Target {
  const t = String(s ?? '').trim();
  if (t.startsWith('git:')) {
    const url = t.slice(4);
    if (!GIT_URL.test(url) || url.startsWith('-')) throw new BackupError(`${scrub(url)} isn't a git URL loom pushes to (https://, ssh://, user@host:path, or a local path)`);
    // Credentials come from git's own credential helper or ssh key, never the URL: an https URL with userinfo is refused
    // (it would sit in household.json and in every bundle). ssh://git@host, a user name alone, is how ssh names one.
    if (/^https:\/\/[^/]*@/.test(url) || /^ssh:\/\/[^/@]*:[^/@]*@/.test(url) || /^file:\/\/[^/]*@/.test(url)) {
      throw new BackupError('a target URL carries no credentials (user:pass@ or token@): git\'s credential helper or an ssh key supplies them');
    }
    return { kind: 'git', url };
  }
  if (t.startsWith('path:')) {
    const dir = t.slice(5);
    if (!dir.startsWith('/') || /[\0\n]/.test(dir)) throw new BackupError(`${dir} isn't an absolute directory`);
    return { kind: 'path', dir };
  }
  throw new BackupError('a target is git:<url> or path:<absolute directory>');
}

/**
 * Text from git (or about the target) as it may go into an error, the state, a log or an alert: any URL's userinfo
 * masked, and the configured target URL itself replaced by its short name.
 */
export function scrub(text: string, url?: string): string {
  let t = String(text ?? '');
  if (url) t = t.split(url).join(`<target ${shortName(url)}>`);
  // Up to the last '@' before the host: a password may hold one (u:p@ss@host).
  return t.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@/g, '$1***@');
}

function shortName(url: string): string {
  return url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop()?.replace(/^[^@]*@/, '') ?? 'repo';
}

export function targetString(t: Target): string { return t.kind === 'git' ? `git:${t.url}` : `path:${t.dir}`; }

/** Where it goes, in a few words: the repo's name, or the directory. */
export function targetLabel(t: Target): string {
  if (t.kind === 'path') return t.dir;
  return t.url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? t.url;
}

/** Settings as the owner gives them, checked, with the defaults filled in. Throws BackupError. */
export function validateSettings(input: { target?: unknown; recipients?: unknown; at?: unknown; tz?: unknown; keep?: unknown; required?: unknown }, defaultTz = 'UTC'): BackupSettings {
  const target = parseTarget(String(input.target ?? ''));
  const recipients = Array.isArray(input.recipients) ? input.recipients.map((r) => String(r).trim()).filter(Boolean) : [];
  if (!recipients.length) throw new BackupError('a backup needs at least one --recipient: an age (age1…) or ssh public key the owner holds');
  for (const r of recipients) if (!RECIPIENT.test(r)) throw new BackupError(`${r.slice(0, 40)} isn't an age recipient (age1…) or an ssh public key`);
  const at = input.at === undefined || input.at === '' ? '03:00' : String(input.at);
  if (!AT.test(at)) throw new BackupError(`--at is a time of day, HH:MM (24-hour), not ${at}`);
  const tz = input.tz === undefined || input.tz === '' ? defaultTz : String(input.tz);
  if (!validTz(tz)) throw new BackupError(`${tz} isn't a time zone (America/Chicago, UTC, …)`);
  const keep = input.keep === undefined || input.keep === '' ? 7 : Number(input.keep);
  if (!Number.isInteger(keep) || keep < 1 || keep > 90) throw new BackupError('--keep is a whole number of nights, 1 to 90');
  // The floor a fresh machine has no last good bundle to give (art-loom-bundle's REQUIRED): pieces every bundle must hold.
  const required = Array.isArray(input.required) ? input.required.map((r) => String(r).trim()).filter(Boolean)
    : typeof input.required === 'string' && input.required ? input.required.split(',').map((r) => r.trim()).filter(Boolean) : [];
  for (const r of required) if (!/^[a-z][a-z0-9-]{0,39}$/.test(r)) throw new BackupError(`--require names a piece (lowercase letters, digits, dashes), not ${r.slice(0, 40)}`);
  return { target, recipients: [...new Set(recipients)], at, tz, keep, required: [...new Set(required)] };
}

/** The household's backup settings, or why there are none usable. */
export function readSettings(h: Household): { settings?: BackupSettings; problem?: string } {
  const raw = rawHousehold(h.home).backup as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  try {
    return { settings: validateSettings(raw) };
  } catch (e) { return { problem: (e as Error).message }; }
}

/** Store the settings (as the owner gave them, checked), and make the drill key if there isn't one. */
export function setSettings(h: Household, s: BackupSettings, env: NodeJS.ProcessEnv, now = new Date()): { settings: BackupSettings; drillRecipient: string } {
  assertOutsideHome(h.home, s.target);
  const key = ensureDrillKey(h.home, env);
  if (s.recipients.includes(key.recipient)) throw new BackupError('that recipient is this machine\'s own drill key: the bundle is always encrypted to it already; give your own key');
  writeHouseholdKey(h, 'backup', { target: targetString(s.target), recipients: s.recipients, at: s.at, tz: s.tz, keep: s.keep, ...(s.required.length ? { required: s.required } : {}) });
  updateState(h.home, (st) => { st.setAt = now.toISOString(); });
  return { settings: s, drillRecipient: key.recipient };
}

/** A path target inside $LOOM_HOME would put bundles beside the drill key: never. */
function assertOutsideHome(home: string, t: Target): void {
  // A path target, or a git target that's a local repo (an absolute path or file:///): neither may sit in loom's home.
  const dir = t.kind === 'path' ? t.dir : t.url.startsWith('/') ? t.url : t.url.startsWith('file://') ? t.url.slice('file://'.length) : null;
  if (!dir) return;
  const inside = (a: string, b: string) => { const r = relative(b, a); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  let real = resolve(dir);
  try { real = realpathSync(dir); } catch { /* not there yet: its own path */ }
  let homeReal = resolve(home);
  try { homeReal = realpathSync(home); } catch { /* as given */ }
  if (inside(real, homeReal) || inside(resolve(dir), resolve(home))) throw new BackupError(`${dir} is inside loom's home (${home}); a backup goes somewhere else`);
}

export function clearSettings(h: Household): void { writeHouseholdKey(h, 'backup', undefined); }

// ─── The drill key, the state, the lock ──────────────────────────────────────

export const backupDir = (home: string) => join(home, DIR);

function ensureDir(home: string): string {
  const d = backupDir(home);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
}

/** The machine's own key for the drill: made once (age-keygen), 0600. Returns its file and public key. */
export function ensureDrillKey(home: string, env: NodeJS.ProcessEnv): { identity: string; recipient: string } {
  const d = ensureDir(home);
  const identity = join(d, 'drill.key');
  if (!existsSync(identity)) {
    const keygen = findProgram('age-keygen', env, 'the backup');
    const tmp = `${identity}.${process.pid}.tmp`;
    const r = spawnSync(keygen, ['-o', tmp], { encoding: 'utf-8' });
    if (r.status !== 0) throw new BackupError(`age-keygen failed: ${(r.stderr || '').trim()}`);
    chmodSync(tmp, 0o600);
    renameSync(tmp, identity);
  }
  chmodSync(identity, 0o600);
  const m = /public key: (age1[0-9a-z]+)/.exec(readFileSync(identity, 'utf-8'));
  if (!m) throw new BackupError(`${identity} isn't an age identity`);
  return { identity, recipient: m[1] };
}

const statePath = (home: string) => join(backupDir(home), 'state.json');

export function readState(home: string): BackupState {
  try {
    const s = JSON.parse(readFileSync(statePath(home), 'utf-8')) as BackupState;
    if (s?.v === 1 && Array.isArray(s.runs)) return s;
  } catch { /* none yet */ }
  return { v: 1, runs: [] };
}

function writeState(home: string, s: BackupState): void {
  ensureDir(home);
  const tmp = `${statePath(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, statePath(home));
}

function updateState(home: string, f: (s: BackupState) => void): BackupState {
  const s = readState(home);
  f(s);
  writeState(home, s);
  return s;
}

/** Whether a pid names a live process here (EPERM: alive, someone else's). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Take the run lock, or null when another live process holds it. One stale (its pid gone, or too old) is taken over.
 * `seam.judged` runs once a lock has been judged stale, before the takeover: tests use it to change the lock there.
 */
export function takeLock(home: string, nowMs = Date.now(), seam: { judged?: () => void } = {}): { release: () => void } | null {
  const p = join(ensureDir(home), 'run.lock');
  const token = randomBytes(8).toString('hex');
  const mine = () => { try { return (JSON.parse(readFileSync(p, 'utf-8')) as { token?: string }).token === token; } catch { return false; } };
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(p, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(nowMs).toISOString(), token }));
      closeSync(fd);
      // Released only while it's still ours: a run taken over as stale never removes its successor's lock.
      return { release: () => { if (mine()) { try { unlinkSync(p); } catch { /* gone */ } } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let raw = '';
      try { raw = readFileSync(p, 'utf-8'); } catch { continue; /* gone between: try again */ }
      let held: { pid?: number; at?: string } = {};
      try { held = JSON.parse(raw); } catch { /* half-written: judge by age */ }
      let mtime = nowMs;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      const age = nowMs - (Date.parse(held.at ?? '') || mtime);
      if (pidAlive(held.pid ?? 0) && age < LOCK_STALE_MS) return null;
      seam.judged?.();
      // Stale. Taken over by one taker at a time, under a claim beside it: the taker's pid and token, written whole
      // and linked into place (a link lands whole or not at all, and only one taker's does). There the lock is read
      // again, and only the one judged stale is removed; one that's changed meanwhile is someone's fresh lock, left
      // where it is. (Moving it aside to look, as before, could move a fresh one, and a third taker made its own in
      // the gap: two ran, t-1886.)
      const over = `${p}.takeover`;
      const claim = `${process.pid} ${token}`;
      const draft = `${over}.${token}`;
      let claimed = false;
      try {
        writeFileSync(draft, claim, { mode: 0o600 });
        try { linkSync(draft, over); claimed = true; } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
      } finally { try { unlinkSync(draft); } catch { /* gone */ } }
      if (!claimed) {
        // Another taker's claim. One whose taker died there is cleared, for the next tick; a live one, however slow
        // (a laptop asleep mid-takeover), is waited on: no clock decides it.
        let other = '';
        try { other = readFileSync(over, 'utf-8'); } catch { return null; /* done meanwhile */ }
        if (!pidAlive(Number(other.split(' ')[0]))) {
          try { if (readFileSync(over, 'utf-8') === other) unlinkSync(over); } catch { /* gone */ }
        }
        return null;
      }
      try {
        let now = '';
        try { now = readFileSync(p, 'utf-8'); } catch { /* gone: free */ }
        if (now && now !== raw) return null;
        if (now) { try { unlinkSync(p); } catch { /* gone */ } }
      } finally {
        try { if (readFileSync(over, 'utf-8') === claim) unlinkSync(over); } catch { /* gone */ }
      }
    }
  }
  return null;
}

// ─── When ───────────────────────────────────────────────────────────────────

/** The offset of `tz` from UTC at instant `ms`, in ms. */
function tzOffset(ms: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant the wall clock in `tz` reads y-m-d hh:mm. */
function zoned(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

/** The latest scheduled moment at or before `nowMs`: today's `at` in `tz`, or yesterday's if today's hasn't come. */
export function lastSlot(s: Pick<BackupSettings, 'at' | 'tz'>, nowMs: number): number {
  const [hh, mm] = s.at.split(':').map(Number);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: s.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const today = zoned(+p.year, +p.month, +p.day, hh, mm, s.tz);
  if (today <= nowMs) return today;
  const y = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - 86_400_000);
  return zoned(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), hh, mm, s.tz);
}

/** Due: the latest slot has passed, and no run has started since it. */
/** A night's run that failed is tried again this long after, this many times in all, before the next night's. */
export const RETRY_AFTER_MS = 60 * 60_000;
export const TRIES_A_NIGHT = 3;

/**
 * Due: the latest slot has passed and no run has started since it; or the runs since it all failed, there have been
 * fewer than TRIES_A_NIGHT, and the last was RETRY_AFTER_MS ago (a push the network dropped is tried again tonight,
 * not tomorrow).
 */
export function isDue(s: Pick<BackupSettings, 'at' | 'tz'>, st: Pick<BackupState, 'lastStart' | 'runs'>, nowMs: number): boolean {
  const slot = lastSlot(s, nowMs);
  const started = Date.parse(st.lastStart ?? '');
  if (Number.isNaN(started) || started < slot) return true;
  const tonight = st.runs.filter((r) => Date.parse(r.at) >= slot);
  if (!tonight.length || tonight.some((r) => r.ok) || tonight.length >= TRIES_A_NIGHT) return false;
  // An hour after the last try ended (its start and how long it took), not after it started or after the slot.
  const last = tonight[0];
  const ended = Date.parse(last.at) + (last.ms ?? 0);
  return Date.parse(st.lastStart ?? '') <= Date.parse(last.at) && nowMs - ended >= RETRY_AFTER_MS;
}

/** A bundle's stamp, in the backup's time zone: YYYYMMDD-HHMM. */
export function stampOf(ms: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}

/**
 * Which stamps stay: a night is a date (a night's tries share it), and each night kept keeps its newest bundle; the
 * newest `keep` nights, and the first night of each month.
 */
export function keptStamps(stamps: string[], keep: number): Set<string> {
  const byNight = new Map<string, string>();
  for (const s of [...new Set(stamps)].sort()) byNight.set(s.slice(0, 8), s); // sorted: the night's newest wins
  const nights = [...byNight.keys()].sort();
  const kept = new Set(nights.slice(-keep));
  const firstOfMonth = new Map<string, string>();
  for (const n of nights) if (!firstOfMonth.has(n.slice(0, 6))) firstOfMonth.set(n.slice(0, 6), n);
  for (const n of firstOfMonth.values()) kept.add(n);
  return new Set([...kept].map((n) => byNight.get(n)!));
}

const BUNDLE_NAME = /^loom-household-(\d{8}-\d{4})\.bundle(\.part-\d{2})?$/;

// ─── A run ──────────────────────────────────────────────────────────────────

export interface RunDeps {
  exportBundle?: typeof realExport;
  drillBundle?: typeof realDrill;
  /** What the owner's alert command is told (alertCommand by default). */
  alert?: (env: NodeJS.ProcessEnv, a: CoreAlert) => boolean;
  splitAt?: number;
  /** Called just before the push (a test moves the remote here, as a second machine would). */
  beforePush?: () => void;
  /** The pieces installed here now (listPieces by default). */
  installedPieces?: () => string[];
}

function sha256File(p: string): string {
  const h = createHash('sha256');
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest('hex');
}

/** Split a file into `<name>.part-00`, `-01`, … of at most `size` bytes, in `dir`. Returns the parts' paths. */
function splitFile(file: string, name: string, dir: string, size: number): string[] {
  const out: string[] = [];
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    let part = -1, left = 0, outFd = -1;
    for (let n; (n = readSync(fd, buf, 0, left > 0 ? Math.min(buf.length, left) : Math.min(buf.length, size), null)) > 0;) {
      if (left === 0) {
        if (outFd >= 0) closeSync(outFd);
        part++;
        const p = join(dir, `${name}.part-${String(part).padStart(2, '0')}`);
        out.push(p);
        outFd = openSync(p, 'w', 0o600);
        left = size;
      }
      writeSync(outFd, buf, 0, n);
      left -= n;
    }
    if (outFd >= 0) closeSync(outFd);
  } finally { closeSync(fd); }
  return out;
}

/** The parts, concatenated, hash to `sha`: they rejoin to the drilled file, byte for byte. */
function rejoins(parts: string[], sha: string): boolean {
  const h = createHash('sha256');
  for (const p of parts) h.update(readFileSync(p));
  return h.digest('hex') === sha;
}

export function restoreText(s: BackupSettings): string {
  const git = s.target.kind === 'git';
  const take = git
    ? `2. Take the newest bundle. One in parts joins first:

       cat bundles/loom-household-<stamp>.bundle.part-* > loom-household-<stamp>.bundle`
    : '2. Take the newest bundle here: loom-household-<stamp>.bundle (the stamp is the date and time it was made).';
  const kept = git
    ? `Kept: the newest ${s.keep} nights and the first bundle of each month. This
branch is always one commit: loom replaces it each night.`
    : `Kept: the newest ${s.keep} nights and the first bundle of each month.`;
  return `# The household's backup

Written by loom each night (docs/specs/keeping-watch.md). Each bundle is the
whole household (every agent's memory and identity, the commons, the tokens,
each piece's own part), encrypted with age to the owner's keys. Nothing here
can be read without one of them.

To bring the household back on a new machine:

1. Install loom (npm i -g @jbarket/loomai) and age.
${take}

3. Restore it into an empty home:

       loom restore loom-household-<stamp>.bundle --identity <your age key file> --to ~/.config/loom

   It installs the pieces the household had, at loom's pinned commits, and
   hands each its part.
4. Start loom (loom serve --http) and point a harness at it.

${kept}
`;
}

/** git's stderr as a failure's words: userinfo masked, the target named by its short name, the last two lines. */
export function gitFailure(verb: string, stderr: string, url?: string): string {
  const why = scrub(String(stderr ?? '').trim(), url).split('\n').filter((l) => !/password|token/i.test(l)).slice(-2).join(' ');
  return `git ${verb} failed: ${why.slice(0, 300)}`;
}

function git(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; url?: string } = {}): string {
  // Never a prompt: a credential git can't find is a failure that says so, not a run holding the lock for 30 minutes.
  const r = spawnSync('git', args, { cwd: o.cwd, env: { ...(o.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }, input: o.input, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
  // Its verb, past -C <dir> and -c <k=v>: what a failure is named by ("git push failed").
  let v = 0;
  while (v < args.length && (args[v] === '-C' || args[v] === '-c')) v += 2;
  if (r.status !== 0) throw new BackupError(gitFailure(args[v] ?? 'git', `${r.stderr || r.error?.message || `exit ${r.status}`}`, o.url ?? currentUrl));
  return r.stdout;
}

/** The target URL of the run under way, so every git failure in it is scrubbed of it. */
let currentUrl: string | undefined;

/** The git target's bare clone, its remote set to the target. */
function gitRepo(home: string, url: string, env: NodeJS.ProcessEnv): string {
  const repo = join(ensureDir(home), 'repo.git');
  if (!existsSync(join(repo, 'HEAD'))) git(['init', '-q', '--bare', repo], { env });
  const has = spawnSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf-8', env });
  if (has.status !== 0) git(['-C', repo, 'remote', 'add', 'origin', url], { env });
  else if (has.stdout.trim() !== url) git(['-C', repo, 'remote', 'set-url', 'origin', url], { env });
  return repo;
}

/** The remote branch's commit (fetched if loom doesn't have it), or null for an empty repo. Refuses a repo that isn't the backup's. */
function gitPreflight(repo: string, env: NodeJS.ProcessEnv): string | null {
  const line = git(['-C', repo, 'ls-remote', '--heads', 'origin', BRANCH], { env }).trim();
  const sha = line ? line.split(/\s+/)[0] : null;
  if (!sha) {
    // No main: an empty repo is ours to start. One with other branches isn't.
    const any = git(['-C', repo, 'ls-remote', '--heads', 'origin'], { env }).trim();
    if (any) throw new BackupError(`the target has branches but no ${BRANCH}; loom only writes to a repo that's empty or its own (${MARKER})`);
    return null;
  }
  if (spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { env }).status !== 0) {
    git(['-C', repo, 'fetch', '-q', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`], { env });
  }
  const names = git(['-C', repo, 'ls-tree', '--name-only', sha], { env }).split('\n').filter(Boolean);
  // A main whose tree is empty (an --allow-empty first commit) isn't "a repo with no branches": it's someone's.
  if (!names.includes(MARKER)) throw new BackupError(`the target ${names.length ? 'holds files' : 'has a main'} loom didn't write (no ${MARKER}); loom only writes to a repo that's empty or its own`);
  return sha;
}

/** One commit, no parent: the kept bundles, RESTORE.md and the marker. Pushed with a lease on what loom saw. */
function gitWrite(repo: string, remote: string | null, files: Array<{ path: string; name: string }>, s: BackupSettings, stamp: string, env: NodeJS.ProcessEnv, beforePush?: () => void): { commit: string; kept: string[] } {
  const index = join(mkdtempSync(join(tmpdir(), 'loom-backup-index-')), 'index');
  // A bare clone has no work tree, and the index commands want one: an empty dir stands in (nothing is checked out).
  const genv = { ...env, GIT_DIR: repo, GIT_WORK_TREE: join(index, '..'), GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'loom', GIT_AUTHOR_EMAIL: 'loom@localhost', GIT_COMMITTER_NAME: 'loom', GIT_COMMITTER_EMAIL: 'loom@localhost' };
  try {
    if (remote) git(['-C', repo, 'read-tree', remote], { env: genv });
    const had = git(['-C', repo, 'ls-files'], { env: genv }).split('\n').filter(Boolean);
    for (const f of files) {
      const blob = git(['-C', repo, 'hash-object', '-w', '--', f.path], { env: genv }).trim();
      git(['-C', repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},bundles/${f.name}`], { env: genv });
    }
    const bundles = [...had, ...files.map((f) => `bundles/${f.name}`)].filter((p) => p.startsWith('bundles/'));
    const stampOfPath = (p: string) => BUNDLE_NAME.exec(p.slice('bundles/'.length))?.[1];
    const keep = keptStamps([...bundles.map(stampOfPath).filter((x): x is string => !!x), stamp], s.keep);
    for (const p of new Set(bundles)) {
      const st = stampOfPath(p);
      if (st && !keep.has(st)) git(['-C', repo, 'update-index', '--force-remove', '--', p], { env: genv });
    }
    for (const [path, body] of [['RESTORE.md', restoreText(s)], [MARKER, MARKER_TEXT]]) {
      const blob = git(['-C', repo, 'hash-object', '-w', '--stdin'], { env: genv, input: body }).trim();
      git(['-C', repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env: genv });
    }
    const tree = git(['-C', repo, 'write-tree'], { env: genv }).trim();
    const commit = git(['-C', repo, 'commit-tree', '--no-gpg-sign', tree, '-m', `household bundle ${stamp} (drilled)`], { env: genv }).trim();
    beforePush?.();
    // One sized POST, not a chunked one: GitHub hung up on chunked pushes of ~50 MB over a lossy uplink twice on
    // 2026-11-04, and the same push with a large buffer went through. The buffer is the night's bundle plus 16 MB.
    const newBytes = files.reduce((n, f) => n + statSync(f.path).size, 0);
    git(['-C', repo, '-c', `http.postBuffer=${postBufferFor(newBytes)}`, 'push', '-q', `--force-with-lease=refs/heads/${BRANCH}:${remote ?? ''}`, 'origin', `${commit}:refs/heads/${BRANCH}`], { env });
    git(['-C', repo, 'update-ref', `refs/remotes/origin/${BRANCH}`, commit], { env });
    // What the old commits held and the new one doesn't: gone from the clone too, so it doesn't grow a bundle a night.
    spawnSync('git', ['-C', repo, 'prune', '--expire=now'], { env });
    return { commit, kept: [...keep].sort() };
  } finally {
    rmSync(join(index, '..'), { recursive: true, force: true });
  }
}

function pathPreflight(dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new BackupError(`${dir} isn't a directory (is the drive mounted?)`);
  const names = readdirSync(dir);
  if (names.length && !names.includes(MARKER)) throw new BackupError(`${dir} holds files loom didn't write (no ${MARKER}); loom only writes to a directory that's empty or its own`);
}

function pathWrite(dir: string, bundle: string, name: string, s: BackupSettings, stamp: string): string[] {
  // The marker first: a crash after the bundle lands never leaves a target loom then refuses as someone else's.
  writeFileSync(join(dir, MARKER), MARKER_TEXT, { mode: 0o600 });
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  copyFileSync(bundle, tmp);
  chmodSync(tmp, 0o600);
  renameSync(tmp, join(dir, name));
  writeFileSync(join(dir, 'RESTORE.md'), restoreText(s), { mode: 0o600 });
  const names = readdirSync(dir).filter((n) => BUNDLE_NAME.test(n));
  const keep = keptStamps([...names.map((n) => BUNDLE_NAME.exec(n)![1]), stamp], s.keep);
  for (const n of names) if (!keep.has(BUNDLE_NAME.exec(n)![1])) rmSync(join(dir, n), { force: true });
  return [...keep].sort();
}

/**
 * One backup: export, drill (a mismatch gets one fresh try), the required parts, the target,
 * the state. Never throws: what went wrong is the run's `why`. The caller holds the lock.
 */
export async function runBackup(opts: { home: string; env: NodeJS.ProcessEnv; now?: () => Date; scheduled?: boolean; deps?: RunDeps }): Promise<BackupRun> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const deps = opts.deps ?? {};
  const doExport = deps.exportBundle ?? realExport;
  const doDrill = deps.drillBundle ?? realDrill;
  const run: BackupRun = { at: started.toISOString(), ok: false, ...(opts.scheduled ? { scheduled: true } : {}) };
  updateState(opts.home, (st) => { st.lastStart = run.at; });
  const work = mkdtempSync(join(tmpdir(), 'loom-backup-'));
  chmodSync(work, 0o700);
  const before = readState(opts.home);
  try {
    const h = loadHousehold(opts.home);
    if (!h) throw new BackupError(`there's no household at ${opts.home}`);
    const { settings: s, problem } = readSettings(h);
    if (!s) throw new BackupError(problem ? `the backup's settings: ${problem}` : 'the backup isn\'t set up (loom backup set)');
    assertOutsideHome(opts.home, s.target);
    if (!before.setAt) throw new BackupError('this household was restored here: run loom backup set to resume its backup on this machine');
    if (s.target.kind === 'git') currentUrl = s.target.url;
    const key = ensureDrillKey(opts.home, opts.env);
    const recipients = [...s.recipients, key.recipient];
    // The target first: refusing it costs nothing, an export costs minutes.
    const repo = s.target.kind === 'git' ? gitRepo(opts.home, s.target.url, opts.env) : null;
    const remote = repo ? gitPreflight(repo, opts.env) : null;
    if (s.target.kind === 'path') pathPreflight(s.target.dir);

    const stamp = stampOf(started.getTime(), s.tz);
    const name = `loom-household-${stamp}.bundle`;
    const file = join(work, name);
    const contextDir = agentDir(h, h.default);
    let manifest: Manifest | undefined;
    let drill: DrillReport | undefined;
    let tries = 0;
    for (; tries < 2;) {
      tries++;
      rmSync(file, { force: true });
      manifest = await doExport({ contextDir, to: file, recipients, env: opts.env, now: started });
      drill = await doDrill({ file, identity: key.identity, contextDir, env: opts.env });
      if (drill.ok) break;
    }
    run.drill = { ok: !!drill?.ok, tries, ...(drill && !drill.ok ? { differences: drill.differences.map((d) => d.what).slice(0, 10) } : {}) };
    if (!drill?.ok) throw new BackupError(`the drill didn't match the live household twice (${run.drill.differences?.join(', ')}); nothing was written`);
    run.pieces = manifest!.pieces.filter((p) => p.included).map((p) => p.name);
    // Every piece whose part was in the last good bundle must be in this one (the box's dropped out silently, 2026-10-26).
    // ...that's still installed: a piece the owner removed isn't required.
    const installed = new Set((deps.installedPieces ?? (() => listPieces(opts.env).map((p) => p.name)))());
    const missing = [...new Set([...s.required, ...(before.lastGood?.pieces ?? []).filter((p) => installed.has(p))])].filter((p) => !run.pieces!.includes(p));
    if (missing.length) run.missing = missing;
    run.name = name;
    run.bytes = statSync(file).size;
    const sha = sha256File(file);

    if (s.target.kind === 'git') {
      const size = deps.splitAt ?? SPLIT_AT;
      const files = run.bytes > size ? splitFile(file, name, work, size).map((p) => ({ path: p, name: p.slice(work.length + 1) })) : [{ path: file, name }];
      if (files.length > 1 && !rejoins(files.map((f) => f.path), sha)) throw new BackupError('the parts don\'t rejoin to the drilled bundle; nothing was pushed');
      run.parts = files.length;
      run.commit = gitWrite(repo!, remote, files, s, stamp, opts.env, deps.beforePush).commit;
    } else {
      pathWrite(s.target.dir, file, name, s, stamp);
      run.parts = 1;
    }
    if (missing.length) throw new BackupError(`written, but without ${missing.join(', ')}'s part (in the last good backup)`);
    run.ok = true;
  } catch (e) {
    run.ok = false;
    run.why = scrub((e as Error).message, currentUrl).slice(0, 500);
  } finally {
    currentUrl = undefined;
    rmSync(work, { recursive: true, force: true });
  }
  run.ms = now().getTime() - started.getTime();
  const after = updateState(opts.home, (st) => {
    st.runs = [run, ...st.runs].slice(0, RUNS_KEPT);
    if (run.ok) st.lastGood = run;
  });
  sayRun(opts.env, after, run, deps.alert ?? alertCommand, opts.home, now().getTime());
  return run;
}

// ─── What the owner sees and hears ──────────────────────────────────────────

export interface BackupProblem { kind: 'failed' | 'missed'; text: string; meta: string; at: string }

const shortWhen = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** What's wrong with the backup now, if anything: the latest run failed, or none good in 26 hours. */
export function backupProblem(h: Household, nowMs = Date.now()): BackupProblem | null {
  const { settings: s, problem } = readSettings(h);
  if (!s && !problem) return null;
  const st = readState(h.home);
  // Restored here (settings, no setAt): it waits for the owner, and that's no alert (Setup says so).
  if (!st.setAt) return null;
  const tz = s?.tz ?? 'UTC';
  const latest = st.runs[0];
  if (latest && !latest.ok) {
    return { kind: 'failed', text: 'The nightly backup failed', meta: latest.why ?? 'it didn\'t say why', at: latest.at };
  }
  if (problem) return { kind: 'failed', text: 'The nightly backup can\'t run', meta: problem, at: st.setAt ?? new Date(nowMs).toISOString() };
  const since = st.lastGood?.at ?? st.setAt;
  if (since && nowMs - Date.parse(since) > MISSED_MS) {
    return { kind: 'missed', text: st.lastGood ? `No backup since ${shortWhen(st.lastGood.at, tz)}` : 'The nightly backup hasn\'t run yet',
      meta: `It runs each day at ${s!.at} (${s!.tz}). Is loom running?`, at: since };
  }
  return null;
}

/** The Inbox's FYI that it's over: the last recovery, for a week. */
export function backupFyi(h: Household, nowMs = Date.now()): { text: string; meta: string; at: string } | null {
  const r = readState(h.home).recovered;
  if (!r || nowMs - Date.parse(r.at) > 7 * 86_400_000) return null;
  return { text: r.text, meta: 'A good backup again, drilled.', at: r.at };
}

/** Setup's Backup row: when the last good one was, its drill and where it went; or what's wrong. */
export function backupRow(h: Household, nowMs = Date.now(), ago: (iso: string) => string = (iso) => iso): { label: string; tone: 'ok' | 'warn' | 'bad'; text: string; meta: string } {
  const { settings: s, problem } = readSettings(h);
  if (!s && !problem) return { label: 'Backup', tone: 'warn', text: 'not set up', meta: 'loom backup set --target … --recipient …' };
  if (!readState(h.home).setAt) return { label: 'Backup', tone: 'warn', text: 'waiting', meta: 'Restored here: run loom backup set to resume it on this machine.' };
  const p = backupProblem(h, nowMs);
  const good = readState(h.home).lastGood;
  const last = good ? `last good ${ago(good.at)}` : 'none good yet';
  if (p) return { label: 'Backup', tone: 'bad', text: p.kind === 'missed' ? 'missed' : 'failed', meta: `${p.meta.slice(0, 160)} · ${last}` };
  const mb = good?.bytes ? `${(good.bytes / 1048576).toFixed(0)} MB` : '';
  return { label: 'Backup', tone: good ? 'ok' : 'warn', text: good ? ago(good.at) : 'not yet',
    meta: [good?.drill?.ok ? 'drill passed' : '', mb, s ? `to ${targetLabel(s.target)}` : ''].filter(Boolean).join(' · ') };
}

// ─── The owner's alert command (core's) ─────────────────────────────────────

export interface CoreAlert { source: string; severity: 'warn' | 'bad'; summary: string; facts?: Record<string, string | number | undefined> }
const SOURCE = /^[a-z][a-z0-9-]{0,39}$/;
const FACT_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const oneLine = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * LOOM_ALERT_COMMAND, the daemon's environment's (a JSON argv), never a household setting: a bundle
 * restored elsewhere can't plant a command to run. Run detached with
 * `<source> --severity <warn|bad> --summary <line> [--fact k=v]...`, as the runtime's alert command is.
 * Returns whether it was started. Never throws.
 */
export function alertCommandArgv(env: NodeJS.ProcessEnv, a: CoreAlert): string[] | null {
  let argv: unknown;
  try { argv = JSON.parse(env.LOOM_ALERT_COMMAND || 'null'); } catch { return null; }
  if (!Array.isArray(argv) || !argv.length || !argv.every((x) => typeof x === 'string' && x)) return null;
  if (!SOURCE.test(a.source) || !oneLine(a.summary, 1)) return null;
  const out = [...argv as string[], a.source, '--severity', a.severity === 'bad' ? 'bad' : 'warn', '--summary', oneLine(a.summary, 200)];
  for (const [k, v] of Object.entries(a.facts ?? {})) if (FACT_KEY.test(k) && v !== undefined && v !== '') out.push('--fact', `${k}=${oneLine(v, 300)}`);
  return out;
}

export function alertCommand(env: NodeJS.ProcessEnv, a: CoreAlert): boolean {
  const argv = alertCommandArgv(env, a);
  if (!argv) return false;
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', env });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

/** After a run: a failure is said (each failed run is news); a good one after a failure or a miss says it's over. */
function sayRun(env: NodeJS.ProcessEnv, st: BackupState, run: BackupRun, alert: NonNullable<RunDeps['alert']>, home: string, nowMs: number): void {
  if (!run.ok) {
    // One failure alert a night: a night's retries that fail too are in the state, not said again.
    const s0 = readSettings(loadHousehold(home)!).settings;
    const slot = s0 ? lastSlot(s0, Date.parse(run.at)) : NaN;
    if (st.said?.failed && Number.isFinite(slot) && Date.parse(st.said.failed) >= slot) return;
    alert(env, { source: 'loom-backup', severity: 'bad', summary: `The nightly backup failed: ${run.why ?? 'no reason given'}`,
      facts: { at: run.at, drill: run.drill ? (run.drill.ok ? 'passed' : 'failed') : 'not run', missing: run.missing?.join(',') } });
    updateState(home, (s) => { s.said = { ...s.said, failed: new Date(nowMs).toISOString() }; });
    return;
  }
  const prev = st.runs[1];
  const wasBad = st.said?.failed || st.said?.missed || st.said?.broken || (prev && !prev.ok);
  if (wasBad) {
    if (st.said?.failed || st.said?.missed || st.said?.broken) alert(env, { source: 'loom-backup', severity: 'warn', summary: 'The nightly backup is OK again', facts: { cleared: 1, at: run.at, name: run.name } });
    updateState(home, (s) => { delete s.said; s.recovered = { at: run.at, text: 'The nightly backup is OK again' }; });
  }
}

/** Whether a tick has anything to do now (a run due, or a miss to say): the daemon starts one only then. */
export function tickWanted(h: Household, nowMs = Date.now()): boolean {
  const { settings: s, problem } = readSettings(h);
  const st = readState(h.home);
  if (!st.setAt || (!s && !problem)) return false;
  // Settings that don't work: the alert command hears it on the cadence (there's no run to do).
  if (!s) return !st.said?.broken || nowMs - Date.parse(st.said.broken) >= REMIND_MS;
  if (isDue(s, st, nowMs)) return true;
  const p = backupProblem(h, nowMs);
  return p?.kind === 'missed' && (!st.said?.missed || nowMs - Date.parse(st.said.missed) >= REMIND_MS);
}

/**
 * The daemon's tick (every 10 minutes, from each listener): a miss is said (again every 6 hours while it
 * lasts), and a run that's due is run. Only the process holding the run lock does either.
 */
export async function tickBackup(opts: { home: string; env: NodeJS.ProcessEnv; nowMs?: number; deps?: RunDeps }): Promise<'not-set' | 'busy' | 'ran' | 'idle'> {
  const nowMs = opts.nowMs ?? Date.now();
  const h = loadHousehold(opts.home);
  if (!h) return 'not-set';
  const { settings: s, problem } = readSettings(h);
  if ((!s && !problem) || !readState(opts.home).setAt) return 'not-set';
  const lock = takeLock(opts.home, nowMs);
  if (!lock) return 'busy';
  try {
    if (!s) {
      const said = readState(opts.home).said?.broken;
      if (!said || nowMs - Date.parse(said) >= REMIND_MS) {
        (opts.deps?.alert ?? alertCommand)(opts.env, { source: 'loom-backup', severity: 'bad', summary: `The nightly backup can't run: its settings don't work${said ? ' (still)' : ''}`, facts: { problem } });
        updateState(opts.home, (st) => { st.said = { ...st.said, broken: new Date(nowMs).toISOString() }; });
      }
      return 'idle';
    }
    const p = backupProblem(h, nowMs);
    const said = readState(opts.home).said?.missed;
    if (p?.kind === 'missed' && (!said || nowMs - Date.parse(said) >= REMIND_MS)) {
      (opts.deps?.alert ?? alertCommand)(opts.env, { source: 'loom-backup', severity: 'bad', summary: `${p.text}${said ? ' (still)' : ''}`, facts: { since: p.at, minutes: Math.round((nowMs - Date.parse(p.at)) / 60_000) } });
      updateState(opts.home, (st) => { st.said = { ...st.said, missed: new Date(nowMs).toISOString() }; });
    }
    if (!isDue(s, readState(opts.home), nowMs)) return 'idle';
    await runBackup({ home: opts.home, env: opts.env, now: () => new Date(opts.nowMs ?? Date.now()), scheduled: true, ...(opts.deps ? { deps: opts.deps } : {}) });
    return 'ran';
  } finally {
    lock.release();
  }
}
