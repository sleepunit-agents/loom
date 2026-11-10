/**
 * The household store, `$LOOM_HOME/household.db` (docs/specs/conversations.md, "Where it
 * lives"): what's household-wide rather than one agent's: the `venues` registry, and the
 * review's `audit_reads` (src/audit.ts), `conversation_strangers` (markStrangers), and
 * `review_scores` and `scorecards` (src/review.ts).
 *
 * The registry is core's copy of every installed piece's `venues` declaration (src/offers.ts
 * checked it at install), so a conversation can always be shown, even once the piece that
 * carried it is gone:
 *  - install and update replace the piece's rows;
 *  - removal keeps them, marked orphaned, with `render` dropped (name, label and kind stay);
 *  - reinstalling clears the mark.
 * `syncVenues` reconciles the whole table against what's installed, so it's idempotent:
 * install, update, rollback and remove call it, and so does the daemon at start (a sync that
 * failed once is repaired by the next).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { managedPieces } from './cli/pieces-managed.js';
import type { VenueKind } from './offers.js';

export const HOUSEHOLD_DB = 'household.db';

export interface VenueRow {
  name: string;
  /** The piece that declares it, or core's own (`loom`) for session and wake. */
  piece: string;
  label: string;
  kind: VenueKind;
  /** Only on a live (not orphaned) venue that declared one. */
  render?: string[];
  /** When its piece was removed (or stopped declaring it); absent while it's installed. */
  orphaned?: string;
  /** A venue core carries itself (`loom`, docs/specs/comms.md): the runtime posts to core's adapter route, not an argv. */
  adapter?: 'core';
}

/** Core's own venues (conversations.md: `session` is live, `wake` scheduled). Never in the table. */
export const CORE_VENUE_ROWS: Readonly<Record<string, VenueRow>> = Object.freeze(Object.assign(Object.create(null) as Record<string, VenueRow>, {
  session: { name: 'session', piece: 'loom', label: 'Session', kind: 'live' },
  wake: { name: 'wake', piece: 'loom', label: 'Wake', kind: 'scheduled' },
  // Comms threads (docs/specs/comms.md): core is its adapter, at POST /api/loom/comms/adapter.
  loom: { name: 'loom', piece: 'loom', label: 'loom', kind: 'live', adapter: 'core' },
}));

/** Core's own venue `name`, by own key only: a venue named "constructor" is no core venue. */
export function coreVenue(name: string): VenueRow | undefined {
  return Object.hasOwn(CORE_VENUE_ROWS, name) ? CORE_VENUE_ROWS[name] : undefined;
}

/** Where a household's home is, for the store: LOOM_HOME, else ~/.config/loom (as pieces' root). */
export function storeHome(env: NodeJS.ProcessEnv): string | undefined {
  if (env.LOOM_HOME) return env.LOOM_HOME;
  return env.HOME ? join(env.HOME, '.config', 'loom') : undefined;
}

/** The db files whose schema this process has made sure of: it runs once per file, not per open. */
const schemaDone = new Set<string>();

/**
 * household.db's schema:
 *  - `venues`: the registry above;
 *  - `deliveries`: POST /api/loom/deliver's replay table (src/delivery.ts). One row per calling
 *    piece (whichever of its credentials called) and id, for 24 hours: when, a SHA-256 of the
 *    body (never the text) and the runtime's answer;
 *  - the review's records (src/audit.ts, src/review.ts): `audit_reads` (who took which audit
 *    entry, never its text), `conversation_strangers` (sticky: a turn came from a non-owner),
 *    `models_seen` (every model and harness a turn named), `review_scores` and `scorecards`.
 *  - `turn_keys`: POST /api/loom/conversations/turn's idempotency keys (src/conversations.ts):
 *    (agent, key) for 24 hours, with a hash of the turn and the {conversation, seq} it answered.
 *  - `house_conversations`: the one conversation each body's house holds, as the runtime said before handing
 *    it a body (POST /api/loom/conversations/house, t-2061). Set once, never moved to another.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS house_conversations (
    house        TEXT PRIMARY KEY,
    agent        TEXT NOT NULL,
    conversation TEXT NOT NULL,
    at           TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turn_keys (
    agent        TEXT NOT NULL,
    key          TEXT NOT NULL,
    at           INTEGER NOT NULL,
    turn_sha256  TEXT NOT NULL,
    conversation TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    PRIMARY KEY (agent, key)
  );
  CREATE INDEX IF NOT EXISTS turn_keys_at ON turn_keys (at);
  CREATE TABLE IF NOT EXISTS venues (
    name        TEXT PRIMARY KEY,
    piece       TEXT NOT NULL,
    label       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    render_json TEXT,
    orphaned    TEXT,
    updated     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    piece       TEXT NOT NULL,
    id          TEXT NOT NULL,
    at          INTEGER NOT NULL,
    body_sha256 TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    PRIMARY KEY (piece, id)
  );
  CREATE INDEX IF NOT EXISTS deliveries_piece_at ON deliveries (piece, at);
  CREATE TABLE IF NOT EXISTS audit_reads (
    ref          TEXT PRIMARY KEY,
    run          TEXT NOT NULL,
    at           TEXT NOT NULL,
    agent        TEXT NOT NULL,
    conversation TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    UNIQUE (agent, conversation, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_audit_reads_run ON audit_reads(run);
  CREATE TABLE IF NOT EXISTS conversation_strangers (
    agent        TEXT NOT NULL,
    conversation TEXT NOT NULL,
    at           TEXT NOT NULL,
    PRIMARY KEY (agent, conversation)
  );
  CREATE TABLE IF NOT EXISTS models_seen (
    kind  TEXT NOT NULL,
    name  TEXT NOT NULL,
    first TEXT NOT NULL,
    PRIMARY KEY (kind, name)
  );
  CREATE TABLE IF NOT EXISTS review_scores (
    ref           TEXT NOT NULL,
    grader_family TEXT NOT NULL,
    score         INTEGER NOT NULL,
    at            TEXT NOT NULL,
    PRIMARY KEY (ref, grader_family)
  );
  CREATE TABLE IF NOT EXISTS scorecards (
    day         TEXT NOT NULL,
    model       TEXT NOT NULL,
    family      TEXT NOT NULL,
    harness     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    measure     TEXT NOT NULL,
    same_family INTEGER NOT NULL,
    value       REAL NOT NULL,
    n           INTEGER NOT NULL,
    total       REAL NOT NULL,
    PRIMARY KEY (day, model, family, harness, kind, measure, same_family)
  );`;

export function openHouseholdDb(home: string): Database {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, HOUSEHOLD_DB);
  // A file made since (a test's fresh home, a deleted db) gets its schema again.
  const fresh = !existsSync(path);
  const db = new BetterSqlite3(path);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    if (fresh || !schemaDone.has(path)) {
      db.exec(SCHEMA);
      schemaDone.add(path);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** One household.db connection for `f`, closed after. */
export function withHouseholdDb<T>(home: string, f: (db: Database) => T): T {
  const db = openHouseholdDb(home);
  try { return f(db); } finally { db.close(); }
}

interface Row { name: string; piece: string; label: string; kind: string; render_json: string | null; orphaned: string | null }

const rowOf = (r: Row): VenueRow => ({
  name: r.name, piece: r.piece, label: r.label, kind: r.kind as VenueKind,
  ...(r.render_json && !r.orphaned ? { render: JSON.parse(r.render_json) as string[] } : {}),
  ...(r.orphaned ? { orphaned: r.orphaned } : {}),
});

/**
 * Make the registry match what's installed: every installed piece's declared venues present
 * and not orphaned (a name another piece held before passes to the one declaring it now), and
 * every other row orphaned, its render dropped. Answers the names whose rows changed.
 */
export function syncVenues(env: NodeJS.ProcessEnv, now: Date = new Date()): string[] {
  const home = storeHome(env);
  if (!home) return [];
  const declared = new Map<string, VenueRow>();
  for (const p of managedPieces(env)) {
    for (const [name, v] of Object.entries(p.loom.venues ?? {})) {
      declared.set(name, { name, piece: p.name, label: v.label, kind: v.kind, ...(v.render ? { render: v.render } : {}) });
    }
  }
  // Nothing declared and no registry yet: nothing to keep, so no file is made for it.
  if (!declared.size && !existsSync(join(home, HOUSEHOLD_DB))) return [];
  return withHouseholdDb(home, (db) => db.transaction(() => {
    const changed: string[] = [];
    const at = now.toISOString();
    const rows = new Map((db.prepare('SELECT * FROM venues').all() as Row[]).map((r) => [r.name, r]));
    for (const v of declared.values()) {
      const r = rows.get(v.name);
      const render = v.render ? JSON.stringify(v.render) : null;
      if (r && r.piece === v.piece && r.label === v.label && r.kind === v.kind && r.render_json === render && r.orphaned === null) continue;
      db.prepare(`INSERT INTO venues (name, piece, label, kind, render_json, orphaned, updated) VALUES (?, ?, ?, ?, ?, NULL, ?)
                  ON CONFLICT(name) DO UPDATE SET piece = excluded.piece, label = excluded.label, kind = excluded.kind,
                    render_json = excluded.render_json, orphaned = NULL, updated = excluded.updated`).run(v.name, v.piece, v.label, v.kind, render, at);
      changed.push(v.name);
    }
    for (const r of rows.values()) {
      if (declared.has(r.name) || r.orphaned !== null) continue;
      db.prepare('UPDATE venues SET orphaned = ?, render_json = NULL, updated = ? WHERE name = ?').run(at, at, r.name);
      changed.push(r.name);
    }
    return changed;
  }).immediate());
}

/** A house's binding was refused: it holds another conversation (or another agent's). */
export class HouseBindingError extends Error {}

/**
 * Record that house `house` (agent's) holds conversation `conversation` (t-2061): the runtime says so before it hands
 * the house a body. A house holds one conversation, for good: the same binding again is a no-op, and any other (a
 * second conversation, another agent) is refused, so a house can't come to speak for two.
 */
export function bindHouseConversation(home: string, b: { agent: string; house: string; conversation: string }, now: Date = new Date()): { house: string; conversation: string } {
  return withHouseholdDb(home, (db) => db.transaction(() => {
    const had = db.prepare('SELECT agent, conversation FROM house_conversations WHERE house = ?').get(b.house) as { agent: string; conversation: string } | undefined;
    if (had) {
      if (had.agent !== b.agent || had.conversation !== b.conversation) throw new HouseBindingError(`${b.house} holds another conversation; a house holds one`);
      return { house: b.house, conversation: had.conversation };
    }
    db.prepare('INSERT INTO house_conversations (house, agent, conversation, at) VALUES (?, ?, ?, ?)').run(b.house, b.agent, b.conversation, now.toISOString());
    return { house: b.house, conversation: b.conversation };
  }).immediate());
}

/** The conversation house `house` holds, or null when the runtime never said (a house from before t-2061, a service's). */
export function houseConversation(home: string, house: string): { agent: string; conversation: string } | null {
  return withHouseholdDb(home, (db) => (db.prepare('SELECT agent, conversation FROM house_conversations WHERE house = ?').get(house) as { agent: string; conversation: string } | undefined) ?? null);
}

/**
 * Mark conversation `conversation` (agent's) as one with someone other than its owners: a turn
 * came from a non-member or an unknown sender. Sticky: never cleared, so neither the people
 * cap nor the 90-day fold can make it look owner-only (conversations.md, "Review", step 2).
 */
export function markStrangers(home: string, agent: string, conversation: string, now: Date = new Date()): void {
  withHouseholdDb(home, (db) => db.prepare('INSERT OR IGNORE INTO conversation_strangers (agent, conversation, at) VALUES (?, ?, ?)').run(agent, conversation, now.toISOString()));
}

/**
 * Remember a model and a harness a turn named, household-wide and for good (a turn may be
 * folded away; the name stays redactable, and its family stays a grader family).
 */
export function noteModels(home: string, seen: { model?: string; harness?: string }, now: Date = new Date()): void {
  if (!seen.model && !seen.harness) return;
  withHouseholdDb(home, (db) => {
    const put = db.prepare('INSERT OR IGNORE INTO models_seen (kind, name, first) VALUES (?, ?, ?)');
    if (seen.model) put.run('model', seen.model, now.toISOString());
    if (seen.harness) put.run('harness', seen.harness, now.toISOString());
  });
}

/** Every model and harness noteModels has kept. */
export function modelsNoted(home: string): { models: string[]; harnesses: string[] } {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return { models: [], harnesses: [] };
  const rows = withHouseholdDb(home, (db) => db.prepare('SELECT kind, name FROM models_seen ORDER BY kind, name').all() as Array<{ kind: string; name: string }>);
  return { models: rows.filter((r) => r.kind === 'model').map((r) => r.name), harnesses: rows.filter((r) => r.kind === 'harness').map((r) => r.name) };
}

/** Whether conversation `conversation` (agent's) was ever marked by markStrangers. */
export function hasStrangers(home: string, agent: string, conversation: string): boolean {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return false;
  return withHouseholdDb(home, (db) => db.prepare('SELECT 1 FROM conversation_strangers WHERE agent = ? AND conversation = ?').get(agent, conversation) !== undefined);
}

/** Every venue in the registry, by name (core's own not included). */
export function listVenues(home: string): VenueRow[] {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return [];
  return withHouseholdDb(home, (db) => (db.prepare('SELECT * FROM venues ORDER BY name').all() as Row[]).map(rowOf));
}

/** A venue by name: core's own, or the registry's row (orphaned or not); undefined when unknown. */
export function venueOf(home: string | undefined, name: string): VenueRow | undefined {
  const core = coreVenue(name);
  if (core) return core;
  if (!home || !existsSync(join(home, HOUSEHOLD_DB))) return undefined;
  const r = withHouseholdDb(home, (db) => db.prepare('SELECT * FROM venues WHERE name = ?').get(name) as Row | undefined);
  return r ? rowOf(r) : undefined;
}

/** A venue's label for showing: the registry's (or core's), else its name. */
export function venueLabel(home: string | undefined, name: string): string {
  try { return venueOf(home, name)?.label ?? name; } catch { return name; }
}

/** Sync after a piece change, never failing it: a failed sync is said, and the daemon's next start repairs it. */
export function syncVenuesQuietly(env: NodeJS.ProcessEnv, say: (s: string) => void = (s) => process.stderr.write(s)): void {
  try { syncVenues(env); } catch (e) { say(`loom: couldn't update the venues registry (${(e as Error).message}); the daemon's next start does\n`); }
}

/** A venue as the runtime is told it (GET /api/loom/venues): where to send an agent's words. */
export interface VenueEntry {
  name: string;
  label: string;
  kind: VenueKind;
  /** The piece that declares it, or `loom` for core's own (session, wake). */
  piece: string;
  /** Its declared `send` argv (agent-runtime.md, "Delivery", Outbound), while its piece is installed. */
  send?: string[];
  /** `core` for a venue core carries itself (`loom`): post to POST /api/loom/comms/adapter instead of a send argv. */
  adapter?: 'core';
  /** When its piece was removed; an orphaned venue has no send. */
  orphaned?: string;
}

/**
 * Every venue the household has, for the runtime (GET /api/loom/venues, role runtime): core's
 * own, then the registry's, each with its piece and, while that piece is installed and still
 * declares it, its `send`, read from the piece's checked loom block. So the runtime never reads
 * another piece's piece.json itself.
 */
export function venueDirectory(env: NodeJS.ProcessEnv): VenueEntry[] {
  const home = storeHome(env);
  const sends = new Map<string, { piece: string; send?: string[] }>();
  for (const p of managedPieces(env)) {
    for (const [name, v] of Object.entries(p.loom.venues ?? {})) sends.set(name, { piece: p.name, ...(v.send ? { send: [...v.send] } : {}) });
  }
  const core = Object.values(CORE_VENUE_ROWS).map((v): VenueEntry => ({ name: v.name, label: v.label, kind: v.kind, piece: v.piece, ...(v.adapter ? { adapter: v.adapter } : {}) }));
  const rows = home ? listVenues(home) : [];
  return [...core, ...rows.map((v): VenueEntry => {
    const live = sends.get(v.name);
    const send = !v.orphaned && live?.piece === v.piece ? live.send : undefined;
    return { name: v.name, label: v.label, kind: v.kind, piece: v.piece, ...(send ? { send } : {}), ...(v.orphaned ? { orphaned: v.orphaned } : {}) };
  })];
}
