/**
 * Archive tool — soft-retire a memory with a tombstone instead of hard delete.
 *
 * Archived memories are excluded from recall, list, audit, and findSimilar
 * but remain recoverable via restore. The tombstone preserves the original
 * body plus a caller-provided note (who/why retired) and a timestamp.
 */
import { createBackend } from '../backends/index.js';
import type { ArchiveInput } from '../backends/types.js';



export async function archive(
  contextDir: string,
  input: ArchiveInput,
): Promise<string> {
  const isSingle = input.ref || (input.category && input.title);

  if (!isSingle) {
    return 'Nothing to archive. Provide a ref or category+title.';
  }

  const backend = createBackend(contextDir);
  const result = await backend.archive(input);

  if (result.archived.length === 0) {
    const identifier = input.ref ?? `${input.category}/${input.title}`;
    return `Memory not found (or already archived): "${identifier}". Use recall to find the correct reference.`;
  }

  return `Memory archived: ${result.archived[0]}`;
}
