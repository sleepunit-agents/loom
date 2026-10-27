/**
 * knowledge list / knowledge_list — every active page's freshness fields, no
 * bodies: what a verification sweep picks from. A listing, not a read: it
 * doesn't count as an access (no hit_count).
 */
import { createKnowledgeBackend } from '../backends/index.js';

export interface PageFreshness {
  slug: string;
  title: string;
  domain: string;
  created: string;
  verified_at: string | null;
  freshness_anchor: string | null;
  sla_class: string;
}

export async function knowledgeFreshness(contextDir: string, domain?: string): Promise<PageFreshness[]> {
  const backend = createKnowledgeBackend(contextDir);
  try {
    return (await backend.listPages({ domain, limit: 1_000_000 }))
      .filter((p) => p.status === 'active')
      .map((p) => ({
        slug: p.slug, title: p.title, domain: p.domain, created: p.created,
        verified_at: p.verified_at ?? null, freshness_anchor: p.freshness_anchor ?? null, sla_class: p.sla_class,
      }));
  } finally {
    backend.close();
  }
}
