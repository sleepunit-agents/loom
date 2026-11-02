/**
 * Conversations (docs/specs/conversations.md): what happened, in any venue, as
 * core records in each agent's memory database.
 *
 *   conversations          one per agent · venue · place: who, where, when
 *   conversation_turns     per-turn metadata (never text), seq assigned here
 *   conversation_days      a folded UTC day: counts, median latency, outcomes
 *   conversation_digests   the agent's own summary of one body run
 *
 * This module is the store and its rules. It never sees text: a turn write
 * with any key it doesn't know (text included) is rejected, and a digest is
 * the agent's own words, never compared with anything. Venues, renders and
 * who may call what are src/conversations.ts.
 *
 * Like the tape and proposals, it opens memories.db directly (plain SQL, no
 * embedder), so a turn write or the boot tape stays cheap.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveSqliteDbPath } from '../config.js';

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type TurnKind = 'message' | 'reply' | 'action' | 'wake' | 'note' | 'refused';
export const TURN_KINDS: readonly TurnKind[] = ['message', 'reply', 'action', 'wake', 'note', 'refused'];
/** The agent's own turns: they carry `run`, `outcome`, and optionally `model` and `harness`. */
export const AGENT_TURN_KINDS: readonly TurnKind[] = ['reply', 'action', 'note'];
export type Outcome = 'answered' | 'progressed' | 'deferred' | 'failed' | 'none';
export const OUTCOMES: readonly Outcome[] = ['answered', 'progressed', 'deferred', 'failed', 'none'];

export type From =
  | { kind: 'person'; slug: string }
  | { kind: 'agent'; id: string }
  | { kind: 'schedule' }
  | { kind: 'unknown' };

/** What a turn writer sends (conversations.md, "The conversation record"). Nothing else is accepted. */
export interface TurnInput {
  venue: string;
  place: string;
  at: string;
  from: From;
  kind: TurnKind;
  label?: string;
  run?: string;
  model?: string;
  harness?: string;
  outcome?: Outcome;
}

export interface Turn extends TurnInput {
  conversation: string;
  seq: number;
  latency_ms?: number;
}

export interface Conversation {
  id: string;
  agent: string;
  venue: string;
  place: string;
  label: string | null;
  people: string[];
  agents: string[];
  /** The union of its digests' projects (slugs), computed at read. */
  projects: string[];
  started: string;
  last: string;
}

export interface DigestInput {
  summary: string;
  asks?: string[];
  decisions?: string[];
  tasks?: string[];
  projects?: string[];
  needs_owner?: string | null;
}

export interface Digest {
  id: string;
  conversation: string;
  run: string;
  at: string;
  summary: string;
  asks: string[];
  decisions: string[];
  tasks: string[];
  projects: string[];
  needs_owner: string | null;
}

export interface DayRow {
  conversation: string;
  /** YYYY-MM-DD, UTC. */
  day: string;
  /** Turn counts by kind. */
  counts: Record<string, number>;
  /** Median latency_ms of the day's replies that had one; null when none did. */
  median_latency_ms: number | null;
  /** {model: {outcome: count}} over the agent's turns ("unknown" when a turn named no model). */
  outcomes: Record<string, Record<string, number>>;
}

/** A rejection the caller made: its message names what's wrong. HTTP answers 400. */
export class ConversationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ConversationError';
  }
}
function fail(m: string, status = 400): never { throw new ConversationError(m, status); }

// ─── Limits ─────────────────────────────────────────────────────────────────

export const MAX_PLACE = 200;
export const MAX_LABEL = 80;
export const MAX_PEOPLE = 32;
export const MAX_AGENTS = 16;
export const MAX_SUMMARY = 600;
export const MAX_DIGEST_PROJECTS = 4;
export const MAX_ASKS = 8;
export const MAX_ASK = 200;
export const MAX_TASKS = 16;
export const MAX_TASK = 64;
export const MAX_NEEDS_OWNER = 200;
/** A run id, a model and a harness: short printable strings. */
export const MAX_RUN = 128;
export const MAX_MODEL = 120;
/** `conversations` returns at most this many. */
export const LIST_MAX = 100;
/** A day folds once its every turn is older than this. */
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

const VENUE = /^[a-z][a-z0-9-]{0,31}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;
const CONV_ID = /^cv-[0-9a-f]{12}$/;

const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
/** "cv-" + first 12 hex of SHA-256 over "agent\0venue\0place". */
export const conversationId = (agent: string, venue: string, place: string): string => `cv-${sha12(`${agent}\0${venue}\0${place}`)}`;
/** "dg-" + 12 hex of SHA-256 over "conversation id\0run id". */
export const digestId = (conversation: string, run: string): string => `dg-${sha12(`${conversation}\0${run}`)}`;
export const isConversationId = (s: unknown): s is string => typeof s === 'string' && CONV_ID.test(s);
export const isRunId = (s: unknown): s is string => typeof s === 'string' && RUN.test(s);

// ─── Schema ─────────────────────────────────────────────────────────────────

export const CONVERSATION_TABLES = ['conversations', 'conversation_turns', 'conversation_days', 'conversation_digests'] as const;

/** The four tables, idempotently. The `conversations` migration and openConversations both run it. */
export function createConversationTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      agent       TEXT NOT NULL,
      venue       TEXT NOT NULL,
      place       TEXT NOT NULL,
      label       TEXT,
      people_json TEXT NOT NULL DEFAULT '[]',
      agents_json TEXT NOT NULL DEFAULT '[]',
      started     TEXT NOT NULL,
      last        TEXT NOT NULL,
      last_seq    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_last ON conversations(last);
    CREATE TABLE IF NOT EXISTS conversation_turns (
      conversation TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      at           TEXT NOT NULL,
      from_json    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      run          TEXT,
      latency_ms   INTEGER,
      model        TEXT,
      harness      TEXT,
      outcome      TEXT,
      writer       TEXT NOT NULL,
      PRIMARY KEY (conversation, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_turns_at ON conversation_turns(at);
    CREATE TABLE IF NOT EXISTS conversation_days (
      conversation      TEXT NOT NULL,
      day               TEXT NOT NULL,
      counts_json       TEXT NOT NULL,
      median_latency_ms INTEGER,
      outcomes_json     TEXT NOT NULL,
      PRIMARY KEY (conversation, day)
    );
    CREATE TABLE IF NOT EXISTS conversation_digests (
      id             TEXT PRIMARY KEY,
      conversation   TEXT NOT NULL,
      run            TEXT NOT NULL,
      at             TEXT NOT NULL,
      summary        TEXT NOT NULL,
      asks_json      TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      tasks_json     TEXT NOT NULL,
      projects_json  TEXT NOT NULL,
      needs_owner    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_digests_conv ON conversation_digests(conversation, at);
    CREATE INDEX IF NOT EXISTS idx_conversation_digests_at ON conversation_digests(at);
  `);
}

export function hasTable(db: Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/** memories.db for writing, with the tables there. */
export function openConversations(contextDir: string): Database {
  const db = new BetterSqlite3(resolveSqliteDbPath(contextDir));
  db.pragma('busy_timeout = 5000');
  if (!CONVERSATION_TABLES.every((t) => hasTable(db, t))) createConversationTables(db);
  return db;
}

/** memories.db read-only, or null when there's no store or no conversations yet. */
export function openConversationsReadonly(contextDir: string): Database | null {
  const path = resolveSqliteDbPath(contextDir);
  if (!existsSync(path)) return null;
  const db = new BetterSqlite3(path, { readonly: true });
  db.pragma('busy_timeout = 5000');
  if (!hasTable(db, 'conversations')) { db.close(); return null; }
  return db;
}

function withDb<T>(contextDir: string, f: (db: Database) => T): T {
  const db = openConversations(contextDir);
  try { return f(db); } finally { db.close(); }
}

function withReadonly<T>(contextDir: string, empty: T, f: (db: Database) => T): T {
  const db = openConversationsReadonly(contextDir);
  if (!db) return empty;
  try { return f(db); } finally { db.close(); }
}

// ─── Validation ─────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const TURN_KEYS = ['venue', 'place', 'at', 'from', 'kind', 'label', 'run', 'model', 'harness', 'outcome'] as const;

function shortString(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string' || !v.length || v.length > max || !PRINTABLE.test(v)) fail(`${what} is 1-${max} printable characters`);
  return v as string;
}

function parseFrom(v: unknown): From {
  if (!isObject(v)) return fail('from is {kind: person, slug}, {kind: agent, id}, {kind: schedule} or {kind: unknown}');
  const keys = Object.keys(v).sort().join(',');
  if (v.kind === 'person' && keys === 'kind,slug' && typeof v.slug === 'string' && SLUG.test(v.slug) && v.slug.length <= 80) return { kind: 'person', slug: v.slug };
  if (v.kind === 'agent' && keys === 'id,kind' && typeof v.id === 'string' && AGENT_ID.test(v.id)) return { kind: 'agent', id: v.id };
  if ((v.kind === 'schedule' || v.kind === 'unknown') && keys === 'kind') return { kind: v.kind };
  return fail('from is {kind: person, slug}, {kind: agent, id}, {kind: schedule} or {kind: unknown}, with no other keys');
}

/**
 * A turn as a writer sent it, checked: exactly the known keys, never text. `agent` is the
 * conversation's agent: the agent's own turns (reply, action, note) must come from it.
 */
export function parseTurn(raw: unknown, agent: string): TurnInput {
  if (!isObject(raw)) return fail('a turn is a JSON object');
  if ('text' in raw) fail('a turn carries no text: its words go to the audit log, never the record');
  const bad = Object.keys(raw).find((k) => !(TURN_KEYS as readonly string[]).includes(k));
  if (bad !== undefined) fail(`a turn has no key ${JSON.stringify(bad)} (it has ${TURN_KEYS.join(', ')})`);
  if (typeof raw.venue !== 'string' || !VENUE.test(raw.venue)) fail('venue is a venue name: lowercase letters, digits and dashes, at most 32');
  if (typeof raw.place !== 'string' || !raw.place.length || raw.place.length > MAX_PLACE) fail(`place is 1-${MAX_PLACE} characters`);
  if (typeof raw.at !== 'string' || !ISO_UTC.test(raw.at) || Number.isNaN(Date.parse(raw.at))) fail('at is an ISO-8601 UTC time (…Z)');
  const from = parseFrom(raw.from);
  if (!TURN_KINDS.includes(raw.kind as TurnKind)) fail(`kind is one of ${TURN_KINDS.join(', ')}`);
  const kind = raw.kind as TurnKind;
  const turn: TurnInput = { venue: raw.venue as string, place: raw.place as string, at: raw.at as string, from, kind };
  if (raw.label !== undefined) turn.label = shortString(raw.label, MAX_LABEL, 'label');
  const own = AGENT_TURN_KINDS.includes(kind);
  if (own) {
    if (from.kind !== 'agent' || from.id !== agent) fail(`a ${kind} is the agent's own turn: from is {kind: agent, id: ${agent}}`);
    if (!isRunId(raw.run)) fail(`a ${kind} names its run: 1-${MAX_RUN} of letters, digits and . _ : @ -`);
    turn.run = raw.run as string;
    if (!OUTCOMES.includes(raw.outcome as Outcome)) fail(`a ${kind} has an outcome: ${OUTCOMES.join(', ')}`);
    turn.outcome = raw.outcome as Outcome;
    if (raw.model !== undefined) turn.model = shortString(raw.model, MAX_MODEL, 'model');
    if (raw.harness !== undefined) turn.harness = shortString(raw.harness, MAX_MODEL, 'harness');
  } else {
    for (const k of ['run', 'model', 'harness', 'outcome'] as const) {
      if (raw[k] !== undefined) fail(`${k} is only on the agent's own turns (${AGENT_TURN_KINDS.join(', ')}), not a ${kind}`);
    }
  }
  return turn;
}

const dayOf = (iso: string) => new Date(iso).toISOString().slice(0, 10);

// ─── Turns ──────────────────────────────────────────────────────────────────

/**
 * Record one turn in agent · venue · place, creating the conversation on its first.
 * `writer` is who wrote it (a role string), kept so the audit log can check that the
 * entry's writer is the turn's. Answers the conversation's id and the turn's seq.
 */
export function recordTurn(contextDir: string, agent: string, turn: TurnInput, writer: string): { conversation: string; seq: number; latency_ms?: number } {
  const id = conversationId(agent, turn.venue, turn.place);
  return withDb(contextDir, (db) => db.transaction(() => {
    const day = dayOf(turn.at);
    if (db.prepare('SELECT 1 FROM conversation_days WHERE conversation = ? AND day = ?').get(id, day)) {
      fail(`${day} is already folded for this conversation (older than ${RETENTION_DAYS} days): a folded day takes no more turns`, 409);
    }
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConvRow | undefined;
    const people = row ? JSON.parse(row.people_json) as string[] : [];
    const agents = row ? JSON.parse(row.agents_json) as string[] : [];
    // Past the caps they aren't added; the turn still counts.
    if (turn.from.kind === 'person' && !people.includes(turn.from.slug) && people.length < MAX_PEOPLE) people.push(turn.from.slug);
    if (turn.from.kind === 'agent' && turn.from.id !== agent && !agents.includes(turn.from.id) && agents.length < MAX_AGENTS) agents.push(turn.from.id);
    const seq = (row?.last_seq ?? 0) + 1;
    let latency: number | undefined;
    if (turn.kind === 'reply') {
      // From the earliest message with no reply after it: the oldest still waiting.
      const lastReply = (db.prepare("SELECT MAX(seq) AS s FROM conversation_turns WHERE conversation = ? AND kind = 'reply'").get(id) as { s: number | null }).s ?? 0;
      const waiting = db.prepare("SELECT at FROM conversation_turns WHERE conversation = ? AND kind = 'message' AND seq > ? ORDER BY seq LIMIT 1").get(id, lastReply) as { at: string } | undefined;
      if (waiting) latency = Math.max(0, Date.parse(turn.at) - Date.parse(waiting.at));
    }
    if (row) {
      db.prepare('UPDATE conversations SET label = ?, people_json = ?, agents_json = ?, started = ?, last = ?, last_seq = ? WHERE id = ?').run(
        turn.label ?? row.label, JSON.stringify(people), JSON.stringify(agents),
        turn.at < row.started ? turn.at : row.started, turn.at > row.last ? turn.at : row.last, seq, id);
    } else {
      db.prepare('INSERT INTO conversations (id, agent, venue, place, label, people_json, agents_json, started, last, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, agent, turn.venue, turn.place, turn.label ?? null, JSON.stringify(people), JSON.stringify(agents), turn.at, turn.at, seq);
    }
    db.prepare(`INSERT INTO conversation_turns (conversation, seq, at, from_json, kind, run, latency_ms, model, harness, outcome, writer)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, seq, turn.at, JSON.stringify(turn.from), turn.kind, turn.run ?? null, latency ?? null, turn.model ?? null, turn.harness ?? null, turn.outcome ?? null, writer);
    return { conversation: id, seq, ...(latency !== undefined ? { latency_ms: latency } : {}) };
  }).immediate());
}

interface ConvRow { id: string; agent: string; venue: string; place: string; label: string | null; people_json: string; agents_json: string; started: string; last: string; last_seq: number }
interface TurnRow { conversation: string; seq: number; at: string; from_json: string; kind: string; run: string | null; latency_ms: number | null; model: string | null; harness: string | null; outcome: string | null; writer: string }

function turnOf(r: TurnRow, c: { venue: string; place: string }): Turn {
  return {
    conversation: r.conversation, seq: r.seq, venue: c.venue, place: c.place, at: r.at, from: JSON.parse(r.from_json) as From, kind: r.kind as TurnKind,
    ...(r.run !== null ? { run: r.run } : {}), ...(r.latency_ms !== null ? { latency_ms: r.latency_ms } : {}),
    ...(r.model !== null ? { model: r.model } : {}), ...(r.harness !== null ? { harness: r.harness } : {}), ...(r.outcome !== null ? { outcome: r.outcome as Outcome } : {}),
  };
}

/** A conversation's turns still held (not folded), in seq order. */
export function turnsOf(contextDir: string, conversation: string): Turn[] {
  return withReadonly(contextDir, [], (db) => {
    const c = db.prepare('SELECT venue, place FROM conversations WHERE id = ?').get(conversation) as { venue: string; place: string } | undefined;
    if (!c) return [];
    return (db.prepare('SELECT * FROM conversation_turns WHERE conversation = ? ORDER BY seq').all(conversation) as TurnRow[]).map((r) => turnOf(r, c));
  });
}

/** Who wrote turn (conversation, seq), or undefined when there's no such turn. The audit log's order check. */
export function turnWriter(contextDir: string, conversation: string, seq: number): string | undefined {
  return withReadonly(contextDir, undefined, (db) =>
    (db.prepare('SELECT writer FROM conversation_turns WHERE conversation = ? AND seq = ?').get(conversation, seq) as { writer: string } | undefined)?.writer);
}

/** One held turn with its conversation's agent, venue and place, and its writer: what the audit log and review read. */
export interface TurnRecord extends Turn { agent: string; writer: string }

/** Turn (conversation, seq) as held, or undefined when there's no such turn (never written, or folded). */
export function turnRecord(contextDir: string, conversation: string, seq: number): TurnRecord | undefined {
  if (!isConversationId(conversation) || !Number.isSafeInteger(seq) || seq < 1) return undefined;
  return withReadonly(contextDir, undefined, (db) => {
    const c = db.prepare('SELECT agent, venue, place FROM conversations WHERE id = ?').get(conversation) as { agent: string; venue: string; place: string } | undefined;
    if (!c) return undefined;
    const r = db.prepare('SELECT * FROM conversation_turns WHERE conversation = ? AND seq = ?').get(conversation, seq) as TurnRow | undefined;
    return r ? { ...turnOf(r, c), agent: c.agent, writer: r.writer } : undefined;
  });
}

/** Conversations with a held turn in [from, to): id, venue, people. The scorecard pass reads them per UTC day. */
export function conversationsActive(contextDir: string, from: string, to: string): Array<{ id: string; venue: string; people: string[] }> {
  return withReadonly(contextDir, [], (db) => (db.prepare(`SELECT c.id, c.venue, c.people_json FROM conversations c
      WHERE EXISTS (SELECT 1 FROM conversation_turns t WHERE t.conversation = c.id AND t.at >= ? AND t.at < ?) ORDER BY c.id`).all(from, to) as Array<{ id: string; venue: string; people_json: string }>)
    .map((r) => {
      let people: string[] = [];
      try { people = JSON.parse(r.people_json) as string[]; } catch { /* a bad row names no one */ }
      return { id: r.id, venue: r.venue, people };
    }));
}

/** Every model and harness string this store has seen, held or folded: what redaction replaces. */
export function modelsSeen(contextDir: string): { models: string[]; harnesses: string[] } {
  return withReadonly(contextDir, { models: [], harnesses: [] }, (db) => {
    const models = new Set<string>();
    const harnesses = new Set<string>();
    for (const r of db.prepare('SELECT DISTINCT model, harness FROM conversation_turns').all() as Array<{ model: string | null; harness: string | null }>) {
      if (r.model) models.add(r.model);
      if (r.harness) harnesses.add(r.harness);
    }
    for (const r of db.prepare('SELECT outcomes_json FROM conversation_days').all() as Array<{ outcomes_json: string }>) {
      try { for (const m of Object.keys(JSON.parse(r.outcomes_json) as Record<string, unknown>)) if (m !== 'unknown') models.add(m); } catch { /* a bad row names nothing */ }
    }
    return { models: [...models], harnesses: [...harnesses] };
  });
}

/** Every person slug this store's conversations have seen: their `people`, and every turn `from` a person (past the people cap too). */
export function peopleSeen(contextDir: string): string[] {
  return withReadonly(contextDir, [], (db) => {
    const out = new Set<string>();
    for (const r of db.prepare('SELECT people_json FROM conversations').all() as Array<{ people_json: string }>) {
      try { for (const p of JSON.parse(r.people_json) as string[]) out.add(p); } catch { /* skip */ }
    }
    for (const r of db.prepare("SELECT DISTINCT json_extract(from_json, '$.slug') AS s FROM conversation_turns WHERE json_extract(from_json, '$.kind') = 'person'").all() as Array<{ s: string | null }>) {
      if (r.s) out.add(r.s);
    }
    return [...out];
  });
}

/** Every agent id this store's conversations have seen (beyond its own agent). */
export function agentsSeen(contextDir: string): string[] {
  return withReadonly(contextDir, [], (db) => {
    const out = new Set<string>();
    for (const r of db.prepare('SELECT agent, agents_json FROM conversations').all() as Array<{ agent: string; agents_json: string }>) {
      out.add(r.agent);
      try { for (const a of JSON.parse(r.agents_json) as string[]) out.add(a); } catch { /* skip */ }
    }
    return [...out];
  });
}

// ─── Findings (conversations.md, "Review", step 3) ──────────────────────────

/** A finding is one line of at most this many characters. */
export const MAX_FINDING = 200;

export interface Finding {
  id: string;
  conversation: string;
  seq: number;
  /** The UTC day of the turn it's on: at most one finding per conversation and day. */
  day: string;
  measure: string;
  score: number | null;
  text: string;
  at: string;
}

function createFindingsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS findings (
      id           TEXT PRIMARY KEY,
      conversation TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      day          TEXT NOT NULL,
      measure      TEXT NOT NULL,
      score        REAL,
      text         TEXT NOT NULL,
      at           TEXT NOT NULL,
      UNIQUE (conversation, day)
    );
    CREATE INDEX IF NOT EXISTS idx_findings_at ON findings(at);`);
}

/**
 * Keep a grader's finding on turn (conversation, seq) of this agent's store. At most one per
 * conversation per UTC day (the turn's day): a second is a 409, so findings can't add up to
 * a transcript. The text is one printable line of at most 200 characters.
 */
export function writeFinding(contextDir: string, f: { conversation: string; seq: number; measure: string; score: number | null; text: string }, now: Date = new Date()): Finding {
  if (typeof f.text !== 'string' || !f.text.trim().length || f.text.length > MAX_FINDING || !PRINTABLE.test(f.text)) fail(`a finding's text is one line of 1-${MAX_FINDING} printable characters`);
  return withDb(contextDir, (db) => db.transaction(() => {
    createFindingsTable(db);
    const t = db.prepare('SELECT at FROM conversation_turns WHERE conversation = ? AND seq = ?').get(f.conversation, f.seq) as { at: string } | undefined;
    if (!t) fail('no such turn in this agent\'s store', 404);
    const day = dayOf(t!.at);
    if (db.prepare('SELECT 1 FROM findings WHERE conversation = ? AND day = ?').get(f.conversation, day)) {
      fail(`this conversation already has its finding for ${day}: one per conversation per UTC day`, 409);
    }
    const out: Finding = {
      id: `fd-${createHash('sha256').update(`${f.conversation}\0${day}`).digest('hex').slice(0, 12)}`,
      conversation: f.conversation, seq: f.seq, day, measure: f.measure, score: f.score, text: f.text.trim(), at: now.toISOString(),
    };
    db.prepare('INSERT INTO findings (id, conversation, seq, day, measure, score, text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      out.id, out.conversation, out.seq, out.day, out.measure, out.score, out.text, out.at);
    return out;
  }).immediate());
}

// ─── Digests ────────────────────────────────────────────────────────────────

const DIGEST_KEYS = ['summary', 'asks', 'decisions', 'tasks', 'projects', 'needs_owner'] as const;

function stringList(v: unknown, maxItems: number, maxLen: number, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= maxLen)) {
    fail(`${what} is at most ${maxItems} non-empty strings of at most ${maxLen} characters`);
  }
  return (v as string[]).map((x) => x.trim());
}

/** A digest as the agent wrote it, checked: exactly these keys, within the caps. Projects are names, unresolved. */
export function parseDigest(raw: unknown): Required<Omit<DigestInput, 'needs_owner'>> & { needs_owner: string | null } {
  if (!isObject(raw)) return fail('a digest is a JSON object');
  const bad = Object.keys(raw).find((k) => !(DIGEST_KEYS as readonly string[]).includes(k));
  if (bad !== undefined) fail(`a digest has no key ${JSON.stringify(bad)} (it has ${DIGEST_KEYS.join(', ')})`);
  if (typeof raw.summary !== 'string' || !raw.summary.trim() || raw.summary.length > MAX_SUMMARY) fail(`summary is required, at most ${MAX_SUMMARY} characters`);
  const needs = raw.needs_owner;
  if (needs !== undefined && needs !== null && (typeof needs !== 'string' || !needs.trim() || needs.length > MAX_NEEDS_OWNER || /[\r\n]/.test(needs))) {
    fail(`needs_owner is null or a one-line reason of at most ${MAX_NEEDS_OWNER} characters`);
  }
  const projects = stringList(raw.projects, MAX_DIGEST_PROJECTS, 80, 'projects');
  const badName = projects.find((p) => !SLUG.test(p));
  if (badName !== undefined) fail(`projects are project names (slugs or aliases): not ${JSON.stringify(badName)}`);
  return {
    summary: (raw.summary as string).trim(),
    asks: stringList(raw.asks, MAX_ASKS, MAX_ASK, 'asks'),
    decisions: stringList(raw.decisions, MAX_ASKS, MAX_ASK, 'decisions'),
    tasks: stringList(raw.tasks, MAX_TASKS, MAX_TASK, 'tasks'),
    projects,
    needs_owner: typeof needs === 'string' ? needs.trim() : null,
  };
}

/**
 * Projects (docs/specs/projects.md) as this store reads them: `project_names` (name → slug,
 * live projects only) and `projects.card_json` (`links.venues`). The projects work owns those
 * tables; until they exist, names are kept as written and there's no venue fallback.
 */
export interface ProjectLookup {
  /** The slug a name resolves to; undefined when it's no live project's. Null when there's no projects store. */
  resolve(name: string): string | undefined | null;
  /** Live projects whose links.venues contains `<venue>:<place>`. */
  byVenue(venuePlace: string): string[];
}

export function projectLookup(db: Database): ProjectLookup {
  const names = hasTable(db, 'project_names');
  const cards = hasTable(db, 'projects');
  return {
    resolve: (name) => names ? (db.prepare('SELECT slug FROM project_names WHERE name = ?').get(name) as { slug: string } | undefined)?.slug : null,
    byVenue: (vp) => {
      if (!cards) return [];
      const rows = db.prepare('SELECT slug, card_json FROM projects WHERE archived_at IS NULL').all() as Array<{ slug: string; card_json: string }>;
      return rows.filter((r) => {
        try {
          const v = (JSON.parse(r.card_json) as { links?: { venues?: unknown } }).links?.venues;
          return Array.isArray(v) && v.includes(vp);
        } catch { return false; }
      }).map((r) => r.slug);
    },
  };
}

/**
 * Write the digest for (conversation, run): the conversation and run the body was given at
 * identity, and only a conversation of this agent's store. The same run replaces its digest;
 * another run adds one. Projects resolve to slugs; with none named, the one live project whose
 * links.venues holds `<venue>:<place>` (none when several do).
 */
export function writeDigest(contextDir: string, at: { conversation: string; run: string }, raw: unknown, now: Date = new Date()): Digest {
  if (!isConversationId(at.conversation) || !isRunId(at.run)) fail('a digest is written for the conversation and run given at identity: pass conversation and run to identity first');
  const input = parseDigest(raw);
  return withDb(contextDir, (db) => db.transaction(() => {
    const c = db.prepare('SELECT venue, place FROM conversations WHERE id = ?').get(at.conversation) as { venue: string; place: string } | undefined;
    if (!c) fail(`no conversation ${at.conversation} for this agent`, 404);
    const look = projectLookup(db);
    const projects: string[] = [];
    for (const name of input.projects) {
      const slug = look.resolve(name);
      if (slug === undefined) fail(`projects: ${name} is no live project's name`);
      const s = slug ?? name;
      if (!projects.includes(s)) projects.push(s);
    }
    if (!projects.length) {
      const matches = look.byVenue(`${c!.venue}:${c!.place}`);
      if (matches.length === 1) projects.push(matches[0]);
    }
    const d: Digest = {
      id: digestId(at.conversation, at.run), conversation: at.conversation, run: at.run, at: now.toISOString(),
      summary: input.summary, asks: input.asks, decisions: input.decisions, tasks: input.tasks, projects, needs_owner: input.needs_owner,
    };
    db.prepare(`INSERT INTO conversation_digests (id, conversation, run, at, summary, asks_json, decisions_json, tasks_json, projects_json, needs_owner)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET at = excluded.at, summary = excluded.summary, asks_json = excluded.asks_json,
                  decisions_json = excluded.decisions_json, tasks_json = excluded.tasks_json, projects_json = excluded.projects_json,
                  needs_owner = excluded.needs_owner`).run(
      d.id, d.conversation, d.run, d.at, d.summary, JSON.stringify(d.asks), JSON.stringify(d.decisions), JSON.stringify(d.tasks), JSON.stringify(d.projects), d.needs_owner);
    return d;
  }).immediate());
}

interface DigestRow { id: string; conversation: string; run: string; at: string; summary: string; asks_json: string; decisions_json: string; tasks_json: string; projects_json: string; needs_owner: string | null }

function digestOf(r: DigestRow): Digest {
  return {
    id: r.id, conversation: r.conversation, run: r.run, at: r.at, summary: r.summary,
    asks: JSON.parse(r.asks_json) as string[], decisions: JSON.parse(r.decisions_json) as string[], tasks: JSON.parse(r.tasks_json) as string[],
    projects: JSON.parse(r.projects_json) as string[], needs_owner: r.needs_owner,
  };
}

/** A conversation's digests, newest first. */
export function digestsOf(contextDir: string, conversation: string): Digest[] {
  return withReadonly(contextDir, [], (db) =>
    (db.prepare('SELECT * FROM conversation_digests WHERE conversation = ? ORDER BY at DESC, rowid DESC').all(conversation) as DigestRow[]).map(digestOf));
}

// ─── Reading ────────────────────────────────────────────────────────────────

function projectsOf(db: Database, conversation: string): string[] {
  const rows = db.prepare('SELECT DISTINCT j.value AS p FROM conversation_digests d, json_each(d.projects_json) j WHERE d.conversation = ? ORDER BY j.value').all(conversation) as Array<{ p: string }>;
  return rows.map((r) => r.p);
}

function conversationOf(db: Database, r: ConvRow): Conversation {
  return {
    id: r.id, agent: r.agent, venue: r.venue, place: r.place, label: r.label,
    people: JSON.parse(r.people_json) as string[], agents: JSON.parse(r.agents_json) as string[],
    projects: projectsOf(db, r.id), started: r.started, last: r.last,
  };
}

export function getConversation(contextDir: string, id: string): Conversation | undefined {
  if (!isConversationId(id)) return undefined;
  return withReadonly(contextDir, undefined, (db) => {
    const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConvRow | undefined;
    return r ? conversationOf(db, r) : undefined;
  });
}

export interface ListFilter {
  /** A person slug the conversation must include. */
  people?: string;
  /** A project slug its digests must name (the caller resolves an alias first). */
  project?: string;
  venue?: string;
  /** ISO time: only conversations whose `last` is after it. */
  since?: string;
  limit?: number;
}

/** A conversation as `conversations` lists it: the record, its newest digest's summary, and any open needs_owner. */
export interface ConversationListItem extends Conversation {
  turns: number;
  summary: string | null;
  needs_owner: string | null;
}

/** The newest digest of each conversation, by conversation id. */
function newestDigests(db: Database, ids: string[]): Map<string, DigestRow> {
  const out = new Map<string, DigestRow>();
  for (const id of ids) {
    const r = db.prepare('SELECT * FROM conversation_digests WHERE conversation = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(id) as DigestRow | undefined;
    if (r) out.set(id, r);
  }
  return out;
}

/** This store's conversations, newest `last` first, at most 100. */
export function listConversations(contextDir: string, f: ListFilter = {}): ConversationListItem[] {
  const limit = Math.min(Math.max(1, f.limit ?? LIST_MAX), LIST_MAX);
  return withReadonly(contextDir, [], (db) => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.venue) { where.push('c.venue = ?'); args.push(f.venue); }
    if (f.since) { where.push('c.last > ?'); args.push(new Date(f.since).toISOString()); }
    if (f.people) { where.push('EXISTS (SELECT 1 FROM json_each(c.people_json) p WHERE p.value = ?)'); args.push(f.people); }
    if (f.project) {
      where.push('EXISTS (SELECT 1 FROM conversation_digests d, json_each(d.projects_json) j WHERE d.conversation = c.id AND j.value = ?)');
      args.push(f.project);
    }
    const rows = db.prepare(`SELECT c.* FROM conversations c ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.last DESC, c.id LIMIT ?`).all(...args, limit) as ConvRow[];
    const newest = newestDigests(db, rows.map((r) => r.id));
    return rows.map((r) => {
      const d = newest.get(r.id);
      return { ...conversationOf(db, r), turns: r.last_seq, summary: d?.summary ?? null, needs_owner: d?.needs_owner ?? null };
    });
  });
}

/** Turn counts by kind and outcomes by model, over held turns and folded days alike: the generic render's numbers. */
export function turnStats(contextDir: string, conversation: string): { counts: Record<string, number>; outcomes: Record<string, number> } {
  return withReadonly(contextDir, { counts: {}, outcomes: {} }, (db) => {
    const counts: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    for (const r of db.prepare('SELECT kind, outcome, COUNT(*) AS n FROM conversation_turns WHERE conversation = ? GROUP BY kind, outcome').all(conversation) as Array<{ kind: string; outcome: string | null; n: number }>) {
      counts[r.kind] = (counts[r.kind] ?? 0) + r.n;
      if (r.outcome) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + r.n;
    }
    for (const r of db.prepare('SELECT counts_json, outcomes_json FROM conversation_days WHERE conversation = ?').all(conversation) as Array<{ counts_json: string; outcomes_json: string }>) {
      for (const [k, n] of Object.entries(JSON.parse(r.counts_json) as Record<string, number>)) counts[k] = (counts[k] ?? 0) + n;
      for (const byOutcome of Object.values(JSON.parse(r.outcomes_json) as Record<string, Record<string, number>>)) {
        for (const [o, n] of Object.entries(byOutcome)) outcomes[o] = (outcomes[o] ?? 0) + n;
      }
    }
    return { counts, outcomes };
  });
}

/** The folded days of a conversation, oldest first. */
export function daysOf(contextDir: string, conversation: string): DayRow[] {
  return withReadonly(contextDir, [], (db) => (db.prepare('SELECT * FROM conversation_days WHERE conversation = ? ORDER BY day').all(conversation) as Array<{ conversation: string; day: string; counts_json: string; median_latency_ms: number | null; outcomes_json: string }>)
    .map((r) => ({ conversation: r.conversation, day: r.day, counts: JSON.parse(r.counts_json), median_latency_ms: r.median_latency_ms, outcomes: JSON.parse(r.outcomes_json) })));
}

/**
 * Findings on this agent's turns, newest first (conversations.md, "Introspection"): what
 * POST /api/loom/findings kept (writeFinding). A store with no finding yet has no table, and reads none.
 */
export function findingsOf(contextDir: string, opts: { conversation?: string; since?: string } = {}): Array<Record<string, unknown>> {
  return withReadonly(contextDir, [], (db) => {
    if (!hasTable(db, 'findings')) return [];
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.conversation) { where.push('conversation = ?'); args.push(opts.conversation); }
    if (opts.since) { where.push('at > ?'); args.push(new Date(opts.since).toISOString()); }
    return db.prepare(`SELECT * FROM findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT 500`).all(...args) as Array<Record<string, unknown>>;
  });
}

// ─── Needs you ──────────────────────────────────────────────────────────────

/** Conversations whose newest digest has needs_owner: what core asks the owner, until a later digest has none. */
export function openNeeds(contextDir: string): Array<{ conversation: Conversation; digest: Digest }> {
  return withReadonly(contextDir, [], (db) => {
    const rows = db.prepare(`SELECT d.* FROM conversation_digests d
      WHERE d.rowid = (SELECT d2.rowid FROM conversation_digests d2 WHERE d2.conversation = d.conversation ORDER BY d2.at DESC, d2.rowid DESC LIMIT 1)
        AND d.needs_owner IS NOT NULL
      ORDER BY d.at DESC`).all() as DigestRow[];
    return rows.flatMap((r) => {
      const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(r.conversation) as ConvRow | undefined;
      return c ? [{ conversation: conversationOf(db, c), digest: digestOf(r) }] : [];
    });
  });
}

// ─── The project hub's section ──────────────────────────────────────────────

export const HUB_MAX = 20;

export interface HubConversation {
  id: string;
  venue: string;
  label: string | null;
  people: string[];
  last: string;
  summary: string | null;
  needs_owner: string | null;
  new: boolean;
}

/**
 * The `conversations` core section of a project's hub (conversations.md, "Projects"): the 20
 * conversations with the newest `last` whose projects include `slug`. `since` marks `new`
 * (last after since); it doesn't filter. `venueLabel` names a venue for the page.
 */
export function hubConversations(contextDir: string, slug: string, since: string, venueLabel: (venue: string) => string = (v) => v): HubConversation[] {
  const sinceMs = Date.parse(since);
  return listConversations(contextDir, { project: slug, limit: HUB_MAX }).map((c) => ({
    id: c.id, venue: venueLabel(c.venue), label: c.label, people: c.people, last: c.last,
    summary: c.summary, needs_owner: c.needs_owner, new: Date.parse(c.last) > sinceMs,
  }));
}

// ─── The tape ───────────────────────────────────────────────────────────────

export interface TapeDigest { at: string; venue: string; label: string | null; place: string; summary: string }

/** Digests written in [since, now], oldest first, for the boot tape. */
export function tapeDigests(contextDir: string, sinceIso: string, nowIso: string): TapeDigest[] {
  return withReadonly(contextDir, [], (db) => db.prepare(`SELECT d.at, c.venue, c.label, c.place, d.summary FROM conversation_digests d
      JOIN conversations c ON c.id = d.conversation WHERE d.at >= ? AND d.at <= ? ORDER BY d.at`).all(sinceIso, nowIso) as TapeDigest[]);
}

// ─── Retention ──────────────────────────────────────────────────────────────

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * The retention sweep: fold each UTC day whose every turn is older than 90 days into one
 * `conversation_days` row per conversation and day, then delete those turns. A day already
 * folded is never folded again (and takes no new turns). Conversations and digests stay.
 */
export function foldConversations(contextDir: string, now: Date = new Date()): { days: number; turns: number } {
  const path = resolveSqliteDbPath(contextDir);
  if (!existsSync(path)) return { days: 0, turns: 0 };
  return withDb(contextDir, (db) => db.transaction(() => {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
    // A day's every turn is older than the cutoff: its newest turn is.
    const groups = db.prepare(`SELECT conversation, substr(at, 1, 10) AS day, MAX(at) AS newest FROM conversation_turns
      GROUP BY conversation, substr(at, 1, 10) HAVING MAX(at) < ?`).all(cutoff) as Array<{ conversation: string; day: string }>;
    let days = 0;
    let turns = 0;
    for (const g of groups) {
      if (db.prepare('SELECT 1 FROM conversation_days WHERE conversation = ? AND day = ?').get(g.conversation, g.day)) continue;
      const rows = db.prepare('SELECT * FROM conversation_turns WHERE conversation = ? AND substr(at, 1, 10) = ?').all(g.conversation, g.day) as TurnRow[];
      const counts: Record<string, number> = {};
      const outcomes: Record<string, Record<string, number>> = {};
      for (const r of rows) {
        counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        if (r.outcome) {
          const m = (outcomes[r.model ?? 'unknown'] ??= {});
          m[r.outcome] = (m[r.outcome] ?? 0) + 1;
        }
      }
      const lat = median(rows.filter((r) => r.kind === 'reply' && r.latency_ms !== null).map((r) => r.latency_ms!));
      db.prepare('INSERT INTO conversation_days (conversation, day, counts_json, median_latency_ms, outcomes_json) VALUES (?, ?, ?, ?, ?)').run(
        g.conversation, g.day, JSON.stringify(counts), lat, JSON.stringify(outcomes));
      turns += db.prepare('DELETE FROM conversation_turns WHERE conversation = ? AND substr(at, 1, 10) = ?').run(g.conversation, g.day).changes;
      days++;
    }
    return { days, turns };
  }).immediate());
}

// ─── Measures from metadata (conversations.md, "What each kind is measured on") ─

/**
 * `due_to_progress_s` over a set of turns: per run (the agent's turns grouped by `run`), the time
 * from the `wake` turn just before the run's first turn to its first `progressed` or `answered`
 * turn; the median of those, in seconds. Runs with no such wake or no such turn don't count.
 * The scorecard pass (a later task) calls it per UTC day; it's here so criterion 15 can pin it.
 */
export function dueToProgressSeconds(turns: readonly Pick<Turn, 'seq' | 'at' | 'kind' | 'run' | 'outcome'>[]): number | null {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq);
  const runs = new Map<string, typeof ordered>();
  for (const t of ordered) if (t.run && AGENT_TURN_KINDS.includes(t.kind)) { const r = runs.get(t.run) ?? []; r.push(t); runs.set(t.run, r); }
  const spans: number[] = [];
  for (const rs of runs.values()) {
    const first = rs[0];
    const wake = ordered.filter((t) => t.kind === 'wake' && t.seq < first.seq).pop();
    const done = rs.find((t) => t.outcome === 'progressed' || t.outcome === 'answered');
    if (wake && done) spans.push((Date.parse(done.at) - Date.parse(wake.at)) / 1000);
  }
  if (!spans.length) return null;
  const s = spans.sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A project name as the read tools take it: its slug when the projects store resolves it, else the name as given. */
export function resolveProjectName(contextDir: string, name: string): string {
  return withReadonly(contextDir, name, (db) => projectLookup(db).resolve(name) ?? name);
}
