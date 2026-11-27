/** The two paces of a live selection (docs/specs/boards.md, "Live reads and their cost"). Plain values only: the
 * server's live reads (./live.ts, ./subscriptions.ts) and the page (web/src/data/graphql) both read this file.
 *
 * `eager` is what every selection was before there were two: read again at once for a commit that comes alone, and
 * at most once in the settle time (src/next-data.ts, `LIVE_SETTLE_MS`). `relaxed` is read again at most once in
 * `LIVE_RELAXED_MS`, with the same promises: its first answer never waits, and there is always a reading after the
 * last commit. The client asks for a pace by name with each selection; it never sends a number. */
export type LivePace = 'eager' | 'relaxed';
/** How soon after one reading of a relaxed selection began the next may begin, unless the client asks for it now. */
export const LIVE_RELAXED_MS = 5000;
/** What a client asked for, as loom takes it: `relaxed` and nothing else is relaxed. A missing, misspelt or
 * unknown word, a number and anything else is eager, so no client can ask for a pace faster than eager. */
export const livePace = (asked: unknown): LivePace => (asked === 'relaxed' ? 'relaxed' : 'eager');
/** The most selections one "now" may name, and the longest name a client may give a selection. */
export const NOW_KEYS_MOST = 200, NOW_KEY_LONGEST = 64;
