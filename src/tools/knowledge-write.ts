/**
 * knowledge_write tool — upsert an entity page by slug/title.
 *
 * Two knowledge classes:
 *   world/  — facts true independent of us (default; domain = "music/gear", etc.)
 *   ours/   — Art-created artifacts revised-in-place (domain starts with "ours/").
 *             Cited to repo paths/commits, loom_memory refs, or live-system probes.
 *
 * Epistemic gate (§E1):
 *   - conversation-only citations → provisional (both classes).
 *   - any repo citation → internal (ours/ class; overrides the sourced gate).
 *   - any web citation (no repo) → sourced (world/ default).
 *
 * Filing test for world/ pages: knowledge is true independent of Jonathan; if
 * it's about Jonathan / our work use memory or ours/ instead, not the world class.
 */
import { createKnowledgeBackend } from '../backends/index.js';

export interface KnowledgeWriteInput {
  domain: string;
  title: string;
  body: string;
  slug?: string;
  freshness_anchor?: string;
  /**
   * Body combine mode when the slug already exists: 'replace' (default)
   * overwrites the stored body; 'append' adds this body after the existing
   * one. Citations are always appended (with exact-duplicate dedup),
   * regardless of mode.
   */
  mode?: 'replace' | 'append';
  citations: Array<{
    claim: string;
    source_kind: 'web' | 'loom_memory' | 'conversation' | 'repo';
    source_locator?: string;
    excerpt: string;
  }>;
  /** ours/ class: who created or last owned this artifact (e.g. "art", "jonathan"). */
  created_by?: string;
  /** ours/ class: artifact version or revision tag (e.g. "v2", "2026-08-19"). */
  version?: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

/**
 * §E1: Epistemic gate.
 * - conversation-only → provisional (both classes).
 * - ours/ domain + any repo citation → internal (ours/ class artifact; repo = git path/commit/ref).
 * - any web/repo citation on a non-ours/ domain → sourced (world/ default).
 *
 * NOTE: repo citations on world-class pages (domain does NOT start with "ours/") are treated
 * as sourced, not internal. A citation to github.com/someone-else/project is a world source.
 * Only citations to our own repos, combined with an ours/ domain, signal an internal artifact.
 */
function determineSourcing(
  citations: KnowledgeWriteInput['citations'],
  domain: string,
): 'sourced' | 'provisional' | 'internal' {
  if (citations.length === 0) return 'provisional';
  if (citations.every((c) => c.source_kind === 'conversation')) return 'provisional';
  if (domain.startsWith('ours/') && citations.some((c) => c.source_kind === 'repo')) return 'internal';
  return 'sourced';
}

export async function knowledgeWrite(
  contextDir: string,
  input: KnowledgeWriteInput,
): Promise<string> {
  if (input.citations.length === 0) {
    return (
      'Error: at least one citation is required — knowledge must be supported. ' +
      'If this is a conversation-distilled insight, pass source_kind="conversation" ' +
      'and the page will be stored provisional.'
    );
  }

  const slug = input.slug ?? slugify(input.title);
  if (!slug) {
    return 'Error: could not derive a slug from the title. Provide an explicit slug.';
  }

  const sourcing = determineSourcing(input.citations, input.domain);
  const backend = createKnowledgeBackend(contextDir);
  try {
    const result = await backend.writePage({
      slug,
      title: input.title,
      domain: input.domain,
      body: input.body,
      sourcing,
      freshness_anchor: input.freshness_anchor,
      bodyMode: input.mode,
      citations: input.citations,
      created_by: input.created_by,
      version: input.version,
    });

    const sourcingNote =
      sourcing === 'provisional'
        ? '\n> **Provisional** — sole support is conversation citations. ' +
          'Add a web or repo citation to promote to sourced/internal.'
        : sourcing === 'internal'
          ? '\n> **Internal** — ours/ class artifact; cited to repo/live-system sources.'
          : '';

    const action =
      result.bodyMode === 'create' ? 'created'
      : result.bodyMode === 'append' ? 'updated (body appended)'
      : 'updated (body replaced)';
    const dedupNote = result.citationsDeduped > 0
      ? ` (${result.citationsDeduped} duplicate${result.citationsDeduped === 1 ? '' : 's'} skipped)`
      : '';

    return (
      `Knowledge page ${action}: **${result.title}** (\`${result.slug}\`)\n` +
      `Domain: ${input.domain} | Citations added: ${result.citationsAdded}${dedupNote} | Sourcing: ${sourcing}` +
      sourcingNote
    );
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
