/**
 * Read-only queries behind loom's own pages: memories with their heat
 * explained, one memory by ref, the memories about a person. Plain SQL over
 * memories.db opened read-only, like the digest; nothing here writes.
 */
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { resolveSqliteDbPath } from '../config.js';
import { DEFAULT_HALF_LIFE_DAYS, HALF_LIVES, pickForDigest, temperature, tierOf, type Tier } from '../backends/salience.js';

const EPISODE = 'episode';

export interface MemoryView {
  ref: string;
  title: string;
  category: string;
  project: string | null;
  content: string;
  sourcing: string | null;
  scope: string | null;
  created: string;
  updated: string | null;
  lastAccessed: string | null;
  expiresAt: string | null;
  timesSeen: number;
  /** The person this memory is about (metadata.person), when tagged. */
  person: string | null;
  /** The stored field, refreshed by the consolidation lane. */
  stored: number;
  /** Heat right now, from the timestamps: what the digest uses. */
  heat: number;
  tier: Tier;
  halfLifeDays: number;
  /** Whether it's in the boot digest: what the agent wakes up holding. */
  inDigest: boolean;
}

interface Row {
  ref: string; title: string; category: string; project: string | null; content: string;
  sourcing: string | null; scope: string | null; created: string; updated: string | null;
  last_accessed: string | null; expires_at: string | null; times_seen: number | null;
  metadata: string | null; salience: number | null;
}

const COLUMNS = 'ref, title, category, project, content, sourcing, scope, created, updated, last_accessed, expires_at, times_seen, metadata, salience';

function open(contextDir: string): BetterSqlite3.Database | null {
  const path = resolveSqliteDbPath(contextDir);
  if (!existsSync(path)) return null;
  const db = new BetterSqlite3(path, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function hasColumns(db: BetterSqlite3.Database): Set<string> {
  return new Set((db.pragma('table_info(memories)') as { name: string }[]).map((c) => c.name));
}

/** Older stores lack some columns; select what exists and default the rest. */
function selectList(db: BetterSqlite3.Database): string {
  const have = hasColumns(db);
  return COLUMNS.split(', ').map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(', ');
}

function personOf(metadata: string | null): string | null {
  try {
    const m = JSON.parse(metadata || '{}') as Record<string, unknown>;
    return typeof m.person === 'string' && m.person ? m.person : null;
  } catch { return null; }
}

function view(r: Row, nowMs: number, inDigest = false): MemoryView {
  const touch = r.last_accessed ?? r.updated ?? r.created;
  const heat = temperature(touch, r.category, nowMs);
  return {
    ref: r.ref, title: r.title, category: r.category, project: r.project, content: r.content,
    sourcing: r.sourcing, scope: r.scope, created: r.created, updated: r.updated,
    lastAccessed: r.last_accessed, expiresAt: r.expires_at, timesSeen: r.times_seen ?? 1,
    person: personOf(r.metadata), stored: r.salience ?? heat, heat, tier: tierOf(heat),
    halfLifeDays: HALF_LIVES[r.category] ?? DEFAULT_HALF_LIFE_DAYS, inDigest,
  };
}

/** Live memories (not episodes) hottest first, each marked with whether the digest carries it. */
export function heatList(contextDir: string, opts: { limit?: number; category?: string; nowMs?: number } = {}): { rows: MemoryView[]; total: number; inDigest: number } {
  const db = open(contextDir);
  if (!db) return { rows: [], total: 0, inDigest: 0 };
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const all = (db.prepare(`SELECT ${selectList(db)} FROM memories WHERE archived = 0 AND category != ?`).all(EPISODE) as Row[])
      .map((r) => view(r, nowMs))
      .sort((a, b) => b.heat - a.heat);
    // The same selection the boot digest makes, so "in the digest" is exact.
    const picked = new Set(pickForDigest(all.map((m) => ({ ...m, salience: m.heat }))).map((m) => m.ref));
    for (const m of all) m.inDigest = picked.has(m.ref);
    const filtered = opts.category ? all.filter((m) => m.category === opts.category) : all;
    return { rows: filtered.slice(0, opts.limit ?? 40), total: all.length, inDigest: picked.size };
  } finally {
    db.close();
  }
}

export function memoryByRef(contextDir: string, ref: string, nowMs = Date.now()): MemoryView | null {
  const db = open(contextDir);
  if (!db) return null;
  try {
    const r = db.prepare(`SELECT ${selectList(db)} FROM memories WHERE ref = ? AND archived = 0`).get(ref) as Row | undefined;
    if (!r) return null;
    const m = view(r, nowMs);
    if (m.category !== EPISODE) {
      m.inDigest = heatList(contextDir, { limit: 400, nowMs }).rows.some((x) => x.ref === ref && x.inDigest);
    }
    return m;
  } finally {
    db.close();
  }
}

/** User memories tagged to a person, newest first. */
export function memoriesAbout(contextDir: string, slug: string, opts: { since?: string | null; limit?: number; nowMs?: number } = {}): MemoryView[] {
  const db = open(contextDir);
  if (!db) return [];
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const rows = db.prepare(
      `SELECT ${selectList(db)} FROM memories
       WHERE category = 'user' AND archived = 0 AND json_extract(metadata, '$.person') = ?
         AND (expires_at IS NULL OR expires_at > ?) AND (? IS NULL OR created > ?)
       ORDER BY created DESC LIMIT ?`,
    ).all(slug, new Date(nowMs).toISOString(), opts.since ?? null, opts.since ?? null, opts.limit ?? 20) as Row[];
    return rows.map((r) => view(r, nowMs));
  } finally {
    db.close();
  }
}

export interface TapeEntry { ref: string; title: string; created: string; where: string }

/** Episodes in the last `hours`, newest first, with where each body was. */
export function tapeRows(contextDir: string, hours: number, nowMs = Date.now()): TapeEntry[] {
  const db = open(contextDir);
  if (!db) return [];
  try {
    const since = new Date(nowMs - hours * 3_600_000).toISOString();
    const rows = db.prepare(
      `SELECT ref, title, created, project, metadata FROM memories
       WHERE category = ? AND archived = 0 AND created >= ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created DESC`,
    ).all(EPISODE, since, new Date(nowMs).toISOString()) as Array<{ ref: string; title: string; created: string; project: string | null; metadata: string | null }>;
    return rows.map((r) => {
      let where = r.project?.trim() || '?';
      try {
        const m = JSON.parse(r.metadata || '{}') as Record<string, unknown>;
        if (typeof m.where === 'string' && m.where.trim()) where = m.where.trim();
      } catch { /* keep the fallback */ }
      return { ref: r.ref, title: r.title, created: r.created, where };
    });
  } finally {
    db.close();
  }
}
