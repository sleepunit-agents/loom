/**
 * knowledge_restore tool — return an archived knowledge page to active status.
 *
 * Clears status back to 'active' and wipes the tombstone note. The page
 * becomes visible to knowledge_recall and knowledge_maintain again.
 * Mirror of memory_restore.
 */
import { createKnowledgeBackend } from '../backends/index.js';

export interface KnowledgeRestoreToolInput {
  slug: string;
}

export async function knowledgeRestore(
  contextDir: string,
  input: KnowledgeRestoreToolInput,
): Promise<string> {
  const backend = createKnowledgeBackend(contextDir);
  try {
    const result = await backend.restorePage({ slug: input.slug });
    if (!result.restored) {
      return `Archived knowledge page not found: \`${input.slug}\`. It may not be archived, or the slug may be wrong.`;
    }
    return `Knowledge page restored: \`${input.slug}\``;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
