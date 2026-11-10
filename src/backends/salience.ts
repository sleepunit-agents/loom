/**
 * Salience temperature + the assembled boot digest (c-loom-memory: it-loom-salience).
 *
 * A memory's temperature DECAYS by a per-category half-life and REHEATS when
 * it's written or edited (full heat) or recalled (heat added by rank, see
 * recallWeight) — so a frequently-used fact stays warm and an untouched one
 * cools. It's computed when read (heatOf); the stored scalar is a cache. The consolidation lane recomputes the stored field; the digest assembler
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

/**
 * Feedback confidence model (t-338, parent t-325).
 *
 * Stolen from affaan-m/ECC's instinct design (confidence range 0.3-0.9,
 * evidence-backed, +0.05 per confirming observation, -0.1 per contradicting
 * one) — deliberately NOT their implementation. In ECC that arithmetic lives
 * only as prose in a prompt (agents/observer.md) fed to an LLM; instinct-cli.py
 * never computes, adjusts, or decays the number anywhere. Here the arithmetic
 * is plain functions loom's own code calls from remember()/update() — never a
 * prompt. Decay reuses `temperature()` above (same HALF_LIVES table) instead
 * of a second, separate -0.02/week rule: one decay mechanism, not two.
 */
export const FEEDBACK_CONFIDENCE_MIN = 0.3;
export const FEEDBACK_CONFIDENCE_MAX = 0.9;
/** Starting value for a newly observed feedback memory, and the value decay relaxes toward. */
export const FEEDBACK_CONFIDENCE_DEFAULT = 0.6;
export const FEEDBACK_CONFIRM_DELTA = 0.05;
export const FEEDBACK_CONTRADICT_DELTA = -0.1;

export function clampConfidence(value: number): number {
  return Math.min(FEEDBACK_CONFIDENCE_MAX, Math.max(FEEDBACK_CONFIDENCE_MIN, value));
}

/** Apply one confirming or contradicting observation to a stored confidence value. */
export function applyObservation(current: number, kind: 'confirm' | 'contradict'): number {
  const delta = kind === 'confirm' ? FEEDBACK_CONFIRM_DELTA : FEEDBACK_CONTRADICT_DELTA;
  return clampConfidence(current + delta);
}

/**
 * Confidence after decay: relax the evidence-weighted raw value toward the
 * neutral default as the memory cools, scaled by the SAME exponential
 * half-life curve as salience (`temperature()`, same HALF_LIVES table) — a
 * fully-decayed (temp→0) memory reads as neutral, a freshly-touched one
 * (temp=1) reads as its raw evidence-backed value.
 *
 * `lastTouchIso` should be the last OBSERVATION time (the row's
 * `observed_at`, falling back to `created`) — not `updated` and not
 * `last_accessed`. A recall, an edit, an archive or a restore isn't
 * evidence and mustn't reheat confidence; only a confirm/contradict (which
 * goes through update() and stamps `observed_at`) is.
 */
export function decayedConfidence(
  rawConfidence: number,
  lastTouchIso: string,
  category: string,
  nowMs: number,
): number {
  const temp = temperature(lastTouchIso, category, nowMs);
  return FEEDBACK_CONFIDENCE_DEFAULT + (rawConfidence - FEEDBACK_CONFIDENCE_DEFAULT) * temp;
}

/**
 * How much one recall adds to a memory's recall heat, by its rank in the
 * results: the top hit counts most, an incidental hit near the bottom barely
 * at all. Recall used to reset every result to full heat, so one vague query
 * put ten unrelated memories at the top of mind (t-1489).
 */
export const RECALL_WEIGHTS: readonly number[] = [0.5, 0.3, 0.2];
export const RECALL_TAIL_WEIGHT = 0.1;

export function recallWeight(rank: number): number {
  return RECALL_WEIGHTS[rank] ?? RECALL_TAIL_WEIGHT;
}

/** A stored recall heat, decayed by the category's half-life since it was last added to. */
export function decayedRecallHeat(value: number | null | undefined, atIso: string | null | undefined, category: string, nowMs: number): number {
  if (!value || !atIso) return 0;
  return Math.min(1, value * temperature(atIso, category, nowMs));
}

/** The recall heat after one more hit at `rank`: decay what's there, add the weight, cap at 1. */
export function bumpedRecallHeat(value: number | null | undefined, atIso: string | null | undefined, category: string, rank: number, nowMs: number): number {
  return Math.min(1, decayedRecallHeat(value, atIso, category, nowMs) + recallWeight(rank));
}

export interface HeatInput {
  category: string;
  created: string;
  updated: string | null;
  recall_heat?: number | null;
  recall_heat_at?: string | null;
}

/**
 * A memory's heat right now. Writing or editing it (including a repeat
 * remember) makes it fully hot, decaying from then; recall adds to it by rank
 * (recallWeight), so a memory stays hot by being used again and again, not by
 * turning up once at the bottom of someone's results.
 */
export function heatOf(r: HeatInput, nowMs: number): number {
  const written = temperature(r.updated ?? r.created, r.category, nowMs);
  return Math.max(written, decayedRecallHeat(r.recall_heat, r.recall_heat_at, r.category, nowMs));
}

/** Columns heatOf reads; older stores without the recall columns read them as null. */
export function heatColumns(db: Database): string {
  const have = hasColumn(db, 'memories', 'recall_heat');
  return have ? 'created, updated, recall_heat, recall_heat_at' : 'created, updated, NULL AS recall_heat, NULL AS recall_heat_at';
}

/**
 * Recompute and STORE the salience scalar for every non-archived memory. Called
 * by the consolidation lane. The digest no longer depends on it (it reads heat
 * live, see liveRows); the stored field is for anything that sorts in SQL.
 * Returns the number of memories recomputed.
 */
export function recomputeSalience(db: Database, nowMs: number): number {
  const rows = db
    .prepare(`SELECT id, category, ${heatColumns(db)} FROM memories WHERE archived = 0`)
    .all() as Array<HeatInput & { id: number }>;
  const upd = db.prepare('UPDATE memories SET salience = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(heatOf(r, nowMs), r.id);
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
  /** The moment heat is read at (tests pin it). */
  nowMs?: number;
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
 * Assemble the boot digest from rows with heat already set: order hottest-first,
 * fill the token budget, group the included atoms under their tier headers. Pure
 * selection + ordering of authored content — no generated prose, no persisted
 * glue. Returns null when there is nothing to show.
 */
/** The rows the digest includes: hottest first, until the token budget is spent. */
export function pickForDigest<T extends DigestRow>(rows: T[], opts: DigestOptions = {}): T[] {
  const budgetChars = (opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * (opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const ordered = [...rows].sort((a, b) => b.salience - a.salience);
  const picked: T[] = [];
  let used = 0;
  for (const r of ordered) {
    const len = atomLine(r).length;
    if (used + len > budgetChars && picked.length > 0) break; // hottest-first to the cap
    picked.push(r);
    used += len + 1;
  }
  return picked;
}

export function assembleDigest(rows: DigestRow[], opts: DigestOptions = {}): string | null {
  const picked = pickForDigest(rows, opts).map((r) => ({ tier: tierOf(r.salience), line: atomLine(r) }));
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
  db.pragma('busy_timeout = 5000');
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
 * Every live authored memory (not episodes) with its heat computed NOW from
 * its timestamps, hottest first. The digest reads heat this way instead of
 * trusting the stored field: the stored field only moves when the
 * consolidation lane runs, and when the lane missed days (t-1488, and once
 * before for two months) Top of Mind froze, with ties at 1.0 falling back to
 * write order. The stored field stays, refreshed by the lane, for anything
 * that sorts in SQL.
 */
function liveRows(db: Database, nowMs: number): Array<DigestRow & { stored: number }> {
  const rows = db
    .prepare(
      `SELECT title, category, content, salience AS stored, sourcing, ${heatColumns(db)} FROM memories WHERE archived = 0 AND category != ?`,
    )
    .all(EPISODE_CATEGORY) as Array<Omit<DigestRow, 'salience'> & HeatInput & { stored: number }>;
  return rows
    .map(({ created, updated, recall_heat, recall_heat_at, ...r }) => ({
      ...r,
      salience: heatOf({ category: r.category, created, updated, recall_heat, recall_heat_at }, nowMs),
    }))
    .sort((a, b) => b.salience - a.salience);
}

/**
 * Structured salience digest for a UI widget: the hottest authored atoms,
 * tier-labeled, ordered hot→cold, plus the total memory count. Same
 * assemble-not-generate view as the text digest — just shaped for rendering.
 */
export function digestData(
  contextDir: string,
  limit = 40,
  nowMs = Date.now(),
): { atoms: DigestAtom[]; total: number } | null {
  const db = openMemoriesDb(contextDir, true);
  if (!db) return null;
  try {
    if (!hasColumn(db, 'memories', 'salience')) return { atoms: [], total: 0 };
    const total = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0').get() as { n: number }).n;
    const atoms = liveRows(db, nowMs)
      .slice(0, limit)
      .map(({ stored: _stored, ...r }) => ({ ...r, tier: tierOf(r.salience) }));
    return { atoms, total };
  } finally {
    db.close();
  }
}

/** Assemble the boot digest for a context, with heat read live. Returns null if no store / nothing hot. */
export function digestForContext(contextDir: string, opts: DigestOptions = {}): string | null {
  const db = openMemoriesDb(contextDir, true);
  if (!db) return null;
  try {
    // A store not yet migrated to salience simply has no digest yet (read-only
    // path can't migrate; the lane / normal backend connect will add the column).
    if (!hasColumn(db, 'memories', 'salience')) return null;
    // Episodes are the tape, not the digest: a fresh episode is always hot
    // and would crowd Top of Mind with what just happened.
    const rows = liveRows(db, opts.nowMs ?? Date.now()).slice(0, 100);
    return assembleDigest(rows, opts);
  } finally {
    db.close();
  }
}
