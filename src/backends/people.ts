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
import { MIGRATIONS } from './migrations.js';
import {
  CardTable, fail, isPlainObject, assertNoNull, checkString, checkFieldName, checkVerifiedAt,
  checkEnvelope, slugError, renderWhereLine, oneLine, byName, mergeLevel, withoutNulls, stampWhere, whereCounts,
  hasTable, RESERVED_KEYS, isReserved, type CardRowBase, type RevisionMeta, type RevisionOp,
} from './cards.js';

export { SLUG_RE, RESERVED_KEYS, fieldState, type FieldState, type RevisionOp } from './cards.js';
/** Every rejection the people surface makes. The message names the path. */
export { CardError as PersonCardError } from './cards.js';

// ─── Limits (the spec's Shape and Rendering sections) ────────────────────────

export const MAX_SLUG = 64;
const MAX_NAME = 80;
const MAX_SUMMARY = 1200;
const MAX_FIELDS = 12;
const MAX_STRING = 200;
const MAX_ARRAY = 8;
const MAX_MAY = 8;
export const MAX_RENDER = 2000;

const TOP_KEYS = ['slug', 'name', 'summary', 'where', 'how', 'may'];
const WRITE_KEYS = [...TOP_KEYS, 'merge'];

// ─── Types ───────────────────────────────────────────────────────────────────

export type CardValue = string | number | boolean | string[];

export interface WhereEnvelope {
  value: CardValue;
  verified_at?: string;
  source?: string;
  stale_after_days?: number;
  /** What a person reads for the value: "@sleepunit" for a Discord id, "Jonathan Barket (@jbarket)" for a Slack one. */
  label?: string;
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

/** One memory a person card condenses (PeopleStore.evidence). */
export interface PersonEvidence {
  created: string;
  category: string;
  title: string;
  content: string;
}

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

export interface PersonRevisionMeta extends RevisionMeta {
  /** In a household: which half of the card this revision is from. */
  store?: 'directory' | 'relationship';
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Null when `slug` is a valid person slug, else the reason. Never echoes an over-long slug. */
export function personSlugError(slug: unknown): string | null {
  return slugError(slug, MAX_SLUG);
}

/** Reject a reserved key anywhere under `node`, naming it. Runs before shape checks. */
function assertNoReserved(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertNoReserved(v, `${path}[${i}]`));
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (isReserved(k)) {
      fail(
        `${path}.${k}: "${k}" is a reserved key (harness gating names: ${RESERVED_KEYS.join(', ')}). ` +
        'A card is not an authorization surface; gates stay in the harness.',
      );
    }
    assertNoReserved(v, `${path}.${k}`);
  }
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
      if (section === 'where') checkEnvelope(fields[n], `where.${n}`, nowMs, { checkValue, extraStringKeys: ['label'] });
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

function renderValue(v: CardValue): string {
  return oneLine(Array.isArray(v) ? v.join(', ') : String(v));
}

/**
 * The rendered card — the text identity and `person` return. With
 * `worstCase`, every where marker is counted at its widest ([STALE 999+d]):
 * that is the length the write-time cap checks, so time passing can never
 * push a stored card over it.
 */
export function renderCard(card: PersonCard, nowMs: number, opts: { worstCase?: boolean } = {}): string {
  const lines = [`## ${oneLine(card.name)} (${card.slug})`, card.summary ? card.summary.trim() : '_(no summary)_'];
  const where = renderWhereLine(card.where ?? {}, nowMs, opts.worstCase ?? false,
    (env) => `${renderValue(env.value)}${env.label ? ` (${oneLine(env.label)})` : ''}`);
  if (where) lines.push(where);
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

// ─── Store ───────────────────────────────────────────────────────────────────

const PEOPLE_MIGRATIONS = ['people_cards', 'person_revisions_actor'];

type RawRow = CardRowBase;

const PERSON_NOUN = {
  missing: (slug: string) => `no card for ${slug}`,
  archived: (slug: string, verb: string) => `card for ${slug} is archived; person_restore it before ${verb}`,
  otherRevision: (id: number, slug: string) => `revision ${id} belongs to another card, not ${slug}`,
};

export interface PeopleStoreConfig {
  dbPath: string;
  /** Open read-only and never migrate. Reads on an unmigrated store see no cards. */
  readonly?: boolean;
  busyTimeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Who is writing (an agent's name), recorded on every revision it makes. */
  actor?: string;
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
  private readonly table: CardTable<RawRow>;
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
      for (const id of PEOPLE_MIGRATIONS) {
        const m = MIGRATIONS.find((x) => x.id === id)!;
        if (m.pending(this.db)) m.run(this.db);
      }
    }
    this.migrated = hasTable(this.db, 'people') && hasTable(this.db, 'person_revisions');
    this.table = new CardTable<RawRow>(this.db, { table: 'people', revisions: 'person_revisions', noun: PERSON_NOUN }, config.actor ?? null);
  }

  close(): void {
    this.db.close();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** One BEGIN IMMEDIATE transaction around `fn`, retried as a whole on SQLITE_BUSY. */
  private mutate<T>(fn: () => T): T {
    if (!this.migrated) fail('people store is not migrated');
    return this.table.mutate(fn);
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
      if (!(section in raw) || raw[section] === undefined) continue;
      if (!isPlainObject(raw[section])) fail(`${section}: must be an object`);
      // Names are checked before any null-delete applies: an invalid request
      // rejects even when it would change nothing (PR143 review).
      for (const n of Object.keys(raw[section] as object)) checkFieldName(n, `${section}.${n}`);
    }
    const passedSummary = 'summary' in raw && raw.summary !== undefined;

    return this.mutate(() => {
      const nowMs = this.now();
      const at = new Date(nowMs).toISOString();
      const existing = this.table.readRow(input.slug);
      if (existing?.archived_at) fail(`card for ${input.slug} is archived; person_restore it before writing`);
      const current = existing ? (parseRow(existing).card) : null;

      let next: Record<string, unknown>;
      if (!merge || !current) {
        next = { slug: input.slug, name: input.name, where: withoutNulls(input.where), how: withoutNulls(input.how), may: input.may ?? [] };
        if (passedSummary) next.summary = input.summary;
      } else {
        next = structuredClone(current) as unknown as Record<string, unknown>;
        if (input.name !== undefined) next.name = input.name;
        if (passedSummary) next.summary = input.summary;
        for (const section of ['where', 'how'] as const) {
          const passed = input[section];
          if (passed) next[section] = mergeLevel(next[section] as Record<string, unknown>, passed);
        }
        if (input.may !== undefined) next.may = input.may;
      }
      if (next.name === undefined) fail(`name: is required ${current ? 'on a merge: false write' : 'to create a card'}`);
      validateCard(next, nowMs);

      const c = this.table.commitWrite({ existing, current, next, passedSummary, merge, at });
      return this.result(c.row, c.unchanged, c.revisionId);
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
      const existing = this.table.requireActive(input.slug, 'verifying');
      const card = parseRow(existing).card;
      const next = stampWhere(card, input.fields, verifiedAt, input.source, input.slug);
      validateCard(next, nowMs);
      const c = this.table.commitVerify(existing, card, next, at);
      return this.result(c.row, c.unchanged, c.revisionId);
    });
  }

  archive(input: { slug: string; reason: string; actor: string }): MutationResult {
    const slugErr = personSlugError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    const reason = checkString(input.reason, 'reason', MAX_STRING);
    if (reason.trim() === '') fail('reason: is required');
    return this.mutate(() => {
      const c = this.table.archive(input.slug, reason, input.actor, this.nowIso());
      return this.result(c.row, c.unchanged, c.revisionId);
    });
  }

  restore(input: { slug: string }): MutationResult {
    const slugErr = personSlugError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    return this.mutate(() => {
      const c = this.table.restore(input.slug, this.nowIso());
      return this.result(c.row, c.unchanged, c.revisionId);
    });
  }

  revisionRestore(input: { slug: string; revision_id: number }): MutationResult {
    const slugErr = personSlugError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    return this.mutate(() => {
      // Structural only: time checks are not re-applied to a snapshot that was valid when written.
      const c = this.table.revisionRestore(input.slug, input.revision_id, this.nowIso(), (card) => validateCard(card, null));
      return this.result(c.row, c.unchanged, c.revisionId);
    });
  }

  /** The stored row, or null. Throws UnreadableCardError for a row that does not parse or validate. */
  getRow(slug: string): PersonRow | null {
    if (!this.migrated) return null;
    const raw = this.table.readRow(slug);
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
    const raws = this.table.allRows(includeArchived);
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
      let counts = { stale: 0, unverified: 0 };
      try {
        counts = whereCounts(parseRow(raw).card.where, nowMs);
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
        stale: counts.stale,
        unverified: counts.unverified,
        memories_since_synthesis: n,
      };
    });
  }

  history(slug: string): PersonRevisionMeta[] {
    const slugErr = personSlugError(slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    if (!this.migrated) return [];
    return this.table.history(slug);
  }

  /**
   * Put a card in place as is, keeping the row's timestamps and archive state
   * (a migration, not an edit). Recorded as a 'split' revision when a row is
   * replaced.
   */
  replaceCard(slug: string, card: PersonCard, keep: Pick<RawRow, 'updated' | 'synthesized_at' | 'archived_at' | 'archived_by' | 'archive_reason'>): void {
    validateCard(card, null);
    this.mutate(() => {
      const existing = this.table.readRow(slug);
      if (existing) this.table.snapshot(existing, 'split', this.nowIso());
      this.table.store({ slug, name: card.name, card_json: JSON.stringify(card), ...keep });
    });
  }

  /** The raw stored rows (timestamps and archive state included), for a migration. */
  rows(): Array<{ slug: string; card: PersonCard; updated: string; synthesized_at: string | null; archived_at: string | null; archived_by: string | null; archive_reason: string | null }> {
    if (!this.migrated) return [];
    return this.table.allRows(true)
      .map((r) => ({ slug: r.slug, card: JSON.parse(r.card_json) as PersonCard, updated: r.updated, synthesized_at: r.synthesized_at, archived_at: r.archived_at, archived_by: r.archived_by, archive_reason: r.archive_reason }));
  }

  /**
   * The memories a card condenses: active, unexpired `user` and `feedback`
   * memories tagged metadata.person = slug, oldest first, newer than `since`
   * when given. What a synthesis re-reads before it rewrites a card's summary.
   */
  evidence(slug: string, since: string | null): PersonEvidence[] {
    if (!hasTable(this.db, 'memories')) return [];
    const nowIso = new Date(this.now()).toISOString();
    return this.db.prepare(
      `SELECT created, category, title, content FROM memories
       WHERE json_extract(metadata, '$.person') = ? AND category IN ('user', 'feedback') AND archived = 0
         AND (expires_at IS NULL OR expires_at > ?) AND (? IS NULL OR created > ?)
       ORDER BY created`,
    ).all(slug, nowIso, since, since) as PersonEvidence[];
  }

  /** This database's `user` memories about a person, newer than `since` (all of them when null). */
  memoriesSince(slug: string, since: string | null): number {
    if (!hasTable(this.db, 'memories')) return 0;
    const nowIso = new Date(this.now()).toISOString();
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM memories
       WHERE category = 'user' AND archived = 0 AND json_extract(metadata, '$.person') = ?
         AND (expires_at IS NULL OR expires_at > ?) AND (? IS NULL OR created > ?)`,
    ).get(slug, nowIso, since, since) as { n: number }).n;
  }

  /** A revision's snapshot (the whole previous row), for tests and inspection. */
  revisionSnapshot(id: number): { slug: string; card: PersonCard; synthesized_at: string | null; archived_at: string | null } | null {
    return this.table.revisionSnapshot(id);
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
/** How an invalid slug appears in the omitted line: never echoed there. */
const INVALID_LABEL = '(invalid slug)';

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
        else skipped.push(INVALID_LABEL);
        continue;
      }
      if (personSlugError(slug)) {
        const line = `_(invalid slug: ${slug})_`;
        if (fits(line)) place(line);
        else skipped.push(INVALID_LABEL);
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

    const omitted = [...skipped, ...truncated.map((s) => (personSlugError(s) ? INVALID_LABEL : s))];
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
