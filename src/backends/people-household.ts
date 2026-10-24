/**
 * Person cards in a household (docs/specs/household.md, "The commons"): one
 * card a reader sees, kept in two places.
 *
 *   directory     commons/people.db, one entry per human, shared by every
 *                 agent: name, `where` (handles), and the facts in `how`
 *                 that don't depend on who's asking (FACT_KEYS)
 *   relationship  the agent's own memories.db: summary, the rest of `how`
 *                 (how *this* agent talks to them), `may`
 *
 * A read merges the two into one card, rendered exactly as before. A write
 * splits by field. Every revision names the agent that made it. No agent
 * reads another's relationship: there's no API for it here.
 *
 * Same surface as PeopleStore, so the person tools don't care which they got.
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import {
  PeopleStore, PersonCardError, renderCard,
  type MutationResult, type PersonCard, type PersonListEntry, type PersonReadResult, type PersonRevisionMeta,
  type PersonRow, type PersonWriteInput,
} from './people.js';
import { resolveSqliteDbPath } from '../config.js';
import { commonsDir, type Household } from '../household.js';

/** `how` fields that are facts about the person, not how one agent talks to them. */
export const FACT_KEYS: ReadonlySet<string> = new Set(['tz', 'timezone', 'pronouns', 'languages']);

export function commonsPeoplePath(h: Household): string {
  return join(commonsDir(h), 'people.db');
}

type How = PersonCard['how'];

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function splitHow(how: How | Record<string, unknown> | undefined): { facts: Record<string, unknown>; rest: Record<string, unknown> } {
  const facts: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(how ?? {})) (FACT_KEYS.has(k) ? facts : rest)[k] = v;
  return { facts, rest };
}

/** The directory half and the relationship half of a whole card. */
export function splitCard(card: PersonCard): { directory: PersonCard; relationship: PersonCard } {
  const { facts, rest } = splitHow(card.how);
  return {
    directory: { slug: card.slug, name: card.name, where: card.where ?? {}, how: facts as How, may: [] },
    relationship: {
      slug: card.slug, name: card.name, ...(card.summary !== undefined ? { summary: card.summary } : {}),
      where: {}, how: rest as How, may: card.may ?? [],
    },
  };
}

/** One card from its two halves. */
export function mergeCard(d: PersonCard, r: PersonCard | null): PersonCard {
  return {
    slug: d.slug,
    name: d.name,
    ...(r?.summary !== undefined ? { summary: r.summary } : {}),
    where: d.where ?? {},
    how: { ...(r?.how ?? {}), ...(d.how ?? {}) },
    may: r?.may ?? [],
  };
}

/** Try a write against an in-memory copy of the current row; throws exactly what the real write would. */
function rehearse(row: PersonRow | null, input: PersonWriteInput | null, now: () => number): void {
  if (!input) return;
  const mem = new PeopleStore({ dbPath: ':memory:', now });
  try {
    if (row) {
      mem.replaceCard(row.slug, row.card, {
        updated: row.updated, synthesized_at: row.synthesized_at,
        archived_at: row.archived_at, archived_by: row.archived_by, archive_reason: row.archive_reason,
      });
    }
    mem.write(input);
  } finally {
    mem.close();
  }
}

export class HouseholdPeople {
  constructor(
    private readonly directory: PeopleStore,
    private readonly relationship: PeopleStore,
    private readonly now: () => number = Date.now,
  ) {}

  close(): void {
    this.directory.close();
    this.relationship.close();
  }

  getRow(slug: string): PersonRow | null {
    const d = this.directory.getRow(slug);
    if (!d) return null;
    const r = this.relationship.getRow(slug);
    return {
      ...d,
      card: mergeCard(d.card, r?.card ?? null),
      updated: r && r.updated > d.updated ? r.updated : d.updated,
      synthesized_at: r?.synthesized_at ?? null,
    };
  }

  read(slug: string, includeArchived = false): PersonReadResult {
    const row = this.getRow(slug);
    if (!row) return this.directory.read(slug, includeArchived);
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
    const rel = new Map(this.relationship.list(true).map((e) => [e.slug, e]));
    return this.directory.list(includeArchived).map((e) => {
      const r = rel.get(e.slug);
      const since = r?.synthesized_at ?? null;
      return {
        ...e,
        updated: r && r.updated > e.updated ? r.updated : e.updated,
        synthesized_at: since,
        memories_since_synthesis: this.relationship.memoriesSince(e.slug, since),
      };
    });
  }

  /**
   * Split a write by field: name, `where` and the fact keys of `how` go to the
   * directory; summary, the rest of `how` and `may` to this agent's
   * relationship. Both halves are rehearsed against in-memory copies first,
   * so a write either half would refuse changes neither.
   */
  write(input: PersonWriteInput): MutationResult {
    const merge = input.merge ?? true;
    const dirRow = this.directory.getRow(input.slug);
    const relRow = this.relationship.getRow(input.slug);
    const name = input.name ?? dirRow?.card.name;
    if (name === undefined) throw new PersonCardError('name: is required to create a card');
    const { facts, rest } = splitHow(input.how);

    const dirInput: PersonWriteInput | null =
      input.name !== undefined || input.where !== undefined || Object.keys(facts).length > 0 || !dirRow || !merge
        ? { slug: input.slug, name, merge, ...(input.where !== undefined ? { where: input.where } : {}), how: facts as PersonWriteInput['how'] }
        : null;
    const relInput: PersonWriteInput | null =
      input.summary !== undefined || Object.keys(rest).length > 0 || input.may !== undefined || !merge || !relRow || (input.name !== undefined && relRow.card.name !== input.name)
        ? {
            slug: input.slug, name, merge,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            how: rest as PersonWriteInput['how'],
            ...(input.may !== undefined ? { may: input.may } : {}),
          }
        : null;

    rehearse(dirRow, dirInput, this.now);
    rehearse(relRow, relInput, this.now);
    if (dirInput) this.directory.write(dirInput);
    if (relInput) this.relationship.write(relInput);
    return this.mutation(input.slug);
  }

  verify(input: { slug: string; fields: string[]; verified_at?: string; source?: string }): MutationResult {
    this.directory.verify(input);
    return this.mutation(input.slug);
  }

  archive(input: { slug: string; reason: string; actor: string }): MutationResult {
    this.directory.archive(input);
    if (this.relationship.getRow(input.slug)) this.relationship.archive(input);
    return this.mutation(input.slug);
  }

  restore(input: { slug: string }): MutationResult {
    this.directory.restore(input);
    if (this.relationship.getRow(input.slug)) this.relationship.restore(input);
    return this.mutation(input.slug);
  }

  /** Revisions from both halves, newest first, each saying which half and which agent. */
  history(slug: string): PersonRevisionMeta[] {
    return [
      ...this.directory.history(slug).map((r) => ({ ...r, store: 'directory' as const })),
      ...this.relationship.history(slug).map((r) => ({ ...r, store: 'relationship' as const })),
    ].sort((a, b) => (a.replaced_at < b.replaced_at ? 1 : a.replaced_at > b.replaced_at ? -1 : 0));
  }

  /** Restore one half to a revision: `store` says which (the relationship, unless named). */
  revisionRestore(input: { slug: string; revision_id: number; store?: 'directory' | 'relationship' }): MutationResult {
    (input.store === 'directory' ? this.directory : this.relationship).revisionRestore(input);
    return this.mutation(input.slug);
  }

  private mutation(slug: string): MutationResult {
    const row = this.getRow(slug);
    if (!row) throw new PersonCardError(`no card for ${slug}`);
    return { card: row.card, unchanged: false, revision_id: null, archived: row.archived_at !== null, updated: row.updated, synthesized_at: row.synthesized_at };
  }
}

/**
 * Open the people for a household agent: the commons directory plus the
 * agent's relationships, both attributing revisions to the agent. A
 * read-only open returns null when the directory doesn't exist yet.
 */
export function openHouseholdPeople(
  h: Household,
  agent: string,
  contextDir: string,
  opts: { readonly?: boolean; now?: () => number } = {},
): HouseholdPeople | null {
  const dirPath = commonsPeoplePath(h);
  const relPath = resolveSqliteDbPath(contextDir);
  if (opts.readonly && (!existsSync(dirPath) || !existsSync(relPath))) return null;
  if (!opts.readonly) mkdirSync(commonsDir(h), { recursive: true, mode: 0o700 });
  return new HouseholdPeople(
    new PeopleStore({ dbPath: dirPath, readonly: opts.readonly, now: opts.now, actor: agent }),
    new PeopleStore({ dbPath: relPath, readonly: opts.readonly, now: opts.now, actor: agent }),
    opts.now,
  );
}

/**
 * Move an agent's whole cards into the household split: the directory half
 * to the commons, the relationship half back in place (timestamps and
 * archive state kept). Every card is checked first: merged back together it
 * must render the same text it does today, or nothing is written. Refuses a
 * slug the directory already has (merging a second agent's people is a later
 * step). Returns how many cards moved.
 */
export function splitPeopleIntoCommons(h: Household, agent: string, contextDir: string, nowMs = Date.now()): number {
  if (!existsSync(resolveSqliteDbPath(contextDir))) return 0;
  mkdirSync(commonsDir(h), { recursive: true, mode: 0o700 });
  const rel = new PeopleStore({ dbPath: resolveSqliteDbPath(contextDir), actor: agent });
  const dir = new PeopleStore({ dbPath: commonsPeoplePath(h), actor: agent });
  try {
    const plan = rel.rows().flatMap((r) => {
      const halves = splitCard(r.card);
      const there = dir.getRow(r.slug);
      // Already split (a re-run): the agent's card holds no handles or facts
      // and the directory has the person.
      if (there && !holdsDirectoryFields(r.card)) return [];
      if (there && canonicalJson(there.card) !== canonicalJson(halves.directory)) {
        throw new PersonCardError(`${r.slug} is already in the directory with different details; merging another agent's card into it isn't automatic yet`);
      }
      const before = renderCard(r.card, nowMs);
      const after = renderCard(mergeCard(halves.directory, halves.relationship), nowMs);
      if (before !== after) throw new PersonCardError(`${r.slug} would render differently after the split; nothing was moved`);
      return [{ r, halves }];
    });
    for (const { r, halves } of plan) {
      const keep = { updated: r.updated, archived_at: r.archived_at, archived_by: r.archived_by, archive_reason: r.archive_reason };
      dir.replaceCard(r.slug, halves.directory, { ...keep, synthesized_at: null });
      rel.replaceCard(r.slug, halves.relationship, { ...keep, synthesized_at: r.synthesized_at });
    }
    return plan.length;
  } finally {
    rel.close();
    dir.close();
  }
}

function holdsDirectoryFields(card: PersonCard): boolean {
  return Object.keys(card.where ?? {}).length > 0 || Object.keys(splitHow(card.how).facts).length > 0;
}

/** Whether an agent still holds directory fields (handles, facts) in its own cards: an unsplit store. */
export function hasUnsplitPeople(contextDir: string): boolean {
  if (!existsSync(resolveSqliteDbPath(contextDir))) return false;
  const rel = new PeopleStore({ dbPath: resolveSqliteDbPath(contextDir), readonly: true });
  try {
    return rel.rows().some((r) => holdsDirectoryFields(r.card));
  } finally {
    rel.close();
  }
}
