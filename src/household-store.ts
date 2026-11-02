/**
 * The household store, `$LOOM_HOME/household.db` (docs/specs/conversations.md, "Where it
 * lives"): what's household-wide rather than one agent's. This slice keeps the `venues`
 * registry in it; scorecards, audit reads and review runs join it with the review work.
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
export const CORE_VENUE_ROWS: Readonly<Record<string, VenueRow>> = {
  session: { name: 'session', piece: 'loom', label: 'Session', kind: 'live' },
  wake: { name: 'wake', piece: 'loom', label: 'Wake', kind: 'scheduled' },
};

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
  return db;
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
  const db = openHouseholdDb(home);
  try {
    return db.transaction(() => {
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
    }).immediate();
  } finally {
    db.close();
  }
}

/** Every venue in the registry, by name (core's own not included). */
export function listVenues(home: string): VenueRow[] {
  if (!existsSync(join(home, HOUSEHOLD_DB))) return [];
  const db = openHouseholdDb(home);
  try { return (db.prepare('SELECT * FROM venues ORDER BY name').all() as Row[]).map(rowOf); } finally { db.close(); }
}

/** A venue by name: core's own, or the registry's row (orphaned or not); undefined when unknown. */
export function venueOf(home: string | undefined, name: string): VenueRow | undefined {
  if (CORE_VENUE_ROWS[name]) return CORE_VENUE_ROWS[name];
  if (!home || !existsSync(join(home, HOUSEHOLD_DB))) return undefined;
  const db = openHouseholdDb(home);
  try {
    const r = db.prepare('SELECT * FROM venues WHERE name = ?').get(name) as Row | undefined;
    return r ? rowOf(r) : undefined;
  } finally {
    db.close();
  }
}

/** A venue's label for showing: the registry's (or core's), else its name. */
export function venueLabel(home: string | undefined, name: string): string {
  try { return venueOf(home, name)?.label ?? name; } catch { return name; }
}

/** Sync after a piece change, never failing it: a failed sync is said, and the daemon's next start repairs it. */
export function syncVenuesQuietly(env: NodeJS.ProcessEnv, say: (s: string) => void = (s) => process.stderr.write(s)): void {
  try { syncVenues(env); } catch (e) { say(`loom: couldn't update the venues registry (${(e as Error).message}); the daemon's next start does\n`); }
}
