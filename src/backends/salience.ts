/**
 * Salience temperature + the assembled boot digest (c-loom-memory: it-loom-salience).
 *
 * A memory's temperature DECAYS by a per-category half-life and REHEATS when
 * it's written or edited (full heat) or recalled (heat added by rank, see
 * recallWeight) — so a frequently-used fact stays warm and an untouched one
 * cools. It's computed when read (heatOf); the `salience` column holds only what a
 * memory was written with and is not read for ranking. The digest assembler
 * fills a token budget HOTTEST-FIRST from existing authored atoms, labeled into
 * tiers. It ASSEMBLES a view over authored memories — it never generates new
 * prose (the integrity line: loom holds the pen, unlike Anthropic's native digest
 * which is generated).
 */
import { DAY_MS } from '../core/day.js';
import type { Database } from 'better-sqlite3';
import { EPISODE_CATEGORY } from '../categories.js';
import type { Observation } from './types.js';

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


/**
 * Temperature in [0, 1]: 1.0 at the moment of last touch, 0.5 after one
 * category half-life, decaying exponentially after. `lastTouchIso` is the most
 * recent authored write. Malformed or future timestamps read as cold (0).
 */
export function temperature(lastTouchIso: string, category: string, nowMs: number): number {
  const touchMs = Date.parse(lastTouchIso);
  if (!Number.isFinite(touchMs) || !Number.isFinite(nowMs) || touchMs > nowMs) return 0;
  const ageDays = (nowMs - touchMs) / DAY_MS;
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
export function applyObservation(current: number, kind: Observation): number {
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
  /** Known authored write; legacy rows fall back to creation, never audit updates. */
  authored_at?: string | null;
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
  const written = temperature(r.authored_at ?? r.created, r.category, nowMs);
  return Math.max(written, decayedRecallHeat(r.recall_heat, r.recall_heat_at, r.category, nowMs));
}

/** Legacy stores read missing heat columns as null; no writes on digest reads. */
export function heatColumns(db: Database): string {
  const have = hasColumn(db, 'memories', 'recall_heat');
  const authored = hasColumn(db, 'memories', 'authored_at') ? 'authored_at' : 'NULL AS authored_at';
  return `created, updated, ${authored}, ${have ? 'recall_heat, recall_heat_at' : 'NULL AS recall_heat, NULL AS recall_heat_at'}`;
}

/**
 * The ids of the `limit` hottest memories a WHERE clause selects, hottest first (ties: newer first).
 * Heat is worked out now, from when each was written and how it has been recalled (heatOf). The
 * stored `salience` column is not read: it is set when a memory is written and nothing refreshes it,
 * so sorting by it in SQL gives the order of writing.
 */
export function hottestIds(db: Database, where: string, args: readonly unknown[], limit: number, nowMs: number): number[] {
  const rows = db
    .prepare(`SELECT id, category, ${heatColumns(db)} FROM memories WHERE ${where}`)
    .all(...args) as Array<HeatInput & { id: number }>;
  return rows
    .map((r) => ({ id: r.id, created: r.created, heat: heatOf(r, nowMs) }))
    .sort((a, b) => b.heat - a.heat || (a.created < b.created ? 1 : a.created > b.created ? -1 : 0) || b.id - a.id)
    .slice(0, limit)
    .map((r) => r.id);
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
  /** Leave out rows whose time has run out. */
  excludeExpired?:boolean;
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
function compareDigestRows(a: DigestRow, b: DigestRow): number {
  const heat = (Number.isFinite(b.salience) ? b.salience : 0) - (Number.isFinite(a.salience) ? a.salience : 0);
  if (heat) return heat;
  // Code-unit comparison is locale-independent; equal authored atoms render identically.
  for (const key of ['category', 'title', 'content', 'sourcing'] as const) {
    const av = a[key] ?? '', bv = b[key] ?? '';
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export function pickForDigest<T extends DigestRow>(rows: T[], opts: DigestOptions = {}): T[] {
  const budgetChars = (opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * (opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const ordered = [...rows].sort(compareDigestRows);
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

/**
 * Every live authored memory (not episodes) with its heat computed NOW from
 * its timestamps, hottest first. The digest reads heat this way instead of
 * trusting the stored field: nothing in this program refreshes the stored
 * field after a memory is written, and when an earlier program's refresh
 * missed days (t-1488, and once before for two months) Top of Mind froze,
 * with ties at 1.0 falling back to write order. Anything that ranks by heat
 * works it out at the read (here, and hottestIds).
 */
function liveRows(db: Database, nowMs: number,excludeExpired=false): Array<DigestRow & { stored: number }> {
  const expiry=excludeExpired&&hasColumn(db,'memories','expires_at')?' AND (expires_at IS NULL OR julianday(expires_at)>julianday(?))':'';
  const rows = db
    .prepare(
      `SELECT title, category, content, salience AS stored, sourcing, ${heatColumns(db)} FROM memories WHERE archived = 0 AND category != ?${expiry}`,
    )
    .all(EPISODE_CATEGORY,...(expiry?[new Date(nowMs).toISOString()]:[])) as Array<Omit<DigestRow, 'salience'> & HeatInput & { stored: number }>;
  return rows
    .map(({ created, updated, authored_at, recall_heat, recall_heat_at, ...r }) => ({
      ...r,
      salience: heatOf({ category: r.category, created, updated, authored_at, recall_heat, recall_heat_at }, nowMs),
    }))
    .sort(compareDigestRows);
}

/** Read-only projection over an explicitly selected, already-owned connection. */
export function digestOnConnection(db: Database, opts: DigestOptions = {}): string | null {
  // Read-only callers leave stores predating salience untouched.
  if (!hasColumn(db, 'memories', 'salience')) return null;
  // Episodes belong to the tape and do not crowd the salience digest.
  const rows = liveRows(db, opts.nowMs ?? Date.now(), opts.excludeExpired).slice(0, 100);
  return assembleDigest(rows, opts);
}
