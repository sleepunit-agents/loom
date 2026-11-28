/** `changeFilePatch(change, path)`: one changed file's patch, for the pull brick's big form (docs/specs/boards.md,
 * "The pull brick's file patches"). Nothing of it is stored. It is read from GitHub when a member opens the file,
 * with the credential the changes poll uses, and kept a short while in memory. */
import { and, eq, getTableColumns } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { DataDatabase } from '../../core/data/database.js';
import { changeFiles, changes } from '../../core/data/schema.js';
import { markUnscoped } from '../../core/data/table-tracker.js';
import { outsideRead } from '../../core/data/outside-read.js';
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { ListingReader } from './github.js';

/** The most patch text one answer carries, in UTF-8 bytes (200 KB). A longer patch is cut at the last whole line
 * within it, or inside its line where one line is longer than that, and said to be cut. */
export const PATCH_BYTES_MAX = 200 * 1024;
/** Pages of GitHub's files list asked for at most, a hundred files each, before a file is taken as not listed.
 * `change_files` holds the first hundred files of the same pull request, so it is nearly always on the first. */
export const PATCH_PAGES_MAX = 3;
/** How long a page of the files list is kept: five minutes. A new push changes the head commit, which is in the key,
 * so it is read again at once whatever this says. */
export const LISTING_KEEP_MS = 5 * 60_000;
/** How long an `unavailable` answer, and a page that does not list an asked-for file, are kept: 30 s. Within that,
 * asking again does not go to GitHub again. */
export const UNAVAILABLE_KEEP_MS = 30_000;
/** How much kept pages hold at most, counted as JavaScript holds text (two bytes a character): 32 MiB, the oldest
 * page dropped first. One page holds at most a hundred patches already cut to `PATCH_BYTES_MAX`. */
export const LISTING_KEEP_BYTES = 32 * 1024 * 1024;
/** GitHub requests this read makes at once, across every change and viewer: 2. */
export const GITHUB_AT_ONCE = 2;
/** Pages waiting for one of those at most; past that, an ask is `unavailable` at once and nothing is sent. */
export const GITHUB_WAITING_MAX = 8;
/** The longest one answer takes: 20 s, waiting included. Past that it is `unavailable`; a page still being read
 * finishes on its own limit (github.ts, `LISTING_PAGE_MS`) and is kept for the next ask. */
export const PATCH_ANSWER_MS = 20_000;

export type FilePatch =
  | { state: 'patch'; patch: string; cut: boolean }
  /** GitHub lists the file with no patch: a binary file, a diff too large for GitHub to give, a rename with no change
   * in it, or an empty file. */
  | { state: 'none'; patch: null; cut: false }
  /** GitHub's list of the pull request's files does not have this file just now (it may have been pushed since). */
  | { state: 'unlisted'; patch: null; cut: false }
  /** GitHub could not be read: no credential for the owner, a failed, malformed or too large answer, too slow, or
   * too many reads waiting. */
  | { state: 'unavailable'; patch: null; cut: false };
const unavailable: FilePatch = { state: 'unavailable', patch: null, cut: false };

const encoder = new TextEncoder();
/** The patch within the cap: whole, or cut at the last line that ends inside it, or inside the line where there is
 * no such line. A character split by the cut is left out whole. */
export function capPatch(patch: string): { patch: string; cut: boolean } {
  const bytes = encoder.encode(patch);
  if (bytes.byteLength <= PATCH_BYTES_MAX) return { patch, cut: false };
  // A streaming decode holds back a character the cut splits instead of writing U+FFFD for it.
  const head = new TextDecoder().decode(bytes.subarray(0, PATCH_BYTES_MAX), { stream: true });
  const line = head.lastIndexOf('\n');
  return { patch: line > 0 ? head.slice(0, line) : head, cut: true };
}

/** One page of the files list as kept: each listed path with its cut patch or none, and whether a next page may hold more. */
type Listing = { files: Map<string, { patch: string; cut: boolean } | null>; more: boolean; bytes: number };
type Kept = { until: number; listing: Listing | 'unavailable'; bytes: number };

const tooMany = new Error('Too many GitHub reads waiting');
/** At most `GITHUB_AT_ONCE` running and `GITHUB_WAITING_MAX` waiting; a sync throw becomes a rejection. */
function limiter(atOnce: number, waitingMax: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= atOnce && waiting.length >= waitingMax) return Promise.reject(tooMany);
    const turn = running < atOnce ? (running++, Promise.resolve()) : new Promise<void>(go => waiting.push(go));
    return turn.then(work).finally(() => { const next = waiting.shift(); if (next) next(); else running--; });
  };
}

export function changeFilePatches(db: DataDatabase, read: ListingReader | undefined, now: () => number = Date.now) {
  const kept = new Map<string, Kept>(), asking = new Map<string, Promise<Listing | 'unavailable'>>();
  const limit = limiter(GITHUB_AT_ONCE, GITHUB_WAITING_MAX);
  let keptBytes = 0;
  const drop = (key: string) => { const was = kept.get(key); if (was) { keptBytes -= was.bytes; kept.delete(key); } };
  const keep = (key: string, value: Kept) => {
    drop(key); kept.set(key, value); keptBytes += value.bytes;
    while (keptBytes > LISTING_KEEP_BYTES && kept.size > 1) drop(kept.keys().next().value!);
  };
  /** One page of one pull request at one head commit: kept, being read for another ask, or read now. Shared by every
   * path and viewer, so a hundred paths of one pull request cost one request a page. */
  const page = (repository: string, number: number, head: string, n: number): Promise<Listing | 'unavailable'> => {
    const key = JSON.stringify([repository, number, head, n]), hit = kept.get(key);
    if (hit && now() < hit.until) return Promise.resolve(hit.listing);
    if (hit) drop(key);
    const pending = asking.get(key);
    if (pending) return pending;
    const asked = limit(() => read!(repository, number, n)).then((entries): Listing | 'unavailable' => {
      const files: Listing['files'] = new Map();
      let bytes = 0;
      for (const entry of entries) {
        const cut = entry.patch === null ? null : capPatch(entry.patch);
        files.set(entry.filename, cut);
        bytes += 2 * (entry.filename.length + (cut?.patch.length ?? 0));
      }
      const listing = { files, more: entries.length >= 100, bytes };
      keep(key, { until: now() + LISTING_KEEP_MS, listing, bytes });
      return listing;
    }, (error: unknown): 'unavailable' => {
      // A failed read is kept the short while. Too many waiting is not GitHub's answer: nothing was sent, nothing kept.
      if (error !== tooMany) keep(key, { until: now() + UNAVAILABLE_KEEP_MS, listing: 'unavailable', bytes: 0 });
      return 'unavailable';
    }).finally(() => asking.delete(key));
    asking.set(key, asked);
    return asked;
  };
  return {
    /** null for a change the viewer may not see, for a path that is not one of its `change_files` rows, and for
     * anybody not signed in (the door refuses them first): the same null in each case. */
    async read(viewer: Viewer, change: string, path: string): Promise<FilePatch | null> {
      const scope = sqlVisibility(viewer, ['changeFiles']);
      const row = db.select({ repository: changes.repository, number: changes.number, head: changes.headCommit })
        .from(changeFiles).innerJoin(changes, eq(changes.id, changeFiles.change))
        .where(and(eq(changeFiles.change, change), eq(changeFiles.path, path), scope.changeFiles(getTableColumns(changeFiles)))).get();
      if (!row) return null;
      if (!read) return unavailable;
      const walk = async (): Promise<FilePatch> => {
        for (let n = 1; n <= PATCH_PAGES_MAX; n++) {
          const listing = await page(row.repository, row.number, row.head, n);
          if (listing === 'unavailable') return unavailable;
          if (listing.files.has(path)) {
            const found = listing.files.get(path);
            return found ? { state: 'patch', ...found } : { state: 'none', patch: null, cut: false };
          }
          if (!listing.more) break;
        }
        // The stored files and GitHub's list disagree (a push not polled yet): the pages walked are kept only the short while.
        for (let n = 1; n <= PATCH_PAGES_MAX; n++) {
          const hit = kept.get(JSON.stringify([row.repository, row.number, row.head, n]));
          if (hit) hit.until = Math.min(hit.until, now() + UNAVAILABLE_KEEP_MS);
        }
        return { state: 'unlisted', patch: null, cut: false };
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<FilePatch>(done => { timer = setTimeout(() => done(unavailable), PATCH_ANSWER_MS); timer.unref?.(); });
      try { return await Promise.race([walk(), late]); } finally { clearTimeout(timer); }
    },
    /** How much is kept, in pages and counted bytes: for the tests. */
    kept: () => ({ pages: kept.size, bytes: keptBytes }),
  };
}

export function changeFilePatchFields(service: ReturnType<typeof changeFilePatches>): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString);
  const type = new GraphQLObjectType({ name: 'ChangeFilePatch', fields: {
    state: { type: text, description: '`patch`; `none` (GitHub lists the file with no patch: binary, too large for GitHub, a rename with no change, or empty); `unlisted` (GitHub\'s list does not have the file just now); or `unavailable` (GitHub could not be read).' },
    patch: { type: GraphQLString, description: 'The patch text exactly as GitHub gives it, at most 200 KB; null unless the state is `patch`.' },
    cut: { type: new GraphQLNonNull(GraphQLBoolean), description: 'The patch was longer than 200 KB and is cut: at its last whole line within it, or inside a line longer than that.' },
  } });
  // Read from GitHub each time it is asked: refused as a live selection (core/data/outside-read.ts).
  return { changeFilePatch: outsideRead({
    type, args: { change: { type: text }, path: { type: text } },
    description: 'One changed file\'s patch, read from GitHub when asked and not stored; null for a change the viewer may not see and for a path that is not one of its files.',
    resolve: (_source, args, { viewer }) => {
      // An outside read through a cache shared between selections: never taken as skippable by the shadow scope.
      markUnscoped('GitHub (a changed file\'s patch)');
      return service.read(viewer, args.change, args.path);
    },
  }, 'a changed file\'s patch, from GitHub') };
}
