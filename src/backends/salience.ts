/**
 * Salience temperature + the assembled boot digest (c-loom-memory: it-loom-salience).
 *
 * A memory's temperature is a stored scalar that DECAYS by a per-category
 * half-life and REHEATS on access (recall stamps last_accessed; write/update
 * stamps updated) — so a frequently-touched fact stays warm and an untouched one
 * cools. The consolidation lane recomputes the stored field; the digest assembler
 * fills a token budget HOTTEST-FIRST from existing authored atoms, labeled into
 * tiers. It ASSEMBLES a view over authored memories — it never generates new
 * prose (the integrity line: loom holds the pen, unlike Anthropic's native digest
 * which is generated).
 */
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveSqliteDbPath } from '../config.js';
import { runMigrations } from './migrations.js';
import { EPISODE_CATEGORY } from '../categories.js';
import { retryWrite } from './retry.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
}

/** Per-category half-life in days: hot working categories cool fast, identity-level facts cool slow. */
export const HALF_LIVES: Record<string, number> = {
  episode: 1,
  pursuit: 7,
  project: 10,
  self: 30,
  feedback: 30,
  reference: 45,
  user: 90,
};
export const DEFAULT_HALF_LIFE_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Temperature in (0, 1]: 1.0 at the moment of last touch, 0.5 after one
 * category half-life, decaying exponentially after. `lastTouchIso` is the most
 * recent of last_accessed / updated / created.
 */
export function temperature(lastTouchIso: string, category: string, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - Date.parse(lastTouchIso)) / DAY_MS);
  const halfLife = HALF_LIVES[category] ?? DEFAULT_HALF_LIFE_DAYS;
  return Math.pow(2, -ageDays / halfLife);
}

export type Tier = 'Hot' | 'Warm' | 'Cool';
export function tierOf(temp: number): Tier {
  if (temp >= 0.6) return 'Hot';
  if (temp >= 0.2) return 'Warm';
  return 'Cool';
}

interface SalienceRow {
  id: number;
  category: string;
  created: string;
  updated: string | null;
  last_accessed: string | null;
}

/** Most-recent-touch timestamp for a row (recall/write reheat through these). */
function lastTouch(r: { created: string; updated: string | null; last_accessed: string | null }): string {
  return r.last_accessed ?? r.updated ?? r.created;
}

/**
 * Recompute and STORE the salience scalar for every non-archived memory. Called
 * by the consolidation lane (stored + lane-refresh, not computed-on-read).
 * Returns the number of memories recomputed.
 */
export function recomputeSalience(db: Database, nowMs: number): number {
  const rows = db
    .prepare('SELECT id, category, created, updated, last_accessed FROM memories WHERE archived = 0')
    .all() as SalienceRow[];
  const upd = db.prepare('UPDATE memories SET salience = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(temperature(lastTouch(r), r.category, nowMs), r.id);
  });
  // The nightly full-table recompute is the heaviest write in loom; wrap it so
  // a concurrent remember() call during the recompute retries instead of throwing.
  retryWrite(() => tx());
  return rows.length;
}

export interface DigestRow {
  title: string;
  category: string;
  content: string;
  salience: number;
  /** Sourcing tier — null on legacy records without the column. */
  sourcing: string | null;
}

export interface DigestOptions {
  /** Approximate token budget for the whole digest. */
  tokenBudget?: number;
  /** Rough chars-per-token for the budget estimate. */
  charsPerToken?: number;
}

const DEFAULT_TOKEN_BUDGET = 1200;
const DEFAULT_CHARS_PER_TOKEN = 4;

/** One line per atom: a trimmed, single-line view — selected, never synthesized. */
function atomLine(r: DigestRow): string {
  const body = r.content.replace(/\s+/g, ' ').trim();
  const clipped = body.length > 200 ? body.slice(0, 197).trimEnd() + '…' : body;
  // Show sourcing tag when present so readers calibrate confidence on inject.
  // 'inferred' is the critical one: AI-generated reasoning, not ground truth.
  const tag = r.sourcing ? `, ${r.sourcing}` : '';
  return `- **${r.title}** (${r.category}${tag}) — ${clipped}`;
}

/**
 * Assemble the boot digest from already-recomputed salience: order hottest-first,
 * fill the token budget, group the included atoms under their tier headers. Pure
 * selection + ordering of authored content — no generated prose, no persisted
 * glue. Returns null when there is nothing to show.
 */
export function assembleDigest(rows: DigestRow[], opts: DigestOptions = {}): string | null {
  const budgetChars = (opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * (opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const ordered = [...rows].sort((a, b) => b.salience - a.salience);

  const picked: { tier: Tier; line: string }[] = [];
  let used = 0;
  for (const r of ordered) {
    const line = atomLine(r);
    if (used + line.length > budgetChars && picked.length > 0) break; // hottest-first to the cap
    picked.push({ tier: tierOf(r.salience), line });
    used += line.length + 1;
  }
  if (picked.length === 0) return null;

  const tierOrder: Tier[] = ['Hot', 'Warm', 'Cool'];
  const tierLabel: Record<Tier, string> = {
    Hot: 'Top of mind',
    Warm: 'Recent',
    Cool: 'Background',
  };
  const sections: string[] = [];
  for (const tier of tierOrder) {
    const lines = picked.filter((p) => p.tier === tier).map((p) => p.line);
    if (lines.length) sections.push(`## ${tierLabel[tier]}\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

// ── context-dir wrappers (open memories.db directly; no embedder needed) ──

/** Open memories.db without the vector/embedder stack — salience is plain SQL. */
function openMemoriesDb(contextDir: string, readonly: boolean): Database | null {
  const dbPath = resolveSqliteDbPath(contextDir);
  if (!existsSync(dbPath)) return null;
  const db = new BetterSqlite3(dbPath, { readonly });
  db.pragma('busy_timeout = 0');
  return db;
}

/** Lane entry point: recompute + store salience for a context. Returns count (or null if no store). */
export function recomputeSalienceForContext(contextDir: string, nowMs: number): number | null {
  const db = openMemoriesDb(contextDir, false);
  if (!db) return null;
  try {
    // Self-heal: a store that predates the salience migration gets it here, so
    // the lane works on any store (migrations are idempotent).
    if (!hasColumn(db, 'memories', 'salience')) runMigrations(db, { strict: false });
    return recomputeSalience(db, nowMs);
  } finally {
    db.close();
  }
}

export interface DigestAtom {
  title: string;
  category: string;
  content: string;
  salience: number;
  tier: Tier;
  /** Sourcing tier — null on legacy records. */
  sourcing: string | null;
}

/**
 * Structured salience digest for a UI widget: the hottest authored atoms,
 * tier-labeled, ordered hot→cold, plus the total memory count. Same
 * assemble-not-generate view as the text digest — just shaped for rendering.
 */
export function digestData(
  contextDir: string,
  limit = 40,
): { atoms: DigestAtom[]; total: number } | null {
  const db = openMemoriesDb(contextDir, true);
  if (!db) return null;
  try {
    if (!hasColumn(db, 'memories', 'salience')) return { atoms: [], total: 0 };
    const total = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0').get() as { n: number }).n;
    const rows = db
      .prepare(
        'SELECT title, category, content, salience, sourcing FROM memories WHERE archived = 0 AND category != ? ORDER BY salience DESC LIMIT ?',
      )
      .all(EPISODE_CATEGORY, limit) as Omit<DigestAtom, 'tier'>[];
    const atoms = rows.map((r) => ({ ...r, tier: tierOf(r.salience) }));
    return { atoms, total };
  } finally {
    db.close();
  }
}

/** Assemble the boot digest for a context from stored salience. Returns null if no store / nothing hot. */
export function digestForContext(contextDir: string, opts: DigestOptions = {}): string | null {
  const db = openMemoriesDb(contextDir, true);
  if (!db) return null;
  try {
    // A store not yet migrated to salience simply has no digest yet (read-only
    // path can't migrate; the lane / normal backend connect will add the column).
    if (!hasColumn(db, 'memories', 'salience')) return null;
    const rows = db
      .prepare(
        // Episodes are the tape, not the digest: a fresh episode is always
        // salience 1.0 and would crowd Top of Mind with what just happened.
        // sourcing: LEFT JOIN-style null-safe select — old stores without the
        // column return NULL which DigestRow.sourcing accepts.
        'SELECT title, category, content, salience, sourcing FROM memories WHERE archived = 0 AND category != ? ORDER BY salience DESC LIMIT 100',
      )
      .all(EPISODE_CATEGORY) as DigestRow[];
    return assembleDigest(rows, opts);
  } finally {
    db.close();
  }
}
