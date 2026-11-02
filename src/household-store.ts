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
}

/** Core's own venues (conversations.md: `session` is live, `wake` scheduled). Never in the table. */
export const CORE_VENUE_ROWS: Readonly<Record<string, VenueRow>> = Object.freeze(Object.assign(Object.create(null) as Record<string, VenueRow>, {
  session: { name: 'session', piece: 'loom', label: 'Session', kind: 'live' },
  wake: { name: 'wake', piece: 'loom', label: 'Wake', kind: 'scheduled' },
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

export function openHouseholdDb(home: string): Database {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new BetterSqlite3(join(home, HOUSEHOLD_DB));
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS venues (
    name        TEXT PRIMARY KEY,
    piece       TEXT NOT NULL,
    label       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    render_json TEXT,
    orphaned    TEXT,
    updated     TEXT NOT NULL
  )`);
  // The review's household-wide records (src/audit.ts, src/review.ts): who took which audit
  // entry (never its text), the scores graders posted by ref, and the scorecard rows core
  // aggregates from them and from turn metadata.
  db.exec(`
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
    );
  `);
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
