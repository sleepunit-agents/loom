/**
 * The episode tape (t-142) — the short-term, cross-body memory tier.
 *
 * Art runs as many sleeves at once (discord bodies, wakes, lanes, the voice
 * brain, terminals). They share the stack (loom) but not the last few hours:
 * what one body did is invisible to the next unless someone judged it worth a
 * month. Episodes fill that gap. Each body writes a short note — where it was,
 * what was said or decided, what shipped, what's open — as category `episode`
 * with a 48h TTL. At boot every body receives the last 24h of episodes as a
 * plain TIME-ORDERED tape, injected right after identity.
 *
 * Deliberately NOT salience-ranked: salience reheats on recall, so a ranked
 * view surfaces what the last body *searched for*, not what last *happened*.
 * The tape is the wrong place for cleverness — it is just the tape.
 *
 * Like salience, this opens memories.db directly (plain SQL, no embedder) so
 * identity load stays cheap.
 */
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveSqliteDbPath } from '../config.js';
import { EPISODE_CATEGORY } from '../categories.js';

export interface EpisodeRow {
  title: string;
  content: string;
  created: string;
  project: string | null;
  metadata: string;
}

export interface TapeOptions {
  /** Look-back window in hours (default 24). */
  hours?: number;
  /** Approximate token budget for the block (default 1500). Oldest are dropped first. */
  tokenBudget?: number;
  /** Rough chars-per-token for the budget estimate. */
  charsPerToken?: number;
  /** IANA zone for the timestamps (default: TZ env, else America/Chicago). */
  timeZone?: string;
  /** "now" override for tests. */
  nowMs?: number;
}

const DEFAULT_HOURS = 24;
const DEFAULT_TOKEN_BUDGET = 1500;
const DEFAULT_CHARS_PER_TOKEN = 4;
const HOUR_MS = 3_600_000;

function zone(opts: TapeOptions): string {
  return opts.timeZone ?? process.env.LOOM_TIMEZONE ?? process.env.TZ ?? 'America/Chicago';
}

/** "Mon 17:05" in the configured zone — the tape reads as a clock, not ISO. */
export function tapeClock(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d).replace(',', '');
  } catch {
    return iso;
  }
}

/** Where the body was: metadata.where wins, then project, else unknown. */
function whereOf(r: EpisodeRow): string {
  try {
    const meta = JSON.parse(r.metadata || '{}') as Record<string, unknown>;
    if (typeof meta.where === 'string' && meta.where.trim()) return meta.where.trim();
  } catch {
    /* fall through */
  }
  return r.project?.trim() || '?';
}

/** One line per episode — authored content, trimmed to a single line, never synthesized. */
export function episodeLine(r: EpisodeRow, timeZone: string): string {
  const body = r.content.replace(/\s+/g, ' ').trim();
  const clipped = body.length > 600 ? body.slice(0, 597).trimEnd() + '…' : body;
  return `- **${tapeClock(r.created, timeZone)}** [${whereOf(r)}] ${r.title} — ${clipped}`;
}

/**
 * Assemble the tape: oldest→newest, within budget, most-recent kept when over.
 * Pure selection + ordering. Returns null when there are no episodes.
 */
export function assembleTape(rows: EpisodeRow[], opts: TapeOptions = {}): string | null {
  if (rows.length === 0) return null;
  const tz = zone(opts);
  const budgetChars = (opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * (opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const ordered = [...rows].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  const lines = ordered.map((r) => episodeLine(r, tz));

  // Fill from the newest end backwards so the budget drops the OLDEST first.
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (used + line.length > budgetChars && kept.length > 0) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  const head = dropped > 0 ? `_(${dropped} older episode${dropped === 1 ? '' : 's'} omitted for budget)_\n` : '';
  return head + kept.join('\n');
}

function openMemoriesDb(contextDir: string): Database | null {
  const dbPath = resolveSqliteDbPath(contextDir);
  if (!existsSync(dbPath)) return null;
  const db = new BetterSqlite3(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Raw episode rows in the window, oldest first. Empty when there is no store. */
export function episodeRows(contextDir: string, opts: TapeOptions = {}): EpisodeRow[] {
  const db = openMemoriesDb(contextDir);
  if (!db) return [];
  try {
    const now = opts.nowMs ?? Date.now();
    const since = new Date(now - (opts.hours ?? DEFAULT_HOURS) * HOUR_MS).toISOString();
    const nowIso = new Date(now).toISOString();
    return db
      .prepare(
        `SELECT title, content, created, project, metadata FROM memories
         WHERE category = ? AND archived = 0 AND created >= ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created ASC`,
      )
      .all(EPISODE_CATEGORY, since, nowIso) as EpisodeRow[];
  } finally {
    db.close();
  }
}

/**
 * The boot tape for a context: "what happened across all of me in the last
 * N hours", time-ordered. Null when nothing happened (or no store) — the
 * identity block is simply omitted then.
 */
export function tapeForContext(contextDir: string, opts: TapeOptions = {}): string | null {
  return assembleTape(episodeRows(contextDir, opts), opts);
}
