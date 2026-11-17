/** What every memory write is checked against before it reaches the store, and the default life of an episode. */
import type { MemoryInput } from '../backends/types.js';
import { EPISODE_CATEGORY, EPISODE_DEFAULT_TTL } from '../categories.js';

/**
 * Lint-on-write (c-loom-strictness §lint): validate the record BEFORE it reaches
 * the backend, so a malformed write is refused with a typed reason and the store
 * is left untouched — never an empty/torn memory committed then discovered. The
 * knowledge wing already gates its writes (a citation is required); this brings
 * the memory wing to parity. Returns a reason string when invalid, else null.
 */
export function validateMemoryInput(input: MemoryInput): string | null {
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    return 'memory content is required and cannot be empty';
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    return 'memory title is required and cannot be empty';
  }
  if (typeof input.category !== 'string' || input.category.trim() === '') {
    return 'memory category is required and cannot be empty';
  }
  if (input.scope !== undefined && input.scope !== 'project' && input.scope !== 'global') {
    return 'scope must be "project" or "global"';
  }
  return null;
}

/** The same validation and episode defaults apply at every write door. */
export function prepareMemoryInput(input:MemoryInput):MemoryInput {
  const reason = validateMemoryInput(input);
  if (reason !== null) {
    // Rejected pre-commit: nothing is opened or written. The thrown reason is
    // the typed rejection (dispatch wraps it into a typed envelope at the edge).
    throw new Error(`Error: ${reason}`);
  }
  // An episode is short-term by definition: without an explicit ttl it gets the
  // tier default, so a body can never accidentally leave a permanent episode.
  const isEpisode = input.category === EPISODE_CATEGORY;
  return isEpisode&&!input.ttl?{...input,ttl:EPISODE_DEFAULT_TTL}:input;
}
