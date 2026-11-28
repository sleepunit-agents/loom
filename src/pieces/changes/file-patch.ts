/** `changeFilePatch(change, path)`: one changed file's patch, for the pull brick's big form (docs/specs/boards.md,
 * "The pull brick's file patches"). Nothing of it is stored. It is read from GitHub when a member opens the file,
 * with the credential the changes poll uses, and kept a short while in memory. */
import { and, eq, getTableColumns } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { DataDatabase } from '../../core/data/database.js';
import { changeFiles, changes } from '../../core/data/schema.js';
import { markUnscoped } from '../../core/data/table-tracker.js';
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { FilePatchReader } from './github.js';

/** The most patch text one answer carries, in UTF-8 bytes (200 KB). A longer patch is cut at the last whole line
 * within it and said to be cut. */
export const PATCH_BYTES_MAX = 200 * 1024;
/** How many answers the cache holds at most (so at most about 6.4 MB of patch text), the oldest dropped first. */
export const PATCH_CACHE_MAX = 32;
/** How long an answer is kept: five minutes. A new push changes the head commit, which is in the key, so it is
 * read again at once whatever this says. */
export const PATCH_CACHE_MS = 5 * 60_000;

export type FilePatch =
  | { state: 'patch'; patch: string; cut: boolean }
  /** GitHub lists the file with no patch (a binary file, a diff too large for GitHub to give), or no longer lists it. */
  | { state: 'none'; patch: null; cut: false }
  /** GitHub could not be read: no credential for the owner, a failed or malformed answer. Never kept. */
  | { state: 'unavailable'; patch: null; cut: false };

const encoder = new TextEncoder(), decoder = new TextDecoder();
/** The patch within the cap: whole, or cut at the last line that ends inside it. */
export function capPatch(patch: string): { patch: string; cut: boolean } {
  const bytes = encoder.encode(patch);
  if (bytes.byteLength <= PATCH_BYTES_MAX) return { patch, cut: false };
  // Decoding a cut that splits a character drops the half; then back to the last whole line, where there is one.
  const head = decoder.decode(bytes.subarray(0, PATCH_BYTES_MAX)).replace(/�$/, '');
  const line = head.lastIndexOf('\n');
  return { patch: line > 0 ? head.slice(0, line) : head, cut: true };
}

export function changeFilePatches(db: DataDatabase, read: FilePatchReader | undefined, now: () => number = Date.now) {
  const kept = new Map<string, { at: number; answer: FilePatch }>();
  const asking = new Map<string, Promise<FilePatch>>();
  return {
    /** null for a change the viewer may not see, for a path that is not one of its `change_files` rows, and for
     * anybody not signed in: the same null in each case. */
    async read(viewer: Viewer, change: string, path: string): Promise<FilePatch | null> {
      const scope = sqlVisibility(viewer, ['changeFiles']);
      const row = db.select({ repository: changes.repository, number: changes.number, head: changes.headCommit })
        .from(changeFiles).innerJoin(changes, eq(changes.id, changeFiles.change))
        .where(and(eq(changeFiles.change, change), eq(changeFiles.path, path), scope.changeFiles(getTableColumns(changeFiles)))).get();
      if (!row) return null;
      if (!read) return { state: 'unavailable', patch: null, cut: false };
      const key = JSON.stringify([change, path, row.head]), time = now(), hit = kept.get(key);
      if (hit && time - hit.at < PATCH_CACHE_MS) return hit.answer;
      if (hit) kept.delete(key);
      const pending = asking.get(key);
      if (pending) return pending;
      const asked = (async (): Promise<FilePatch> => {
        try {
          const found = await read(row.repository, row.number, path);
          const answer: FilePatch = found.listed && found.patch !== null ? { state: 'patch', ...capPatch(found.patch) } : { state: 'none', patch: null, cut: false };
          kept.set(key, { at: now(), answer });
          while (kept.size > PATCH_CACHE_MAX) kept.delete(kept.keys().next().value!);
          return answer;
        } catch { return { state: 'unavailable', patch: null, cut: false }; }
        finally { asking.delete(key); }
      })();
      asking.set(key, asked);
      return asked;
    },
    /** How many answers are kept: for the tests. */
    size: () => kept.size,
  };
}

export function changeFilePatchFields(service: ReturnType<typeof changeFilePatches>): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString);
  const type = new GraphQLObjectType({ name: 'ChangeFilePatch', fields: {
    state: { type: text, description: '`patch`, `none` (GitHub gives no patch for this file) or `unavailable` (GitHub could not be read).' },
    patch: { type: GraphQLString, description: 'The patch text as GitHub gives it, at most 200 KB; null unless the state is `patch`.' },
    cut: { type: new GraphQLNonNull(GraphQLBoolean), description: 'The patch was longer than 200 KB and is cut at its last whole line within it.' },
  } });
  return { changeFilePatch: {
    type, args: { change: { type: text }, path: { type: text } },
    description: 'One changed file\'s patch, read from GitHub when asked and not stored; null for a change the viewer may not see and for a path that is not one of its files.',
    resolve: (_source, args, { viewer }) => {
      // An outside read through a cache shared between selections: never taken as skippable by the shadow scope.
      markUnscoped('GitHub (a changed file\'s patch)');
      return service.read(viewer, args.change, args.path);
    },
  } };
}
