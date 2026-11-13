/**
 * Person-card tools — person_write / person_verify / person_archive /
 * person_restore / person / person_list / person_history /
 * person_revision_restore (docs/specs/person-cards.md).
 *
 * Thin wrappers over backends/people.ts: each opens the store on the memory
 * database, runs one call, closes. Results are JSON text, the shape the spec
 * names; a rejection is `Error: <message naming the path>`, like every other
 * loom tool. The CLI (`loom person`) calls the read functions here too.
 */
import { existsSync } from 'node:fs';
import { resolveIdentityName, resolveSqliteDbPath } from '../config.js';
import { agentDir, householdOf, type Household } from '../household.js';
import { commonsPeoplePath, HouseholdPeople, openHouseholdPeople } from '../backends/people-household.js';
import { checkEnsureInput, ensurePerson, type EnsureResult } from '../backends/people-ensure.js';
import { checkMergeInput, mergePeople, type PersonMergeResult } from '../backends/people-merge.js';
import {
  openPeopleStore,
  PeopleStore,
  personSlugError,
  PersonCardError,
  UnreadableCardError,
  type PersonWriteInput,
  type PersonReadResult,
  type PersonListEntry,
  type PersonEvidence,
} from '../backends/people.js';

/** Undefined keeps legacy discovery; null explicitly selects a standalone store. */
export type PeopleSelection = { household: Household; agent: string } | null;

function selectedHousehold(contextDir: string, selection: PeopleSelection | undefined) {
  return selection === undefined ? householdOf(contextDir) : selection;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Slugs validate before anything else, store or no store (criterion 11). */
function assertSlug(slug: string): void {
  const err = personSlugError(slug);
  if (err) throw new PersonCardError(`slug: ${err}`);
}

function errorText(e: unknown): string {
  if (e instanceof PersonCardError || e instanceof UnreadableCardError) return `Error: ${e.message}`;
  return `Error: ${(e as Error).message ?? String(e)}`;
}

/**
 * The people a context dir sees. In a household: the commons directory plus
 * this agent's relationships (backends/people-household.ts). Otherwise the
 * one store in the agent's memories.db, as before.
 */
export function openPeople(contextDir: string, opts: { readonly?: boolean; selection?: PeopleSelection } = {}): PeopleStore | HouseholdPeople | null {
  const hh = selectedHousehold(contextDir, opts.selection);
  if (hh) return openHouseholdPeople(hh.household, hh.agent, contextDir, opts);
  return openPeopleStore(contextDir, opts);
}

function withWritable(contextDir: string, fn: (store: PeopleStore | HouseholdPeople) => unknown, selection?: PeopleSelection): string {
  try {
    const store = openPeople(contextDir, { selection })!;
    try {
      return json(fn(store));
    } finally {
      store.close();
    }
  } catch (e) {
    return errorText(e);
  }
}

export async function personWrite(contextDir: string, input: PersonWriteInput, selection?: PeopleSelection): Promise<string> {
  return withWritable(contextDir, (s) => s.write(input), selection);
}

export async function personVerify(
  contextDir: string,
  input: { slug: string; fields: string[]; verified_at?: string; source?: string },
  selection?: PeopleSelection,
): Promise<string> {
  return withWritable(contextDir, (s) => s.verify(input), selection);
}

export async function personArchive(contextDir: string, input: { slug: string; reason: string }, selection?: PeopleSelection): Promise<string> {
  // The actor is the calling agent's name — the value knowledge_write uses for author.
  return withWritable(contextDir, (s) => s.archive({ ...input, actor: resolveIdentityName(contextDir) }), selection);
}

export async function personRestore(contextDir: string, input: { slug: string }, selection?: PeopleSelection): Promise<string> {
  return withWritable(contextDir, (s) => s.restore(input), selection);
}

export async function personRevisionRestore(
  contextDir: string,
  input: { slug: string; revision_id: number; store?: 'directory' | 'relationship' },
  selection?: PeopleSelection,
): Promise<string> {
  return withWritable(contextDir, (s) => (s instanceof PeopleStore ? s.revisionRestore({ slug: input.slug, revision_id: input.revision_id }) : s.revisionRestore(input)), selection);
}

/** A store opened read-only, or an empty one in memory when its file isn't there yet (a dry run writes nothing). */
function readonlyOrEmpty(dbPath: string, actor: string): PeopleStore {
  return existsSync(dbPath) ? new PeopleStore({ dbPath, readonly: true, actor }) : new PeopleStore({ dbPath: ':memory:', actor });
}

/**
 * Ensure a person card (backends/people-ensure.ts): `body` is the route's and the CLI's JSON,
 * `actor` who's adding them (recorded on the revision). The caller has already checked that
 * they may: the owner, a piece in an owner's action, or the runtime. In a household, a new
 * card's summary goes to `body.agent`'s relationship (the household's default agent when
 * none is named); its name and handles go to the shared directory. Throws PersonCardError.
 */
export function personEnsure(contextDir: string, body: unknown, actor: string, selection?: PeopleSelection): EnsureResult {
  const input = checkEnsureInput(body);
  const hh = selectedHousehold(contextDir, selection);
  const h: Household | undefined = hh?.household;
  if (h && input.agent !== undefined && !h.agents.includes(input.agent)) throw new PersonCardError(`agent: ${input.agent} isn't one of this household's agents`);
  const dir = h ? agentDir(h, input.agent ?? hh!.agent) : contextDir;
  let store: PeopleStore | HouseholdPeople;
  if (input.dry_run) {
    store = h
      ? new HouseholdPeople(readonlyOrEmpty(commonsPeoplePath(h), actor), readonlyOrEmpty(resolveSqliteDbPath(dir), actor), Date.now, new Set(h.agents))
      : readonlyOrEmpty(resolveSqliteDbPath(dir), actor);
  } else {
    store = h ? openHouseholdPeople(h, input.agent ?? hh!.agent, dir, { actor })! : openPeopleStore(dir, { actor })!;
  }
  try {
    return ensurePerson(store, input);
  } finally {
    store.close();
  }
}

/**
 * Merge person card `from` into `into` (backends/people-merge.ts): `body` is {from, into,
 * dry_run?}, `actor` who's merging (recorded on the redirect and every revision). The caller
 * has already checked that they may: the owner, the runtime, or an agent of the household
 * that holds both cards (its own store, outside one). In a household the owner and the
 * runtime merge every agent's copy and store; an agent (`onlyOwnAgent`) only its own. The
 * answer shows the card as this context's agent sees it. Throws
 * PersonMergeError (its `status` says 400, 404 or 409).
 */
export function personMergeRun(contextDir: string, body: unknown, actor: string, opts: { onlyOwnAgent?: boolean; selection?: PeopleSelection } = {}): PersonMergeResult {
  const input = checkMergeInput(body);
  const hh = selectedHousehold(contextDir, opts.selection);
  return mergePeople(hh
    ? { household: hh.household, viewer: hh.agent, actor, ...(opts.onlyOwnAgent ? { onlyAgent: hh.agent } : {}) }
    : { contextDir, agentName: resolveIdentityName(contextDir), actor }, input);
}

/**
 * The MCP tool: an agent merges two cards of its own household (or its own store). In a
 * household it reaches the commons card, its own copy and its own memories and
 * conversations, never another agent's store: the answer's not_done names them, for the owner.
 */
export async function personMerge(contextDir: string, input: { from: string; into: string; dry_run?: boolean }, selection?: PeopleSelection): Promise<string> {
  try {
    const hh = selectedHousehold(contextDir, selection);
    return json(personMergeRun(contextDir, input, hh?.agent ?? resolveIdentityName(contextDir), { onlyOwnAgent: true, selection }));
  } catch (e) {
    return errorText(e);
  }
}

/** The `person` read. Throws on an invalid slug or an unreadable row; the MCP wrapper turns that into text. */
export function readPerson(contextDir: string, slug: string, includeArchived = false, selection?: PeopleSelection): PersonReadResult {
  assertSlug(slug);
  const store = openPeople(contextDir, { readonly: true, selection });
  if (!store) return { found: false };
  try {
    return store.read(slug, includeArchived);
  } finally {
    store.close();
  }
}

export function listPeople(contextDir: string, includeArchived = false, selection?: PeopleSelection): PersonListEntry[] {
  const store = openPeople(contextDir, { readonly: true, selection });
  if (!store) return [];
  try {
    return store.list(includeArchived);
  } finally {
    store.close();
  }
}

/** The memories a person's card condenses, oldest first (newer than `since` when given). */
export function personEvidence(contextDir: string, slug: string, since: string | null = null, selection?: PeopleSelection): PersonEvidence[] {
  const store = openPeople(contextDir, { readonly: true, selection });
  if (!store) return [];
  try {
    return store.evidence(slug, since);
  } finally {
    store.close();
  }
}

export async function person(contextDir: string, input: { slug: string; include_archived?: boolean }, selection?: PeopleSelection): Promise<string> {
  try {
    return json(readPerson(contextDir, input.slug, input.include_archived ?? false, selection));
  } catch (e) {
    return errorText(e);
  }
}

export async function personList(contextDir: string, input: { include_archived?: boolean }, selection?: PeopleSelection): Promise<string> {
  try {
    return json(listPeople(contextDir, input.include_archived ?? false, selection));
  } catch (e) {
    return errorText(e);
  }
}

export async function personHistory(contextDir: string, input: { slug: string }, selection?: PeopleSelection): Promise<string> {
  try {
    assertSlug(input.slug);
    const store = openPeople(contextDir, { readonly: true, selection });
    if (!store) return json([]);
    try {
      return json(store.history(input.slug));
    } finally {
      store.close();
    }
  } catch (e) {
    return errorText(e);
  }
}
