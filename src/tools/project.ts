/**
 * Project tools — project_write / project_verify / project_archive /
 * project_restore / project_history / project_revision_restore / project /
 * project_list / project_hub / project_orphans (docs/specs/projects.md).
 *
 * Thin wrappers over backends/projects.ts, as tools/person.ts is over
 * people.ts, plus the hub: a project's sections, computed at read, never
 * stored. The core sections are `memories` (same database as the card),
 * `notes` (the context's notes.db) and `people` (person cards, through the
 * same opener the person tools use, so a household's directory counts), then
 * `conversations` (docs/specs/conversations.md: the 20 newest whose digests
 * name the project).
 * A section whose store doesn't exist yet is absent; one whose source throws
 * becomes `{key, error}`; every other section still returns.
 *
 * Piece sections (`piece:<name>`, the section-feed seam) are a later slice:
 * `HubOptions.pieceSections` is the hook. The default contributes nothing.
 */
import { existsSync } from 'node:fs';
import { conversationsSection } from '../conversations.js';
import type { HubConversation } from '../backends/conversations.js';
import BetterSqlite3 from 'better-sqlite3';
import { resolveIdentityName } from '../config.js';
import { expiresAt, notesDbPath, type Lifespan } from '../notes.js';
import { CardError, fieldState, marker } from '../backends/cards.js';
import type { CardValue } from '../backends/people.js';
import {
  openProjectsStore,
  projectNameError,
  renderProjectCard,
  namesOf,
  fieldNameOf,
  ProjectsStore,
  UnreadableProjectError,
  STATUSES,
  type ProjectCard,
  type ProjectLinks,
  type ProjectReadResult,
  type ProjectStatus,
  type ProjectWriteInput,
  type HubMemory,
} from '../backends/projects.js';
import { openPeople } from './person.js';

const json = (v: unknown) => JSON.stringify(v, null, 2);
const DAY_MS = 86_400_000;
const HUB_NOTES = 20;
/** `since`'s default: 7 days ago. */
export const DEFAULT_SINCE_DAYS = 7;

function assertName(name: string): void {
  const err = projectNameError(name);
  if (err) throw new CardError(`slug: ${err}`);
}

function errorText(e: unknown): string {
  return `Error: ${(e as Error).message ?? String(e)}`;
}

function withStore<T>(contextDir: string, fn: (s: ProjectsStore) => T, opts: { readonly?: boolean; now?: () => number } = {}): T | null {
  const store = openProjectsStore(contextDir, { ...opts, actor: opts.readonly ? undefined : resolveIdentityName(contextDir) });
  if (!store) return null;
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function writing(contextDir: string, fn: (s: ProjectsStore) => unknown): string {
  try {
    return json(withStore(contextDir, fn));
  } catch (e) {
    return errorText(e);
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export async function projectWrite(contextDir: string, input: ProjectWriteInput): Promise<string> {
  return writing(contextDir, (s) => s.write(input));
}

export async function projectVerify(
  contextDir: string,
  input: { slug: string; fields: string[]; verified_at?: string; source?: string },
): Promise<string> {
  return writing(contextDir, (s) => s.verify(input));
}

export async function projectArchive(contextDir: string, input: { slug: string; reason: string }): Promise<string> {
  // The actor is the calling agent's name, as person_archive.
  return writing(contextDir, (s) => s.archive({ ...input, actor: resolveIdentityName(contextDir) }));
}

export async function projectRestore(contextDir: string, input: { slug: string }): Promise<string> {
  return writing(contextDir, (s) => s.restore(input));
}

export async function projectRevisionRestore(contextDir: string, input: { slug: string; revision_id: number }): Promise<string> {
  return writing(contextDir, (s) => s.revisionRestore(input));
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** The `project` read. Throws on an invalid name or an unreadable row. */
export function readProject(contextDir: string, name: string, includeArchived = false): ProjectReadResult {
  assertName(name);
  return withStore(contextDir, (s) => s.read(name, includeArchived), { readonly: true }) ?? { found: false };
}

export function projectHistoryOf(contextDir: string, name: string): { revisions: ReturnType<ProjectsStore['history']>; resolved_from?: string } {
  assertName(name);
  return (
    withStore(contextDir, (s) => {
      const from = s.resolvedFrom(name);
      return { revisions: s.history(name), ...(from ? { resolved_from: from } : {}) };
    }, { readonly: true }) ?? { revisions: [] }
  );
}

export interface ProjectListEntry {
  slug: string;
  name: string;
  status: ProjectStatus | string;
  archived: boolean;
  links: ProjectLinks;
  activity: string;
  updated: string;
  synthesized_at: string | null;
  stale: number;
  unverified: number;
  memories_since_synthesis: number;
  /** Set when the stored card doesn't parse; the counts then read zero. */
  unreadable?: true;
}

/** The latest of the given ISO times (nulls ignored). */
function latest(...times: Array<string | null | undefined>): string {
  return times.filter((t): t is string => !!t).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export function listProjects(
  contextDir: string,
  opts: { status?: string; include_archived?: boolean; nowMs?: number } = {},
): ProjectListEntry[] {
  if (opts.status !== undefined && !(STATUSES as readonly string[]).includes(opts.status)) {
    throw new CardError(`status: must be one of ${STATUSES.join(', ')}`);
  }
  const nowMs = opts.nowMs ?? Date.now();
  const notes = openNotesReader(contextDir);
  try {
    const entries =
      withStore(contextDir, (s) =>
        s
          .rows(opts.include_archived ?? false)
          .filter((r) => opts.status === undefined || r.raw.status === opts.status)
          .map((r): ProjectListEntry => {
            const card = r.row?.card;
            const names = card ? namesOf(card) : [r.raw.slug];
            const counts = card ? ProjectsStore.whereCounts(card, nowMs) : { stale: 0, unverified: 0 };
            let newestNote: string | null = null;
            try {
              newestNote = notes && card ? notes.newest(notePrefixes(card), nowMs) : null;
            } catch {
              // A notes store that can't be read only leaves the notes out of activity.
            }
            return {
              slug: r.raw.slug,
              name: r.raw.name,
              status: r.raw.status,
              archived: r.raw.archived_at !== null,
              links: card?.links ?? {},
              activity: latest(r.raw.updated, s.newestMemory(names), newestNote),
              updated: r.raw.updated,
              synthesized_at: r.raw.synthesized_at,
              stale: counts.stale,
              unverified: counts.unverified,
              memories_since_synthesis: s.memoriesSince(names, r.raw.synthesized_at),
              ...(card ? {} : { unreadable: true as const }),
            };
          }),
        { readonly: true, now: () => nowMs },
      ) ?? [];
    // Most recent activity first; ties by slug, so the order is stable.
    return entries.sort((a, b) => Date.parse(b.activity) - Date.parse(a.activity) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  } finally {
    notes?.close();
  }
}

export function projectOrphans(contextDir: string): Array<{ tag: string; count: number }> {
  return withStore(contextDir, (s) => s.orphans(), { readonly: true }) ?? [];
}

// ─── The hub ─────────────────────────────────────────────────────────────────

export interface HubNote {
  path: string;
  lifespan: Lifespan;
  updated: string;
  new: boolean;
}

export interface HubPerson {
  slug: string;
  name: string;
  field: string;
  value: CardValue;
  marker: string;
}

export type HubSection =
  | { key: 'memories'; items: HubMemory[]; total: number; counts: Record<string, number> }
  | { key: 'notes'; items: HubNote[]; total: number }
  | { key: 'people'; items: HubPerson[] }
  | { key: 'conversations'; items: HubConversation[] }
  | { key: string; groups: unknown[] }
  | { key: string; error: string };

/**
 * The seam for piece sections (`piece:<name>`): given the project (its card,
 * with names taken from the card so an archived project's still work) and
 * `since`, return the pieces' sections. Each must already be keyed
 * `piece:<name>` and turn its own failure into `{key, error}`; the hub orders
 * them by key after the core sections.
 */
export type PieceSectionSource = (args: { contextDir: string; card: ProjectCard; since: string }) => Promise<HubSection[]>;

/** No section feeds yet: the seam's later slice (docs/specs/projects.md, criteria 10–11) plugs in here. */
export const noPieceSections: PieceSectionSource = async () => [];

export interface HubOptions {
  nowMs?: number;
  pieceSections?: PieceSectionSource;
}

export type ProjectHubResult =
  | { found: false }
  | { found: true; archived: true; resolved_from?: string }
  | {
      found: true;
      archived: boolean;
      resolved_from?: string;
      card: ProjectCard;
      rendered: string;
      updated: string;
      synthesized_at: string | null;
      since: string;
      activity: string;
      sections: HubSection[];
    };

/** A context's notes.db, read-only; null when there's no notes store yet. */
function openNotesReader(contextDir: string) {
  const path = notesDbPath(contextDir);
  if (!existsSync(path)) return null;
  const db = new BetterSqlite3(path, { readonly: true });
  type Row = { path: string; lifespan: Lifespan; pinned: number; updated: string };
  const under = (prefixes: readonly string[], nowMs: number): Row[] => {
    const stmt = db.prepare("SELECT path, lifespan, pinned, updated FROM notes WHERE path = ? OR path LIKE ? ESCAPE '\\'");
    const seen = new Map<string, Row>();
    for (const p of prefixes) {
      for (const r of stmt.all(p, `${p.replace(/[\\%_]/g, '\\$&')}/%`) as Row[]) seen.set(r.path, r);
    }
    // Expired notes are out even when no sweep has run yet.
    return [...seen.values()].filter((r) => {
      const exp = r.pinned ? null : expiresAt(r.lifespan, r.updated);
      return exp === null || Date.parse(exp) >= nowMs;
    });
  };
  return {
    under,
    newest(prefixes: readonly string[], nowMs: number): string | null {
      const rows = under(prefixes, nowMs);
      return rows.length ? latest(...rows.map((r) => r.updated)) : null;
    },
    close: () => db.close(),
  };
}

/** The note prefixes a project reads: `links.notes`, or its slug. */
const notePrefixes = (card: ProjectCard) => (card.links.notes?.length ? card.links.notes : [card.slug]);

function notesSection(contextDir: string, card: ProjectCard, since: string, nowMs: number): HubSection | null {
  const notes = openNotesReader(contextDir);
  if (!notes) return null;
  try {
    const sinceMs = Date.parse(since);
    const rows = notes.under(notePrefixes(card), nowMs).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated) || (a.path < b.path ? -1 : 1));
    return {
      key: 'notes',
      items: rows.slice(0, HUB_NOTES).map((r) => ({ path: r.path, lifespan: r.lifespan, updated: r.updated, new: Date.parse(r.updated) > sinceMs })),
      total: rows.length,
    };
  } finally {
    notes.close();
  }
}

/**
 * Active person cards with a `where` field named by any of the project's
 * field names (a name with `-` replaced by `_`), ordered by the person's name.
 */
function peopleSection(contextDir: string, card: ProjectCard, nowMs: number): HubSection | null {
  const store = openPeople(contextDir, { readonly: true });
  if (!store) return null;
  try {
    if ('migrated' in store && !store.migrated) return null;
    const fields = [...new Set(namesOf(card).map(fieldNameOf))];
    const items: HubPerson[] = [];
    for (const entry of store.list(false)) {
      let row;
      try {
        row = store.getRow(entry.slug);
      } catch {
        continue; // One unreadable card doesn't take the section down.
      }
      if (!row || row.archived_at !== null) continue;
      for (const f of fields) {
        if (!Object.hasOwn(row.card.where, f)) continue;
        const env = row.card.where[f];
        items.push({
          slug: row.slug,
          name: row.card.name,
          field: f,
          value: env.value,
          marker: marker(fieldState(env, nowMs)),
        });
      }
    }
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    items.sort((a, b) => cmp(a.name, b.name) || cmp(a.slug, b.slug) || cmp(a.field, b.field));
    return { key: 'people', items };
  } finally {
    store.close();
  }
}

/** Run one section, turning a throw into `{key, error}`. Null means absent. */
function section(key: string, fn: () => HubSection | null): HubSection | null {
  try {
    return fn();
  } catch (e) {
    return { key, error: (e as Error).message ?? String(e) };
  }
}

function parseSince(since: string | undefined, nowMs: number): string {
  if (since === undefined) return new Date(nowMs - DEFAULT_SINCE_DAYS * DAY_MS).toISOString();
  const ms = Date.parse(since);
  if (typeof since !== 'string' || Number.isNaN(ms)) throw new CardError('since: must be an ISO-8601 time');
  return new Date(ms).toISOString();
}

/**
 * `project_hub({slug, since?, include_archived?})`: the card and its sections.
 * A missing project is `{found: false}`; an archived one without
 * `include_archived` is `{found: true, archived: true}` and runs nothing.
 */
export async function projectHubOf(
  contextDir: string,
  input: { slug: string; since?: string; include_archived?: boolean },
  opts: HubOptions = {},
): Promise<ProjectHubResult> {
  assertName(input.slug);
  const nowMs = opts.nowMs ?? Date.now();
  const since = parseSince(input.since, nowMs);
  const store = openProjectsStore(contextDir, { readonly: true, now: () => nowMs });
  if (!store) return { found: false };
  try {
    const found = store.resolve(input.slug);
    if (!found) return { found: false };
    const { row } = found;
    const from = found.resolvedFrom ? { resolved_from: found.resolvedFrom } : {};
    const archived = row.archived_at !== null;
    if (archived && !input.include_archived) return { found: true, archived: true, ...from };
    // Names come from the card, so an archived project's (no longer in project_names) still work.
    const names = namesOf(row.card);
    const core = [
      section('memories', () => {
        const m = store.memorySection(names, since);
        return m ? { key: 'memories', ...m } : null;
      }),
      section('notes', () => notesSection(contextDir, row.card, since, nowMs)),
      section('people', () => peopleSection(contextDir, row.card, nowMs)),
      // After people (docs/specs/conversations.md, "Projects"): digests store project slugs, resolved at write.
      section('conversations', () => conversationsSection(contextDir, row.card.slug, since)),
    ].filter((s): s is HubSection => s !== null);
    let pieces: HubSection[];
    try {
      pieces = await (opts.pieceSections ?? noPieceSections)({ contextDir, card: row.card, since });
    } catch {
      pieces = [];
    }
    pieces = [...pieces].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const memories = core.find((s) => s.key === 'memories' && 'items' in s) as { items: HubMemory[] } | undefined;
    const notes = core.find((s) => s.key === 'notes' && 'items' in s) as { items: HubNote[] } | undefined;
    const activity = latest(
      row.updated,
      memories?.items.length ? latest(...memories.items.map((m) => m.updated)) : null,
      notes?.items[0]?.updated,
    );
    return {
      found: true,
      archived,
      ...from,
      card: row.card,
      rendered: renderProjectCard(row.card, nowMs),
      updated: row.updated,
      synthesized_at: row.synthesized_at,
      since,
      activity,
      sections: [...core, ...pieces],
    };
  } finally {
    store.close();
  }
}

// ─── MCP text wrappers ───────────────────────────────────────────────────────

async function text(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    return json(await fn());
  } catch (e) {
    if (e instanceof CardError || e instanceof UnreadableProjectError) return `Error: ${e.message}`;
    return errorText(e);
  }
}

export async function project(contextDir: string, input: { slug: string; include_archived?: boolean }): Promise<string> {
  return text(() => readProject(contextDir, input.slug, input.include_archived ?? false));
}

export async function projectList(contextDir: string, input: { status?: string; include_archived?: boolean }): Promise<string> {
  return text(() => listProjects(contextDir, input));
}

export async function projectHub(contextDir: string, input: { slug: string; since?: string; include_archived?: boolean }): Promise<string> {
  return text(() => projectHubOf(contextDir, input));
}

export async function projectOrphansText(contextDir: string): Promise<string> {
  return text(() => projectOrphans(contextDir));
}

export async function projectHistory(contextDir: string, input: { slug: string }): Promise<string> {
  return text(() => projectHistoryOf(contextDir, input.slug));
}
