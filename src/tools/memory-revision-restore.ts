/**
 * memory_revision_restore tool — restore a snapshotted body onto a memory.
 *
 * Snapshots the current body first, so restore is never destructive.
 * Use memory_history to list revision IDs before calling this.
 */
import { createBackend } from '../backends/index.js';

export interface MemoryRevisionRestoreToolInput {
  ref: string;
  revision_id: number;
}

export async function memoryRevisionRestore(
  contextDir: string,
  input: MemoryRevisionRestoreToolInput,
): Promise<string> {
  if (!input.ref) {
    return 'Error: ref is required.';
  }
  if (input.revision_id === undefined) {
    return 'Error: revision_id is required — list revisions with memory_history first.';
  }

  const backend = createBackend(contextDir);
  try {
    const result = await backend.restoreRevision({
      ref: input.ref,
      revision_id: input.revision_id,
    });
    if (!result.restored) {
      return (
        `Error: could not restore revision #${input.revision_id} onto \`${input.ref}\`. ` +
        `Check that the ref exists and the revision belongs to it.`
      );
    }
    return (
      `Restored revision #${result.revision_id} onto \`${result.ref}\`. ` +
      `The displaced body was snapshotted as revision #${result.snapshot_id}.`
    );
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
