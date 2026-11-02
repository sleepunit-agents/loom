/**
 * Project cards — the condensed current state of a body of work
 * (docs/specs/projects.md). A project card does for a body of work what a
 * person card does for a human, and follows person cards' rules wherever the
 * spec says "as person cards": the shared machinery is ./cards.ts.
 *
 * What projects add:
 *   - `status` (active | paused | done), a state of a live project;
 *   - `links`, selectors the hub reads with: never resolved as references, so
 *     archiving a project touches nothing else;
 *   - project_names: every live project's slug and aliases, one row each, so
 *     "every project name is unique" is a primary key, not a check. A write
 *     updates projects and project_names in one transaction; archiving frees
 *     the names (never the slug), restoring re-claims them or rolls back.
 *
 * Every surface that takes a slug takes any live name: an alias resolves to
 * its project and the result carries `resolved_from`. An archived project is
 * reached by its slug only.
 *
 * Storage is the memory database (resolveSqliteDbPath), opened raw like the
 * people store — no embedder. The hub's memory reads live here because the
 * memories are in the same database; notes and person cards are read by
 * tools/project.ts, which knows the context dir.
 */
import { existsSync } from 'node:fs';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { resolveSqliteDbPath } from '../config.js';
import { NOTE_PATH } from '../notes.js';
import { MIGRATIONS } from './migrations.js';
import {
  CardTable, fail, isPlainObject, assertNoNull, checkString, checkFieldName, checkVerifiedAt, checkEnvelope,
  slugError, renderWhereLine, oneLine, mergeLevel, withoutNulls, stampWhere, whereCounts, hasTable, isReserved,
  RESERVED_KEYS, type CardRowBase, type RevisionMeta,
} from './cards.js';

export { CardError as ProjectCardError } from './cards.js';

// ─── Limits (the spec's Shape and Rendering sections) ────────────────────────

/** ≤ 32 so that a name's field name (`-` → `_`) fits a `where` field name (person cards' 32). */
export const MAX_PROJECT_SLUG = 32;
const MAX_NAME = 80;
const MAX_SUMMARY = 1200;
const MAX_GOAL = 400;
const MAX_WHERE_VALUE = 400;
const MAX_FIELDS = 12;
const MAX_LIST = 16;
const MAX_LINK = 200;
const MAX_EPIC = 64;
export const MAX_PROJECT_RENDER = 2000;
const MAX_REASON = 200;

export const STATUSES = ['active', 'paused', 'done'] as const;
export type ProjectStatus = (typeof STATUSES)[number];

const TOP_KEYS = ['slug', 'name', 'status', 'summary', 'goal', 'where', 'links'];
const WRITE_KEYS = [...TOP_KEYS, 'merge'];
const LINK_KEYS = ['aliases', 'notes', 'epic', 'repos', 'venues'];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectWhere {
  value: string;
  verified_at?: string;
  source?: string;
  stale_after_days?: number;
}

export interface ProjectLinks {
  aliases?: string[];
  notes?: string[];
  epic?: string;
  repos?: string[];
  venues?: string[];
}

export interface ProjectCard {
  slug: string;
  name: string;
  status: ProjectStatus;
  summary?: string;
  goal?: string;
  where: Record<string, ProjectWhere>;
  links: ProjectLinks;
}

export interface ProjectWriteInput {
  slug: string;
  name?: string;
  status?: ProjectStatus;
  summary?: string;
  goal?: string;
  where?: Record<string, ProjectWhere | null>;
  links?: { [K in keyof ProjectLinks]?: ProjectLinks[K] | null };
  merge?: boolean;
}

interface RawRow extends CardRowBase {
  status: string;
}

export interface ProjectRow {
  slug: string;
  name: string;
  status: ProjectStatus;
  card: ProjectCard;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  updated: string;
  synthesized_at: string | null;
}

/** Present only when the name the caller passed was an alias. */
type Resolved = { resolved_from?: string };

export type ProjectMutationResult = Resolved & {
  card: ProjectCard;
  unchanged: boolean;
  revision_id: number | null;
  archived: boolean;
  updated: string;
  synthesized_at: string | null;
};

export type ProjectReadResult =
  | { found: false }
  | (Resolved & { found: true; archived: true })
  | (Resolved & {
      found: true;
      rendered: string;
      card: ProjectCard;
      archived: boolean;
      updated: string;
      synthesized_at: string | null;
    });

export type ProjectRevisionMeta = RevisionMeta;

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Null when `name` can be a project name (a slug or an alias), else the
 * reason: the slug rule, ≤ 32 chars, and not one of the reserved gating names.
 */
export function projectNameError(name: unknown): string | null {
  const err = slugError(name, MAX_PROJECT_SLUG);
  if (err) return err;
  if (isReserved(name as string)) return `"${name as string}" is a reserved name (${RESERVED_KEYS.join(', ')})`;
  return null;
}

/** A project name's field name: the name with `-` replaced by `_` (what a person card's `where` uses). */
export const fieldNameOf = (name: string) => name.replace(/-/g, '_');

function checkWhereValue(v: unknown, path: string): void {
  if (typeof v !== 'string') fail(`${path}: must be a string (a project's state is prose)`);
  checkString(v, path, MAX_WHERE_VALUE);
}

function checkStringList(v: unknown, path: string, each: (s: string, p: string) => void): string[] {
  if (!Array.isArray(v)) fail(`${path}: must be an array of strings`);
  if (v.length > MAX_LIST) fail(`${path}: more than ${MAX_LIST} entries`);
  const seen = new Set<string>();
  v.forEach((s, i) => {
    const p = `${path}[${i}]`;
    checkString(s, p, MAX_LINK);
    if ((s as string).trim() === '') fail(`${p}: must not be empty`);
    each(s as string, p);
    if (seen.has(s as string)) fail(`${p}: "${s as string}" is listed twice`);
    seen.add(s as string);
  });
  return v as string[];
}

function checkLinks(links: unknown, slug: unknown): void {
  if (!isPlainObject(links)) fail('links: must be an object');
  for (const k of Object.keys(links)) {
    if (!LINK_KEYS.includes(k)) fail(`links.${k}: unknown links key (allowed: ${LINK_KEYS.join(', ')})`);
  }
  if ('aliases' in links) {
    checkStringList(links.aliases, 'links.aliases', (a, p) => {
      const err = projectNameError(a);
      if (err) fail(`${p}: ${err}`);
      if (a === slug) fail(`${p}: "${a}" is this project's own slug, not an alias`);
    });
  }
  if ('notes' in links) {
    checkStringList(links.notes, 'links.notes', (n, p) => {
      if (!NOTE_PATH.test(n)) fail(`${p}: "${n}" is not a note path prefix (up to six segments of letters, digits and . _ -)`);
    });
  }
  for (const k of ['repos', 'venues'] as const) if (k in links) checkStringList(links[k], `links.${k}`, () => {});
  if ('epic' in links) {
    const e = checkString(links.epic, 'links.epic', MAX_EPIC);
    if (e.trim() === '') fail('links.epic: must not be empty');
  }
}

/**
 * Validate a complete card: keys, types, lengths and the worst-case render
 * cap. `nowMs` adds the time checks (no future verified_at); null skips them,
 * which revision restore does.
 */
export function validateProjectCard(card: unknown, nowMs: number | null): asserts card is ProjectCard {
  if (!isPlainObject(card)) fail('card: must be an object');
  assertNoNull(card, 'card');
  for (const k of Object.keys(card)) {
    if (!TOP_KEYS.includes(k)) fail(`${k}: unknown top-level key (allowed: ${TOP_KEYS.join(', ')})`);
  }
  const slugErr = projectNameError(card.slug);
  if (slugErr) fail(`slug: ${slugErr}`);
  const name = checkString(card.name, 'name', MAX_NAME);
  if (name.trim() === '') fail('name: must not be empty');
  if (!(STATUSES as readonly unknown[]).includes(card.status)) fail(`status: must be one of ${STATUSES.join(', ')}`);
  for (const [k, max] of [['summary', MAX_SUMMARY], ['goal', MAX_GOAL]] as const) {
    if (k in card) {
      const s = checkString(card[k], k, max);
      if (s.trim() === '') fail(`${k}: must not be empty (a merge: false write without ${k} removes it)`);
    }
  }
  const where = card.where;
  if (!isPlainObject(where)) fail('where: must be an object');
  const names = Object.keys(where);
  if (names.length > MAX_FIELDS) fail(`where: more than ${MAX_FIELDS} fields`);
  for (const n of names) {
    checkFieldName(n, `where.${n}`);
    if (isReserved(n)) fail(`where.${n}: "${n}" is a reserved name (${RESERVED_KEYS.join(', ')})`);
    checkEnvelope(where[n], `where.${n}`, nowMs, { checkValue: checkWhereValue });
  }
  checkLinks(card.links, card.slug);
  const worst = renderProjectCard(card as unknown as ProjectCard, 0, { worstCase: true }).length;
  if (worst > MAX_PROJECT_RENDER) {
    fail(`card: worst-case render is ${worst} chars, over the ${MAX_PROJECT_RENDER}-char cap (every where marker counted as [STALE 999+d])`);
  }
}

/**
 * Where `null` may appear in a write request: only as a field directly under
 * `where` or a key directly under `links`, in a merge write.
 */
function validateWriteNulls(input: Record<string, unknown>, merge: boolean): void {
  for (const k of TOP_KEYS) {
    if (k in input && input[k] === null) {
      fail(`${k}: null is not allowed${k === 'where' || k === 'links' ? ' (use merge: false to clear a section)' : ''}`);
    }
  }
  if (!merge) {
    assertNoNull(input, 'input');
    return;
  }
  for (const section of ['where', 'links'] as const) {
    const fields = input[section];
    if (!isPlainObject(fields)) continue;
    for (const [n, v] of Object.entries(fields)) if (v !== null) assertNoNull(v, `${section}.${n}`);
  }
}

/** `links.notes` entries are stored without a trailing slash. */
function normalizeLinks(links: unknown): unknown {
  if (!isPlainObject(links) || !Array.isArray(links.notes)) return links;
  return { ...links, notes: links.notes.map((n) => (typeof n === 'string' ? n.replace(/\/+$/, '') : n)) };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * The rendered card — what `project` and identity's `# This project` return:
 *
 *   ## <name> (<slug> · <status>)
 *   <summary, or "_(no summary)_">
 *   **Goal:** <goal>
 *   **Where:** next: … [unverified] · now: … [ok]
 *
 * A line whose section is empty is left out; `links` are never rendered.
 * With `worstCase`, every marker counts at its widest: the write-time cap.
 */
export function renderProjectCard(card: ProjectCard, nowMs: number, opts: { worstCase?: boolean } = {}): string {
  const lines = [
    `## ${oneLine(card.name)} (${card.slug} · ${card.status})`,
    card.summary ? card.summary.trim() : '_(no summary)_',
  ];
  if (card.goal) lines.push(`**Goal:** ${oneLine(card.goal)}`);
  const where = renderWhereLine(card.where ?? {}, nowMs, opts.worstCase ?? false, (env) => oneLine(env.value));
  if (where) lines.push(where);
  return lines.join('\n');
}

/** A project's names: its slug, then its aliases in the card's order. */
export const namesOf = (card: Pick<ProjectCard, 'slug' | 'links'>): string[] => [card.slug, ...(card.links?.aliases ?? [])];

// ─── Store ───────────────────────────────────────────────────────────────────

const PROJECT_MIGRATIONS = ['project_cards'];

const PROJECT_NOUN = {
  missing: (slug: string) => `no project ${slug}`,
  archived: (slug: string, verb: string) => `project ${slug} is archived; project_restore it before ${verb}`,
  otherRevision: (id: number, slug: string) => `revision ${id} belongs to another project, not ${slug}`,
};

/** Thrown when a stored row cannot be turned back into a card. */
export class UnreadableProjectError extends Error {
  constructor(slug: string, cause: unknown) {
    super(`project ${slug} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'UnreadableProjectError';
  }
}

function parseRow(raw: RawRow): ProjectRow {
  let card: unknown;
  try {
    card = JSON.parse(raw.card_json);
    validateProjectCard(card, null);
  } catch (e) {
    throw new UnreadableProjectError(raw.slug, e);
  }
  return { ...raw, status: (card as ProjectCard).status, card: card as ProjectCard };
}

export interface ProjectsStoreConfig {
  dbPath: string;
  /** Open read-only and never migrate. Reads on an unmigrated store see no projects. */
  readonly?: boolean;
  busyTimeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Who is writing (an agent's name), recorded on every revision it makes. */
  actor?: string;
}

/** One memory in a hub's `memories` section. */
export interface HubMemory {
  ref: string;
  category: string;
  snippet: string;
  created: string;
  updated: string;
  new: boolean;
}

const HUB_NEWEST = 20;
const HUB_SALIENT = 10;
const SNIPPET = 200;

export interface ProjectListRow {
  row: ProjectRow | null;
  raw: { slug: string; name: string; status: string; archived_at: string | null; updated: string; synthesized_at: string | null };
}

export class ProjectsStore {
  private db: Database;
  private readonly table: CardTable<RawRow>;
  private readonly now: () => number;
  /** False on a read-only store whose tables do not exist yet. */
  readonly migrated: boolean;

  constructor(config: ProjectsStoreConfig) {
    this.now = config.now ?? Date.now;
    this.db = new BetterSqlite3(config.dbPath, config.readonly ? { readonly: true } : {});
    this.db.pragma(`busy_timeout = ${config.busyTimeoutMs ?? 5000}`);
    if (!config.readonly) {
      this.db.pragma('journal_mode = WAL');
      // Only this feature's migration, as the people store: a raw store must not half-run the memories ones.
      for (const id of PROJECT_MIGRATIONS) {
        const m = MIGRATIONS.find((x) => x.id === id)!;
        if (m.pending(this.db)) m.run(this.db);
      }
    }
    this.migrated = ['projects', 'project_revisions', 'project_names'].every((t) => hasTable(this.db, t));
    this.table = new CardTable<RawRow>(
      this.db,
      { table: 'projects', revisions: 'project_revisions', extraColumns: ['status'], noun: PROJECT_NOUN },
      config.actor ?? null,
    );
  }

  close(): void {
    this.db.close();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private mutate<T>(fn: () => T): T {
    if (!this.migrated) fail('projects store is not migrated');
    return this.table.mutate(fn);
  }

  private result(row: RawRow, unchanged: boolean, revisionId: number | null, resolvedFrom?: string): ProjectMutationResult {
    return {
      card: JSON.parse(row.card_json) as ProjectCard,
      unchanged,
      revision_id: revisionId,
      archived: row.archived_at !== null,
      updated: row.updated,
      synthesized_at: row.synthesized_at,
      ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}),
    };
  }

  // ─── Names ─────────────────────────────────────────────────────────────────

  /**
   * The row a name reaches: a slug (live or archived) first, else a live
   * alias. `resolved_from` is set when it was an alias.
   */
  private resolveRaw(name: string): { raw: RawRow; resolvedFrom?: string } | null {
    const bySlug = this.table.readRow(name);
    if (bySlug) return { raw: bySlug };
    const holder = this.db.prepare("SELECT slug FROM project_names WHERE name = ? AND kind = 'alias'").get(name) as
      | { slug: string }
      | undefined;
    if (!holder) return null;
    const raw = this.table.readRow(holder.slug);
    return raw ? { raw, resolvedFrom: name } : null;
  }

  /**
   * Reject a name set another project holds: an alias that is any project's
   * slug (archived included: a slug is a project's for good), or that a
   * second live project holds. Runs inside the write's transaction.
   */
  private checkNames(slug: string, aliases: readonly string[], path = 'links.aliases'): void {
    const holderOf = this.db.prepare('SELECT slug FROM project_names WHERE name = ?');
    const slugHolder = holderOf.get(slug) as { slug: string } | undefined;
    if (slugHolder && slugHolder.slug !== slug) fail(`slug: "${slug}" is held by project ${slugHolder.slug}`);
    const isSlug = this.db.prepare('SELECT slug FROM projects WHERE slug = ?');
    aliases.forEach((a, i) => {
      if (a === slug) fail(`${path}[${i}]: "${a}" is this project's own slug, not an alias`);
      if (isSlug.get(a)) fail(`${path}[${i}]: "${a}" is the slug of project ${a}`);
      const holder = holderOf.get(a) as { slug: string } | undefined;
      if (holder && holder.slug !== slug) fail(`${path}[${i}]: "${a}" is held by project ${holder.slug}`);
    });
  }

  /** Make project_names hold exactly this live project's names. */
  private syncNames(card: ProjectCard): void {
    this.db.prepare('DELETE FROM project_names WHERE slug = ?').run(card.slug);
    const ins = this.db.prepare('INSERT INTO project_names (name, slug, kind) VALUES (?, ?, ?)');
    ins.run(card.slug, card.slug, 'slug');
    for (const a of card.links.aliases ?? []) ins.run(a, card.slug, 'alias');
  }

  /**
   * Every name of the live project `name` belongs to, or null when it is no
   * live project's name. What recall resolves with.
   */
  nameSet(name: string): Set<string> | null {
    if (!this.migrated) return null;
    return projectNameSet(this.db, name);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  write(input: ProjectWriteInput): ProjectMutationResult {
    if (!isPlainObject(input)) fail('input: must be an object');
    const raw = input as unknown as Record<string, unknown>;
    for (const k of Object.keys(raw)) {
      if (!WRITE_KEYS.includes(k)) fail(`${k}: unknown top-level key (allowed: ${WRITE_KEYS.join(', ')})`);
    }
    const slugErr = projectNameError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    const merge = input.merge ?? true;
    if (typeof merge !== 'boolean') fail('merge: must be a boolean');
    validateWriteNulls(raw, merge);
    if (raw.where !== undefined) {
      if (!isPlainObject(raw.where)) fail('where: must be an object');
      // Names are checked before any null-delete applies: an invalid request
      // rejects even when it would change nothing (as person cards).
      for (const n of Object.keys(raw.where)) {
        checkFieldName(n, `where.${n}`);
        if (isReserved(n)) fail(`where.${n}: "${n}" is a reserved name (${RESERVED_KEYS.join(', ')})`);
      }
    }
    if (raw.links !== undefined) {
      if (!isPlainObject(raw.links)) fail('links: must be an object');
      for (const k of Object.keys(raw.links)) {
        if (!LINK_KEYS.includes(k)) fail(`links.${k}: unknown links key (allowed: ${LINK_KEYS.join(', ')})`);
      }
    }
    const links = normalizeLinks(input.links) as Record<string, unknown> | undefined;
    const passedSummary = 'summary' in raw && raw.summary !== undefined;

    return this.mutate(() => {
      const nowMs = this.now();
      const at = new Date(nowMs).toISOString();
      const found = this.resolveRaw(input.slug);
      const existing = found?.raw;
      if (existing?.archived_at) {
        fail(`project ${existing.slug} is archived; project_restore it before writing (a slug is a project's for good, so a new project can't take it)`);
      }
      const slug = existing?.slug ?? input.slug;
      const current = existing ? parseRow(existing).card : null;

      let next: Record<string, unknown>;
      if (!merge || !current) {
        next = { slug, name: input.name, status: input.status ?? 'active', where: withoutNulls(input.where), links: withoutNulls(links) };
        if (passedSummary) next.summary = input.summary;
        if (input.goal !== undefined) next.goal = input.goal;
      } else {
        next = structuredClone(current) as unknown as Record<string, unknown>;
        for (const k of ['name', 'status', 'summary', 'goal'] as const) if (input[k] !== undefined) next[k] = input[k];
        if (input.where) next.where = mergeLevel(next.where as Record<string, unknown>, input.where);
        if (links) next.links = mergeLevel(next.links as Record<string, unknown>, links);
      }
      if (next.name === undefined) fail(`name: is required ${current ? 'on a merge: false write' : 'to create a project'}`);
      validateProjectCard(next, nowMs);
      this.checkNames(slug, (next as unknown as ProjectCard).links.aliases ?? []);

      const c = this.table.commitWrite({ existing, current, next, passedSummary, merge, at, extra: { status: next.status as string } });
      if (!c.unchanged) this.syncNames(next as unknown as ProjectCard);
      return this.result(c.row, c.unchanged, c.revisionId, found?.resolvedFrom);
    });
  }

  verify(input: { slug: string; fields: string[]; verified_at?: string; source?: string }): ProjectMutationResult {
    const slugErr = projectNameError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    if (!Array.isArray(input.fields) || input.fields.length === 0) fail('fields: list at least one where field');
    if (input.source !== undefined) checkString(input.source, 'source', 200);
    return this.mutate(() => {
      const nowMs = this.now();
      const at = new Date(nowMs).toISOString();
      const verifiedAt = input.verified_at ?? at;
      checkVerifiedAt(verifiedAt, 'verified_at', nowMs);
      const found = this.resolveRaw(input.slug);
      const existing = this.table.requireActive(found?.raw.slug ?? input.slug, 'verifying');
      const card = parseRow(existing).card;
      const next = stampWhere(card, input.fields, verifiedAt, input.source, existing.slug);
      validateProjectCard(next, nowMs);
      const c = this.table.commitVerify(existing, card, next, at);
      return this.result(c.row, c.unchanged, c.revisionId, found?.resolvedFrom);
    });
  }

  /** Retire a project: hidden, its names freed (never its slug). */
  archive(input: { slug: string; reason: string; actor: string }): ProjectMutationResult {
    const slugErr = projectNameError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    const reason = checkString(input.reason, 'reason', MAX_REASON);
    if (reason.trim() === '') fail('reason: is required');
    return this.mutate(() => {
      const found = this.resolveRaw(input.slug);
      const c = this.table.archive(found?.raw.slug ?? input.slug, reason, input.actor, this.nowIso(), (row) => {
        this.db.prepare('DELETE FROM project_names WHERE slug = ?').run(row.slug);
      });
      return this.result(c.row, c.unchanged, c.revisionId, found?.resolvedFrom);
    });
  }

  /** Reactivate an archived project. Its names are re-checked: if any is taken, nothing is restored. */
  restore(input: { slug: string }): ProjectMutationResult {
    const slugErr = projectNameError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    return this.mutate(() => {
      const found = this.resolveRaw(input.slug);
      const restored: { card?: ProjectCard } = {};
      const c = this.table.restore(found?.raw.slug ?? input.slug, this.nowIso(), (row) => {
        const card = parseRow(row).card;
        try {
          this.checkNames(card.slug, card.links.aliases ?? []);
        } catch (e) {
          fail(`project ${row.slug} can't be restored, nothing was: ${(e as Error).message}`);
        }
        restored.card = card;
      });
      if (restored.card) this.syncNames(restored.card);
      return this.result(c.row, c.unchanged, c.revisionId, found?.resolvedFrom);
    });
  }

  revisionRestore(input: { slug: string; revision_id: number }): ProjectMutationResult {
    const slugErr = projectNameError(input.slug);
    if (slugErr) fail(`slug: ${slugErr}`);
    return this.mutate(() => {
      const found = this.resolveRaw(input.slug);
      const slug = found?.raw.slug ?? input.slug;
      const c = this.table.revisionRestore(
        slug,
        input.revision_id,
        this.nowIso(),
        (card) => {
          // Structural only, as person cards; and the snapshot's names must still be free.
          validateProjectCard(card, null);
          this.checkNames(slug, card.links.aliases ?? []);
        },
        (card) => ({ status: card.status as string }),
      );
      if (!c.unchanged) this.syncNames(c.card as unknown as ProjectCard);
      return this.result(c.row, c.unchanged, c.revisionId, found?.resolvedFrom);
    });
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** The row a name reaches (see resolveRaw), parsed. Throws UnreadableProjectError for a bad row. */
  resolve(name: string): { row: ProjectRow; resolvedFrom?: string } | null {
    if (!this.migrated) return null;
    const found = this.resolveRaw(name);
    return found ? { row: parseRow(found.raw), ...(found.resolvedFrom ? { resolvedFrom: found.resolvedFrom } : {}) } : null;
  }

  read(name: string, includeArchived = false): ProjectReadResult {
    const err = projectNameError(name);
    if (err) fail(`slug: ${err}`);
    const found = this.resolve(name);
    if (!found) return { found: false };
    const { row } = found;
    const from = found.resolvedFrom ? { resolved_from: found.resolvedFrom } : {};
    const archived = row.archived_at !== null;
    if (archived && !includeArchived) return { found: true, archived: true, ...from };
    return {
      found: true,
      rendered: renderProjectCard(row.card, this.now()) + (archived ? `\n_(archived ${row.archived_at} by ${row.archived_by}: ${row.archive_reason})_` : ''),
      card: row.card,
      archived,
      updated: row.updated,
      synthesized_at: row.synthesized_at,
      ...from,
    };
  }

  /** Every row, archived ones only with `includeArchived`. A row that doesn't parse lists with `row: null`. */
  rows(includeArchived: boolean): ProjectListRow[] {
    if (!this.migrated) return [];
    return this.table.allRows(includeArchived).map((raw) => {
      let row: ProjectRow | null = null;
      try {
        row = parseRow(raw);
      } catch {
        // An unreadable card still lists.
      }
      const { slug, name, status, archived_at, updated, synthesized_at } = raw;
      return { row, raw: { slug, name, status, archived_at, updated, synthesized_at } };
    });
  }

  history(name: string): ProjectRevisionMeta[] {
    const err = projectNameError(name);
    if (err) fail(`slug: ${err}`);
    if (!this.migrated) return [];
    const found = this.resolveRaw(name);
    return this.table.history(found?.raw.slug ?? name);
  }

  /** The name `name` resolves through, when it's an alias (for surfaces that return a list). */
  resolvedFrom(name: string): string | undefined {
    if (!this.migrated) return undefined;
    return this.resolveRaw(name)?.resolvedFrom;
  }

  /** A revision's snapshot (the whole previous row), for tests and inspection. */
  revisionSnapshot(id: number): { slug: string; card: ProjectCard; synthesized_at: string | null; archived_at: string | null } | null {
    return this.table.revisionSnapshot(id);
  }

  // ─── The memories side (same database) ─────────────────────────────────────

  private memoriesReady(): boolean {
    return hasTable(this.db, 'memories');
  }

  private nameClause(names: readonly string[]): string {
    return `project IN (${names.map(() => '?').join(', ')})`;
  }

  /**
   * Non-archived, non-expired memories tagged with any of `names` whose
   * `created` is after `since` (every one of them when null).
   */
  memoriesSince(names: readonly string[], since: string | null): number {
    if (!this.memoriesReady() || names.length === 0) return 0;
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND (expires_at IS NULL OR expires_at > ?)
           AND ${this.nameClause(names)} AND (? IS NULL OR created > ?)`,
      )
      .get(this.nowIso(), ...names, since, since) as { n: number }).n;
  }

  /** When the newest matching memory last changed, or null. */
  newestMemory(names: readonly string[]): string | null {
    if (!this.memoriesReady() || names.length === 0) return null;
    const r = this.db
      .prepare(
        `SELECT MAX(COALESCE(updated, created)) AS at FROM memories WHERE archived = 0
           AND (expires_at IS NULL OR expires_at > ?) AND ${this.nameClause(names)}`,
      )
      .get(this.nowIso(), ...names) as { at: string | null };
    return r.at;
  }

  /**
   * The hub's `memories` section, or null when there is no memories table:
   * the 20 newest by `created` plus the 10 with the highest stored salience
   * (ties: newer first), deduplicated by ref, newest first; and a count per
   * category over every match. `new` is "changed after `since`".
   */
  memorySection(names: readonly string[], since: string): { items: HubMemory[]; total: number; counts: Record<string, number> } | null {
    if (!this.memoriesReady()) return null;
    if (names.length === 0) return { items: [], total: 0, counts: {} };
    const hasSalience = (this.db.pragma('table_info(memories)') as { name: string }[]).some((c) => c.name === 'salience');
    const where = `archived = 0 AND (expires_at IS NULL OR expires_at > ?) AND ${this.nameClause(names)}`;
    const args = [this.nowIso(), ...names];
    type Row = { ref: string; category: string; title: string; content: string; created: string; updated: string | null };
    const cols = 'ref, category, title, content, created, updated';
    const newest = this.db.prepare(`SELECT ${cols} FROM memories WHERE ${where} ORDER BY created DESC, id DESC LIMIT ?`).all(...args, HUB_NEWEST) as Row[];
    const salient = hasSalience
      ? (this.db.prepare(`SELECT ${cols} FROM memories WHERE ${where} ORDER BY salience DESC, created DESC, id DESC LIMIT ?`).all(...args, HUB_SALIENT) as Row[])
      : [];
    const byRef = new Map<string, Row>();
    for (const r of [...newest, ...salient]) byRef.set(r.ref, r);
    const sinceMs = Date.parse(since);
    const items = [...byRef.values()]
      .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
      .map((r) => {
        const updated = r.updated ?? r.created;
        const text = oneLine(`${r.title} — ${r.content}`);
        return {
          ref: r.ref,
          category: r.category,
          snippet: text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text,
          created: r.created,
          updated,
          new: Date.parse(updated) > sinceMs,
        };
      });
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of this.db.prepare(`SELECT category, COUNT(*) AS n FROM memories WHERE ${where} GROUP BY category ORDER BY category`).all(...args) as { category: string; n: number }[]) {
      counts[r.category] = r.n;
      total += r.n;
    }
    return { items, total, counts };
  }

  /**
   * Tags on non-archived, non-expired memories (any scope) that are no live
   * project's name, with counts, most first (ties by tag). An archived
   * project's names come back here: tags with nothing behind them again.
   */
  orphans(): Array<{ tag: string; count: number }> {
    if (!this.memoriesReady()) return [];
    const live = this.migrated ? 'AND project NOT IN (SELECT name FROM project_names)' : '';
    return this.db
      .prepare(
        `SELECT project AS tag, COUNT(*) AS count FROM memories
         WHERE archived = 0 AND (expires_at IS NULL OR expires_at > ?) AND project IS NOT NULL AND project != '' ${live}
         GROUP BY project ORDER BY count DESC, project ASC`,
      )
      .all(this.nowIso()) as Array<{ tag: string; count: number }>;
  }

  /** Stale and unverified `where` counts for a card. */
  static whereCounts(card: ProjectCard, nowMs: number): { stale: number; unverified: number } {
    return whereCounts(card.where, nowMs);
  }
}

/**
 * Every name of the live project `name` is a name of, read from
 * project_names; null when it's no live project's name or the table isn't
 * there. Recall and find_similar resolve with this (isVisibleInProject).
 */
export function projectNameSet(db: Database, name: string): Set<string> | null {
  if (!hasTable(db, 'project_names')) return null;
  const holder = db.prepare('SELECT slug FROM project_names WHERE name = ?').get(name) as { slug: string } | undefined;
  if (!holder) return null;
  const rows = db.prepare('SELECT name FROM project_names WHERE slug = ?').all(holder.slug) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Open the projects store on a context's memory database. A read-only open
 * returns null when there is no database file yet; a writable one creates it.
 */
export function openProjectsStore(
  contextDir: string,
  opts: { readonly?: boolean; now?: () => number; actor?: string } = {},
): ProjectsStore | null {
  const dbPath = resolveSqliteDbPath(contextDir);
  if (opts.readonly && !existsSync(dbPath)) return null;
  return new ProjectsStore({ dbPath, readonly: opts.readonly, now: opts.now, actor: opts.actor });
}

// ─── Identity's `project` param ──────────────────────────────────────────────

const PROJECT_HEADING = '# This project';
/** The longest name a placeholder echoes. A name that can't be a project's is cut here. */
const ECHO_MAX = MAX_PROJECT_SLUG;

/**
 * The `# This project` block for identity: the heading and the rendered card
 * (≤ 2,015 chars: the card's cap is checked at write, so it never needs
 * truncating). Best-effort as person cards: a missing, archived or
 * unreadable card gives its placeholder line, never a failure.
 */
export function projectBlock(contextDir: string, name: string | undefined, opts: { nowMs?: number; onFailure?: (err: unknown) => void } = {}): string | null {
  if (!name) return null;
  const echo = name.length > ECHO_MAX ? `${name.slice(0, ECHO_MAX)}…` : name;
  const line = (text: string) => `${PROJECT_HEADING}\n${text}`;
  if (projectNameError(name)) return line(`_(no project ${echo})_`);
  let store: ProjectsStore | null;
  try {
    store = openProjectsStore(contextDir, { readonly: true });
  } catch (e) {
    opts.onFailure?.(e);
    return line(`_(project ${echo} is unreadable)_`);
  }
  if (!store) return line(`_(no project ${echo})_`);
  try {
    const found = store.resolve(name);
    if (!found) return line(`_(no project ${echo})_`);
    if (found.row.archived_at !== null) return line(`_(project ${echo} is archived)_`);
    return line(renderProjectCard(found.row.card, opts.nowMs ?? Date.now()));
  } catch (e) {
    console.error(`[loom:identity] project card ${echo} unreadable:`, e);
    opts.onFailure?.(e);
    return line(`_(project ${echo} is unreadable)_`);
  } finally {
    store.close();
  }
}
