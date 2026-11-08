/**
 * memory_history tool — body-revision listing and inspection for memories.
 *
 * update() snapshots the displaced body into memory_revisions before
 * overwriting it. This tool is the read surface: list a memory's snapshots
 * (metadata only) or read one snapshot's full content. To put a snapshot
 * back, use memory_revision_restore.
 */
import { createBackend } from '../backends/index.js';

export interface MemoryHistoryToolInput {
  ref: string;
  revision_id?: number;
}

export async function memoryHistory(
  contextDir: string,
  input: MemoryHistoryToolInput,
): Promise<string> {
  if (!input.ref) {
    return 'Error: ref is required.';
  }

  const backend = createBackend(contextDir);
  try {
    // ── Read mode ──
    if (input.revision_id !== undefined) {
      const revision = await backend.getRevision(input.revision_id);
      if (!revision) {
        return `Error: revision not found: ${input.revision_id}`;
      }
      // Ownership is memory_id, not the ref recorded at snapshot time:
      // memory_merge re-parents a source's revisions onto the target and
      // keeps the original ref as provenance (PR120 review). So a revision
      // belongs to input.ref iff it is in input.ref's listing.
      const owned = (await backend.listRevisions(input.ref)).some((r) => r.id === revision.id);
      if (!owned) {
        return `Error: revision #${input.revision_id} does not belong to \`${input.ref}\` (recorded on \`${revision.ref}\`).`;
      }
      const provenance =
        revision.ref !== input.ref ? ` (recorded on \`${revision.ref}\`, merged in)` : '';
      return (
        `# Revision #${revision.id} of \`${input.ref}\`${provenance}\n` +
        `op: ${revision.op} | replaced: ${revision.replaced_at}\n\n` +
        `${revision.content}\n\n` +
        `_Pass to memory_revision_restore to put this body back._`
      );
    }

    // ── List mode ──
    const revisions = await backend.listRevisions(input.ref);
    if (revisions.length === 0) {
      return `\`${input.ref}\` has no revisions — its body has never been replaced.`;
    }
    const lines = revisions.map(
      (r) =>
        `- **#${r.id}** | ${r.op} | replaced ${r.replaced_at} | ${r.content_length} chars` +
        (r.ref !== input.ref ? ` | from \`${r.ref}\` (merged in)` : ''),
    );
    return (
      `# Revision history — \`${input.ref}\` — ${revisions.length} snapshot(s)\n\n` +
      `${lines.join('\n')}\n\n` +
      `_Pass revision_id to read a snapshot; use memory_revision_restore to put one back._`
    );
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
  // No close(): createBackend hands out the shared, process-cached handle.
  // Closing it here would kill any in-flight call on the same backend.
}
