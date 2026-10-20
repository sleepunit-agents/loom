/**
 * Person cards — the condensed current state of a human the agent works with
 * (docs/specs/person-cards.md, t-1376).
 *
 * A card is current state: one value per field, overwritten in place. The past
 * lives only in person_revisions (audit and undo, never read at boot). A card
 * is not a knowledge page and not the memories it condenses: the tagged `user`
 * memories stay the evidence, and stay what recall searches.
 *
 * The card is NOT an authorization surface. The agent writes its own cards, so
 * `may` entries are a record of what was said, never a grant, and the
 * harness's gating names (RESERVED_KEYS) cannot appear on a card at all.
 *
 * Storage is the memory database (resolveSqliteDbPath), opened raw like
 * proposals.ts — no embedder. Every mutation is one BEGIN IMMEDIATE
 * transaction (read, merge, validate, snapshot, write, prune), the pattern of
 * SqliteKnowledgeBackend.writePage: loom's one-writer rule is about *who*
 * writes, so the transaction is what serializes concurrent bodies.
 */
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveSqliteDbPath } from '../config.js';
import { pathSegmentError } from '../path-safety.js';
import { MIGRATIONS } from './migrations.js';
import { retryWrite } from './retry.js';

// ─── Limits (the spec's Shape and Rendering sections) ────────────────────────

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SLUG = 64;
const MAX_NAME = 80;
const MAX_SUMMARY = 1200;
const FIELD_RE = /^[a-z0-9_]+$/;
const MAX_FIELD_NAME = 32;
const MAX_FIELDS = 12;
const MAX_STRING = 200;
const MAX_ARRAY = 8;
const MAX_MAY = 8;
const DEFAULT_STALE_DAYS = 14;
export const MAX_RENDER = 2000;
const MAX_REVISIONS = 10;
const SKEW_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The harness's gating names. Fixed here, not configured: a card that carried
 * one would look like a gate, and the agent writes its own cards.
 */
export const RESERVED_KEYS = ['tier', 'field', 'projects', 'scope', 'trust'] as const;

const TOP_KEYS = ['slug', 'name', 'summary', 'where', 'how', 'may'];
const WRITE_KEYS = [...TOP_KEYS, 'merge'];
const ENVELOPE_KEYS = ['value', 'verified_at', 'source', 'stale_after_days'];
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ─── Types ───────────────────────────────────────────────────────────────────

export type CardValue = string | number | boolean | string[];

export interface WhereEnvelope {
  value: CardValue;
  verified_at?: string;
  source?: string;
  stale_after_days?: number;
}

export interface MayEntry {
  text: string;
  source: string;
}

export interface PersonCard {
  slug: string;
  name: string;
  summary?: string;
  where: Record<string, WhereEnvelope>;
  how: Record<string, CardValue>;
  may: MayEntry[];
}

export interface PersonWriteInput {
  slug: string;
  name?: string;
  summary?: string;
  where?: Record<string, WhereEnvelope | null>;
  how?: Record<string, CardValue | null>;
  may?: MayEntry[];
  merge?: boolean;
}

export interface PersonRow {
  slug: string;
  name: string;
  card: PersonCard;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  updated: string;
  synthesized_at: string | null;
}

export interface MutationResult {
  card: PersonCard;
  unchanged: boolean;
  revision_id: number | null;
  archived: boolean;
  updated: string;
  synthesized_at: string | null;
}

export type PersonReadResult =
  | { found: false }
  | { found: true; archived: true }
  | {
      found: true;
      rendered: string;
      card: PersonCard;
      archived: boolean;
      updated: string;
      synthesized_at: string | null;
    };

export interface PersonListEntry {
  slug: string;
  name: string;
  archived: boolean;
  updated: string;
  synthesized_at: string | null;
  stale: number;
  unverified: number;
  memories_since_synthesis: number;
}

export interface PersonRevisionMeta {
  id: number;
  op: RevisionOp;
  replaced_at: string;
}

export type RevisionOp = 'write' | 'verify' | 'archive' | 'restore' | 'revision_restore';

/** Every rejection the people surface makes. The message names the path. */
export class PersonCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonCardError';
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Null when `slug` is a valid person slug, else the reason. Never echoes an over-long slug. */
export function personSlugError(slug: unknown): string | null {
  if (typeof slug !== 'string' || slug === '') return 'slug is required';
  if (slug.length > MAX_SLUG) return `slug is longer than ${MAX_SLUG} chars`;
  const segment = pathSegmentError(slug, 'slug');
  if (segment) return segment;
  if (!SLUG_RE.test(slug)) return `slug "${slug}" must match ${SLUG_RE.source}`;
  return null;
}

function fail(message: string): never {
  throw new PersonCardError(message);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reject a reserved key anywhere under `node`, naming it. Runs before shape checks. */
function assertNoReserved(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertNoReserved(v, `${path}[${i}]`));
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if ((RESERVED_KEYS as readonly string[]).includes(k)) {
      fail(
        `${path}.${k}: "${k}" is a reserved key (harness gating names: ${RESERVED_KEYS.join(', ')}). ` +
        'A card is not an authorization surface; gates stay in the harness.',
      );
    }
    assertNoReserved(v, `${path}.${k}`);
  }
}

/** Reject a `null` anywhere under `node`, naming the path. */
function assertNoNull(node: unknown, path: string): void {
  if (node === null) fail(`${path}: null is not allowed here`);
  if (Array.isArray(node)) node.forEach((v, i) => assertNoNull(v, `${path}[${i}]`));
  else if (isPlainObject(node)) for (const [k, v] of Object.entries(node)) assertNoNull(v, `${path}.${k}`);
}

function checkString(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') fail(`${path}: must be a string`);
  if (v.length > max) fail(`${path}: longer than ${max} chars (${v.length})`);
  return v;
}

function checkValue(v: unknown, path: string): void {
  if (typeof v === 'string') {
    checkString(v, path, MAX_STRING);
  } else if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${path}: must be a finite number`);
  } else if (typeof v === 'boolean') {
    // ok
  } else if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY) fail(`${path}: more than ${MAX_ARRAY} items`);
    v.forEach((item, i) => checkString(item, `${path}[${i}]`, MAX_STRING));
  } else {
    fail(`${path}: must be a string, number, boolean, or array of strings`);
  }
}

function checkFieldName(name: string, path: string): void {
  if (!FIELD_RE.test(name) || name.length > MAX_FIELD_NAME) {
    fail(`${path}: field name must match ${FIELD_RE.source} and be at most ${MAX_FIELD_NAME} chars`);
  }
}

function checkVerifiedAt(v: unknown, path: string, nowMs: number | null): void {
  const s = checkString(v, path, MAX_STRING);
  if (!ISO_UTC_RE.test(s) || Number.isNaN(Date.parse(s))) {
    fail(`${path}: must be an ISO-8601 UTC timestamp (e.g. 2026-10-19T14:00:00Z)`);
  }
  if (nowMs !== null && Date.parse(s) > nowMs + SKEW_MS) fail(`${path}: is in the future`);
}

function checkEnvelope(env: unknown, path: string, nowMs: number | null): void {
  if (!isPlainObject(env)) fail(`${path}: must be an object with a "value"`);
  for (const k of Object.keys(env)) {
    if (!ENVELOPE_KEYS.includes(k)) fail(`${path}.${k}: unknown envelope key (allowed: ${ENVELOPE_KEYS.join(', ')})`);
  }
  if (!('value' in env)) fail(`${path}.value: is required`);
  checkValue(env.value, `${path}.value`);
  if ('verified_at' in env) checkVerifiedAt(env.verified_at, `${path}.verified_at`, nowMs);
  if ('source' in env) checkString(env.source, `${path}.source`, MAX_STRING);
  if ('stale_after_days' in env) {
    const d = env.stale_after_days;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 365) {
      fail(`${path}.stale_after_days: must be an integer 1–365`);
    }
  }
}

/**
 * Validate a complete card: keys, types, lengths and the worst-case render
 * cap. `nowMs` adds the time checks (no future verified_at); pass null to skip
 * them, which revision restore does — the snapshot was valid when written.
 */
export function validateCard(card: unknown, nowMs: number | null): asserts card is PersonCard {
  if (!isPlainObject(card)) fail('card: must be an object');
  assertNoReserved(card, 'card');
  assertNoNull(card, 'card');
  for (const k of Object.keys(card)) {
    if (!TOP_KEYS.includes(k)) fail(`${k}: unknown top-level key (allowed: ${TOP_KEYS.join(', ')})`);
  }
  const slugErr = personSlugError(card.slug);
  if (slugErr) fail(`slug: ${slugErr}`);
  const name = checkString(card.name, 'name', MAX_NAME);
  if (name.trim() === '') fail('name: must not be empty');
  if ('summary' in card) {
    const summary = checkString(card.summary, 'summary', MAX_SUMMARY);
    if (summary.trim() === '') fail('summary: must not be empty (a merge: false write without summary removes it)');
  }
  for (const section of ['where', 'how'] as const) {
    const fields = card[section];
    if (!isPlainObject(fields)) fail(`${section}: must be an object`);
    const names = Object.keys(fields);
    if (names.length > MAX_FIELDS) fail(`${section}: more than ${MAX_FIELDS} fields`);
    for (const n of names) {
      checkFieldName(n, `${section}.${n}`);
      if (section === 'where') checkEnvelope(fields[n], `where.${n}`, nowMs);
      else checkValue(fields[n], `how.${n}`);
    }
  }
  if (!Array.isArray(card.may)) fail('may: must be an array');
  if (card.may.length > MAX_MAY) fail(`may: more than ${MAX_MAY} entries`);
  card.may.forEach((entry, i) => {
    const path = `may[${i}]`;
    if (!isPlainObject(entry)) fail(`${path}: must be {text, source}`);
    for (const k of Object.keys(entry)) {
      if (k !== 'text' && k !== 'source') fail(`${path}.${k}: unknown key (allowed: text, source)`);
    }
    if (!('text' in entry)) fail(`${path}.text: is required`);
    if (!('source' in entry)) fail(`${path}.source: is required — a may entry records who said it`);
    checkString(entry.text, `${path}.text`, MAX_STRING);
    checkString(entry.source, `${path}.source`, MAX_STRING);
  });
  const worst = renderCard(card as unknown as PersonCard, 0, { worstCase: true }).length;
  if (worst > MAX_RENDER) {
    fail(`card: worst-case render is ${worst} chars, over the ${MAX_RENDER}-char cap (every where marker counted as [STALE 999+d])`);
  }
}

/** Where `null` may appear in a write request: only as a field directly under where/how, in a merge write. */
function validateWriteNulls(input: Record<string, unknown>, merge: boolean): void {
  for (const k of TOP_KEYS) {
    if (k in input && input[k] === null) {
      fail(`${k}: null is not allowed${k === 'where' || k === 'how' || k === 'may' ? ' (use merge: false to clear a section)' : ''}`);
    }
  }
  if (!merge) {
    assertNoNull(input, 'input');
    return;
  }
  for (const section of ['where', 'how'] as const) {
    const fields = input[section];
    if (!isPlainObject(fields)) continue;
    for (const [n, v] of Object.entries(fields)) {
      if (v !== null) assertNoNull(v, `${section}.${n}`);
    }
  }
  if ('may' in input) assertNoNull(input.may, 'may');
  for (const k of ['name', 'summary']) if (k in input) assertNoNull(input[k], k);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export type FieldState = { kind: 'ok' } | { kind: 'unverified' } | { kind: 'stale'; days: number };

/** Stale when now − verified_at > stale_after_days × 86,400 s (strictly greater). */
export function fieldState(env: WhereEnvelope, nowMs: number): FieldState {
  if (!env.verified_at) return { kind: 'unverified' };
  const age = nowMs - Date.parse(env.verified_at);
  const limit = (env.stale_after_days ?? DEFAULT_STALE_DAYS) * DAY_MS;
  if (age > limit) return { kind: 'stale', days: Math.floor(age / DAY_MS) };
  return { kind: 'ok' };
}

function marker(state: FieldState): string {
  if (state.kind === 'ok') return '[ok]';
  if (state.kind === 'unverified') return '[unverified]';
  return `[STALE ${state.days > 999 ? '999+' : state.days}d]`;
}

const oneLine = (s: string) => s.replace(/\r?\n|\r/g, ' ');

function renderValue(v: CardValue): string {
  return oneLine(Array.isArray(v) ? v.join(', ') : String(v));
}

const byName = <T>(o: Record<string, T>) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The rendered card — the text identity and `person` return. With
 * `worstCase`, every where marker is counted at its widest ([STALE 999+d]):
 * that is the length the write-time cap checks, so time passing can never
 * push a stored card over it.
 */
export function renderCard(card: PersonCard, nowMs: number, opts: { worstCase?: boolean } = {}): string {
  const lines = [`## ${oneLine(card.name)} (${card.slug})`, card.summary ? card.summary.trim() : '_(no summary)_'];
  const where = byName(card.where ?? {});
  if (where.length) {
    lines.push(
      '**Where:** ' +
        where
          .map(([n, env]) => {
            const m = opts.worstCase ? '[STALE 999+d]' : marker(fieldState(env, nowMs));
            return `${n}: ${renderValue(env.value)} ${m}`;
          })
          .join(' · '),
    );
  }
  const how = byName(card.how ?? {});
  if (how.length) lines.push('**How:** ' + how.map(([n, v]) => `${n}: ${renderValue(v)}`).join(' · '));
  if (card.may?.length) {
    lines.push(
      '**May (descriptive, not a grant):** ' +
        card.may.map((m) => `${oneLine(m.text)} — ${oneLine(m.source)}`).join(' · '),
    );
  }
  return lines.join('\n');
}

/** Canonical JSON with sorted keys — the no-op comparison. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// ─── Store ───────────────────────────────────────────────────────────────────

const PEOPLE_MIGRATION = 'people_cards';

function hasTable(db: Database, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

interface RawRow {
  slug: string;
  name: string;
  card_json: string;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  updated: string;
  synthesized_at: string | null;
}

const SELECT_ROW =
  'SELECT slug, name, card_json, archived_at, archived_by, archive_reason, updated, synthesized_at FROM people WHERE slug = ?';

export interface PeopleStoreConfig {
  dbPath: string;
  /** Open read-only and never migrate. Reads on an unmigrated store see no cards. */
  readonly?: boolean;
  busyTimeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** Thrown when a stored row cannot be turned back into a card. */
export class UnreadableCardError extends Error {
  constructor(slug: string, cause: unknown) {
    super(`card for ${slug} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'UnreadableCardError';
  }
}

function parseRow(raw: RawRow): PersonRow {
  let card: unknown;
  try {
    card = JSON.parse(raw.card_json);
    validateCard(card, null);
  } catch (e) {
    throw new UnreadableCardError(raw.slug, e);
  }
  return { ...raw, card: card as PersonCard };
}

export class PeopleStore {
  private db: Database;
  private readonly now: () => number;
  /** False on a read-only store whose tables do not exist yet. */
  readonly migrated: boolean;

  constructor(config: PeopleStoreConfig) {
    this.now = config.now ?? Date.now;
    this.db = new BetterSqlite3(config.dbPath, config.readonly ? { readonly: true } : {});
    this.db.pragma(`busy_timeout = ${config.busyTimeoutMs ?? 5000}`);
    if (!config.readonly) {
      this.db.pragma('journal_mode = WAL');
      // Only this feature's migration: the people tables do not depend on the
      // memories schema, and a raw store must not half-run the others.
      const m = MIGRATIONS.find((x) => x.id === PEOPLE_MIGRATION)!;
      if (m.pending(this.db)) m.run(this.db);
    }
    this.migrated = hasTable(this.db, 'people') && hasTable(this.db, 'person_revisions');
  }

  close(): void {
    this.db.close();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private readRow(slug: string): RawRow | undefined {
    return this.db.prepare(SELECT_ROW).get(slug) as RawRow | undefined;
  }

  private snapshot(prev: RawRow, op: RevisionOp, at: string): number {
    const snap = { ...prev, card: JSON.parse(prev.card_json) as unknown };
    delete (snap as Partial<RawRow>).card_json;
    const id = Number(
      this.db
        .prepare('INSERT INTO person_revisions (slug, snapshot_json, op, replaced_at) VALUES (?, ?, ?, ?)')
        .run(prev.slug, JSON.stringify(snap), op, at).lastInsertRowid,
    );
    this.db
      .prepare(
        `DELETE FROM person_revisions WHERE slug = ? AND id NOT IN
           (SELECT id FROM person_revisions WHERE slug = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(prev.slug, prev.slug, MAX_REVISIONS);
    return id;
  }

  private store(row: RawRow): void {
    this.db
      .prepare(
        `INSERT INTO people (slug, name, card_json, archived_at, archived_by, archive_reason, updated, synthesized_at)
         VALUES (@slug, @name, @card_json, @archived_at, @archived_by, @archive_reason, @updated, @synthesized_at)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name, card_json = excluded.card_json,
           archived_at = excluded.archived_at, archived_by = excluded.archived_by,
           archive_reason = excluded.archive_reason, updated = excluded.updated,
           synthesized_at = excluded.synthesized_at`,
      )
      .run(row);
  }

  /** One BEGIN IMMEDIATE transaction around `fn`, retried as a whole on SQLITE_BUSY. */
  private mutate<T>(fn: () => T): T {
    if (!this.migrated) fail('people store is not migrated');
    return retryWrite(() => this.db.transaction(fn).immediate());
  }

  private result(row: RawRow, unchanged: boolean, revisionId: number | null): MutationResult {
    return {
      card: JSON.parse(row.card_json) as PersonCard,
      unchanged,
      revision_id: revisionId,
      archived: row.archived_at !== null,
      updated: row.updated,
      synthesized_at: row.synthesized_at,
    };
  }

  private requireActive(slug: string, verb: string): RawRow {
    const row = this.readRow(slug);
    if (!row) fail(`no card for ${slug}`);
    if (row.archived_at !== null) fail(`card for ${slug} is archived; person_restore it before ${verb}`);
    return row;
  }

  write(input: PersonWriteInput): MutationResult {
    if (!isPlainObject(input)) fail('input: must be an object');
    const raw = input as unknown as Record<string, unknown>;
    for (const k of Object.keys(raw)) {
      if (!WRITE_KEYS.includes(k)) fail(`${k}: unknown top-level key (allowed: ${WRITE_KEYS.join(', ')})`);
    }
    const slugErr = personSlugError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    const merge = input.merge ?? true;
    if (typeof merge !== 'boolean') fail('merge: must be a boolean');
    assertNoReserved({ where: raw.where, how: raw.how, may: raw.may }, 'input');
    validateWriteNulls(raw, merge);
    for (const section of ['where', 'how'] as const) {
      if (section in raw && !isPlainObject(raw[section])) fail(`${section}: must be an object`);
    }
    const passedSummary = 'summary' in raw && raw.summary !== undefined;

    return this.mutate(() => {
      const nowMs = this.now();
      const at = new Date(nowMs).toISOString();
      const existing = this.readRow(input.slug);
      if (existing?.archived_at) fail(`card for ${input.slug} is archived; person_restore it before writing`);
      const current = existing ? (parseRow(existing).card) : null;

      let next: Record<string, unknown>;
      if (!merge || !current) {
        next = { slug: input.slug, name: input.name, where: input.where ?? {}, how: input.how ?? {}, may: input.may ?? [] };
        if (passedSummary) next.summary = input.summary;
        // A merge write that creates: drop the null deletes, there is nothing to remove.
        for (const section of ['where', 'how'] as const) {
          next[section] = Object.fromEntries(Object.entries(next[section] as object).filter(([, v]) => v !== null));
        }
      } else {
        next = structuredClone(current) as unknown as Record<string, unknown>;
        if (input.name !== undefined) next.name = input.name;
        if (passedSummary) next.summary = input.summary;
        for (const section of ['where', 'how'] as const) {
          const passed = input[section];
          if (!passed) continue;
          const merged = { ...(next[section] as Record<string, unknown>) };
          for (const [n, v] of Object.entries(passed)) {
            if (v === null) delete merged[n];
            else merged[n] = v;
          }
          next[section] = merged;
        }
        if (input.may !== undefined) next.may = input.may;
      }
      if (next.name === undefined) fail(`name: is required ${current ? 'on a merge: false write' : 'to create a card'}`);
      validateCard(next, nowMs);

      if (current && !passedSummary && canonical(next) === canonical(current)) {
        return this.result(existing!, true, null);
      }
      const revisionId = existing ? this.snapshot(existing, 'write', at) : null;
      const synthesizedAt = passedSummary ? at : !merge ? null : (existing?.synthesized_at ?? null);
      const row: RawRow = {
        slug: input.slug,
        name: next.name as string,
        card_json: JSON.stringify(next),
        archived_at: null,
        archived_by: null,
        archive_reason: null,
        updated: at,
        synthesized_at: synthesizedAt,
      };
      this.store(row);
      return this.result(row, false, revisionId);
    });
  }

  verify(input: { slug: string; fields: string[]; verified_at?: string; source?: string }): MutationResult {
    const slugErr = personSlugError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    if (!Array.isArray(input.fields) || input.fields.length === 0) fail('fields: list at least one where field');
    if (input.source !== undefined) checkString(input.source, 'source', MAX_STRING);
    return this.mutate(() => {
      const nowMs = this.now();
      const at = new Date(nowMs).toISOString();
      const verifiedAt = input.verified_at ?? at;
      checkVerifiedAt(verifiedAt, 'verified_at', nowMs);
      const existing = this.requireActive(input.slug, 'verifying');
      const card = parseRow(existing).card;
      for (const f of input.fields) {
        if (!(f in card.where)) fail(`fields: "${f}" is not a where field on ${input.slug}`);
      }
      const next = structuredClone(card);
      for (const f of input.fields) {
        next.where[f].verified_at = verifiedAt;
        if (input.source !== undefined) next.where[f].source = input.source;
      }
      validateCard(next, nowMs);
      if (canonical(next) === canonical(card)) return this.result(existing, true, null);
      const revisionId = this.snapshot(existing, 'verify', at);
      const row = { ...existing, card_json: JSON.stringify(next), updated: at };
      this.store(row);
      return this.result(row, false, revisionId);
    });
  }

  archive(input: { slug: string; reason: string; actor: string }): MutationResult {
    const slugErr = personSlugError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    const reason = checkString(input.reason, 'reason', MAX_STRING);
    if (reason.trim() === '') fail('reason: is required');
    return this.mutate(() => {
      const at = this.nowIso();
      const existing = this.readRow(input.slug);
      if (!existing) fail(`no card for ${input.slug}`);
      if (existing.archived_at !== null) return this.result(existing, true, null);
      const revisionId = this.snapshot(existing, 'archive', at);
      const row = { ...existing, archived_at: at, archived_by: input.actor, archive_reason: reason, updated: at };
      this.store(row);
      return this.result(row, false, revisionId);
    });
  }

  restore(input: { slug: string }): MutationResult {
    const slugErr = personSlugError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    return this.mutate(() => {
      const at = this.nowIso();
      const existing = this.readRow(input.slug);
      if (!existing) fail(`no card for ${input.slug}`);
      if (existing.archived_at === null) return this.result(existing, true, null);
      const revisionId = this.snapshot(existing, 'restore', at);
      const row = { ...existing, archived_at: null, archived_by: null, archive_reason: null, updated: at };
      this.store(row);
      return this.result(row, false, revisionId);
    });
  }

  revisionRestore(input: { slug: string; revision_id: number }): MutationResult {
    const slugErr = personSlugError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    return this.mutate(() => {
      const at = this.nowIso();
      const existing = this.requireActive(input.slug, 'restoring a revision');
      const rev = this.db
        .prepare('SELECT slug, snapshot_json FROM person_revisions WHERE id = ?')
        .get(input.revision_id) as { slug: string; snapshot_json: string } | undefined;
      if (!rev) fail(`revision ${input.revision_id} not found`);
      if (rev.slug !== input.slug) fail(`revision ${input.revision_id} belongs to another card, not ${input.slug}`);
      const snap = JSON.parse(rev.snapshot_json) as { card: unknown; synthesized_at: string | null };
      // Structural only: time checks are not re-applied to a snapshot that was valid when written.
      validateCard(snap.card, null);
      if (snap.card.slug !== input.slug) fail(`revision ${input.revision_id} holds a card for another slug`);
      const cardJson = JSON.stringify(snap.card);
      const synthesizedAt = snap.synthesized_at ?? null;
      if (cardJson === existing.card_json && synthesizedAt === existing.synthesized_at) {
        return this.result(existing, true, null);
      }
      const revisionId = this.snapshot(existing, 'revision_restore', at);
      const row = { ...existing, name: snap.card.name, card_json: cardJson, synthesized_at: synthesizedAt, updated: at };
      this.store(row);
      return this.result(row, false, revisionId);
    });
  }

  /** The stored row, or null. Throws UnreadableCardError for a row that does not parse or validate. */
  getRow(slug: string): PersonRow | null {
    if (!this.migrated) return null;
    const raw = this.readRow(slug);
    return raw ? parseRow(raw) : null;
  }

  read(slug: string, includeArchived = false): PersonReadResult {
    const slugErr = personSlugError(slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    const row = this.getRow(slug);
    if (!row) return { found: false };
    const archived = row.archived_at !== null;
    if (archived && !includeArchived) return { found: true, archived: true };
    return {
      found: true,
      rendered: renderCard(row.card, this.now()) + (archived ? `\n_(archived ${row.archived_at} by ${row.archived_by}: ${row.archive_reason})_` : ''),
      card: row.card,
      archived,
      updated: row.updated,
      synthesized_at: row.synthesized_at,
    };
  }

  list(includeArchived = false): PersonListEntry[] {
    if (!this.migrated) return [];
    const raws = this.db
      .prepare(
        `SELECT slug, name, card_json, archived_at, archived_by, archive_reason, updated, synthesized_at FROM people
         ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY slug`,
      )
      .all() as RawRow[];
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const hasMemories = hasTable(this.db, 'memories');
    const count = hasMemories
      ? this.db.prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE category = 'user' AND archived = 0
             AND json_extract(metadata, '$.person') = ?
             AND (expires_at IS NULL OR expires_at > ?)
             AND (? IS NULL OR created > ?)`,
        )
      : null;
    return raws.map((raw) => {
      let stale = 0;
      let unverified = 0;
      try {
        for (const env of Object.values(parseRow(raw).card.where)) {
          const s = fieldState(env, nowMs);
          if (s.kind === 'stale') stale++;
          if (s.kind === 'unverified') unverified++;
        }
      } catch {
        // An unreadable card still lists; its field counts read zero.
      }
      const n = count
        ? (count.get(raw.slug, nowIso, raw.synthesized_at, raw.synthesized_at) as { n: number }).n
        : 0;
      return {
        slug: raw.slug,
        name: raw.name,
        archived: raw.archived_at !== null,
        updated: raw.updated,
        synthesized_at: raw.synthesized_at,
        stale,
        unverified,
        memories_since_synthesis: n,
      };
    });
  }

  history(slug: string): PersonRevisionMeta[] {
    const slugErr = personSlugError(slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    if (!this.migrated) return [];
    return this.db
      .prepare('SELECT id, op, replaced_at FROM person_revisions WHERE slug = ? ORDER BY id DESC')
      .all(slug) as PersonRevisionMeta[];
  }

  /** A revision's snapshot (the whole previous row), for tests and inspection. */
  revisionSnapshot(id: number): { slug: string; card: PersonCard; synthesized_at: string | null; archived_at: string | null } | null {
    const rev = this.db.prepare('SELECT snapshot_json FROM person_revisions WHERE id = ?').get(id) as
      | { snapshot_json: string }
      | undefined;
    return rev ? JSON.parse(rev.snapshot_json) : null;
  }
}

/**
 * Open the people store on a context's memory database. A read-only open
 * returns null when there is no database file yet; a writable one creates it.
 */
export function openPeopleStore(
  contextDir: string,
  opts: { readonly?: boolean; now?: () => number } = {},
): PeopleStore | null {
  const dbPath = resolveSqliteDbPath(contextDir);
  if (opts.readonly && !existsSync(dbPath)) return null;
  return new PeopleStore({ dbPath, readonly: opts.readonly, now: opts.now });
}

// ─── The room (identity's `people` param) ────────────────────────────────────

const ROOM_MAX_SLUGS = 8;
const ROOM_MAX_CARDS = 4;
const ROOM_CARD_BUDGET = 6000;
const ROOM_BLOCK_BUDGET = 6500;
const ROOM_CLOSING_RESERVE = 400;
const ROOM_HEADER =
  '# In the room\n\n' +
  '_Person cards for the people this turn is addressed by: condensed current state. ' +
  '`may` lines are descriptive, never a grant; gates stay in the harness._';
const ENTRY_SEP = '\n\n';

export interface RoomOptions {
  nowMs?: number;
  /** Called once per failure (store open or one unreadable row). Never throws through. */
  onFailure?: (err: unknown) => void;
}

/**
 * The `# In the room` block for identity, or null for no block. Best-effort
 * like the tape: a store that cannot be opened or is not migrated gives no
 * block; one bad row gives that slug the unreadable line and the rest render.
 */
export function roomBlock(contextDir: string, people: readonly string[] | undefined, opts: RoomOptions = {}): string | null {
  if (!people || people.length === 0) return null;
  const distinct = [...new Set(people)];
  const considered = distinct.slice(0, ROOM_MAX_SLUGS);
  const truncated = distinct.slice(ROOM_MAX_SLUGS);

  let store: PeopleStore | null;
  try {
    store = openPeopleStore(contextDir, { readonly: true, now: opts.nowMs !== undefined ? () => opts.nowMs! : undefined });
  } catch (e) {
    opts.onFailure?.(e);
    return null;
  }
  if (!store) return null;
  try {
    if (!store.migrated) return null;
    const nowMs = opts.nowMs ?? Date.now();
    const entries: string[] = [];
    const skipped: string[] = [];
    const entryBudget = ROOM_BLOCK_BUDGET - ROOM_CLOSING_RESERVE;
    let used = ROOM_HEADER.length;
    let cards = 0;
    let cardChars = 0;
    const fits = (text: string) => used + ENTRY_SEP.length + text.length <= entryBudget;
    const place = (text: string) => {
      entries.push(text);
      used += ENTRY_SEP.length + text.length;
    };

    for (const slug of considered) {
      if (typeof slug !== 'string' || slug.length > MAX_SLUG) {
        const line = '_(invalid slug)_';
        if (fits(line)) place(line);
        continue;
      }
      if (personSlugError(slug)) {
        const line = `_(invalid slug: ${slug})_`;
        if (fits(line)) place(line);
        continue;
      }
      let line: string | null = null;
      let card: string | null = null;
      try {
        const row = store.getRow(slug);
        if (!row) line = `_(no card for ${slug})_`;
        else if (row.archived_at !== null) line = `_(card for ${slug} is archived)_`;
        else card = renderCard(row.card, nowMs);
      } catch (e) {
        console.error(`[loom:identity] person card ${slug} unreadable:`, e);
        opts.onFailure?.(e);
        line = `_(card for ${slug} is unreadable)_`;
      }
      if (line !== null) {
        if (fits(line)) place(line);
        else skipped.push(slug);
        continue;
      }
      if (cards >= ROOM_MAX_CARDS || cardChars + card!.length > ROOM_CARD_BUDGET || !fits(card!)) {
        skipped.push(slug);
        continue;
      }
      place(card!);
      cards++;
      cardChars += card!.length;
    }

    const omitted = [...skipped, ...truncated.map((s) => (personSlugError(s) ? '(invalid slug)' : s))];
    let block = [ROOM_HEADER, ...entries].join(ENTRY_SEP);
    if (omitted.length) block += ENTRY_SEP + omittedLine(omitted);
    return block;
  } finally {
    store.close();
  }
}

/** `_(N cards omitted for budget: a, b, …)_`, listing slugs until the next would overflow the reserve. */
function omittedLine(omitted: string[]): string {
  const head = `_(${omitted.length} card${omitted.length === 1 ? '' : 's'} omitted for budget: `;
  const max = ROOM_CLOSING_RESERVE - ENTRY_SEP.length;
  const listed: string[] = [];
  for (const s of omitted) {
    const candidate = head + [...listed, s].join(', ');
    const tailRoom = listed.length + 1 < omitted.length ? ', …)_'.length : ')_'.length;
    if (candidate.length + tailRoom > max) break;
    listed.push(s);
  }
  const ellipsis = listed.length < omitted.length ? (listed.length ? ', …' : '…') : '';
  return `${head}${listed.join(', ')}${ellipsis})_`;
}
