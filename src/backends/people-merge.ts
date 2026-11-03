/**
 * Merge one person card into another (docs/specs/person-cards.md, "Merge"): two agents each
 * met the same human and each made a card, and it turns out they're one person. After a
 * merge there is one card, and nothing in loom points at the old slug.
 *
 *   the card     into keeps its name and summary; `where` is the union of both cards' values
 *                (per field, by id); `how` and `may` are the union, into's winning a clash;
 *                into's summary gains one line, "Merged <from> (<name>) <date>", and from's
 *                card is kept in into's history (op merged_from). In a household that's done
 *                to the directory entry and to every agent's own copy (its relationship).
 *   re-tags      every memory and memory proposal tagged `from` (metadata.person, or in
 *                metadata.people) in every agent's store; every conversation's people and
 *                every turn from the person; `how.via` and `how.loop_in` on every card
 *   the redirect from is archived, and person_merges records from -> into (in every store the
 *                merge touched), so reading from answers into's card and a later write to
 *                from (person_write, ensure, reach, verify) lands on into, until it's purged
 *                by hand
 *
 * One SQLite transaction per database. In a household that's the directory first (the card,
 * the archive and the redirect together), then each agent's store (its copy, its re-tags),
 * then the counts. A crash between them leaves at worst a redirect with some agent stores
 * not yet re-tagged; running the same merge again finds the redirect and finishes them.
 *
 * The caller's authority is checked where it arrives (the MCP tool, the CLI, the HTTP
 * route); this module only plans and writes.
 */
import { existsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import {
  PeopleStore, PersonCardError, personSlugError, validateCard,
  type PersonCard, type WhereEnvelope, type PersonMergeRecord,
} from './people.js';
import { commonsPeoplePath, kindOf, mergeCard } from './people-household.js';
import { holdsValue, valuesOf } from './people-ensure.js';
import { hasTable, isPlainObject, CardError, type CardRowBase, type CardTable } from './cards.js';
import { fieldNameOf, namesOf, type ProjectCard } from './projects.js';
import { agentDir, type Household } from '../household.js';
import { resolveSqliteDbPath } from '../config.js';

/** A refusal, with the HTTP status it answers: 400 a bad request, 404 no such card, 409 the cards can't be merged. */
export class PersonMergeError extends PersonCardError {
  constructor(message: string, readonly status: 400 | 404 | 409 = 409) {
    super(message);
    this.name = 'PersonMergeError';
  }
}

export interface PersonMergeInput {
  from: string;
  into: string;
  /** Plan only: say what would change, write nothing (the stores are opened read-only). */
  dry_run?: boolean;
}

/** What a merge did (or would do) in one agent's store. */
export interface StoreCounts {
  /**
   * The agent's copy of the card: `merged` (it had both), `moved` (it had only from's: it's
   * into's now), `noted` (it had only into's: the merge line was added), `none` (neither).
   */
  card: 'merged' | 'moved' | 'noted' | 'none';
  /** Memories tagged from (metadata.person or metadata.people), archived ones too. */
  memories: number;
  /** Memory proposals tagged from. */
  proposals: number;
  /** Conversations whose people named from. */
  conversations: number;
  /** Turns from the person from. */
  turns: number;
  /** Other cards in this store whose how.via or how.loop_in named from. */
  relinked: string[];
}

export interface PersonMergeResult {
  from: string;
  into: string;
  dry_run: boolean;
  /** The redirect was already there (an earlier merge stopped part-way, or an agent merged only its own): this one finished it. */
  resumed: boolean;
  /** from had no card, only tags: memories, conversations and links were re-tagged and the redirect written; no card was archived. */
  cardless: boolean;
  /** Who merged: recorded on the redirect and every revision. */
  merged_by: string;
  /** `where` values into gains, by field. */
  where_added: Record<string, string[]>;
  /** `how` keys into gains (from any copy). */
  how_added: string[];
  /** `may` entries into gains (all copies). */
  may_added: number;
  /** Into's card after the merge, as `viewer` (the calling agent, or the household's default) sees it. */
  card: PersonCard;
  /**
   * Per agent (one entry for a store outside a household). An agent's own merge lists only
   * itself: other agents' stores are theirs, and `not_done` names them.
   */
  agents: Record<string, StoreCounts>;
  /** In a household: the shared directory's cards relinked (how.via). */
  directory?: { relinked: string[] };
  /** Project hubs that list from today (a where field named for the project) and will list into. */
  projects: Array<{ agent: string; project: string; field: string }>;
  /** What a card merge doesn't do: the caller's to finish. */
  not_done: string[];
}

const INPUT_KEYS = ['from', 'into', 'dry_run'];

/** The input, checked: two valid, different slugs, and nothing else. */
export function checkMergeInput(body: unknown): PersonMergeInput {
  if (!isPlainObject(body)) throw new PersonMergeError('input: is a JSON object {from, into, dry_run?}', 400);
  for (const k of Object.keys(body)) if (!INPUT_KEYS.includes(k)) throw new PersonMergeError(`${k}: unknown key (allowed: ${INPUT_KEYS.join(', ')})`, 400);
  for (const k of ['from', 'into'] as const) {
    const err = personSlugError(body[k]);
    if (err) throw new PersonMergeError(`${k}: ${err}`, 400);
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') throw new PersonMergeError('dry_run: is true or false', 400);
  if (body.from === body.into) throw new PersonMergeError(`from and into are both ${body.from as string}: a card isn't merged into itself`, 400);
  return { from: body.from as string, into: body.into as string, ...(body.dry_run !== undefined ? { dry_run: body.dry_run as boolean } : {}) };
}

// ─── The card ────────────────────────────────────────────────────────────────

const cap = (s: string, max = 200) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const older = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);

/** The line a merge adds to into's summary. */
export const mergeLine = (from: string, fromName: string, at: string) => `Merged ${from} (${fromName}) ${at.slice(0, 10)}`;

function appendLine(summary: string | undefined, line: string): string {
  return summary?.trim() ? `${summary.trimEnd()}\n${line}` : line;
}

export interface CardMerge {
  card: PersonCard;
  where_added: Record<string, string[]>;
  how_added: string[];
  may_added: number;
}

/**
 * `from`'s card folded into `into`'s. where: per field, the union of the values by id (a value
 * whose id is already there counts as there, as ensure and reach count it); a field only from
 * has comes whole, with its own verification and source. A field both have keeps one envelope
 * (the schema has one per field): checked at the older of the two times (unverified if either
 * is), both sources, both labels, the shorter staleness. how and may: the union, into winning
 * a key. Name: into's. Summary: into's (from's when into's copy has none), plus `line`.
 */
export function mergeCardInto(into: PersonCard, from: PersonCard, line?: string): CardMerge {
  const where: Record<string, WhereEnvelope> = structuredClone(into.where ?? {});
  const whereAdded: Record<string, string[]> = {};
  for (const [f, env] of Object.entries(from.where ?? {})) {
    const have = where[f];
    if (!have) {
      where[f] = structuredClone(env);
      whereAdded[f] = valuesOf(env);
      continue;
    }
    const there = valuesOf(have);
    const fresh = valuesOf(env).filter((v, i, all) => !holdsValue(there, v) && all.indexOf(v) === i);
    if (!fresh.length) continue;
    const next: WhereEnvelope = { value: [...there, ...fresh] };
    if (have.verified_at && env.verified_at) next.verified_at = older(have.verified_at, env.verified_at);
    const sources = [...new Set([have.source, env.source].filter((s): s is string => !!s))];
    if (sources.length) next.source = cap(sources.join('; '));
    const labels = [...new Set([have.label, env.label].filter((s): s is string => !!s))];
    if (labels.length) next.label = cap(labels.join(' / '));
    const stale = [have.stale_after_days, env.stale_after_days].filter((d): d is number => d !== undefined);
    if (stale.length) next.stale_after_days = Math.min(...stale);
    where[f] = next;
    whereAdded[f] = fresh;
  }
  const how = { ...(into.how ?? {}) };
  const howAdded: string[] = [];
  for (const [k, v] of Object.entries(from.how ?? {})) {
    if (Object.hasOwn(how, k)) continue;
    how[k] = structuredClone(v);
    howAdded.push(k);
  }
  const may = [...(into.may ?? [])];
  let mayAdded = 0;
  for (const m of from.may ?? []) {
    if (may.some((x) => x.text === m.text && x.source === m.source)) continue;
    may.push({ ...m });
    mayAdded++;
  }
  const base = into.summary ?? from.summary;
  const summary = line ? appendLine(base, line) : base;
  return {
    card: { slug: into.slug, name: into.name, ...(summary !== undefined ? { summary } : {}), where, how, may },
    where_added: whereAdded,
    how_added: howAdded,
    may_added: mayAdded,
  };
}

/** A card with every how.via and how.loop_in naming `from` pointed at `into`, or null when it names neither. */
export function relinkCard(card: PersonCard, from: string, into: string): PersonCard | null {
  const how = { ...(card.how ?? {}) };
  let changed = false;
  if (how.via === from) { how.via = into; changed = true; }
  const loop = how.loop_in;
  if (loop === from) { how.loop_in = into; changed = true; }
  else if (Array.isArray(loop) && loop.includes(from)) { how.loop_in = swapped(loop, from, into)!; changed = true; }
  return changed ? { ...card, how } : null;
}

/** `list` with `from` replaced by `into` (once, where it first stands), or null when it doesn't name from. */
function swapped(list: readonly unknown[], from: string, into: string): string[] | null {
  if (!list.includes(from)) return null;
  const out: string[] = [];
  for (const x of list) {
    const y = x === from ? into : x;
    if (typeof y === 'string' && !out.includes(y)) out.push(y);
  }
  return out;
}

// ─── Re-tags in one database ─────────────────────────────────────────────────

interface Retags { memories: number; proposals: number; conversations: number; turns: number }

/**
 * Re-tag `from` to `into` in one agent's memory database: memories and proposals
 * (metadata.person, metadata.people), conversations' people, turns from the person. Counts
 * only when `write` is false. A slug is [a-z0-9-], so LIKE needs no escaping; it only narrows
 * the rows, and each is checked in full after.
 */
function retag(db: Database, from: string, into: string, write: boolean): Retags {
  const out: Retags = { memories: 0, proposals: 0, conversations: 0, turns: 0 };
  const like = `%${from}%`;
  for (const table of ['memories', 'proposals'] as const) {
    if (!hasTable(db, table)) continue;
    const update = write ? db.prepare(`UPDATE ${table} SET metadata = ? WHERE id = ?`) : null;
    for (const r of db.prepare(`SELECT id, metadata FROM ${table} WHERE metadata LIKE ?`).all(like) as Array<{ id: number; metadata: string | null }>) {
      let m: unknown;
      try { m = JSON.parse(r.metadata ?? '{}'); } catch { continue; }
      if (!isPlainObject(m)) continue;
      let changed = false;
      if (m.person === from) { m.person = into; changed = true; }
      if (Array.isArray(m.people)) {
        const people = swapped(m.people, from, into);
        if (people) { m.people = people; changed = true; }
      }
      if (!changed) continue;
      out[table]++;
      update?.run(JSON.stringify(m), r.id);
    }
  }
  if (hasTable(db, 'conversations')) {
    const update = write ? db.prepare('UPDATE conversations SET people_json = ? WHERE id = ?') : null;
    for (const r of db.prepare('SELECT id, people_json FROM conversations WHERE people_json LIKE ?').all(like) as Array<{ id: string; people_json: string }>) {
      let people: unknown;
      try { people = JSON.parse(r.people_json); } catch { continue; }
      const next = Array.isArray(people) ? swapped(people, from, into) : null;
      if (!next) continue;
      out.conversations++;
      update?.run(JSON.stringify(next), r.id);
    }
  }
  if (hasTable(db, 'conversation_turns')) {
    const update = write ? db.prepare('UPDATE conversation_turns SET from_json = ? WHERE conversation = ? AND seq = ?') : null;
    for (const r of db.prepare('SELECT conversation, seq, from_json FROM conversation_turns WHERE from_json LIKE ?').all(like) as Array<{ conversation: string; seq: number; from_json: string }>) {
      let f: unknown;
      try { f = JSON.parse(r.from_json); } catch { continue; }
      if (!isPlainObject(f) || f.kind !== 'person' || f.slug !== from) continue;
      out.turns++;
      update?.run(JSON.stringify({ ...f, slug: into }), r.conversation, r.seq);
    }
  }
  return out;
}

/** Cards in one store (not from's own) whose how names from, and what they'd become. */
function relinks(table: CardTable<CardRowBase>, from: string, into: string, next: PersonCard | null): Array<{ row: CardRowBase; card: PersonCard }> {
  const out: Array<{ row: CardRowBase; card: PersonCard }> = [];
  for (const row of table.allRows(true)) {
    if (row.slug === from) continue;
    let card: PersonCard;
    try { card = row.slug === into && next ? next : (JSON.parse(row.card_json) as PersonCard); } catch { continue; }
    const relinked = relinkCard(card, from, into);
    if (relinked) out.push({ row, card: relinked });
  }
  return out;
}

/** Project hubs in one store that list from: an active project whose field name is one of from's where fields. */
function hubsListing(db: Database, where: Record<string, unknown>, agent: string): Array<{ agent: string; project: string; field: string }> {
  if (!hasTable(db, 'projects')) return [];
  const out: Array<{ agent: string; project: string; field: string }> = [];
  for (const r of db.prepare('SELECT slug, card_json FROM projects WHERE archived_at IS NULL ORDER BY slug').all() as Array<{ slug: string; card_json: string }>) {
    let card: ProjectCard;
    try { card = JSON.parse(r.card_json) as ProjectCard; } catch { continue; }
    for (const f of new Set(namesOf(card).map(fieldNameOf))) if (Object.hasOwn(where, f)) out.push({ agent, project: r.slug, field: f });
  }
  return out;
}

// ─── Applying it to one store ────────────────────────────────────────────────

interface StoreStep {
  /** Into's row in this store after the merge, or null to leave the cards alone. */
  next: PersonCard | null;
  /** Archive from's row here (it's active). */
  archiveFrom: boolean;
  /** Reset into's synthesized_at here: its summary no longer condenses everything tagged into. */
  resynthesize: boolean;
}

/**
 * One store's part of a merge, in one transaction: into's row, from's archive (its card kept
 * in into's history first), the redirect, the relinks and the re-tags. Re-reads the rows
 * inside the transaction, so a step planned outside it still applies to what's there.
 */
function applyStore(st: PeopleStore, from: string, into: string, step: StoreStep, actor: string, nowMs: number): Retags & { relinked: string[] } {
  if (step.next) validateCard(step.next, nowMs);
  return st.mergeTransaction((db, table, at) => {
    const intoRow = table.readRow(into);
    const fromRow = table.readRow(from);
    if (step.next) {
      if (intoRow?.archived_at) throw new PersonMergeError(`card for ${into} was archived while merging; restore it and merge again`);
      if (intoRow) table.snapshot(intoRow, 'merge', at);
      table.store({
        slug: into, name: step.next.name, card_json: JSON.stringify(step.next),
        archived_at: null, archived_by: null, archive_reason: null, updated: at,
        synthesized_at: step.resynthesize ? null : (intoRow?.synthesized_at ?? null),
      });
    } else if (step.resynthesize && intoRow && intoRow.archived_at === null && intoRow.synthesized_at !== null) {
      // Memories were re-tagged to into here: its summary no longer condenses them all.
      table.snapshot(intoRow, 'merge', at);
      table.store({ ...intoRow, synthesized_at: null, updated: at });
    }
    if (step.archiveFrom && fromRow && fromRow.archived_at === null) {
      // From's card as it was, kept in into's history (person_history(into) lists it; it isn't restorable onto into).
      table.snapshot({ ...fromRow, slug: into }, 'merged_from', at);
      table.snapshot(fromRow, 'merge', at);
      table.store({ ...fromRow, archived_at: at, archived_by: actor, archive_reason: `merged into ${into}`, updated: at });
    }
    db.prepare("INSERT OR IGNORE INTO person_merges (from_slug, into_slug, merged_at, merged_by, counts_json) VALUES (?, ?, ?, ?, '{}')")
      .run(from, into, at, actor);
    const relinked: string[] = [];
    for (const { row, card } of relinks(table, from, into, null)) {
      table.snapshot(row, 'merge', at);
      table.store({ ...row, card_json: JSON.stringify(card), updated: at });
      relinked.push(row.slug);
    }
    return { ...retag(db, from, into, true), relinked };
  });
}

/** Add `more`'s numbers into `base`, per agent and key: a resumed merge's counts are the whole merge's. */
function addCounts(base: Record<string, unknown>, more: Record<string, StoreCounts>): Record<string, unknown> {
  const prior = isPlainObject(base.agents) ? (base.agents as Record<string, Record<string, unknown>>) : {};
  const agents: Record<string, Record<string, unknown>> = { ...prior };
  for (const [a, c] of Object.entries(more)) {
    const p = prior[a] ?? {};
    const num = (k: keyof Retags) => (typeof p[k] === 'number' ? (p[k] as number) : 0) + c[k];
    agents[a] = {
      card: c.card === 'none' && typeof p.card === 'string' ? p.card : c.card,
      memories: num('memories'), proposals: num('proposals'), conversations: num('conversations'), turns: num('turns'),
      relinked: [...new Set([...(Array.isArray(p.relinked) ? (p.relinked as string[]) : []), ...c.relinked])],
    };
  }
  return { ...base, agents };
}

// ─── The merge ───────────────────────────────────────────────────────────────

export interface MergeScope {
  /** The household: its directory and every agent's store. */
  household?: Household;
  /** Outside a household: the one context dir whose store holds the cards. */
  contextDir?: string;
  /** Outside a household: the agent's name, for the answer's counts. */
  agentName?: string;
  /** In a household: whose copy of the card the answer shows (the default agent otherwise). */
  viewer?: string;
  /** Who's merging: recorded on the redirect and every revision. */
  actor: string;
  /**
   * In a household, an agent merging: only the commons card, this agent's own copy and its
   * own memories and conversations. Every other agent's store is left alone and unread (no
   * counts); `not_done` names them, for the owner to finish. Unset: the owner or the
   * runtime, across every agent's store.
   */
  onlyAgent?: string;
  now?: () => number;
}

const fail404 = (slug: string) => new PersonMergeError(`no card for ${slug}`, 404);

type Mode = 'card' | 'resumed' | 'cardless';

/**
 * How this merge goes, or why it can't: `card` (both cards there), `resumed` (from already
 * redirects to into: finish what's left), `cardless` (from is only a tag on memories and
 * conversations, into a card: re-tag and redirect, nothing to archive).
 */
function modeOf(from: string, into: string, fromRow: CardRowBase | null, intoRow: CardRowBase | null, already: PersonMergeRecord | null, intoMerged: PersonMergeRecord | null): Mode {
  if (already) {
    if (already.into !== into) throw new PersonMergeError(`${from} was already merged into ${already.into}`);
    if (!intoRow) throw fail404(into);
    if (intoRow.archived_at) throw new PersonMergeError(`card for ${into} is archived; restore it before merging into it`);
    return 'resumed';
  }
  if (!intoRow) throw fail404(into);
  if (fromRow?.archived_at) throw new PersonMergeError(`card for ${from} is archived; restore it before merging it`);
  if (intoRow.archived_at) {
    throw new PersonMergeError(intoMerged ? `${into} was merged into ${intoMerged.into}: merge into ${intoMerged.into}` : `card for ${into} is archived; restore it before merging into it`);
  }
  return fromRow ? 'card' : 'cardless';
}

/** A cardless from that nothing in reach is tagged with is a typo, not a person: refused. */
function refuseUntagged(from: string, counts: Iterable<StoreCounts>): void {
  for (const c of counts) if (c.memories || c.proposals || c.conversations || c.turns || c.relinked.length) return;
  throw new PersonMergeError(`no card for ${from}, and nothing in reach is tagged ${from}`, 404);
}

function parsed(row: CardRowBase): PersonCard {
  return JSON.parse(row.card_json) as PersonCard;
}

function checked(card: PersonCard, nowMs: number, where: string): PersonCard {
  try {
    validateCard(card, nowMs);
  } catch (e) {
    if (e instanceof CardError) throw new PersonMergeError(`the merged card (${where}) would be refused: ${e.message}`);
    throw e;
  }
  return card;
}

const NOT_DONE = (from: string, into: string, others: readonly string[] = []) => [
  ...(others.length ? [`${others.join(', ')}: ${others.length === 1 ? 'its' : 'their'} own copy, memories and conversations weren't touched or read (an agent merges only its own); ask the owner to run \`loom person merge ${from} ${into}\` to finish them`] : []),
  `gates: rename ${from} to ${into} in every agent's gates (shuttle's people merge, one agent's list at a time); loom doesn't hold them`,
  `text: memory bodies, notes, knowledge pages and conversation digests that write "${from}" in prose are left as written`,
  `pieces' own stores: a piece that keeps person slugs renames them itself`,
];

/** Merge `from` into `into` (or, dry, say what that would do). Throws PersonMergeError with the reason. */
export function mergePeople(scope: MergeScope, input: PersonMergeInput): PersonMergeResult {
  const { from, into } = checkMergeInput(input);
  const dry = input.dry_run === true;
  const now = scope.now ?? Date.now;
  const at = new Date(now()).toISOString();
  const h = scope.household;
  if (h) return mergeInHousehold(h, scope, from, into, dry, now, at);
  if (!scope.contextDir) throw new PersonMergeError('no store to merge in', 400);
  return mergeInStore(scope.contextDir, scope.agentName ?? 'agent', scope.actor, from, into, dry, now, at);
}

function openStore(dbPath: string, dry: boolean, actor: string, now: () => number): PeopleStore | null {
  if (!existsSync(dbPath)) return null;
  return new PeopleStore({ dbPath, readonly: dry, actor, now });
}

function mergeInStore(contextDir: string, agent: string, actor: string, from: string, into: string, dry: boolean, now: () => number, at: string): PersonMergeResult {
  const nowMs = Date.parse(at);
  const st = openStore(resolveSqliteDbPath(contextDir), dry, actor, now);
  if (!st) throw fail404(from);
  try {
    const fromRow = st.migrated ? st.rawRow(from) : null;
    const intoRow = st.migrated ? st.rawRow(into) : null;
    const mode = modeOf(from, into, fromRow, intoRow, st.mergeOf(from), st.mergeOf(into));
    const resumed = mode === 'resumed';
    const intoCard = parsed(intoRow!);
    const fromCard = fromRow ? parsed(fromRow) : null;
    if (mode === 'card' && kindOf(fromCard!) !== kindOf(intoCard)) throw new PersonMergeError(`${from} is ${kindOf(fromCard!) === 'agent' ? 'an agent' : 'a person'} and ${into} isn't: they aren't one card`);
    const plan = mode === 'card' ? mergeCardInto(intoCard, fromCard!, mergeLine(from, fromCard!.name, at)) : null;
    if (plan) plan.card = relinkCard(plan.card, from, into) ?? plan.card;
    const next = plan ? checked(plan.card, nowMs, `${agent}'s card`) : null;
    const counts: StoreCounts = { card: plan ? 'merged' : 'none', ...retag(st.database, from, into, false), relinked: relinks(st.cardTable, from, into, next).map((r) => r.row.slug) };
    if (mode === 'cardless') refuseUntagged(from, [counts]);
    const projects = hubsListing(st.database, fromCard?.where ?? {}, agent);
    const result = (card: PersonCard, c: StoreCounts): PersonMergeResult => ({
      from, into, dry_run: dry, resumed, cardless: mode === 'cardless', merged_by: actor,
      where_added: plan?.where_added ?? {}, how_added: plan?.how_added ?? [], may_added: plan?.may_added ?? 0,
      card, agents: { [agent]: c }, projects, not_done: NOT_DONE(from, into),
    });
    if (dry) return result(next ?? intoCard, counts);
    const done = applyStore(st, from, into, { next, archiveFrom: mode === 'card', resynthesize: mode === 'card' || counts.memories > 0 }, actor, nowMs);
    const c: StoreCounts = { card: counts.card, memories: done.memories, proposals: done.proposals, conversations: done.conversations, turns: done.turns, relinked: done.relinked };
    recordCounts(st, from, { [agent]: c });
    return result(st.getRow(into)!.card, c);
  } finally {
    st.close();
  }
}

function recordCounts(st: PeopleStore, from: string, agents: Record<string, StoreCounts>, directory?: { relinked: string[] }): void {
  st.mergeTransaction((db) => {
    const prior = st.mergeOf(from)?.counts ?? {};
    const counts = addCounts(prior, agents);
    if (directory) {
      const was = isPlainObject(prior.directory) && Array.isArray(prior.directory.relinked) ? (prior.directory.relinked as string[]) : [];
      counts.directory = { relinked: [...new Set([...was, ...directory.relinked])] };
    }
    db.prepare('UPDATE person_merges SET counts_json = ? WHERE from_slug = ?').run(JSON.stringify(counts), from);
  });
}

function mergeInHousehold(h: Household, scope: MergeScope, from: string, into: string, dry: boolean, now: () => number, at: string): PersonMergeResult {
  const actor = scope.actor;
  const nowMs = Date.parse(at);
  if (h.agents.includes(from)) throw new PersonMergeError(`${from} is one of this household's agents: its entry isn't merged away`);
  if (scope.onlyAgent !== undefined && !h.agents.includes(scope.onlyAgent)) throw new PersonMergeError(`${scope.onlyAgent} isn't one of this household's agents`, 400);
  // An agent reaches only its own store; the owner and the runtime reach every agent's.
  const reach = scope.onlyAgent !== undefined ? [scope.onlyAgent] : h.agents;
  const others = h.agents.filter((a) => !reach.includes(a));
  const dir = openStore(commonsPeoplePath(h), dry, actor, now);
  if (!dir) throw fail404(from);
  const opened: Array<{ agent: string; st: PeopleStore }> = [];
  try {
    const fromRow = dir.migrated ? dir.rawRow(from) : null;
    const intoRow = dir.migrated ? dir.rawRow(into) : null;
    const mode = modeOf(from, into, fromRow, intoRow, dir.mergeOf(from), dir.mergeOf(into));
    const resumed = mode === 'resumed';
    // A member's card stays (tokens and sign-ins name them); a bare tag of the same slug has no card to keep.
    if (mode === 'card' && h.members.some((m) => m.person === from)) {
      throw new PersonMergeError(`${from} is a member of this household (its tokens and sign-ins name them): merge ${into} into ${from} instead`);
    }
    const intoDir = parsed(intoRow!);
    const fromDir = fromRow ? parsed(fromRow) : null;
    if (mode === 'card' && kindOf(fromDir!) !== kindOf(intoDir)) throw new PersonMergeError(`${from} is ${kindOf(fromDir!) === 'agent' ? 'an agent' : 'a person'} and ${into} isn't: they aren't one card`);
    const dirPlan = mode === 'card' ? mergeCardInto(intoDir, fromDir!) : null;
    if (dirPlan) dirPlan.card = relinkCard(dirPlan.card, from, into) ?? dirPlan.card;
    const dirNext = dirPlan ? checked(dirPlan.card, nowMs, 'the directory entry') : null;
    // The line says a card was merged in: a cardless from adds none.
    const line = fromDir ? mergeLine(from, fromDir.name, at) : null;
    const intoName = (dirNext ?? intoDir).name;

    // Every agent's copy: planned (and checked) before anything is written.
    const steps: Array<{ agent: string; st: PeopleStore; step: StoreStep; counts: StoreCounts; plan: CardMerge | null }> = [];
    const projects: PersonMergeResult['projects'] = [];
    for (const agent of reach) {
      const st = openStore(resolveSqliteDbPath(agentDir(h, agent)), dry, actor, now);
      if (!st) continue;
      opened.push({ agent, st });
      const relFromRow = st.migrated ? st.rawRow(from) : null;
      const relIntoRow = st.migrated ? st.rawRow(into) : null;
      const relFrom = relFromRow && relFromRow.archived_at === null ? parsed(relFromRow) : null;
      const relInto = relIntoRow && relIntoRow.archived_at === null ? parsed(relIntoRow) : null;
      const retags = retag(st.database, from, into, false);
      let plan: CardMerge | null = null;
      let card: StoreCounts['card'] = 'none';
      if (relFrom) {
        plan = mergeCardInto(relInto ?? { slug: into, name: intoName, where: {}, how: {}, may: [] }, relFrom, line ?? undefined);
        card = relInto ? 'merged' : 'moved';
      } else if (relInto && line && !resumed) {
        plan = { card: { ...relInto, summary: appendLine(relInto.summary, line) }, where_added: {}, how_added: [], may_added: 0 };
        card = 'noted';
      }
      if (plan) {
        plan.card = { ...(relinkCard(plan.card, from, into) ?? plan.card), name: intoName };
        checked(plan.card, nowMs, `${agent}'s copy`);
      }
      const next = plan?.card ?? null;
      steps.push({
        agent, st, plan,
        step: { next, archiveFrom: relFrom !== null, resynthesize: relFrom !== null || retags.memories > 0 },
        counts: { card, ...retags, relinked: st.migrated ? relinks(st.cardTable, from, into, next).map((r) => r.row.slug) : [] },
      });
      projects.push(...hubsListing(st.database, fromDir?.where ?? {}, agent));
    }
    const dirRelinked = dir.migrated ? relinks(dir.cardTable, from, into, dirNext).map((r) => r.row.slug) : [];
    if (mode === 'cardless') refuseUntagged(from, [...steps.map((x) => x.counts), { card: 'none', memories: 0, proposals: 0, conversations: 0, turns: 0, relinked: dirRelinked }]);
    const viewer = scope.onlyAgent ?? (scope.viewer && h.agents.includes(scope.viewer) ? scope.viewer : h.default);
    const howAdded = new Set(dirPlan?.how_added ?? []);
    let mayAdded = 0;
    for (const s of steps) {
      for (const k of s.plan?.how_added ?? []) howAdded.add(k);
      mayAdded += s.plan?.may_added ?? 0;
    }
    const viewerRel = (stepsFor: typeof steps) => {
      const s = stepsFor.find((x) => x.agent === viewer);
      if (!s) return null;
      return s.step.next ?? (s.st.migrated ? s.st.getRow(into)?.card ?? null : null);
    };
    const answer = (directoryCard: PersonCard, agents: Record<string, StoreCounts>, relinked: string[]): PersonMergeResult => ({
      from, into, dry_run: dry, resumed, cardless: mode === 'cardless', merged_by: actor,
      where_added: dirPlan?.where_added ?? {}, how_added: [...howAdded], may_added: mayAdded,
      card: mergeCard(directoryCard, viewerRel(steps)),
      agents, directory: { relinked }, projects, not_done: NOT_DONE(from, into, others),
    });
    if (dry) return answer(dirNext ?? intoDir, Object.fromEntries(steps.map((s) => [s.agent, s.counts])), dirRelinked);

    // The directory first: card, archive and redirect together. From here on, from reads and writes as into.
    const d = applyStore(dir, from, into, { next: dirNext, archiveFrom: mode === 'card', resynthesize: false }, actor, nowMs);
    const done: Record<string, StoreCounts> = {};
    for (const s of steps) {
      const r = applyStore(s.st, from, into, s.step, actor, nowMs);
      done[s.agent] = { card: s.counts.card, memories: r.memories, proposals: r.proposals, conversations: r.conversations, turns: r.turns, relinked: r.relinked };
    }
    recordCounts(dir, from, done, { relinked: d.relinked });
    return answer(dir.getRow(into)!.card, done, d.relinked);
  } finally {
    for (const o of opened) o.st.close();
    dir.close();
  }
}
