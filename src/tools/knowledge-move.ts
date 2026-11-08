/**
 * knowledge_move tool — re-key or re-domain a knowledge page in place.
 *
 * Three modes:
 *   1. Single-page: change slug and/or domain on one page (same row, same uuid).
 *   2. Batch by slug list: re-domain a set of named pages atomically.
 *   3. Batch by domain prefix: re-home an entire subtree in one transaction.
 *
 * Slug changes write a supersessions pointer (old→new) unless leave_pointer=false.
 * Slug collisions are rejected — use knowledge_merge instead.
 */
import { createKnowledgeBackend } from '../backends/index.js';

export interface KnowledgeMoveToolInput {
  // Single-page mode
  slug?: string;
  new_slug?: string;
  new_domain?: string;
  leave_pointer?: boolean;

  // Batch by slug list
  slugs?: string[];

  // Batch by domain prefix
  from_domain_prefix?: string;
  to_domain_prefix?: string;
}

export async function knowledgeMove(
  contextDir: string,
  input: KnowledgeMoveToolInput,
): Promise<string> {
  const backend = createKnowledgeBackend(contextDir);
  try {
    const result = await backend.movePage(input);

    if (result.moved === 0) {
      return 'No pages matched — nothing moved.';
    }

    const lines: string[] = [];

    if (input.from_domain_prefix !== undefined) {
      lines.push(
        `Moved ${result.moved} page(s) from domain prefix \`${input.from_domain_prefix}\` → \`${input.to_domain_prefix}\`.`,
      );
    } else if (input.slugs && input.slugs.length > 0) {
      lines.push(
        `Moved ${result.moved} page(s) to domain \`${input.new_domain}\`.`,
      );
    } else {
      const page = result.pages[0];
      if (page.old_slug) {
        lines.push(`Re-slugged \`${page.old_slug}\` → \`${page.slug}\`.`);
        if (result.pointers_written > 0) {
          lines.push('Supersessions pointer written (old slug → new slug).');
        }
      }
      if (page.new_domain !== page.old_domain) {
        lines.push(`Domain changed: \`${page.old_domain}\` → \`${page.new_domain}\`.`);
      }
      lines.push(`uuid, citations, and verification history are unchanged.`);
    }

    return lines.join(' ');
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
