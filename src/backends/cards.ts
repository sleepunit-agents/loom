/**
 * What person cards and project cards share (docs/specs/person-cards.md,
 * docs/specs/projects.md: "as person cards").
 *
 * A card is current state: one JSON object per slug, overwritten in place,
 * the past only in a revisions table. Both kinds follow the same rules for
 * validation primitives, `where` envelopes and their staleness markers, merge
 * one level deep, no-op detection (canonical JSON), timestamps (`updated`;
 * `synthesized_at`, moved by passing `summary`), archive/restore tombstones,
 * revisions (newest 10 per slug) and atomicity (one BEGIN IMMEDIATE
 * transaction per mutation). This module is those rules once; people.ts and
 * projects.ts add their own shape, render and side tables.
 */
import type { Database } from 'better-sqlite3';
import { pathSegmentError } from '../path-safety.js';
import { retryWrite } from './retry.js';

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Every rejection a card surface makes. The message names the path. */
export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardError';
  }
}

export function fail(message: string): never {
  throw new CardError(message);
}

// ─── Validation primitives ───────────────────────────────────────────────────

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const FIELD_RE = /^[a-z0-9_]+$/;
export const MAX_FIELD_NAME = 32;
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const DEFAULT_STALE_DAYS = 14;
export const MAX_REVISIONS = 10;
const SKEW_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The harness's gating names. Fixed here, not configured: a card that carried
 * one would look like a gate, and the agent writes its own cards.
 */
export const RESERVED_KEYS = ['tier', 'field', 'projects', 'scope', 'trust'] as const;
export const isReserved = (k: string) => (RESERVED_KEYS as readonly string[]).includes(k);

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Null when `slug` is a valid card slug of at most `max` chars, else the reason. Never echoes an over-long slug. */
export function slugError(slug: unknown, max: number): string | null {
  if (typeof slug !== 'string' || slug === '') return 'slug is required';
  if (slug.length > max) return `slug is longer than ${max} chars`;
  const segment = pathSegmentError(slug, 'slug');
  if (segment) return segment;
  if (!SLUG_RE.test(slug)) return `slug "${slug}" must match ${SLUG_RE.source}`;
  return null;
}

/** Reject a `null` anywhere under `node`, naming the path. */
export function assertNoNull(node: unknown, path: string): void {
  if (node === null) fail(`${path}: null is not allowed here`);
  if (Array.isArray(node)) node.forEach((v, i) => assertNoNull(v, `${path}[${i}]`));
  else if (isPlainObject(node)) for (const [k, v] of Object.entries(node)) assertNoNull(v, `${path}.${k}`);
}

export function checkString(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') fail(`${path}: must be a string`);
  if (v.length > max) fail(`${path}: longer than ${max} chars (${v.length})`);
  return v;
}

/** Names FIELD_RE admits that would reach Object.prototype through a plain-object assignment. */
const PROTO_NAMES = ['__proto__', 'constructor', 'prototype'];

export function checkFieldName(name: string, path: string): void {
  if (!FIELD_RE.test(name) || name.length > MAX_FIELD_NAME) {
    fail(`${path}: field name must match ${FIELD_RE.source} and be at most ${MAX_FIELD_NAME} chars`);
  }
  if (PROTO_NAMES.includes(name)) fail(`${path}: "${name}" is not allowed as a field name`);
}

export function checkVerifiedAt(v: unknown, path: string, nowMs: number | null): void {
  const s = checkString(v, path, 200);
  if (!ISO_UTC_RE.test(s) || Number.isNaN(Date.parse(s))) {
    fail(`${path}: must be an ISO-8601 UTC timestamp (e.g. 2026-10-19T14:00:00Z)`);
  }
  if (nowMs !== null && Date.parse(s) > nowMs + SKEW_MS) fail(`${path}: is in the future`);
}

/**
 * A `where` envelope: `value` (checked by the card kind's `checkValue`),
 * optional `verified_at`, `source` and `stale_after_days`, plus any extra
 * string keys the kind allows (person cards' `label`).
 */
export function checkEnvelope(
  env: unknown,
  path: string,
  nowMs: number | null,
  opts: { checkValue: (v: unknown, path: string) => void; extraStringKeys?: readonly string[] },
): void {
  const allowed = ['value', 'verified_at', 'source', 'stale_after_days', ...(opts.extraStringKeys ?? [])];
  if (!isPlainObject(env)) fail(`${path}: must be an object with a "value"`);
  for (const k of Object.keys(env)) {
    if (!allowed.includes(k)) fail(`${path}.${k}: unknown envelope key (allowed: ${allowed.join(', ')})`);
  }
  if (!('value' in env)) fail(`${path}.value: is required`);
  opts.checkValue(env.value, `${path}.value`);
  if ('verified_at' in env) checkVerifiedAt(env.verified_at, `${path}.verified_at`, nowMs);
  if ('source' in env) checkString(env.source, `${path}.source`, 200);
  for (const k of opts.extraStringKeys ?? []) if (k in env) checkString(env[k], `${path}.${k}`, 200);
  if ('stale_after_days' in env) {
    const d = env.stale_after_days;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 365) {
      fail(`${path}.stale_after_days: must be an integer 1–365`);
    }
  }
}

// ─── Staleness and rendering ─────────────────────────────────────────────────

export interface EnvelopeBase {
  verified_at?: string;
  stale_after_days?: number;
}

export type FieldState = { kind: 'ok' } | { kind: 'unverified' } | { kind: 'stale'; days: number };

/** Stale when now − verified_at > stale_after_days × 86,400 s (strictly greater). */
export function fieldState(env: EnvelopeBase, nowMs: number): FieldState {
  if (!env.verified_at) return { kind: 'unverified' };
  const age = nowMs - Date.parse(env.verified_at);
  const limit = (env.stale_after_days ?? DEFAULT_STALE_DAYS) * DAY_MS;
  if (age > limit) return { kind: 'stale', days: Math.floor(age / DAY_MS) };
  return { kind: 'ok' };
}

/** The widest marker: what the write-time cap counts every `where` field at. */
export const WORST_MARKER = '[STALE 999+d]';

export function marker(state: FieldState): string {
  if (state.kind === 'ok') return '[ok]';
  if (state.kind === 'unverified') return '[unverified]';
  return `[STALE ${state.days > 999 ? '999+' : state.days}d]`;
}

export const oneLine = (s: string) => s.replace(/\r?\n|\r/g, ' ');

export const byName = <T>(o: Record<string, T>) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The `**Where:** a: v [ok] · b: w [unverified]` line, fields in name order, or
 * null for an empty section. `text` renders one field's value part.
 */
export function renderWhereLine<E extends EnvelopeBase>(
  where: Record<string, E>,
  nowMs: number,
  worstCase: boolean,
  text: (env: E) => string,
): string | null {
  const fields = byName(where ?? {});
  if (!fields.length) return null;
  return (
    '**Where:** ' +
    fields
      .map(([n, env]) => `${n}: ${text(env)} ${worstCase ? WORST_MARKER : marker(fieldState(env, nowMs))}`)
      .join(' · ')
  );
}

/** Stale and unverified field counts, for a list. */
export function whereCounts(where: Record<string, EnvelopeBase>, nowMs: number): { stale: number; unverified: number } {
  let stale = 0;
  let unverified = 0;
  for (const env of Object.values(where ?? {})) {
    const s = fieldState(env, nowMs);
    if (s.kind === 'stale') stale++;
    if (s.kind === 'unverified') unverified++;
  }
  return { stale, unverified };
}

/** Canonical JSON with sorted keys — the no-op comparison. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Merge one level deep: a key passed replaces that key's whole value, a key passed as null is removed. */
export function mergeLevel(current: Record<string, unknown> | undefined, passed: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...(current ?? {}) };
  for (const [n, v] of Object.entries(passed)) {
    if (v === null) delete merged[n];
    else merged[n] = v;
  }
  return merged;
}

/** A section with its null deletes dropped: a merge write that creates has nothing to remove. */
export function withoutNulls(section: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(section ?? {}).filter(([, v]) => v !== null));
}

/**
 * Stamp `where` fields as checked (person_verify, project_verify): sets
 * `verified_at` and, if passed, `source`. All-or-nothing: an unknown field
 * rejects the whole call. Returns a new card.
 */
export function stampWhere<C extends { where: Record<string, EnvelopeBase & { source?: string }> }>(
  card: C,
  fields: unknown[],
  verifiedAt: string,
  source: string | undefined,
  slug: string,
): C {
  for (const f of fields) {
    // Own properties only: `in` would accept an inherited name like
    // __proto__ and stamp Object.prototype (PR143 review).
    if (typeof f !== 'string' || !Object.hasOwn(card.where, f)) {
      fail(`fields: "${String(f)}" is not a where field on ${slug}`);
    }
  }
  const next = structuredClone(card);
  for (const f of fields as string[]) {
    next.where[f].verified_at = verifiedAt;
    if (source !== undefined) next.where[f].source = source;
  }
  return next;
}

// ─── The row store ───────────────────────────────────────────────────────────

export function hasTable(db: Database, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

export type RevisionOp = 'write' | 'verify' | 'archive' | 'restore' | 'revision_restore' | 'split';

/** The columns every card table has. A kind may add its own (projects' `status`). */
export interface CardRowBase {
  slug: string;
  name: string;
  card_json: string;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  updated: string;
  synthesized_at: string | null;
}

export interface RevisionMeta {
  id: number;
  op: RevisionOp;
  replaced_at: string;
  /** The agent whose change this revision records (null before households). */
  actor?: string | null;
}

/** How a kind names its cards in rejections: "no card for x" / "no project x". */
export interface CardNoun {
  missing: (slug: string) => string;
  archived: (slug: string, verb: string) => string;
  /** The rejection for a revision that belongs to another slug. */
  otherRevision: (id: number, slug: string) => string;
}

const BASE_COLUMNS = ['slug', 'name', 'card_json', 'archived_at', 'archived_by', 'archive_reason', 'updated', 'synthesized_at'];

/**
 * One card table plus its revisions table, on an open database. Every
 * mutation runs inside `mutate` (BEGIN IMMEDIATE, retried whole on
 * SQLITE_BUSY), so its reads see the row it then writes.
 */
export class CardTable<R extends CardRowBase> {
  private readonly columns: string[];
  readonly selectRowSql: string;

  constructor(
    readonly db: Database,
    private readonly spec: { table: string; revisions: string; extraColumns?: readonly string[]; noun: CardNoun },
    private readonly actor: string | null,
  ) {
    // The base columns' order is load-bearing: write-race tests hook the
    // row read by its `SELECT slug, name, card_json` prefix.
    this.columns = [...BASE_COLUMNS, ...(spec.extraColumns ?? [])];
    this.selectRowSql = `SELECT ${this.columns.join(', ')} FROM ${spec.table} WHERE slug = ?`;
  }

  get noun(): CardNoun {
    return this.spec.noun;
  }

  readRow(slug: string): R | undefined {
    return this.db.prepare(this.selectRowSql).get(slug) as R | undefined;
  }

  /** Every row, active only unless `includeArchived`, by slug. */
  allRows(includeArchived: boolean): R[] {
    return this.db
      .prepare(
        `SELECT ${this.columns.join(', ')} FROM ${this.spec.table}
         ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY slug`,
      )
      .all() as R[];
  }

  /** Snapshot the whole previous row before a change, then prune to the newest MAX_REVISIONS for the slug. */
  snapshot(prev: R, op: RevisionOp, at: string): number {
    const snap = { ...prev, card: JSON.parse(prev.card_json) as unknown } as unknown as Record<string, unknown>;
    delete snap.card_json;
    const rev = this.spec.revisions;
    const id = Number(
      this.db
        .prepare(`INSERT INTO ${rev} (slug, snapshot_json, op, replaced_at, actor) VALUES (?, ?, ?, ?, ?)`)
        .run(prev.slug, JSON.stringify(snap), op, at, this.actor).lastInsertRowid,
    );
    this.db
      .prepare(`DELETE FROM ${rev} WHERE slug = ? AND id NOT IN (SELECT id FROM ${rev} WHERE slug = ? ORDER BY id DESC LIMIT ?)`)
      .run(prev.slug, prev.slug, MAX_REVISIONS);
    return id;
  }

  store(row: R): void {
    const cols = this.columns;
    this.db
      .prepare(
        `INSERT INTO ${this.spec.table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
         ON CONFLICT(slug) DO UPDATE SET ${cols.filter((c) => c !== 'slug').map((c) => `${c} = excluded.${c}`).join(', ')}`,
      )
      .run(row);
  }

  /** One BEGIN IMMEDIATE transaction around `fn`, retried as a whole on SQLITE_BUSY. */
  mutate<T>(fn: () => T): T {
    return retryWrite(() => this.db.transaction(fn).immediate());
  }

  requireActive(slug: string, verb: string): R {
    const row = this.readRow(slug);
    if (!row) fail(this.spec.noun.missing(slug));
    if (row.archived_at !== null) fail(this.spec.noun.archived(slug, verb));
    return row;
  }

  /**
   * Store a written card: the no-op check, the snapshot and the timestamps.
   * A write whose card equals the current one and that does not pass
   * `summary` is a no-op (nothing stored, nothing snapshotted). Passing
   * `summary` moves `synthesized_at`; a merge: false write without it resets
   * `synthesized_at` to null.
   */
  commitWrite(args: {
    existing: R | undefined;
    current: unknown;
    next: Record<string, unknown>;
    passedSummary: boolean;
    merge: boolean;
    at: string;
    /** The kind's own columns, derived from the next card. */
    extra?: Partial<R>;
  }): { row: R; unchanged: boolean; revisionId: number | null } {
    const { existing, current, next, passedSummary, merge, at } = args;
    if (existing && current && !passedSummary && canonical(next) === canonical(current)) {
      return { row: existing, unchanged: true, revisionId: null };
    }
    const revisionId = existing ? this.snapshot(existing, 'write', at) : null;
    const synthesizedAt = passedSummary ? at : !merge ? null : (existing?.synthesized_at ?? null);
    const row = {
      ...(args.extra ?? {}),
      slug: next.slug as string,
      name: next.name as string,
      card_json: JSON.stringify(next),
      archived_at: null,
      archived_by: null,
      archive_reason: null,
      updated: at,
      synthesized_at: synthesizedAt,
    } as R;
    this.store(row);
    return { row, unchanged: false, revisionId };
  }

  /** A verify's result: a no-op when nothing changed, else a `verify` snapshot. */
  commitVerify(existing: R, current: unknown, next: unknown, at: string): { row: R; unchanged: boolean; revisionId: number | null } {
    if (canonical(next) === canonical(current)) return { row: existing, unchanged: true, revisionId: null };
    const revisionId = this.snapshot(existing, 'verify', at);
    const row = { ...existing, card_json: JSON.stringify(next), updated: at };
    this.store(row);
    return { row, unchanged: false, revisionId };
  }

  /**
   * Soft-retire with a tombstone. Archiving an archived card is a no-op; a
   * missing one is rejected. `before` runs inside the transaction before the
   * row changes (projects free their names there).
   */
  archive(slug: string, reason: string, actor: string, at: string, before?: (row: R) => void): { row: R; unchanged: boolean; revisionId: number | null } {
    const existing = this.readRow(slug);
    if (!existing) fail(this.spec.noun.missing(slug));
    if (existing.archived_at !== null) return { row: existing, unchanged: true, revisionId: null };
    before?.(existing);
    const revisionId = this.snapshot(existing, 'archive', at);
    const row = { ...existing, archived_at: at, archived_by: actor, archive_reason: reason, updated: at };
    this.store(row);
    return { row, unchanged: false, revisionId };
  }

  /** Reactivate, fields intact. Restoring an active card is a no-op. `before` may reject (projects re-check names). */
  restore(slug: string, at: string, before?: (row: R) => void): { row: R; unchanged: boolean; revisionId: number | null } {
    const existing = this.readRow(slug);
    if (!existing) fail(this.spec.noun.missing(slug));
    if (existing.archived_at === null) return { row: existing, unchanged: true, revisionId: null };
    before?.(existing);
    const revisionId = this.snapshot(existing, 'restore', at);
    const row = { ...existing, archived_at: null, archived_by: null, archive_reason: null, updated: at };
    this.store(row);
    return { row, unchanged: false, revisionId };
  }

  /**
   * Put a card back to a revision. Rejects another slug's revision, validates
   * the snapshot's card structurally (`validate`, no time checks: it was valid
   * when written), snapshots what it displaces, keeps archive state, and
   * takes the snapshot's `synthesized_at`.
   */
  revisionRestore(
    slug: string,
    revisionId: number,
    at: string,
    validate: (card: unknown) => void,
    extra?: (card: Record<string, unknown>) => Partial<R>,
  ): { row: R; unchanged: boolean; revisionId: number | null; card: Record<string, unknown> } {
    const existing = this.requireActive(slug, 'restoring a revision');
    const rev = this.db
      .prepare(`SELECT slug, snapshot_json FROM ${this.spec.revisions} WHERE id = ?`)
      .get(revisionId) as { slug: string; snapshot_json: string } | undefined;
    if (!rev) fail(`revision ${revisionId} not found`);
    if (rev.slug !== slug) fail(this.spec.noun.otherRevision(revisionId, slug));
    const snap = JSON.parse(rev.snapshot_json) as { card: unknown; synthesized_at: string | null };
    validate(snap.card);
    const card = snap.card as Record<string, unknown>;
    if (card.slug !== slug) fail(`revision ${revisionId} holds a card for another slug`);
    const cardJson = JSON.stringify(card);
    const synthesizedAt = snap.synthesized_at ?? null;
    if (cardJson === existing.card_json && synthesizedAt === existing.synthesized_at) {
      return { row: existing, unchanged: true, revisionId: null, card };
    }
    const id = this.snapshot(existing, 'revision_restore', at);
    const row = { ...existing, ...(extra?.(card) ?? {}), name: card.name as string, card_json: cardJson, synthesized_at: synthesizedAt, updated: at };
    this.store(row);
    return { row, unchanged: false, revisionId: id, card };
  }

  history(slug: string): RevisionMeta[] {
    const rev = this.spec.revisions;
    const hasActor = (this.db.pragma(`table_info(${rev})`) as { name: string }[]).some((c) => c.name === 'actor');
    return this.db
      .prepare(`SELECT id, op, replaced_at${hasActor ? ', actor' : ''} FROM ${rev} WHERE slug = ? ORDER BY id DESC`)
      .all(slug) as RevisionMeta[];
  }

  revisionSnapshot<S>(id: number): S | null {
    const rev = this.db.prepare(`SELECT snapshot_json FROM ${this.spec.revisions} WHERE id = ?`).get(id) as
      | { snapshot_json: string }
      | undefined;
    return rev ? (JSON.parse(rev.snapshot_json) as S) : null;
  }
}
