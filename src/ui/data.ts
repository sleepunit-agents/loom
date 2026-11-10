/**
 * Read-only queries behind loom's own pages: memories with their heat
 * explained, one memory by ref, the memories about a person. Plain SQL over
 * memories.db opened read-only, like the digest; nothing here writes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from '../sqlite.js';
import type { Database, Statement } from 'better-sqlite3';
import { resolveSqliteDbPath } from '../config.js';
import { plainEpisode, type ConversationFacts } from './episode-title.js';
import { DEFAULT_HALF_LIFE_DAYS, HALF_LIVES, decayedRecallHeat, heatOf, pickForDigest, temperature, tierOf, type Tier } from '../backends/salience.js';

const EPISODE = 'episode';

/** The agent's name: IDENTITY.md's first heading, else the context dir's name. */
export function agentName(contextDir: string): string {
  try {
    const line = readFileSync(join(contextDir, 'IDENTITY.md'), 'utf-8').split('\n').find((l) => /^#\s+\S/.test(l));
    if (line) return line.replace(/^#\s+/, '').trim();
  } catch { /* no identity file */ }
  return contextDir.split('/').filter(Boolean).pop() ?? 'loom';
}
const agentLabelOf = agentName;

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
  /** Where it was learned (metadata.where: "discord:#studio", "wake:w-…"), when recorded. */
  where: string | null;
  /** The stored field, refreshed by the consolidation lane. */
  stored: number;
  /** Heat right now (heatOf): what the digest uses. */
  heat: number;
  /** Its two parts: from being written or edited, and from being recalled. */
  writtenHeat: number;
  recallHeat: number;
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
  recall_heat: number | null; recall_heat_at: string | null;
}

const COLUMNS = 'ref, title, category, project, content, sourcing, scope, created, updated, last_accessed, expires_at, times_seen, metadata, salience, recall_heat, recall_heat_at';

function open(contextDir: string): Database | null {
  const path = resolveSqliteDbPath(contextDir);
  if (!existsSync(path)) return null;
  const db = new BetterSqlite3(path, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function hasColumns(db: Database): Set<string> {
  return new Set((db.pragma('table_info(memories)') as { name: string }[]).map((c) => c.name));
}

/** Older stores lack some columns; select what exists and default the rest. */
function selectList(db: Database): string {
  const have = hasColumns(db);
  return COLUMNS.split(', ').map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(', ');
}

/** A where's surface: "slack" for "slack:dm:pat", "wake" for "wake:w-1a2b3c". */
export function surfaceOf(where: string): string {
  return where.split(/[:/]/)[0] || '?';
}

const SURFACES: Record<string, string> = { slack: 'Slack', discord: 'Discord', wake: 'Wake', web: 'Web', cli: 'Terminal', mcp: 'MCP' };

/** A where as a person says it: "Slack DM · Patrick Kells", "Discord #pond", "Wake". */
export function whereLabel(where: string): string {
  if (!where || where === '?') return '';
  const [surface, ...rest] = where.split(':');
  const name = SURFACES[surface] ?? (surface ? surface[0].toUpperCase() + surface.slice(1) : where);
  if (surface === 'wake') return name;
  // Comms: a thread's place is its id, never shown.
  if (surface === 'loom') return 'Comms';
  if (rest[0] === 'dm' && rest[1]) return `${name} DM · ${rest.slice(1).join(':').split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')}`;
  return rest.length ? `${name} ${rest.join(':')}` : name;
}

function whereOf(metadata: string | null): string | null {
  try {
    const m = JSON.parse(metadata || '{}') as Record<string, unknown>;
    return typeof m.where === 'string' && m.where ? m.where : null;
  } catch { return null; }
}

function personOf(metadata: string | null): string | null {
  try {
    const m = JSON.parse(metadata || '{}') as Record<string, unknown>;
    return typeof m.person === 'string' && m.person ? m.person : null;
  } catch { return null; }
}

function view(r: Row, nowMs: number, inDigest = false): MemoryView {
  const heat = heatOf(r, nowMs);
  const writtenHeat = temperature(r.updated ?? r.created, r.category, nowMs);
  const recallHeat = decayedRecallHeat(r.recall_heat, r.recall_heat_at, r.category, nowMs);
  return {
    ref: r.ref, title: r.title, category: r.category, project: r.project, content: r.content,
    sourcing: r.sourcing, scope: r.scope, created: r.created, updated: r.updated,
    lastAccessed: r.last_accessed, expiresAt: r.expires_at, timesSeen: r.times_seen ?? 1,
    person: personOf(r.metadata), where: whereOf(r.metadata), stored: r.salience ?? heat, heat, writtenHeat, recallHeat, tier: tierOf(heat),
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

export interface Revision { content: string; op: string; at: string }

/**
 * A memory's earlier bodies, newest first: each is what it said until `at`,
 * when an edit (op "update") or a rollback ("revision-restore") replaced it.
 */
export function memoryHistory(contextDir: string, ref: string, limit = 10): Revision[] {
  const db = open(contextDir);
  if (!db) return [];
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_revisions'").get();
    if (!has) return [];
    return (db.prepare('SELECT content, op, replaced_at AS at FROM memory_revisions WHERE ref = ? ORDER BY replaced_at DESC, id DESC LIMIT ?').all(ref, limit) as Revision[]);
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

export interface TapeEntry { ref: string; title: string; created: string; where: string;
  /** The conversation it belongs to, when it names one (a body the runtime started in one). */
  conversation?: string;
  /** Its body, when asked for (tapeRows' `withContent`). */
  content?: string;
  /** Its metadata, parsed. */
  meta?: Record<string, unknown> }

/** The conversations table's row an episode names, from the same store (memories.db holds both). */
function conversationLookup(db: Database): (id: string) => ConversationFacts | undefined {
  let q: Statement | null | undefined;
  return (id) => {
    if (q === undefined) {
      try { q = db.prepare('SELECT venue, place, label FROM conversations WHERE id = ?'); } catch { q = null; }
    }
    return (q?.get(id) as ConversationFacts | undefined) ?? undefined;
  };
}

/**
 * Episodes in the last `hours`, newest first, with where each body was. A title that is a body's prompt (a runtime
 * spawn's preamble, kept by a harness's fallback episode) is never returned: the conversation's label stands in for it
 * (episode-title.ts), and its where is the conversation's venue.
 */
export function tapeRows(contextDir: string, hours: number, nowMs = Date.now(), opts: { until?: number; withContent?: boolean } = {}): TapeEntry[] {
  const db = open(contextDir);
  if (!db) return [];
  try {
    const since = new Date(nowMs - hours * 3_600_000).toISOString();
    const until = opts.until ? new Date(opts.until).toISOString() : null;
    const rows = db.prepare(
      `SELECT ref, title, created, project, metadata, substr(content, 1, ?) AS content FROM memories
       WHERE category = ? AND archived = 0 AND created >= ? AND (? IS NULL OR created < ?) AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created DESC`,
    ).all(opts.withContent ? 20_000 : 600, EPISODE, since, until, until, new Date(nowMs).toISOString()) as Array<{ ref: string; title: string; created: string; project: string | null; metadata: string | null; content: string | null }>;
    const conv = conversationLookup(db);
    const label = agentLabelOf(contextDir);
    return rows.map((r) => {
      let where = r.project?.trim() || '?';
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(r.metadata || '{}') as Record<string, unknown>;
        if (typeof meta.where === 'string' && meta.where.trim()) where = meta.where.trim();
      } catch { /* keep the fallback */ }
      const p = plainEpisode({ title: r.title, content: r.content, where, meta }, label, conv);
      return { ref: r.ref, title: p.title, created: r.created, where: p.where, ...(p.conversation ? { conversation: p.conversation } : {}),
        ...(opts.withContent ? { content: r.content ?? '', meta } : {}) };
    });
  } finally {
    db.close();
  }
}
