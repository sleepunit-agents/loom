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
import { resolveIdentityName } from '../config.js';
import {
  openPeopleStore,
  PersonCardError,
  UnreadableCardError,
  type PeopleStore,
  type PersonWriteInput,
  type PersonReadResult,
  type PersonListEntry,
} from '../backends/people.js';

const json = (v: unknown) => JSON.stringify(v, null, 2);

function errorText(e: unknown): string {
  if (e instanceof PersonCardError || e instanceof UnreadableCardError) return `Error: ${e.message}`;
  return `Error: ${(e as Error).message ?? String(e)}`;
}

function withWritable(contextDir: string, fn: (store: PeopleStore) => unknown): string {
  try {
    const store = openPeopleStore(contextDir)!;
    try {
      return json(fn(store));
    } finally {
      store.close();
    }
  } catch (e) {
    return errorText(e);
  }
}

export async function personWrite(contextDir: string, input: PersonWriteInput): Promise<string> {
  return withWritable(contextDir, (s) => s.write(input));
}

export async function personVerify(
  contextDir: string,
  input: { slug: string; fields: string[]; verified_at?: string; source?: string },
): Promise<string> {
  return withWritable(contextDir, (s) => s.verify(input));
}

export async function personArchive(contextDir: string, input: { slug: string; reason: string }): Promise<string> {
  // The actor is the calling agent's name — the value knowledge_write uses for author.
  return withWritable(contextDir, (s) => s.archive({ ...input, actor: resolveIdentityName(contextDir) }));
}

export async function personRestore(contextDir: string, input: { slug: string }): Promise<string> {
  return withWritable(contextDir, (s) => s.restore(input));
}

export async function personRevisionRestore(
  contextDir: string,
  input: { slug: string; revision_id: number },
): Promise<string> {
  return withWritable(contextDir, (s) => s.revisionRestore(input));
}

/** The `person` read. Throws on an invalid slug or an unreadable row; the MCP wrapper turns that into text. */
export function readPerson(contextDir: string, slug: string, includeArchived = false): PersonReadResult {
  const store = openPeopleStore(contextDir, { readonly: true });
  if (!store) return { found: false };
  try {
    return store.read(slug, includeArchived);
  } finally {
    store.close();
  }
}

export function listPeople(contextDir: string, includeArchived = false): PersonListEntry[] {
  const store = openPeopleStore(contextDir, { readonly: true });
  if (!store) return [];
  try {
    return store.list(includeArchived);
  } finally {
    store.close();
  }
}

export async function person(contextDir: string, input: { slug: string; include_archived?: boolean }): Promise<string> {
  try {
    return json(readPerson(contextDir, input.slug, input.include_archived ?? false));
  } catch (e) {
    return errorText(e);
  }
}

export async function personList(contextDir: string, input: { include_archived?: boolean }): Promise<string> {
  try {
    return json(listPeople(contextDir, input.include_archived ?? false));
  } catch (e) {
    return errorText(e);
  }
}

export async function personHistory(contextDir: string, input: { slug: string }): Promise<string> {
  try {
    const store = openPeopleStore(contextDir, { readonly: true });
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
