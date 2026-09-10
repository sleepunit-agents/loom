/**
 * Remember tool — stores an episodic memory that persists across sessions.
 *
 * Delegates to the configured MemoryBackend. v0.3.1 ships a single
 * backend (sqlite-vec + fastembed); the interface stays generic so
 * future stacks can swap in without changing the tool contract.
 */
import { createBackend } from '../backends/index.js';
import type { MemoryInput, MemoryRef } from '../backends/types.js';
import { EPISODE_CATEGORY, EPISODE_DEFAULT_TTL } from '../categories.js';
import { recordSuccess, recordFailure } from '../backends/recorder-health.js';

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
  return null;
}

export async function remember(
  contextDir: string,
  input: MemoryInput,
): Promise<MemoryRef> {
  const reason = validateMemoryInput(input);
  if (reason !== null) {
    // Rejected pre-commit: nothing is opened or written. The thrown reason is
    // the typed rejection (dispatch wraps it into a typed envelope at the edge).
    throw new Error(`Error: ${reason}`);
  }
  const backend = createBackend(contextDir);
  // An episode is short-term by definition: without an explicit ttl it gets the
  // tier default, so a body can never accidentally leave a permanent episode.
  const isEpisode = input.category === EPISODE_CATEGORY;
  if (isEpisode && !input.ttl) {
    input = { ...input, ttl: EPISODE_DEFAULT_TTL };
  }
  try {
    const ref = await backend.remember(input);
    // Record health only for episode writes — that's the path identity.ts monitors.
    if (isEpisode) recordSuccess(contextDir);
    return ref;
  } catch (err) {
    if (isEpisode) recordFailure(contextDir, err);
    throw err;
  }
}
