/**
 * Recall observation log — local-only telemetry for memory search.
 *
 * One JSON line per search, appended to `<contextDir>/telemetry/recall.jsonl`.
 * Nothing leaves the machine: it is a file in the agent's own context dir,
 * kept so `loom memory recall-stats` can answer "does recall actually
 * work?" — hit rate, latency, score distribution, what missed. Set
 * `LOOM_RECALL_LOG=0` to turn it off.
 *
 * Writes never throw. A failed write must never fail a search.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTelemetryDir } from '../config.js';
import type { RecallObservation } from './types.js';

export const RECALL_LOG_FILE = 'recall.jsonl';
export const QUERY_MAX_CHARS = 120;

export function recallLogPath(contextDir: string): string {
  return resolve(resolveTelemetryDir(contextDir), RECALL_LOG_FILE);
}

/** `LOOM_RECALL_LOG=0|off|false|no` disables the log; anything else (or unset) keeps it on. */
export function isRecallLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LOOM_RECALL_LOG?.trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/**
 * Append one observation. Synchronous and cheap (one appendFileSync);
 * creates the telemetry dir on first write; swallows every error.
 */
export function appendRecallObservation(
  contextDir: string,
  obs: RecallObservation,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isRecallLogEnabled(env)) return;
  try {
    const dir = resolveTelemetryDir(contextDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line: RecallObservation = { ...obs, query: obs.query.slice(0, QUERY_MAX_CHARS) };
    appendFileSync(resolve(dir, RECALL_LOG_FILE), JSON.stringify(line) + '\n', 'utf-8');
  } catch {
    // Telemetry is best-effort by contract: never let it fail a search.
  }
}

/** Read observations, oldest first. Malformed lines are skipped. */
export function readRecallObservations(
  contextDir: string,
  opts: { since?: Date } = {},
): RecallObservation[] {
  const path = recallLogPath(contextDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const sinceMs = opts.since?.getTime();
  const out: RecallObservation[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obs: RecallObservation;
    try {
      obs = JSON.parse(line) as RecallObservation;
    } catch {
      continue;
    }
    if (typeof obs !== 'object' || obs === null || typeof obs.ts !== 'string') continue;
    if (sinceMs !== undefined && Date.parse(obs.ts) < sinceMs) continue;
    out.push(obs);
  }
  return out;
}

const SINCE_RE = /^(\d+)(m|h|d|w)$/;

/** Parse a `--since` window like "30m", "24h", "7d", "2w" into milliseconds. */
export function parseSinceDuration(spec: string): number {
  const m = spec.trim().match(SINCE_RE);
  if (!m) throw new Error(`Invalid --since "${spec}". Use e.g. 30m, 24h, 7d, 2w.`);
  const n = Number.parseInt(m[1], 10);
  switch (m[2]) {
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default:  return n * 7 * 86_400_000;
  }
}

export interface RecallMiss {
  ts: string;
  tool: RecallObservation['tool'];
  query: string;
  category?: string;
  project?: string;
  candidates: number;
}

export interface RecallStats {
  searches: number;
  hits: number;
  misses: number;
  /** hits / searches, or null when there were no searches. */
  hitRate: number | null;
  medianLatencyMs: number | null;
  /** Median of topScore over hits, or null when there were none. */
  medianTopScore: number | null;
  diversityDrops: number;
  /** Newest first, capped at `recentMisses` (default 10). */
  recentMisses: RecallMiss[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeRecallObservations(
  rows: RecallObservation[],
  opts: { recentMisses?: number } = {},
): RecallStats {
  const cap = opts.recentMisses ?? 10;
  const hits = rows.filter((r) => r.hit);
  const misses = rows.filter((r) => !r.hit);
  return {
    searches: rows.length,
    hits: hits.length,
    misses: misses.length,
    hitRate: rows.length === 0 ? null : hits.length / rows.length,
    medianLatencyMs: median(rows.map((r) => r.latencyMs).filter(Number.isFinite)),
    medianTopScore: median(
      hits.map((r) => r.topScore).filter((s): s is number => typeof s === 'number' && Number.isFinite(s)),
    ),
    diversityDrops: rows.reduce((s, r) => s + (r.diversityDrops || 0), 0),
    recentMisses: misses
      .slice(-cap)
      .reverse()
      .map((r) => ({
        ts: r.ts,
        tool: r.tool,
        query: r.query,
        category: r.category,
        project: r.project,
        candidates: r.candidates,
      })),
  };
}

export function formatRecallStats(stats: RecallStats, windowLabel: string): string {
  const pct = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  const num = (x: number | null, digits: number, unit = ''): string =>
    x === null ? 'n/a' : `${x.toFixed(digits)}${unit}`;
  const lines = [
    `Recall observations (last ${windowLabel}): ${stats.searches} search${stats.searches === 1 ? '' : 'es'}`,
  ];
  if (stats.searches === 0) {
    lines.push('  (nothing logged in this window)');
    return lines.join('\n');
  }
  lines.push(
    `  hit rate         ${stats.hits}/${stats.searches} (${pct(stats.hitRate)})`,
    `  median latency   ${num(stats.medianLatencyMs, 0, ' ms')}`,
    `  median topScore  ${num(stats.medianTopScore, 3)} (hits only)`,
    `  diversity drops  ${stats.diversityDrops} candidate${stats.diversityDrops === 1 ? '' : 's'} displaced by MMR`,
  );
  if (stats.recentMisses.length > 0) {
    lines.push(`Recent misses (newest first):`);
    for (const m of stats.recentMisses) {
      const scope = [
        m.category ? `category=${m.category}` : null,
        m.project ? `project=${m.project}` : null,
      ].filter(Boolean).join(' ');
      lines.push(`  ${m.ts.slice(0, 16).replace('T', ' ')}  "${m.query}"${scope ? `  [${scope}]` : ''}`);
    }
  }
  return lines.join('\n');
}
