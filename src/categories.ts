/**
 * Shared memory category vocabulary — the single source of truth for
 * write-side category enforcement across MCP schemas and the CLI
 * (store-convergence spec, "One boundary discipline").
 *
 * Reads (recall / memory_list / forget) intentionally accept arbitrary
 * strings so memories written before the vocabulary existed (e.g.
 * legacy "general") stay reachable. Only writes are enforced.
 */
export const MEMORY_CATEGORIES = [
  'user',
  'project',
  'self',
  'feedback',
  'reference',
  'pursuit',
  // Short-term cross-body tier (t-142): a 3-line "where / what / open" note a
  // sleeve leaves so the NEXT sleeve knows what just happened across all of
  // Art. Defaults to a 48h TTL on write; injected at boot as a time-ordered
  // tape (never salience-ranked) and excluded from the Top-of-Mind digest.
  'episode',
] as const;

/** The category that carries the short-term cross-body tape. */
export const EPISODE_CATEGORY = 'episode';
/** Episodes expire by default — they are a tape, not the stack. */
export const EPISODE_DEFAULT_TTL = '48h';

/** The category that carries evidence-backed confidence (t-338). */
export const FEEDBACK_CATEGORY = 'feedback';

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}
