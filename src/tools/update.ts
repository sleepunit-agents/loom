/**
 * Update tool — modifies an existing memory by reference or by category+title.
 *
 * Delegates to the configured memory backend. Supports full content
 * replacement or metadata-only updates.
 */
import { createBackend } from '../backends/index.js';
import type { UpdateInput } from '../backends/types.js';



export async function update(
  contextDir: string,
  input: UpdateInput,
): Promise<string> {
  const backend = createBackend(contextDir);
  const result = await backend.update(input);

  if (!result.updated) {
    const identifier = input.ref ?? `${input.category}/${input.title}`;
    return `Memory not found: "${identifier}". Use recall to find the correct reference.`;
  }

  const snap = result.snapshotId !== undefined ? ` (snapshot #${result.snapshotId})` : '';
  const conf =
    result.confidence !== undefined
      ? ` — confidence now ${result.confidence.toFixed(2)} (${result.evidenceCount} observations)`
      : '';
  return `Memory updated: ${result.ref}${snap}${conf}`;
}
