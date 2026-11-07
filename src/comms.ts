/**
 * Comms (docs/specs/comms.md): an agent's owners talking with it inside loom, in threads. Each thread is a place in
 * core's own venue `loom`, delivered through the runtime like any venue, and core is that venue's adapter.
 *
 * Where it lives:
 *  - household.db: `comms_threads` (a thread joins a member and an agent) and `comms_deleted` (a deleted thread's
 *    tombstone: its id, member, agent, channel and when, no words);
 *  - comms.db: `comms_messages`, and every word of them, each an age file to comms.key. `secure_delete` is on, so a
 *    deleted or swept message's pages are zeroed. Never in a bundle or an export (COMMS_FILES).
 *  - comms.key (age identity) and comms.salt (32 random bytes: the HMAC key a thread's place is made with), mode 0600.
 *
 * The words are kept for household.json's `comms_days` (1-14, default 14: the continuity slot's window, the owner's
 * ruling of 2026-11-05) and then swept: the row stays, its text goes. Only the thread's member reads them, through the
 * page's thread routes (src/ui/comms-routes.ts). No token, piece or MCP tool can.
 *
 * Who may: a member who owns the thread's agent (owners.md: `agents` is `*` or lists it) and opened the thread. Every
 * other caller, and a thread that doesn't exist, gets the same 403, so a route never says whether a thread exists.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, linkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { findProgram } from './programs.js';
import { agentDir, loadHousehold, type Household, type Member } from './household.js';
import { withHouseholdDb } from './household-store.js';
import { dropRefs, noteRefs } from './comms-work.js';
import { conversationId, digestsOf, openConversationsReadonly, projectLookup, setConversationLabel } from './backends/conversations.js';

export const COMMS_VENUE = 'loom';
export const COMMS_DB = 'comms.db';
export const COMMS_KEY = 'comms.key';
export const COMMS_SALT = 'comms.salt';
/** Every file of the thread store and its keys: what a bundle and an export must never carry. */
export const COMMS_FILES: readonly string[] = [COMMS_DB, `${COMMS_DB}-wal`, `${COMMS_DB}-shm`, `${COMMS_DB}-journal`, COMMS_KEY, COMMS_SALT];
export const COMMS_DAYS_DEFAULT = 14;
export const MAX_TEXT = 40_000;
export const MAX_TITLE = 60;
export const MAX_PINS = 8;
export const PAGE = 100;
/** A `since` read answers at most this many (a reconnect after a long gap reads on with since again). */
export const SINCE_MAX = 500;
/** How many messages are decrypted at once (each is one age process): a thread's page never blocks the daemon. */
const DECRYPT_AT_ONCE = 8;
export const MAX_CARDS = 50;
export const MAX_SUMMARY = 120;
/** A queued message with no `working` from the runtime for this long is "busy" (comms.md, section 7). */
export const BUSY_MS = 2 * 60_000;
/**
 * A member's message still marked on its way this long after its delivery began was cut off (the daemon restarted
 * under it), so it's recorded as not delivered, and Send again delivers it (t-1881). Core's delivery to the runtime
 * gives up at 120 s once it runs (DELIVERY_LIMITS.timeoutMs), after waiting its turn in its piece's pool (2 running,
 * 4 waiting): 6 × 120 s at the very worst, so 15 minutes is past any delivery still going.
 */
export const SEND_STALE_MS = 15 * 60_000;
/**
 * The runtime says `working` again every 15 s while a thread's body works (loom-box delivery.mjs, PRESENCE_MS), and
 * posts its activity: a thread with no word of it this long has no body at work, whatever its last word was (t-1881).
 */
export const WORKING_STALE_MS = 90_000;
const DAY_MS = 86_400_000;

/** A message's id from the app: 16 characters of RFC 4648 base32, lowercased. */
export const CLIENT_ID = /^[a-z2-7]{16}$/;
/** A thread's id, which is its place. */
export const THREAD_ID = /^th:[a-z2-7]{10}$/;
/** A thread's page address (t-1918): its id without the `th:`, since a page's path has no colon (vocab.ts PATH_CHARS),
 * as `login/<id>` went (loom-box#50). `/comms/th:…` still works, and a page load of one is sent here. */
export const threadPath = (id: string): string => `/comms/${id.replace(/^th:/, '')}`;
/** The thread id an address names: its bare 10 characters, or the old `th:` form. */
export const threadIdOf = (seg: string): string => (/^[a-z2-7]{10}$/.test(seg) ? `th:${seg}` : seg);
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export type MessageKind = 'message' | 'reply' | 'card' | 'ask' | 'error';
export type CardState = 'running' | 'done' | 'failed';

/** A refusal: the message says what's wrong in words; `status` is the HTTP answer. */
export class CommsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'CommsError'; }
}
const fail = (m: string, status = 400): never => { throw new CommsError(m, status); };
/** The one answer for a thread a caller may not see, or that doesn't exist: never says which. */
export const NOT_YOURS = 'forbidden: that thread isn\'t one of yours';

export interface Thread {
  id: string;
  agent: string;
  member: string;
  conversation: string;
  title: string | null;
  titled_by: 'agent' | 'member' | null;
  project: string | null;
  pinned: boolean;
  archived: string | null;
  opened: string;
  last: string;
  read_seq: number;
  channel: number;
  working_since: string | null;
  /** When the runtime last said the thread's body is at work (its status or its activity), ms. */
  working_beat: number | null;
  queued_since: string | null;
  last_failed: boolean;
  /** When an app of its member last had it in front (its read calls), ms; null for never. */
  in_front: number | null;
}

export interface Message {
  seq: number;
  at: string;
  kind: MessageKind;
  from: string;
  id: string;
  /** The words (null once swept); for an error, its words from the fixed table. */
  text: string | null;
  /** An activity card's or an error's payload; on a reply, `{on}` when a switched body sent it (the adapter route). */
  card: Record<string, unknown> | null;
  run: string | null;
  /** On a member's message: true once delivered, false when its delivery failed, null while it's on its way. */
  delivered: boolean | null;
  /** On a member's message, the same in a word (comms.md, "Sending"); absent on every other kind. */
  delivery?: Delivery;
}

/** Where a member's message is: on its way, delivered, or not delivered (a failure core recorded). */
export type Delivery = 'sending' | 'delivered' | 'failed';

// ─── Keys ──────────────────────────────────────────────────────────────────────

function regularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

/** A secret file made at first use, mode 0600, by link so two first uses can't both win. */
function firstUse(home: string, name: string, make: (tmp: string) => void): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, name);
  if (!existsSync(path)) {
    const tmp = join(home, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}`);
    try {
      make(tmp);
      chmodSync(tmp, 0o600);
      try { linkSync(tmp, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    } finally { rmSync(tmp, { force: true }); }
  }
  if (!regularFile(path)) fail(`${name} isn't a plain file; refusing to use it`, 503);
  chmodSync(path, 0o600);
  return path;
}

const salts = new Map<string, Buffer>();
/** comms.salt: the key a thread's place and a message's keyed hash are made with. */
export function commsSalt(home: string): Buffer {
  const kept = salts.get(home);
  if (kept) return kept;
  const path = firstUse(home, COMMS_SALT, (tmp) => {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, randomBytes(32)); } finally { closeSync(fd); }
  });
  const salt = readFileSync(path);
  if (salt.length !== 32) fail(`${COMMS_SALT} isn't 32 bytes; refusing to use it`, 503);
  salts.set(home, salt);
  return salt;
}

const base32 = (buf: Buffer): string => {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};

/** A thread's place: `th:` and 10 base32 characters of an HMAC over the member, the agent and the first message's id. */
export function placeFor(home: string, member: string, agent: string, id: string): string {
  return `th:${base32(createHmac('sha256', commsSalt(home)).update(`${member}\0${agent}\0${id}`).digest()).slice(0, 10)}`;
}

/** A keyed hash of a message's words: how a repeat is known without keeping a plain hash of them. */
export function wordsHash(home: string, text: string): string {
  return createHmac('sha256', commsSalt(home)).update(`words\0${text}`).digest('hex');
}

/** The age programs and the comms identity's recipient, made at first use; a 503 without age. */
const recipients = new Map<string, string>();
function ageKeys(home: string, env: NodeJS.ProcessEnv): { age: string; key: string; recipient: string } {
  let age: string;
  let keygen: string;
  try {
    age = findProgram('age', env);
    try { keygen = findProgram('age-keygen', env); } catch {
      keygen = join(dirname(age), 'age-keygen');
      if (!existsSync(keygen)) throw new Error('no age-keygen');
    }
  } catch { return fail('no-age: loom keeps a thread\'s words encrypted, and the age programs aren\'t installed', 503); }
  const key = firstUse(home, COMMS_KEY, (tmp) => {
    const r = spawnSync(keygen, ['-o', tmp], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' });
    if (r.status !== 0) fail(`age-keygen failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`, 503);
  });
  let recipient = recipients.get(key);
  if (!recipient) {
    const r = spawnSync(keygen, ['-y', key], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
    recipient = (r.stdout ?? '').trim();
    if (r.status !== 0 || !/^age1[0-9a-z]{20,}$/.test(recipient)) fail('age-keygen couldn\'t read the comms key\'s recipient', 503);
    recipients.set(key, recipient);
  }
  return { age, key, recipient };
}

/** Whether the age programs are here: a send is refused without them, before anything is stored. */
export function ageReady(home: string, env: NodeJS.ProcessEnv): boolean {
  try { ageKeys(home, env); return true; } catch { return false; }
}

function encrypt(home: string, env: NodeJS.ProcessEnv, text: string): Buffer {
  const k = ageKeys(home, env);
  const r = spawnSync(k.age, ['-e', '-r', k.recipient], { input: Buffer.from(text, 'utf-8'), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * MAX_TEXT + 65_536 });
  if (r.status !== 0 || !r.stdout?.length) fail('age couldn\'t encrypt the message', 503);
  return r.stdout as Buffer;
}

/** One message's words, decrypted by its own age process, without blocking the daemon; null when age can't. */
function decrypt(home: string, env: NodeJS.ProcessEnv, blob: Buffer): Promise<string | null> {
  const k = ageKeys(home, env);
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let size = 0;
    const child = spawn(k.age, ['-d', '-i', k.key], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.on('data', (c: Buffer) => { size += c.length; if (size <= 4 * MAX_TEXT + 65_536) out.push(c); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(out).toString('utf-8') : null));
    child.stdin.on('error', () => {});
    child.stdin.end(blob);
  });
}

/** Each of `items` through `f`, at most `n` at once, in order. */
async function pool<T, U>(items: T[], n: number, f: (x: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i]); }
  }));
  return out;
}

// ─── The stores ────────────────────────────────────────────────────────────────

const THREADS_SCHEMA = `CREATE TABLE IF NOT EXISTS comms_threads (
    id            TEXT PRIMARY KEY,
    agent         TEXT NOT NULL,
    member        TEXT NOT NULL,
    conversation  TEXT NOT NULL,
    title         TEXT,
    titled_by     TEXT,
    project       TEXT,
    pinned        INTEGER NOT NULL DEFAULT 0,
    archived      TEXT,
    opened        TEXT NOT NULL,
    last          TEXT NOT NULL,
    read_seq      INTEGER NOT NULL DEFAULT 0,
    channel       INTEGER NOT NULL,
    first_id      TEXT NOT NULL,
    first_hash    TEXT NOT NULL,
    working_since TEXT,
    working_beat  INTEGER,
    queued_since  TEXT,
    last_failed   INTEGER NOT NULL DEFAULT 0,
    stop          INTEGER NOT NULL DEFAULT 0,
    in_front      INTEGER,
    updated       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comms_threads_member ON comms_threads (member, agent);
  CREATE INDEX IF NOT EXISTS comms_threads_conversation ON comms_threads (conversation);
  CREATE INDEX IF NOT EXISTS comms_threads_updated ON comms_threads (updated);
  CREATE TABLE IF NOT EXISTS comms_deleted (
    id      TEXT PRIMARY KEY,
    member  TEXT NOT NULL,
    agent   TEXT NOT NULL,
    channel INTEGER NOT NULL,
    at      TEXT NOT NULL
  );`;

const MESSAGES_SCHEMA = `CREATE TABLE IF NOT EXISTS comms_messages (
    thread    TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    at        TEXT NOT NULL,
    kind      TEXT NOT NULL,
    sender    TEXT NOT NULL,
    id        TEXT NOT NULL,
    hash      TEXT,
    text      BLOB,
    card_json TEXT,
    run       TEXT,
    delivered INTEGER,
    sending_at INTEGER,
    delivery_json TEXT,
    PRIMARY KEY (thread, seq)
  );
  CREATE INDEX IF NOT EXISTS comms_messages_id ON comms_messages (thread, kind, id);
  CREATE INDEX IF NOT EXISTS comms_messages_at ON comms_messages (at);`;

const threadsReady = new Set<string>();
function withThreads<T>(home: string, f: (db: Database) => T): T {
  return withHouseholdDb(home, (db) => {
    if (!threadsReady.has(home)) { db.exec(THREADS_SCHEMA); addColumn(db, 'comms_threads', 'working_beat', 'INTEGER'); threadsReady.add(home); }
    return f(db);
  });
}

function openMessages(home: string): Database {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, COMMS_DB);
  const fresh = !existsSync(path);
  const db = new BetterSqlite3(path);
  if (fresh) chmodSync(path, 0o600);
  db.pragma('busy_timeout = 5000');
  // Rollback journal with secure_delete, as audit.db: a swept or deleted message's pages are zeroed.
  db.pragma('journal_mode = DELETE');
  db.pragma('secure_delete = ON');
  db.exec(MESSAGES_SCHEMA);
  addColumn(db, 'comms_messages', 'sending_at', 'INTEGER');
  addColumn(db, 'comms_messages', 'delivery_json', 'TEXT');
  return db;
}

/** A column a store made before it gains it (t-1881): added once, empty. */
function addColumn(db: Database, table: string, column: string, type: string): void {
  const have = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
function withMessages<T>(home: string, f: (db: Database) => T): T {
  const db = openMessages(home);
  try { return f(db); } finally { db.close(); }
}

interface ThreadRow {
  id: string; agent: string; member: string; conversation: string; title: string | null; titled_by: string | null; project: string | null;
  pinned: number; archived: string | null; opened: string; last: string; read_seq: number; channel: number; first_id: string; first_hash: string;
  working_since: string | null; working_beat: number | null; queued_since: string | null; last_failed: number; stop: number; in_front: number | null; updated: number;
}
const threadOf = (r: ThreadRow): Thread => ({
  id: r.id, agent: r.agent, member: r.member, conversation: r.conversation, title: r.title,
  titled_by: r.titled_by === 'agent' || r.titled_by === 'member' ? r.titled_by : null, project: r.project, pinned: r.pinned === 1,
  archived: r.archived, opened: r.opened, last: r.last, read_seq: r.read_seq, channel: r.channel,
  working_since: r.working_since, working_beat: r.working_beat ?? null, queued_since: r.queued_since, last_failed: r.last_failed === 1, in_front: r.in_front,
});

// ─── Who may ───────────────────────────────────────────────────────────────────

/** Whether a member owns an agent (owners.md). */
export const owns = (m: Member | undefined, agent: string): boolean =>
  !!m && (m.agents === '*' || m.agents.includes(agent));

/**
 * The thread `id`, for `member`: only when it's theirs and they own its agent. Anything else (another member's, an
 * agent they don't own, one that never existed) is the same 403; their own deleted thread is a 404.
 */
export function threadFor(h: Household, member: Member | undefined, id: string): Thread {
  if (!member || !THREAD_ID.test(id)) return fail(NOT_YOURS, 403);
  return withThreads(h.home, (db) => {
    const r = db.prepare('SELECT * FROM comms_threads WHERE id = ?').get(id) as ThreadRow | undefined;
    if (r && r.member === member.person && owns(member, r.agent) && h.agents.includes(r.agent)) return threadOf(r);
    if (!r) {
      const d = db.prepare('SELECT member, agent FROM comms_deleted WHERE id = ?').get(id) as { member: string; agent: string } | undefined;
      if (d && d.member === member.person && owns(member, d.agent)) return fail('not-found: you deleted that thread', 404);
    }
    return fail(NOT_YOURS, 403);
  });
}

/** Whether `person` may still see thread `id` (a live stream asks before each event). */
export function stillSees(h: Household, person: string, id: string): boolean {
  const m = h.members.find((x) => x.person === person);
  try { threadFor(h, m, id); return true; } catch { return false; }
}

// ─── Reading ───────────────────────────────────────────────────────────────────

interface MsgRow { seq: number; at: string; kind: string; sender: string; id: string; text: Buffer | null; card_json: string | null; run: string | null; delivered: number | null }

const deliveryOf = (delivered: number | null): Delivery => (delivered === 1 ? 'delivered' : delivered === 0 ? 'failed' : 'sending');

/** An error message's words: a fixed table, never stored (comms.md, section 7). */
export function errorWords(code: string, agentName: string, reason: string | undefined): string {
  const r = reason ? reason.replace(/^[a-z-]+: /, '') : '';
  switch (code) {
    case 'no-runtime': return 'loom can\'t reach any agent: the runtime isn\'t installed.';
    case 'refused': return `${agentName} didn't get that: ${r || 'the runtime refused it'}.`;
    case 'start-failed': return `${agentName} couldn't start: ${r || 'no reason given'}.`;
    case 'busy': return `${agentName} is busy with other work; this is waiting its turn.`;
    case 'start-retry': return `${agentName} couldn't start; retrying.`;
    case 'loop': return `Paused: ${agentName} was repeating itself.`;
    case 'post-failed': return `${agentName}'s reply couldn't be shown: ${r || 'no reason given'}.`;
    case 'no-reply': return `${agentName} finished without replying.`;
    case 'no-age': return 'loom can\'t keep messages safely right now: the age program is missing.';
    default: return `${agentName} couldn't be reached: ${r || 'something went wrong'}.`;
  }
}

const label = (agent: string) => agent[0].toUpperCase() + agent.slice(1);

function householdAt(home: string): Household {
  const h = loadHousehold(home);
  if (!h) return fail('no household here', 503);
  return h;
}

async function messageOf(home: string, env: NodeJS.ProcessEnv, agent: string, r: MsgRow): Promise<Message> {
  const card = r.card_json ? JSON.parse(r.card_json) as Record<string, unknown> : null;
  let text: string | null = null;
  if (r.kind === 'error') text = errorWords(String(card?.error ?? ''), label(agent), typeof card?.reason === 'string' ? card.reason : undefined);
  else if (r.text) text = await decrypt(home, env, r.text);
  return { seq: r.seq, at: r.at, kind: r.kind as MessageKind, from: r.sender, id: r.id, text, card, run: r.run, delivered: r.delivered === null ? null : r.delivered === 1,
    ...(r.kind === 'message' ? { delivery: deliveryOf(r.delivered) } : {}) };
}

/** A thread's messages: the newest PAGE, or those after `after`, or the PAGE before `before`; oldest first. */
export async function messagesOf(h: Household, env: NodeJS.ProcessEnv, t: Thread, at: { after?: number; before?: number } = {}): Promise<Message[]> {
  const rows = withMessages(h.home, (db) => {
    if (at.after !== undefined) return db.prepare('SELECT * FROM comms_messages WHERE thread = ? AND seq > ? ORDER BY seq LIMIT ?').all(t.id, at.after, SINCE_MAX) as MsgRow[];
    if (at.before !== undefined) return (db.prepare('SELECT * FROM comms_messages WHERE thread = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(t.id, at.before, PAGE) as MsgRow[]).reverse();
    return (db.prepare('SELECT * FROM comms_messages WHERE thread = ? ORDER BY seq DESC LIMIT ?').all(t.id, PAGE) as MsgRow[]).reverse();
  });
  return pool(rows, DECRYPT_AT_ONCE, (r) => messageOf(h.home, env, t.agent, r));
}

/** The thread's newest message seq (0 with none), and its newest reply's. */
export function seqsOf(home: string, thread: string): { last: number; reply: number } {
  if (!existsSync(join(home, COMMS_DB))) return { last: 0, reply: 0 };
  return withMessages(home, (db) => {
    const last = (db.prepare('SELECT MAX(seq) AS n FROM comms_messages WHERE thread = ?').get(thread) as { n: number | null }).n ?? 0;
    const reply = (db.prepare("SELECT MAX(seq) AS n FROM comms_messages WHERE thread = ? AND kind = 'reply'").get(thread) as { n: number | null }).n ?? 0;
    return { last, reply };
  });
}

/** The digests of a thread's conversation, newest first: what stands in for swept words. */
export function digestsFor(h: Household, t: Thread): Array<{ at: string; summary: string }> {
  try { return digestsOf(agentDir(h, t.agent), t.conversation).map((d) => ({ at: d.at, summary: d.summary })).reverse(); } catch { return []; }
}

export interface ListedThread extends Thread { unread: boolean; working: boolean; last_seq: number; last_reply: number }

/** A member's threads with agents they own: pinned first, then by last; archived ones only when asked. */
export function threadsOf(h: Household, member: Member, opts: { archived?: boolean } = {}): ListedThread[] {
  const rows = withThreads(h.home, (db) => db.prepare('SELECT * FROM comms_threads WHERE member = ? ORDER BY pinned DESC, last DESC').all(member.person) as ThreadRow[]);
  const listed = rows.filter((r) => owns(member, r.agent) && h.agents.includes(r.agent) && (opts.archived ? r.archived !== null : r.archived === null))
    .map((r) => {
      const t = threadOf(r);
      const s = seqsOf(h.home, t.id);
      return { ...t, unread: s.reply > t.read_seq, working: t.working_since !== null, last_seq: s.last, last_reply: s.reply };
    });
  // Pinned, then unread, then the rest, each by last (comms.md, "Phone").
  const rank = (t: ListedThread) => (t.pinned ? 0 : t.unread ? 1 : 2);
  return listed.sort((a, b) => rank(a) - rank(b) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

// ─── Writing ───────────────────────────────────────────────────────────────────

const nowIso = (now: Date) => now.toISOString();

/** Change a thread's row, and tell the live streams (bump). */
function touch(home: string, db: Database, id: string, sets: Record<string, unknown>, now: Date): void {
  const keys = Object.keys(sets);
  db.prepare(`UPDATE comms_threads SET ${[...keys.map((k) => `${k} = ?`), 'updated = ?'].join(', ')} WHERE id = ?`).run(...keys.map((k) => sets[k] as never), now.getTime(), id);
  bump(home);
}
const withThreadsAt = withThreads;

/**
 * Tell this process's and the other listeners' live streams that a thread moved (src/ui/comms-live.ts watches the
 * tick file and reads comms_threads.updated). The tick holds a time, never a thread or a word.
 */
export function bump(home: string): void {
  if (!home) return;
  try { writeFileSync(join(home, 'comms.tick'), String(Date.now())); } catch { /* the streams' fallback poll still finds it */ }
  for (const f of listeners) f();
}
const listeners = new Set<() => void>();
/** A same-process listener for thread moves (the live streams). */
export function onBump(f: () => void): () => void { listeners.add(f); return () => listeners.delete(f); }

function append(home: string, env: NodeJS.ProcessEnv, thread: string, m: { kind: MessageKind; from: string; id: string; text?: string; hash?: string; card?: Record<string, unknown>; run?: string; delivered?: boolean | 'sending' }, now: Date): number {
  const blob = m.text !== undefined ? encrypt(home, env, m.text) : null;
  const seq = withMessages(home, (db) => db.transaction(() => {
    const seq = ((db.prepare('SELECT MAX(seq) AS n FROM comms_messages WHERE thread = ?').get(thread) as { n: number | null }).n ?? 0) + 1;
    db.prepare('INSERT INTO comms_messages (thread, seq, at, kind, sender, id, hash, text, card_json, run, delivered, sending_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      thread, seq, nowIso(now), m.kind, m.from, m.id, m.hash ?? null, blob, m.card ? JSON.stringify(m.card) : null, m.run ?? null,
      m.delivered === undefined || m.delivered === 'sending' ? null : m.delivered ? 1 : 0, m.delivered === 'sending' ? now.getTime() : null);
    return seq;
  }).immediate());
  // The work it names, as refs only, beside the thread (comms.md, "The refs index").
  noteRefs(home, thread, seq, nowIso(now), m.kind, m.text);
  return seq;
}

/** Whether `slug` is one of `agent`'s live projects. */
export function liveProject(h: Household, agent: string, slug: string): boolean {
  const db = openConversationsReadonly(agentDir(h, agent));
  if (!db) return false;
  try { return projectLookup(db).resolve(slug) === slug; } finally { db.close(); }
}

const PROJECT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function checkText(text: unknown): string {
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT) return fail(`bad-input: text is 1-${MAX_TEXT} characters`);
  return text;
}
function checkId(id: unknown): string {
  if (typeof id !== 'string' || !CLIENT_ID.test(id)) return fail('bad-input: id is 16 characters of base32 (a-z, 2-7)');
  return id;
}

/**
 * Open a thread with its first message (POST /comms/new). The same member, agent, id and text answer the same thread;
 * the same id with another agent or other text is a 409. Answers the thread, its first message's seq, and whether it's new.
 */
export function openThread(h: Household, env: NodeJS.ProcessEnv, member: Member, raw: Record<string, unknown>, now: Date = new Date()): { thread: Thread; seq: number; created: boolean } {
  const agent = raw.agent;
  if (typeof agent !== 'string' || !h.agents.includes(agent) || !owns(member, agent)) return fail('forbidden: you can open threads only with an agent you own', 403);
  const id = checkId(raw.id);
  const text = checkText(raw.text);
  let project: string | null = null;
  if (raw.project !== undefined && raw.project !== null) {
    if (typeof raw.project !== 'string' || !PROJECT.test(raw.project) || !liveProject(h, agent, raw.project)) return fail(`bad-input: ${String(raw.project)} isn't one of ${agent}'s live projects`);
    project = raw.project;
  }
  const hash = wordsHash(h.home, text);
  const place = placeFor(h.home, member.person, agent, id);
  const existing = withThreadsAt(h.home, (db) => db.prepare('SELECT * FROM comms_threads WHERE member = ? AND first_id = ?').all(member.person, id) as ThreadRow[]);
  if (existing.length) {
    const r = existing[0];
    if (r.agent !== agent || r.first_hash !== hash) return fail('conflict: that message id already opened another thread', 409);
    const first = withMessages(h.home, (db) => db.prepare("SELECT seq FROM comms_messages WHERE thread = ? AND kind = 'message' AND id = ?").get(r.id, id) as { seq: number } | undefined);
    return { thread: threadOf(r), seq: first?.seq ?? 1, created: false };
  }
  if (withThreadsAt(h.home, (db) => db.prepare('SELECT 1 FROM comms_deleted WHERE id = ?').get(place))) return fail('conflict: that message id opened a thread you deleted', 409);
  if (!ageReady(h.home, env)) return fail('no-age: loom keeps a thread\'s words encrypted, and the age programs aren\'t installed', 503);
  const at = nowIso(now);
  const thread = withThreadsAt(h.home, (db) => db.transaction(() => {
    const channel = 1 + Math.max(
      (db.prepare('SELECT MAX(channel) AS n FROM comms_threads WHERE member = ? AND agent = ?').get(member.person, agent) as { n: number | null }).n ?? 0,
      (db.prepare('SELECT MAX(channel) AS n FROM comms_deleted WHERE member = ? AND agent = ?').get(member.person, agent) as { n: number | null }).n ?? 0);
    db.prepare(`INSERT INTO comms_threads (id, agent, member, conversation, project, opened, last, channel, first_id, first_hash, updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(place, agent, member.person, conversationId(agent, COMMS_VENUE, place), project, at, at, channel, id, hash, now.getTime());
    return threadOf(db.prepare('SELECT * FROM comms_threads WHERE id = ?').get(place) as ThreadRow);
  }).immediate());
  const seq = append(h.home, env, thread.id, { kind: 'message', from: member.person, id, text, hash, delivered: 'sending' }, now);
  bump(h.home);
  return { thread, seq, created: true };
}

/**
 * A member's message into their thread (POST /comms/<thread>/send), recorded on its way. The same id with the same
 * words answers the first message's seq (`repeat`) and where it is: delivered, on its way, or not delivered (after a
 * failure core recorded, or one cut off: settleThread); with other words, a 409.
 */
export function addMemberMessage(h: Household, env: NodeJS.ProcessEnv, t: Thread, raw: Record<string, unknown>, now: Date = new Date()): { seq: number; repeat: boolean; delivery: Delivery } {
  if (t.archived) return fail('conflict: that thread is archived: unarchive it first', 409);
  const id = checkId(raw.id);
  const text = checkText(raw.text);
  const hash = wordsHash(h.home, text);
  const look = () => withMessages(h.home, (db) => db.prepare("SELECT seq, hash, delivered FROM comms_messages WHERE thread = ? AND kind = 'message' AND id = ?").get(t.id, id) as { seq: number; hash: string | null; delivered: number | null } | undefined);
  let prior = look();
  if (prior) {
    if (prior.hash !== hash) return fail('conflict: that message id was already sent with other words', 409);
    if (prior.delivered === null) { settleThread(h.home, t.id, now); prior = look()!; }
    return { seq: prior.seq, repeat: true, delivery: deliveryOf(prior.delivered) };
  }
  if (!ageReady(h.home, env)) {
    append(h.home, env, t.id, { kind: 'error', from: 'loom', id: `e${randomBytes(6).toString('hex')}`, card: { error: 'no-age' } }, now);
    bump(h.home);
    return fail('no-age: loom keeps a thread\'s words encrypted, and the age programs aren\'t installed', 503);
  }
  const seq = append(h.home, env, t.id, { kind: 'message', from: t.member, id, text, hash, delivered: 'sending' }, now);
  withThreadsAt(h.home, (db) => touch(h.home, db, t.id, { last: nowIso(now) }, now));
  return { seq, repeat: false, delivery: 'sending' };
}

/**
 * Send again (t-1881): a message not delivered goes back on its way, once. True when this call took it; false when it
 * isn't one that failed (it's delivered, or already on its way again, from another tab or a second tap).
 */
export function resendMessage(h: Household, t: Thread, seq: number, now: Date = new Date()): boolean {
  const took = withMessages(h.home, (db) => db.prepare("UPDATE comms_messages SET delivered = NULL, sending_at = ? WHERE thread = ? AND seq = ? AND kind = 'message' AND delivered = 0").run(now.getTime(), t.id, seq).changes === 1);
  if (took) withThreadsAt(h.home, (db) => touch(h.home, db, t.id, { last_failed: 0 }, now));
  return took;
}

/**
 * What's recorded, made true of now (t-1881), for one thread or every one: a member's message on its way past
 * SEND_STALE_MS was cut off (its delivery's process is gone), so it's not delivered, with its error line; a thread
 * whose body the runtime hasn't said is at work for WORKING_STALE_MS isn't working. Each is written, never a guess
 * the app makes. Answers whether anything moved.
 */
export function settleThread(home: string, thread: string | null, now: Date = new Date()): boolean {
  let moved = false;
  if (existsSync(join(home, COMMS_DB))) {
    const cut = withMessages(home, (db) => (thread === null
      ? db.prepare("SELECT thread, seq FROM comms_messages WHERE kind = 'message' AND delivered IS NULL AND sending_at < ?").all(now.getTime() - SEND_STALE_MS)
      : db.prepare("SELECT thread, seq FROM comms_messages WHERE thread = ? AND kind = 'message' AND delivered IS NULL AND sending_at < ?").all(thread, now.getTime() - SEND_STALE_MS)) as Array<{ thread: string; seq: number }>);
    for (const c of cut) {
      const took = withMessages(home, (db) => db.prepare("UPDATE comms_messages SET delivered = 0, sending_at = NULL WHERE thread = ? AND seq = ? AND delivered IS NULL").run(c.thread, c.seq).changes === 1);
      if (!took) continue;
      append(home, process.env, c.thread, { kind: 'error', from: 'loom', id: `e${c.seq}`, card: { error: 'unreachable', reason: 'loom restarted while it was delivering it' } }, now);
      if (existsSync(join(home, 'household.db'))) withThreads(home, (db) => touch(home, db, c.thread, { last_failed: 1 }, now));
      moved = true;
    }
  }
  if (existsSync(join(home, 'household.db'))) {
    const beat = now.getTime() - WORKING_STALE_MS;
    const since = new Date(beat).toISOString();
    // A beat older than its window, or none at all (a thread from before the beat) and working since before it.
    const stale = withThreads(home, (db) => (thread === null
      ? db.prepare('SELECT id FROM comms_threads WHERE working_since IS NOT NULL AND (working_beat < ? OR (working_beat IS NULL AND working_since < ?))').all(beat, since)
      : db.prepare('SELECT id FROM comms_threads WHERE id = ? AND working_since IS NOT NULL AND (working_beat < ? OR (working_beat IS NULL AND working_since < ?))').all(thread, beat, since)) as Array<{ id: string }>);
    for (const r of stale) { withThreads(home, (db) => touch(home, db, r.id, { working_since: null, working_beat: null }, now)); moved = true; }
  }
  return moved;
}

/**
 * What a member's message is delivered with besides its words, fixed at its first try (t-1881): its time and the
 * thread's title then. Send again delivers exactly the same message, so core and the runtime answer it as the repeat
 * it is (one that reached the runtime after all is never refused as "another message", nor heard twice).
 */
export function deliveryFacts(h: Household, t: Thread, seq: number): { at: string; label: string } {
  return withMessages(h.home, (db) => {
    const r = db.prepare("SELECT at, delivery_json FROM comms_messages WHERE thread = ? AND seq = ? AND kind = 'message'").get(t.id, seq) as { at: string; delivery_json: string | null } | undefined;
    if (!r) return fail('not-found: no such message', 404);
    if (r.delivery_json) { try { const f = JSON.parse(r.delivery_json) as { at: string; label: string }; if (typeof f.at === 'string' && typeof f.label === 'string') return f; } catch { /* written again below */ } }
    const f = { at: r.at, label: t.title ?? 'New thread' };
    db.prepare('UPDATE comms_messages SET delivery_json = ? WHERE thread = ? AND seq = ?').run(JSON.stringify(f), t.id, seq);
    return f;
  });
}

/** A member message's words, to deliver again (Send again); null once swept. */
export async function memberWords(h: Household, env: NodeJS.ProcessEnv, t: Thread, seq: number): Promise<string | null> {
  const r = withMessages(h.home, (db) => db.prepare("SELECT text FROM comms_messages WHERE thread = ? AND seq = ? AND kind = 'message'").get(t.id, seq) as { text: Buffer | null } | undefined);
  return r?.text ? decrypt(h.home, env, r.text) : null;
}

/** What delivering a member's message came to: delivered or not, and an error message when it failed. */
export function recordDelivery(h: Household, t: Thread, seq: number, outcome: { delivered: boolean; body?: string; error?: { code: string; reason?: string } }, now: Date = new Date()): void {
  withMessages(h.home, (db) => db.prepare("UPDATE comms_messages SET delivered = ?, sending_at = NULL WHERE thread = ? AND seq = ? AND kind = 'message'").run(outcome.delivered ? 1 : 0, t.id, seq));
  if (outcome.error) {
    append(h.home, process.env, t.id, { kind: 'error', from: 'loom', id: `e${seq}`, card: { error: outcome.error.code, ...(outcome.error.reason ? { reason: outcome.error.reason.slice(0, 300) } : {}) } }, now);
  }
  withThreadsAt(h.home, (db) => touch(h.home, db, t.id, {
    last_failed: outcome.error ? 1 : 0,
    queued_since: outcome.delivered && outcome.body === 'queued' ? nowIso(now) : null,
  }, now));
}

/** Title (POST /comms/<thread>/title): the member's, 1-60 characters on one line. Answers the thread. */
export function setTitle(h: Household, t: Thread, raw: unknown, by: 'member' | 'agent', now: Date = new Date()): Thread {
  if (typeof raw !== 'string' || raw.trim().length < 1 || raw.length > MAX_TITLE || /[\r\n\u2028\u2029]/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return fail(`bad-input: a title is 1-${MAX_TITLE} characters on one line`);
  if (by === 'agent' && t.titled_by === 'member') return fail('conflict: the owner named this thread; the agent doesn\'t rename it', 409);
  const title = raw.trim();
  const out = withThreadsAt(h.home, (db) => { touch(h.home, db, t.id, { title, titled_by: by }, now); return threadOf(db.prepare('SELECT * FROM comms_threads WHERE id = ?').get(t.id) as ThreadRow); });
  // The title is the conversation's label too, so its page and the project hub show it (comms.md, "Title").
  try { setConversationLabel(agentDir(h, t.agent), t.conversation, title); } catch { /* no store yet: the next delivery carries it */ }
  return out;
}

export function setProject(h: Household, t: Thread, raw: unknown, now: Date = new Date()): Thread {
  let project: string | null = null;
  if (raw !== null) {
    if (typeof raw !== 'string' || !PROJECT.test(raw) || !liveProject(h, t.agent, raw)) return fail(`bad-input: ${String(raw)} isn't one of ${t.agent}'s live projects`);
    project = raw;
  }
  return withThreadsAt(h.home, (db) => { touch(h.home, db, t.id, { project }, now); return threadOf(db.prepare('SELECT * FROM comms_threads WHERE id = ?').get(t.id) as ThreadRow); });
}

export function setPinned(h: Household, t: Thread, pinned: boolean, now: Date = new Date()): void {
  withThreadsAt(h.home, (db) => db.transaction(() => {
    if (pinned && !t.pinned) {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM comms_threads WHERE member = ? AND pinned = 1').get(t.member) as { n: number }).n;
      if (n >= MAX_PINS) fail(`conflict: you can pin ${MAX_PINS} threads at most; unpin one first`, 409);
    }
    touch(h.home, db, t.id, { pinned: pinned ? 1 : 0 }, now);
  }).immediate());
}

export function setArchived(h: Household, t: Thread, archived: boolean, now: Date = new Date()): void {
  withThreadsAt(h.home, (db) => touch(h.home, db, t.id, { archived: archived ? nowIso(now) : null, working_since: archived ? null : t.working_since, ...(archived ? { working_beat: null } : {}) }, now));
}

/** The member read up to `seq` (never backwards), with the thread in front now. */
export function markRead(h: Household, t: Thread, seq: unknown, now: Date = new Date()): void {
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) fail('bad-input: seq is a whole number');
  withThreadsAt(h.home, (db) => touch(h.home, db, t.id, { read_seq: Math.max(t.read_seq, seq as number), in_front: now.getTime() }, now));
}

export function askStop(h: Household, t: Thread, now: Date = new Date()): void {
  withThreadsAt(h.home, (db) => touch(h.home, db, t.id, { stop: 1 }, now));
}

/** Delete a thread: its row and every message, words included, at once; a tombstone stays. */
export function deleteThread(h: Household, t: Thread, now: Date = new Date()): void {
  withMessages(h.home, (db) => db.prepare('DELETE FROM comms_messages WHERE thread = ?').run(t.id));
  withThreadsAt(h.home, (db) => db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO comms_deleted (id, member, agent, channel, at) VALUES (?, ?, ?, ?, ?)').run(t.id, t.member, t.agent, t.channel, nowIso(now));
    db.prepare('DELETE FROM comms_threads WHERE id = ?').run(t.id);
  }).immediate());
  dropRefs(h.home, t.id);
  bump(h.home);
}

// ─── The runtime's side: the core venue adapter and activity ───────────────────

/** The live thread a runtime call names: the agent's, by place; undefined when there's none (or it's archived). */
function liveThreadAt(home: string, agent: string, place: string): ThreadRow | undefined {
  if (!THREAD_ID.test(place)) return undefined;
  const r = withThreadsAt(home, (db) => db.prepare('SELECT * FROM comms_threads WHERE id = ?').get(place) as ThreadRow | undefined);
  return r && r.agent === agent && r.archived === null ? r : undefined;
}

export type AdapterAnswer = { ok: true; id?: string; brief?: string[]; readers?: string[]; stop?: true; trace?: ThreadTrace } | { ok: false; reason: string; permanent?: true };

/** One message of a thread as a trace shows it (t-1895): where it is and what it was, never its words. */
export interface TraceMessage {
  seq: number;
  at: string;
  kind: MessageKind;
  from: string;
  run: string | null;
  /** A member's message: delivered, failed (core recorded a failure) or still sending. */
  delivery?: Delivery;
  /** An error card: its code and its words from the fixed table (comms.md, section 7). */
  error?: { code: string; words: string };
  /** A tool card: its tool and state. */
  card?: { tool: string; state: string };
}

/** A thread's delivery record for a trace: its state and its newest messages' facts, no words. */
export interface ThreadTrace {
  thread: string;
  conversation: string;
  archived: string | null;
  working_since: string | null;
  queued_since: string | null;
  last_failed: boolean;
  messages: TraceMessage[];
}

/** The newest TRACE_MAX messages a trace carries. */
export const TRACE_MAX = 100;

/** A thread's trace facts (comms.md, "Tracing a reply"): what the runtime's `trace` op answers, and nothing of the words. */
export function traceOf(home: string, r: ThreadRow): ThreadTrace {
  const rows = existsSync(join(home, COMMS_DB))
    ? (withMessages(home, (db) => db.prepare('SELECT seq, at, kind, sender, run, delivered, card_json FROM comms_messages WHERE thread = ? ORDER BY seq DESC LIMIT ?').all(r.id, TRACE_MAX)) as Array<Omit<MsgRow, 'text' | 'id' | 'hash'>>).reverse()
    : [];
  const messages = rows.map((m): TraceMessage => {
    const card = m.card_json ? JSON.parse(m.card_json) as Record<string, unknown> : null;
    const out: TraceMessage = { seq: m.seq, at: m.at, kind: m.kind as MessageKind, from: m.sender, run: m.run };
    if (m.kind === 'message') out.delivery = deliveryOf(m.delivered);
    if (m.kind === 'error') { const code = String(card?.error ?? ''); out.error = { code, words: errorWords(code, label(r.agent), typeof card?.reason === 'string' ? card.reason : undefined) }; }
    if (m.kind === 'card') out.card = { tool: String(card?.tool ?? ''), state: String(card?.state ?? '') };
    return out;
  });
  return { thread: r.id, conversation: r.conversation, archived: r.archived, working_since: r.working_since, queued_since: r.queued_since, last_failed: r.last_failed === 1, messages };
}

/**
 * POST /api/loom/comms/adapter (comms.md, section 1): the runtime's post, describe and status for venue `loom`, the
 * same three calls a piece adapter answers on its send argv, with the same answers.
 */
export function adapterCall(h: Household, env: NodeJS.ProcessEnv, raw: Record<string, unknown>, now: Date = new Date()): AdapterAnswer {
  const { op, place, agent } = raw;
  if (op !== 'post' && op !== 'describe' && op !== 'status' && op !== 'trace') return fail('bad-input: op is post, describe, status or trace');
  if (typeof agent !== 'string' || !h.agents.includes(agent)) return fail('bad-input: agent names one of this household\'s agents');
  if (typeof place !== 'string') return fail('bad-input: place is a thread');
  // trace (t-1895): the thread's delivery facts for the runtime's reply trace, read only. An archived thread too (its
  // record is still the agent's); never one of another agent's, and never its words.
  if (op === 'trace') {
    if (!THREAD_ID.test(place)) return { ok: false, reason: `${place} isn't a thread`, permanent: true };
    const t = withThreadsAt(h.home, (db) => db.prepare('SELECT * FROM comms_threads WHERE id = ?').get(place) as ThreadRow | undefined);
    if (!t || t.agent !== agent) return { ok: false, reason: `${place} isn't a thread of ${agent}'s (deleted, or never one)`, permanent: true };
    return { ok: true, trace: traceOf(h.home, t) };
  }
  const r = liveThreadAt(h.home, agent, place);
  if (op === 'post') {
    const text = raw.text;
    if (!r) return { ok: false, reason: `${place} isn't a live thread of ${agent}'s (archived, deleted, or never one)`, permanent: true };
    if (typeof text !== 'string' || text.length < 1) return { ok: false, reason: 'the reply is empty', permanent: true };
    if (text.length > MAX_TEXT) return { ok: false, reason: `the reply is over ${MAX_TEXT} characters`, permanent: true };
    if (!ageReady(h.home, env)) {
      append(h.home, env, r.id, { kind: 'error', from: 'loom', id: `e${randomBytes(6).toString('hex')}`, card: { error: 'post-failed', reason: 'the age program is missing, so loom couldn\'t keep it' } }, now);
      bump(h.home);
      return { ok: false, reason: 'the age programs aren\'t installed, so loom can\'t keep the reply' };
    }
    // `on`: the harness a switched body answers on (loom-box t-1907: "Codex" while the agent's own account is out of
    // quota), kept on the reply's card for the comm screen's channel line. A short word, or nothing.
    const on = typeof raw.on === 'string' && HARNESS_WORD.test(raw.on) ? raw.on : undefined;
    const seq = append(h.home, env, r.id, { kind: 'reply', from: agent, id: `r${randomBytes(6).toString('hex')}`, text, ...(typeof raw.run === 'string' ? { run: raw.run } : {}), ...(on ? { card: { on } } : {}) }, now);
    withThreadsAt(h.home, (db) => touch(h.home, db, r.id, { last: nowIso(now), queued_since: null, last_failed: 0 }, now));
    return { ok: true, id: String(seq) };
  }
  if (op === 'describe') {
    if (!r) return { ok: false, reason: `${place} isn't a live thread of ${agent}'s`, permanent: true };
    const name = r.member[0].toUpperCase() + r.member.slice(1);
    // Work made here shows in the thread's panel by its source (comms.md, "Made here"); a house's piece calls carry no
    // environment, so the brief names the conversation itself, without naming any piece.
    const lines = [`A private thread in loom's app with your owner, ${name}. Only they read it. They can see your tool use as you work. Work you record here can name this conversation as its source: conversation:${r.conversation}.`];
    if (r.project) lines.push(`The thread is filed under the project ${r.project}.`);
    if (!r.title) lines.push('Give the thread a short title once you know what it\'s about: call comms_title.');
    return { ok: true, brief: lines, readers: [r.member] };
  }
  // status
  const status = raw.status;
  if (status !== 'working' && status !== 'done') return fail('bad-input: status is working or done');
  if (!r) return { ok: true };
  const stop = r.stop === 1;
  // Its turn over with nothing sent (t-1900): said in the thread, once per run, not left as silence.
  if (status === 'done' && raw.replied === false && typeof raw.run === 'string' && RUN_ID.test(raw.run)) {
    const id = `noreply-${raw.run}`;
    const said = withMessages(h.home, (db) => db.prepare("SELECT 1 FROM comms_messages WHERE thread = ? AND kind = 'error' AND id = ?").get(r.id, id));
    if (!said) { append(h.home, env, r.id, { kind: 'error', from: 'loom', id, run: raw.run, card: { error: 'no-reply' } }, now); bump(h.home); }
  }
  withThreadsAt(h.home, (db) => touch(h.home, db, r.id, {
    working_since: status === 'working' ? (r.working_since ?? nowIso(now)) : null,
    working_beat: status === 'working' ? now.getTime() : null,
    ...(status === 'working' ? { queued_since: null } : {}),
    ...(stop ? { stop: 0 } : {}),
  }, now));
  return stop ? { ok: true, stop: true } : { ok: true };
}

const TOOL = /^[A-Za-z0-9_.:\-]{1,64}$/;
/** A runtime's run id, as `status: done, replied: false` names it (loom-box: run-<hex>); up to 128, as activity's. */
const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** A reply's `on` (comms.md, the adapter route): a harness's name in one short word, e.g. "Codex". Else dropped. */
export const HARNESS_WORD = /^[A-Za-z][A-Za-z0-9.-]{0,23}$/;
const PRINTABLE_LINE = /^[^\x00-\x1f\x7f\u2028\u2029]*$/;

/**
 * POST /api/loom/comms/activity {conversation, run, cards}: the runtime's tool cards for a `loom` conversation's live
 * thread. A card's id the thread already has updates its state; a new one is a message. Refused whole on any bad card.
 */
export function postActivity(h: Household, env: NodeJS.ProcessEnv, raw: Record<string, unknown>, now: Date = new Date()): { ok: true; added: number; updated: number } {
  const { conversation, run, cards } = raw;
  if (typeof conversation !== 'string' || !/^cv-[0-9a-f]{12}$/.test(conversation)) return fail('bad-input: conversation is a cv- id');
  if (typeof run !== 'string' || !run || run.length > 128) return fail('bad-input: run is the body run');
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > MAX_CARDS) return fail(`bad-input: cards is a list of 1-${MAX_CARDS}`);
  const checked = cards.map((c, i) => {
    const o = c as Record<string, unknown>;
    if (!o || typeof o !== 'object') return fail(`bad-input: card ${i} isn't an object`);
    const keys = Object.keys(o).filter((k) => !['id', 'at', 'tool', 'summary', 'state'].includes(k));
    if (keys.length) return fail(`bad-input: card ${i} has unknown keys: ${keys.join(', ')}`);
    if (typeof o.id !== 'string' || !/^[A-Za-z0-9_.:\-]{1,80}$/.test(o.id)) return fail(`bad-input: card ${i}'s id`);
    if (typeof o.tool !== 'string' || !TOOL.test(o.tool)) return fail(`bad-input: card ${i}'s tool`);
    if (typeof o.summary !== 'string' || o.summary.length < 1 || o.summary.length > MAX_SUMMARY || !PRINTABLE_LINE.test(o.summary)) return fail(`bad-input: card ${i}'s summary is 1-${MAX_SUMMARY} printable characters on one line`);
    if (o.state !== 'running' && o.state !== 'done' && o.state !== 'failed') return fail(`bad-input: card ${i}'s state is running, done or failed`);
    return { id: o.id, tool: o.tool, summary: o.summary, state: o.state as CardState };
  });
  const r = withThreadsAt(h.home, (db) => db.prepare('SELECT * FROM comms_threads WHERE conversation = ?').get(conversation) as ThreadRow | undefined);
  if (!r || r.archived !== null) return fail('conflict: that conversation has no live thread', 409);
  let added = 0, updated = 0;
  for (const c of checked) {
    const prior = withMessages(h.home, (db) => db.prepare("SELECT seq, card_json FROM comms_messages WHERE thread = ? AND kind = 'card' AND id = ?").get(r.id, c.id) as { seq: number; card_json: string } | undefined);
    if (prior) {
      const card = { ...JSON.parse(prior.card_json) as Record<string, unknown>, state: c.state };
      withMessages(h.home, (db) => db.prepare('UPDATE comms_messages SET card_json = ? WHERE thread = ? AND seq = ?').run(JSON.stringify(card), r.id, prior.seq));
      updated++;
    } else {
      append(h.home, env, r.id, { kind: 'card', from: r.agent, id: c.id, text: c.summary, card: { tool: c.tool, state: c.state }, run }, now);
      added++;
    }
  }
  withThreadsAt(h.home, (db) => touch(h.home, db, r.id, { working_since: r.working_since ?? nowIso(now), working_beat: now.getTime(), queued_since: null }, now));
  return { ok: true, added, updated };
}

// ─── The sweep ─────────────────────────────────────────────────────────────────

/**
 * Every message's words older than `days` go (the row stays), hourly and at daemon start; a queued message with no
 * working for BUSY_MS gains its busy line once. Answers how many messages lost their words.
 */
export function sweepComms(h: Household, now: Date = new Date()): number {
  const days = h.commsDays ?? COMMS_DAYS_DEFAULT;
  let swept = 0;
  if (existsSync(join(h.home, COMMS_DB))) {
    swept = withMessages(h.home, (db) => db.prepare('UPDATE comms_messages SET text = NULL WHERE text IS NOT NULL AND at < ?').run(new Date(now.getTime() - days * DAY_MS).toISOString()).changes);
  }
  if (existsSync(join(h.home, 'household.db'))) {
    const late = withThreadsAt(h.home, (db) => db.prepare('SELECT * FROM comms_threads WHERE queued_since IS NOT NULL AND queued_since < ?').all(new Date(now.getTime() - BUSY_MS).toISOString()) as ThreadRow[]);
    for (const r of late) {
      // A body that couldn't start isn't busy (t-1918): the runtime retries it, and the thread says that, with its trace.
      append(h.home, process.env, r.id, { kind: 'error', from: 'loom', id: `busy${now.getTime()}`, card: { error: r.last_failed ? 'start-retry' : 'busy' } }, now);
      withThreadsAt(h.home, (db) => touch(h.home, db, r.id, { queued_since: null }, now));
    }
  }
  settleThread(h.home, null, now);
  return swept;
}

/**
 * The runtime paused a `loom` conversation as a loop (its `deferred` note turn, delivery.mjs loopNote): the thread
 * says so in words (comms.md, section 7). Called by core's turn write.
 */
export function noteLoopPause(home: string, conversation: string, now: Date = new Date()): void {
  const t = threadOfConversation(home, conversation);
  if (!t) return;
  append(home, process.env, t.id, { kind: 'error', from: 'loom', id: `loop${now.getTime()}`, card: { error: 'loop' } }, now);
  withThreads(home, (db) => touch(home, db, t.id, { last_failed: 1, working_since: null, working_beat: null }, now));
}

/** The thread for a conversation (the title tool, the hub): undefined when it has none. */
export function threadOfConversation(home: string, conversation: string): Thread | undefined {
  if (!existsSync(join(home, 'household.db'))) return undefined;
  const r = withThreadsAt(home, (db) => db.prepare('SELECT * FROM comms_threads WHERE conversation = ?').get(conversation) as ThreadRow | undefined);
  return r ? threadOf(r) : undefined;
}

/**
 * The thread of `agent`'s own loom conversation `conversation`: only when the thread is that agent's and the id is
 * exactly its conversation over agent · loom · place. The agent comes from the caller's own context (the MCP server's
 * agent dir), never from what it sends; a conversation id named at identity is just a claim. Within one agent, that
 * claim is trusted as conversation_digest trusts it: the MCP session can't see the runtime's body key, so a body that
 * names another of its own agent's threads at identity reaches that one. No agent ever reaches another agent's.
 */
export function threadOfAgentConversation(home: string, agent: string, conversation: string): Thread | undefined {
  const t = threadOfConversation(home, conversation);
  return t && t.agent === agent && conversationId(agent, COMMS_VENUE, t.id) === conversation ? t : undefined;
}

/** The conversations of `agent`'s threads filed under project `slug` (the hub counts them, comms.md "Project"). */
export function filedThreads(home: string, agent: string, slug: string): string[] {
  if (!existsSync(join(home, 'household.db'))) return [];
  return withThreads(home, (db) => (db.prepare('SELECT conversation FROM comms_threads WHERE agent = ? AND project = ? ORDER BY last DESC LIMIT 200').all(agent, slug) as Array<{ conversation: string }>).map((r) => r.conversation));
}

/**
 * comms_title (an MCP tool, comms.md "Title"): a body names its own thread, once it knows what it's about. Only in a
 * `loom` conversation; never over the member's own name for it.
 */
export function titleFromAgent(home: string, agent: string, conversation: string, title: unknown, now: Date = new Date()): Thread {
  const t = threadOfAgentConversation(home, agent, conversation);
  if (!t) return fail('comms_title names a Comms thread, and this conversation isn\'t one');
  const h = householdAt(home);
  return setTitle(h, t, title, 'agent', now);
}

/** How many messages comms_thread answers at most, and by default. */
export const AGENT_READ_MAX = 100;
export const AGENT_READ_DEFAULT = 30;

/**
 * comms_thread (an MCP tool, comms.md "An agent reading its own threads", t-1896): a body reads the messages of a Comms
 * thread its own agent is the agent of, as the thread's member sees them (words for 14 days, then none; error cards in
 * their fixed words). Which agent is the server's own agent dir, never what the caller sends: with no `thread`, the
 * thread of the conversation given to identity; with one, only a thread whose agent is that same agent. Another agent's
 * thread, a deleted one, or one that never existed is the same refusal. Read only.
 */
export async function agentThreadRead(home: string, env: NodeJS.ProcessEnv, agent: string, at: { conversation?: string; thread?: unknown; before?: unknown; limit?: unknown }): Promise<{ thread: { id: string; title: string | null; archived: string | null; state: ReturnType<typeof stateOf> }; messages: Message[] }> {
  const refuse = (): never => fail('comms_thread reads a Comms thread of yours: that isn\'t one', 403);
  let t: Thread | undefined;
  if (at.thread !== undefined) {
    if (typeof at.thread !== 'string' || !THREAD_ID.test(at.thread) || !existsSync(join(home, 'household.db'))) return refuse();
    const r = withThreadsAt(home, (db) => db.prepare('SELECT * FROM comms_threads WHERE id = ?').get(at.thread) as ThreadRow | undefined);
    t = r && r.agent === agent ? threadOf(r) : undefined;
  } else if (at.conversation) {
    t = threadOfAgentConversation(home, agent, at.conversation);
  } else {
    return fail('comms_thread needs a thread: name one of yours, or call identity with this body\'s conversation first');
  }
  if (!t) return refuse();
  const h = householdAt(home);
  if (!h.agents.includes(agent)) return refuse();
  const limit = typeof at.limit === 'number' && Number.isInteger(at.limit) && at.limit >= 1 ? Math.min(at.limit, AGENT_READ_MAX) : AGENT_READ_DEFAULT;
  const before = typeof at.before === 'number' && Number.isInteger(at.before) && at.before > 0 ? at.before : undefined;
  const all = existsSync(join(home, COMMS_DB)) ? await messagesOf(h, env, t, before !== undefined ? { before } : {}) : [];
  // The word rule at read time too: the sweep runs on the daemon's clock, and a stdio server reads with no daemon up.
  const cutoff = Date.now() - (h.commsDays ?? COMMS_DAYS_DEFAULT) * DAY_MS;
  const kept = all.slice(-limit).map((m) => (m.kind !== 'error' && m.text !== null && Date.parse(m.at) < cutoff ? { ...m, text: null } : m));
  return { thread: { id: t.id, title: t.title, archived: t.archived, state: stateOf(t) }, messages: kept };
}

/**
 * What of a thread its app draws as state, as one string (t-1881): the body at work, queued, a failure, its title, and
 * how many of its messages are still on their way and how many steps still running. A live stream tells its app when
 * this moves; a read mark (which moves the row too) doesn't.
 */
export function threadState(home: string, thread: string): string {
  if (!existsSync(join(home, 'household.db'))) return '';
  const r = withThreads(home, (db) => db.prepare('SELECT working_since, queued_since, last_failed, title, archived FROM comms_threads WHERE id = ?').get(thread) as Record<string, unknown> | undefined);
  if (!r) return '';
  const m = existsSync(join(home, COMMS_DB)) ? withMessages(home, (db) => db.prepare(`SELECT
      SUM(CASE WHEN kind = 'message' AND delivered IS NULL THEN 1 ELSE 0 END) AS sending,
      SUM(CASE WHEN kind = 'card' AND card_json LIKE '%"state":"running"%' THEN 1 ELSE 0 END) AS running
    FROM comms_messages WHERE thread = ?`).get(thread) as { sending: number | null; running: number | null }) : { sending: 0, running: 0 };
  return JSON.stringify([r.working_since, r.queued_since, r.last_failed, r.title, r.archived, m.sending ?? 0, m.running ?? 0]);
}

/** Threads whose rows moved since `ms` (the live streams' cross-process read). */
export function movedSince(home: string, ms: number): Array<{ id: string; member: string; updated: number }> {
  if (!existsSync(join(home, 'household.db'))) return [];
  return withThreadsAt(home, (db) => db.prepare('SELECT id, member, updated FROM comms_threads WHERE updated > ?').all(ms) as Array<{ id: string; member: string; updated: number }>);
}

/** A thread's state for the app: is the body working, did the last delivery fail, is it queued. */
export function stateOf(t: Thread): { working: boolean; working_since: string | null; queued: boolean; failed: boolean } {
  return { working: t.working_since !== null, working_since: t.working_since, queued: t.queued_since !== null, failed: t.last_failed };
}
