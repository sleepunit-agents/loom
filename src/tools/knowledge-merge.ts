/**
 * knowledge_merge tool — consolidate N knowledge pages into one canonical page.
 *
 * Re-parents all citations from source pages to the target, deduplicating by
 * (claim, source_kind, source_locator, excerpt). Takes MAX(verified_at) across
 * all pages. Supersedes losers (archives each with a pointer to target).
 *
 * Distinct from knowledge_supersede (1:1 pointer, no citation consolidation):
 * use merge when there is real data to consolidate from multiple pages.
 */
import { createKnowledgeBackend } from '../backends/index.js';

export interface KnowledgeMergeToolInput {
  source_slugs: string[];
  target_slug: string;
  note?: string;
  hard_delete_losers?: boolean;
  append_loser_bodies?: boolean;
}

export async function knowledgeMerge(
  contextDir: string,
  input: KnowledgeMergeToolInput,
): Promise<string> {
  if (!input.source_slugs || input.source_slugs.length === 0) {
    return 'Error: source_slugs must not be empty.';
  }

  const backend = createKnowledgeBackend(contextDir);
  try {
    const result = await backend.mergePages(input);

    const lines: string[] = [
      `Merged ${result.sources_merged} page(s) into \`${result.target_slug}\`.`,
      `Citations: ${result.citations_moved} moved to target, ${result.citations_deduped} duplicate(s) removed.`,
      `verified_at set to ${result.verified_at}.`,
      `Losers archived: ${result.losers.map((l) => `\`${l.slug}\``).join(', ')}.`,
    ];

    if (!input.append_loser_bodies && result.losers.length > 0) {
      lines.push('');
      lines.push('Loser bodies (target body NOT modified — curator review):');
      for (const loser of result.losers) {
        lines.push(`\n**${loser.slug}:**\n${loser.body}`);
      }
    }

    return lines.join('\n');
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
