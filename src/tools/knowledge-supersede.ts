/**
 * knowledge_supersede tool — retire a duplicate page in favour of the canonical one.
 *
 * Archives old_slug with a tombstone referencing new_slug, then records the
 * supersession in the supersessions table. This is the dedup-merge primitive:
 *   1. knowledge_write the canonical page (or confirm it exists)
 *   2. knowledge_supersede(loser → canonical)
 *
 * Both pages must already exist. new_slug need not be active (archiving a
 * superseded chain is allowed), but old_slug must not already be archived —
 * if it is, the call returns without error but reports archived=false.
 */
import { createKnowledgeBackend } from '../backends/index.js';

export interface KnowledgeSupersededToolInput {
  old_slug: string;
  new_slug: string;
  note?: string;
}

export async function knowledgeSupersede(
  contextDir: string,
  input: KnowledgeSupersededToolInput,
): Promise<string> {
  if (input.old_slug === input.new_slug) {
    return 'Error: old_slug and new_slug must be different.';
  }

  const backend = createKnowledgeBackend(contextDir);
  try {
    const result = await backend.supersedePage({
      old_slug: input.old_slug,
      new_slug: input.new_slug,
      note: input.note,
    });
    const archiveNote = result.archived
      ? ` \`${result.old_slug}\` archived with supersession tombstone.`
      : ` \`${result.old_slug}\` was already archived.`;
    return (
      `Knowledge supersession recorded: \`${result.old_slug}\` → \`${result.new_slug}\`.${archiveNote}`
    );
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
