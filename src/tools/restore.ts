/**
 * Restore tool — return an archived memory to the active set.
 *
 * Clears the archived flag and wipes the tombstone note. The memory
 * becomes visible to recall, list, audit, and findSimilar again.
 */
import type { MemorySelection } from '../config.js';
import { createBackend } from '../backends/index.js';
import type { RestoreInput } from '../backends/types.js';



export async function restore(
  contextDir: string,
  input: RestoreInput,
  selection?: MemorySelection,
): Promise<string> {
  const isSingle = input.ref || (input.category && input.title);

  if (!isSingle) {
    return 'Nothing to restore. Provide a ref or category+title.';
  }

  const backend = createBackend(contextDir, selection);
  const result = await backend.restore(input);

  if (result.restored.length === 0) {
    const identifier = input.ref ?? `${input.category}/${input.title}`;
    return `Archived memory not found: "${identifier}". It may not be archived, or the ref may be wrong.`;
  }

  return `Memory restored: ${result.restored[0]}`;
}
