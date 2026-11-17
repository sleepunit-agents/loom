/**
 * The memory category vocabulary, once. The commands that write a memory
 * (src/pieces/mind/semantic-commands.ts) and the terminal tools over them
 * (src/shared-mcp-named.ts) both take their list from here.
 *
 * A memory is written with one of these, and recall may be narrowed to one of
 * them. A draft (memory.propose) may carry any category; it must be one of
 * these by the time it is ratified. Memories written before the vocabulary
 * existed (e.g. legacy "general") are still read: nothing that reads a stored
 * row checks its category against this list.
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

