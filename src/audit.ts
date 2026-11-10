/**
 * The audit log (docs/specs/conversations.md, "The audit log"): the temporary, encrypted store
 * of raw turn text that grading reads and then deletes. Its own file, `$LOOM_HOME/audit.db`,
 * so deleting it is a complete purge; never in a bundle or an export.
 *
 *   audit_entries   agent, conversation, seq, venue, kind, at (plaintext: metadata the record
 *                   already holds) and text, an age file encrypted to review.pub. Nothing else.
 *
 * The review identity, `$LOOM_HOME/review.key` and its recipient `review.pub`, are made with
 * `age-keygen` at first use, mode 0600. Without the `age` programs an audit write answers 503,
 * and the turn it was for still stands.
 *
 * Who reads it: only a grading run, through POST /api/loom/audit/take (src/audit-take.ts).
 * `decryptAuditText` is this module's one decrypt function, and the take handler is its only
 * caller (an import-graph test pins that, criterion 9). Who took what is `audit_reads` in
 * household.db: refs and keys, never text. Entries go on POST /api/loom/audit/done, and by
 * the sweep 7 days after their turn whatever happened.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import BetterSqlite3 from './sqlite.js';
import type { Database } from 'better-sqlite3';
import { findProgram } from './programs.js';
import { agentDir, roleString, type Household, type Role } from './household.js';
import { getConversation, isConversationId, turnRecord, type TurnRecord } from './backends/conversations.js';
import { withHouseholdDb } from './household-store.js';

export const AUDIT_DB = 'audit.db';
export const REVIEW_KEY = 'review.key';
export const REVIEW_PUB = 'review.pub';
/** Every file of the audit log and its key: what a bundle and an export must never carry. */
export const AUDIT_FILES: readonly string[] = [AUDIT_DB, `${AUDIT_DB}-wal`, `${AUDIT_DB}-shm`, `${AUDIT_DB}-journal`, REVIEW_KEY, REVIEW_PUB];
/** An entry is gone this long after its turn, whatever happened. */
export const AUDIT_DAYS = 7;
const DAY_MS = 86_400_000;
/** A turn's text, at most (Slack's own message cap). */
export const MAX_AUDIT_TEXT = 40_000;
/** A turn this far in the future can't take an entry: the sweep goes by the turn's time. */
const FUTURE_SLACK_MS = 10 * 60 * 1000;
/** A take answers at most this many entries. */
export const TAKE_MAX = 500;
const AGE_HEADER = 'age-encryption.org/v1';

/** A refused call: the message names what's wrong; `status` is the HTTP answer. */
export class AuditError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'AuditError';
  }
}
const fail = (m: string, status = 400): never => { throw new AuditError(m, status); };

// ─── The review key pair ────────────────────────────────────────────────────

/** The `age` and `age-keygen` programs, or a 503: audit writes need them, turns don't. */
function agePrograms(env: NodeJS.ProcessEnv): { age: string; keygen: string } {
  try {
    const age = findProgram('age', env);
    let keygen: string;
    try { keygen = findProgram('age-keygen', env); } catch {
      // age-keygen ships beside age.
      keygen = join(dirname(age), 'age-keygen');
      if (!existsSync(keygen)) throw new Error('no age-keygen');
    }
    return { age, keygen };
  } catch {
    return fail('the audit log needs the age programs (age and age-keygen), and they aren\'t installed; the turn stands without its text', 503);
  }
}

/** A plain file we made, never a link someone left there. */
function regularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

/**
 * The review identity and its recipient, made at first use: `age-keygen` writes a fresh key
 * beside the real name, then it's hard-linked into place (so two first uses can't both win),
 * and the recipient is derived from it. Both files are 0600.
 */
function reviewKeys(home: string, env: NodeJS.ProcessEnv): { identity: string; recipient: string; age: string } {
  const { age, keygen } = agePrograms(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const key = join(home, REVIEW_KEY);
  const pub = join(home, REVIEW_PUB);
  if (!existsSync(key)) {
    const tmp = join(home, `.${REVIEW_KEY}.${process.pid}.${randomBytes(4).toString('hex')}`);
    try {
      const r = spawnSync(keygen, ['-o', tmp], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' });
      if (r.status !== 0) fail(`age-keygen failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`, 503);
      chmodSync(tmp, 0o600);
      try { linkSync(tmp, key); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if (!regularFile(key)) fail(`${REVIEW_KEY} isn't a plain file; refusing to use it`, 503);
  chmodSync(key, 0o600);
  // The recipient is always derived from the key, never trusted from review.pub: a pub file
  // someone swapped can't redirect the log to another identity.
  const r = spawnSync(keygen, ['-y', key], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  const recipient = (r.stdout ?? '').trim();
  if (r.status !== 0 || !/^age1[0-9a-z]{20,}$/.test(recipient)) fail('age-keygen couldn\'t read the review key\'s recipient', 503);
  if (!regularFile(pub) || readFileSync(pub, 'utf-8').trim() !== recipient) {
    const tmp = `${pub}.${process.pid}.tmp`;
    writeFileSync(tmp, `${recipient}\n`, { mode: 0o600 });
    renameSync(tmp, pub);
  }
  chmodSync(pub, 0o600);
  return { identity: key, recipient, age };
}

function encrypt(text: string, home: string, env: NodeJS.ProcessEnv): Buffer {
  const k = reviewKeys(home, env);
  const r = spawnSync(k.age, ['-e', '-r', k.recipient], { input: Buffer.from(text, 'utf-8'), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * MAX_AUDIT_TEXT + 65_536 });
  const out = r.stdout as Buffer | null;
  if (r.status !== 0 || !out || !out.subarray(0, AGE_HEADER.length).equals(Buffer.from(AGE_HEADER))) fail('age couldn\'t encrypt the entry', 503);
  return out!;
}

/** A blob age itself rejects (not an age file, or not for this key): only this leaves an entry claimed. */
export class UndecryptableEntry extends AuditError {
  constructor() { super('an audit entry isn\'t an age file for the review key', 500); this.name = 'UndecryptableEntry'; }
}

/** What age says about a blob it rejects, as opposed to age itself failing. */
const BLOB_REJECTED = /failed to read header|no identity matched|failed to decrypt|payload|malformed|unexpected EOF/i;

/**
 * Throws the 503 a take answers before claiming anything when it couldn't decrypt: no age
 * programs, or no review key that is a plain file.
 */
export function assertDecryptReady(home: string, env: NodeJS.ProcessEnv = process.env): void {
  agePrograms(env);
  if (!regularFile(join(home, REVIEW_KEY))) fail('the review key is missing or isn\'t a plain file; nothing was taken', 503);
}

/**
 * The one way back to an entry's text: decrypt `blob` with `$LOOM_HOME/review.key`. Only the
 * take handler (src/audit-take.ts) calls this; nothing else may (criterion 9). Throws
 * UndecryptableEntry when age rejects the blob, and a 503 AuditError for anything else (no
 * key, age missing or failing), so the caller can tell a bad entry from a broken decrypt.
 */
export function decryptAuditText(home: string, blob: Buffer, env: NodeJS.ProcessEnv = process.env): string {
  const { age } = agePrograms(env);
  const key = join(home, REVIEW_KEY);
  if (!regularFile(key)) fail('the review key is missing or isn\'t a plain file', 503);
  const r = spawnSync(age, ['-d', '-i', key], { input: blob, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * MAX_AUDIT_TEXT + 65_536 });
  if (r.error || r.signal) fail('age couldn\'t run', 503);
  if (r.status !== 0) {
    if (BLOB_REJECTED.test((r.stderr as Buffer | null)?.toString('utf-8') ?? '')) throw new UndecryptableEntry();
    fail('age failed', 503);
  }
  return ((r.stdout as Buffer | null) ?? Buffer.alloc(0)).toString('utf-8');
}

// ─── The store ──────────────────────────────────────────────────────────────

export function openAuditDb(home: string): Database {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, AUDIT_DB);
  const db = new BetterSqlite3(path);
  try {
    db.pragma('busy_timeout = 5000');
    // DELETE mode, not WAL: a deleted entry's pages leave the file at the next checkpoint
    // otherwise, and secure_delete zeroes them.
    db.pragma('journal_mode = DELETE');
    db.pragma('secure_delete = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS audit_entries (
      agent        TEXT NOT NULL,
      conversation TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      venue        TEXT NOT NULL,
      kind         TEXT NOT NULL,
      at           TEXT NOT NULL,
      text         BLOB NOT NULL,
      PRIMARY KEY (agent, conversation, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entries_at ON audit_entries(at);`);
    chmodSync(path, 0o600);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function withAudit<T>(home: string, f: (db: Database) => T): T {
  const db = openAuditDb(home);
  try { return f(db); } finally { db.close(); }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Which agent's store holds conversation `id`: for the runtime, any of the household's; for an agent, its own. */
function ownerOf(h: Household, role: Role, id: string): string | undefined {
  const candidates = role.kind === 'agent' ? [role.agent] : role.kind === 'runtime' ? h.agents : [];
  return candidates.find((a) => getConversation(agentDir(h, a), id) !== undefined);
}

/**
 * POST /api/loom/audit {conversation, seq, text}: the raw text of a turn already written, by
 * that turn's writer only (the runtime, or the agent for its own session). Refused: a missing
 * (conversation, seq), a different writer, an entry already written or already read, and a
 * turn too far in the future for the 7-day sweep to be honest. 503 without the age programs.
 */
export function writeAudit(h: Household, role: Role, raw: unknown, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): { conversation: string; seq: number } {
  if (role.kind !== 'runtime' && role.kind !== 'agent') fail('an audit entry is written by the turn\'s writer: the runtime, or the agent for its own session', 403);
  if (!isObject(raw)) fail('an audit entry is {conversation, seq, text}');
  const body = raw as Record<string, unknown>;
  const bad = Object.keys(body).find((k) => !['conversation', 'seq', 'text'].includes(k));
  if (bad !== undefined) fail(`an audit entry has no key ${JSON.stringify(bad)} (it has conversation, seq, text)`);
  if (!isConversationId(body.conversation)) fail('conversation is a conversation id (cv-…), as the turn write answered');
  if (typeof body.seq !== 'number' || !Number.isSafeInteger(body.seq) || body.seq < 1) fail('seq is the turn\'s seq, as the turn write answered');
  if (typeof body.text !== 'string' || !body.text.length || body.text.length > MAX_AUDIT_TEXT) fail(`text is 1-${MAX_AUDIT_TEXT} characters`);
  const conversation = body.conversation as string;
  const seq = body.seq as number;
  const agent = ownerOf(h, role, conversation);
  const turn: TurnRecord | undefined = agent ? turnRecord(agentDir(h, agent), conversation, seq) : undefined;
  // The same answer for "no such conversation" and "no such turn": write the turn first.
  if (!agent || !turn) fail(`no turn ${seq} in conversation ${conversation}: write the turn first, then its audit entry`, 404);
  if (turn!.writer !== roleString(role)) fail('only the turn\'s writer writes its audit entry', 403);
  const atMs = Date.parse(turn!.at);
  if (atMs > now.getTime() + FUTURE_SLACK_MS) fail('that turn is in the future: its entry would outlive the 7-day sweep', 409);
  if (atMs < now.getTime() - AUDIT_DAYS * DAY_MS) fail(`that turn is older than ${AUDIT_DAYS} days: the audit log no longer keeps it`, 409);
  const home = h.home;
  const read = withHouseholdDb(home, (db) => db.prepare('SELECT 1 FROM audit_reads WHERE agent = ? AND conversation = ? AND seq = ?').get(agent, conversation, seq));
  if (read) fail('that turn\'s entry was already taken by a review: it isn\'t written again', 409);
  const blob = encrypt(body.text as string, home, env);
  withAudit(home, (db) => {
    const r = db.prepare('INSERT OR IGNORE INTO audit_entries (agent, conversation, seq, venue, kind, at, text) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      agent, conversation, seq, turn!.venue, turn!.kind, turn!.at, blob);
    if (r.changes === 0) fail('that turn already has its audit entry', 409);
  });
  return { conversation, seq };
}

/** An entry as a take claims it: its key, its metadata and its ciphertext. */
export interface ClaimedEntry { ref: string; agent: string; conversation: string; seq: number; venue: string; kind: string; at: string; blob: Buffer }

/**
 * Claim up to `limit` entries not yet taken, oldest first across the household's agents:
 * each gets an opaque `ref` and an `audit_reads` row (run, time, agent, conversation, seq;
 * never text), in one household.db transaction, so two takes never share an entry.
 */
export function claimEntries(home: string, run: string, limit: number, now: Date = new Date()): ClaimedEntry[] {
  if (!existsSync(join(home, AUDIT_DB))) return [];
  return withAudit(home, (adb) => withHouseholdDb(home, (hdb) => hdb.transaction(() => {
    const out: ClaimedEntry[] = [];
    const claim = hdb.prepare('INSERT OR IGNORE INTO audit_reads (ref, run, at, agent, conversation, seq) VALUES (?, ?, ?, ?, ?, ?)');
    const rows = adb.prepare('SELECT agent, conversation, seq, venue, kind, at, text FROM audit_entries ORDER BY at, rowid').iterate() as IterableIterator<{ agent: string; conversation: string; seq: number; venue: string; kind: string; at: string; text: Buffer }>;
    for (const r of rows) {
      if (out.length >= limit) break;
      const ref = `ar-${randomBytes(9).toString('hex')}`;
      if (claim.run(ref, run, now.toISOString(), r.agent, r.conversation, r.seq).changes === 0) continue;
      out.push({ ref, agent: r.agent, conversation: r.conversation, seq: r.seq, venue: r.venue, kind: r.kind, at: r.at, blob: r.text });
    }
    return out;
  }).immediate()));
}

/** Undo a take's claims (its audit_reads rows), so the entries wait for a run that can decrypt them. */
export function releaseClaims(home: string, run: string, refs: readonly string[]): void {
  if (!refs.length) return;
  withHouseholdDb(home, (db) => db.transaction(() => { const del = db.prepare('DELETE FROM audit_reads WHERE ref = ? AND run = ?'); for (const r of refs) del.run(r, run); }).immediate());
}

/** What a ref this run took stands for, or undefined (another run's, or none). */
export function refOf(home: string, run: string, ref: unknown): { agent: string; conversation: string; seq: number } | undefined {
  if (typeof ref !== 'string' || !/^ar-[0-9a-f]{18}$/.test(ref)) return undefined;
  return withHouseholdDb(home, (db) => db.prepare('SELECT agent, conversation, seq FROM audit_reads WHERE ref = ? AND run = ?').get(ref, run) as { agent: string; conversation: string; seq: number } | undefined);
}

/** POST /api/loom/audit/done {refs}: delete the entries this run took. Answers how many went. */
export function doneEntries(home: string, run: string, raw: unknown): { deleted: number } {
  if (!isObject(raw) || Object.keys(raw).some((k) => k !== 'refs')) fail('done is {refs: [...]}');
  const refs = (raw as { refs?: unknown }).refs;
  if (!Array.isArray(refs) || refs.length > TAKE_MAX || !refs.every((r) => typeof r === 'string')) fail(`refs is a list of at most ${TAKE_MAX} refs from this run's takes`);
  if (!existsSync(join(home, AUDIT_DB))) return { deleted: 0 };
  const keys = (refs as string[]).map((r) => refOf(home, run, r)).filter((k): k is NonNullable<typeof k> => k !== undefined);
  return withAudit(home, (db) => db.transaction(() => {
    const del = db.prepare('DELETE FROM audit_entries WHERE agent = ? AND conversation = ? AND seq = ?');
    let deleted = 0;
    for (const k of keys) deleted += del.run(k.agent, k.conversation, k.seq).changes;
    return { deleted };
  }).immediate());
}

/** The sweep: every entry whose turn is older than 7 days goes, taken or not. Hourly, and at daemon start. */
export function sweepAudit(home: string, now: Date = new Date()): number {
  if (!existsSync(join(home, AUDIT_DB))) return 0;
  const cutoff = new Date(now.getTime() - AUDIT_DAYS * DAY_MS).toISOString();
  return withAudit(home, (db) => db.prepare('DELETE FROM audit_entries WHERE at < ?').run(cutoff).changes);
}

/** How many entries the log holds (for tests and the daemon's own checks; never their text). */
export function auditCount(home: string): number {
  if (!existsSync(join(home, AUDIT_DB))) return 0;
  return withAudit(home, (db) => (db.prepare('SELECT COUNT(*) AS n FROM audit_entries').get() as { n: number }).n);
}
