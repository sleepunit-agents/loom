/**
 * knowledge_archive tool — soft-retire a knowledge page.
 *
 * Sets status='archived' with an optional tombstone note. Archived pages are
 * excluded from knowledge_recall and knowledge_maintain but remain in the DB
 * and are recoverable via knowledge_restore. Mirror of memory_archive.
 */
import { createKnowledgeBackend } from '../backends/index.js';

export interface KnowledgeArchiveToolInput {
  slug: string;
  note?: string;
}

export async function knowledgeArchive(
  contextDir: string,
  input: KnowledgeArchiveToolInput,
): Promise<string> {
  const backend = createKnowledgeBackend(contextDir);
  try {
    const result = await backend.archivePage({ slug: input.slug, note: input.note });
    if (!result.archived) {
      return `Knowledge page not found or already archived: \`${input.slug}\`. Use knowledge_recall to find the correct slug.`;
    }
    return `Knowledge page archived: \`${input.slug}\``;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
