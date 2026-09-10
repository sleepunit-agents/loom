/**
 * knowledge_recall tool — LIKE search over the knowledge store.
 *
 * Two detail tiers:
 *   'full'  — whole entity pages with citations (the synthesis unit).
 *             Stamps last_accessed / hit_count via queryPages — the usage
 *             signal the Phase-4 expansion engine reads.
 *   'index' — one compact entry per page (slug, domain, sourcing, anchor,
 *             snippet). Does NOT stamp access: appearing in a listing is
 *             not a read.
 *
 * Default tier: 'full' when a query is given, 'index' when browsing
 * (no query). Full output is size-guarded — once the budget is spent,
 * remaining pages degrade to index entries instead of blowing the
 * tool-result limit. Never surfaces archived pages.
 *
 * Miss logging: when gapsDir is set, every zero-result query (and every
 * slug lookup that finds nothing) is appended to
 * `${gapsDir}/recall-miss.jsonl` as a structured record. The knowledge-mine
 * script reads that file alongside transcript clusters — so gaps Art tried
 * to recall but couldn't surface become a second signal channel for the
 * expansion engine. The append is best-effort; a write failure never
 * disrupts the caller.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createKnowledgeBackend } from '../backends/index.js';
import type { KnowledgePageWithCitations } from '../backends/types.js';

export interface KnowledgeRecallInput {
  /**
   * Exact-slug lookup — fetches that single page in full detail, stamping
   * access. Takes precedence over query/domain/limit. This is the precise
   * path; LIKE token-matching can return the wrong page when bodies
   * cross-reference each other.
   */
  slug?: string;
  query?: string;
  domain?: string;
  limit?: number;
  detail?: 'index' | 'full';
  /**
   * Stale-first ordering for the verification engine: verified_at ASC with
   * never-verified pages first. Index entries gain a `verified:` stamp so
   * the verifier can apply its SLA filter from the listing alone.
   */
  sort_by_verified?: boolean;
}

/**
 * Character budget for full-page output. ~24k chars ≈ 6k tokens — well under
 * typical MCP tool-result caps, with room for the citations and framing.
 */
const FULL_OUTPUT_CHAR_BUDGET = 24_000;

/**
 * Append one recall-miss entry to `${gapsDir}/recall-miss.jsonl`.
 *
 * Called when a query returns zero results or a slug lookup finds nothing.
 * The write is best-effort — failures are silently swallowed so a disk or
 * permission error never disrupts the caller's recall.
 *
 * Entry shape:
 *   query  — the natural-language query string, or null for slug lookups
 *   slug   — the exact slug that was looked up, or null for query searches
 *   at     — ISO 8601 UTC timestamp
 */
function appendRecallMiss(
  gapsDir: string | undefined,
  miss: { query?: string; slug?: string },
): void {
  if (!gapsDir || (!miss.query && !miss.slug)) return;
  try {
    mkdirSync(gapsDir, { recursive: true });
    const entry = JSON.stringify({
      query: miss.query ?? null,
      slug: miss.slug ?? null,
      at: new Date().toISOString(),
    });
    appendFileSync(join(gapsDir, 'recall-miss.jsonl'), entry + '\n', 'utf8');
  } catch {
    // Never let a miss-log failure surface to the caller.
  }
}

/** Max characters of body shown per index entry snippet. */
const SNIPPET_LENGTH = 200;

function formatPage(page: KnowledgePageWithCitations): string {
  const lines: string[] = [];
  lines.push(`## ${page.title}`);
  lines.push(`**Slug:** \`${page.slug}\` | **Domain:** ${page.domain} | **Sourcing:** ${page.sourcing}`);
  if (page.sourcing === 'provisional') {
    lines.push('> ⚠️ Provisional — needs independent citation to be sourced.');
  }
  if (page.provenance) {
    lines.push(`> Provenance: ${page.provenance}`);
  }
  lines.push('');
  lines.push(page.body);
  if (page.citations.length > 0) {
    lines.push('');
    lines.push('**Citations:**');
    for (const cit of page.citations) {
      const loc = cit.source_locator ? ` (${cit.source_locator})` : '';
      lines.push(`- [${cit.source_kind}${loc}] *${cit.claim}* — "${cit.excerpt}"`);
    }
  }
  return lines.join('\n');
}

/** First non-heading, non-blank line of the body, truncated to SNIPPET_LENGTH. */
function snippet(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    return line.length > SNIPPET_LENGTH ? `${line.slice(0, SNIPPET_LENGTH - 1)}…` : line;
  }
  return '';
}

function formatIndexEntry(page: KnowledgePageWithCitations, showVerified = false): string {
  const anchor = page.freshness_anchor ? ` | anchor: ${page.freshness_anchor}` : '';
  const provisional = page.sourcing === 'provisional' ? ' | ⚠️ provisional' : '';
  const verified = showVerified
    ? ` | verified: ${page.verified_at ? page.verified_at.slice(0, 10) : 'never'}`
    : '';
  const lines = [
    `- **${page.title}** (\`${page.slug}\`)`,
    `  ${page.domain}${anchor}${verified}${provisional} | ${page.citations.length} citation${page.citations.length === 1 ? '' : 's'} | hits: ${page.hit_count}`,
  ];
  const snip = snippet(page.body);
  if (snip) lines.push(`  ${snip}`);
  return lines.join('\n');
}

export async function knowledgeRecall(
  contextDir: string,
  input: KnowledgeRecallInput,
  gapsDir?: string,
): Promise<string> {
  const detail = input.detail ?? (input.query ? 'full' : 'index');

  const backend = createKnowledgeBackend(contextDir);
  try {
    // Exact-slug lookup short-circuits the search path entirely.
    if (input.slug) {
      const peek = await backend.getPage(input.slug);
      if (!peek) {
        appendRecallMiss(gapsDir, { slug: input.slug });
        return `No knowledge page found for slug \`${input.slug}\`.`;
      }
      if (peek.status === 'archived') {
        // Not stamped — an archived page surfacing in an error message is
        // not a read, and a phantom hit would survive a later restore.
        return (
          `No active knowledge page for slug \`${input.slug}\` — it is archived. ` +
          `Use knowledge_restore to bring it back.`
        );
      }
      const page = await backend.getPage(input.slug, { stampAccess: true });
      return `# Knowledge recall — 1 result\n\n${formatPage(page!)}`;
    }

    const pages = await backend.queryPages({
      query: input.query,
      domain: input.domain,
      excludeStatus: 'archived',
      // Index entries are cheap — browse wide by default. Full pages are
      // expensive — keep the default narrow.
      limit: input.limit ?? (detail === 'index' ? 50 : 10),
      // Index browsing must not inflate hit_count (expansion-engine signal).
      stampAccess: detail === 'full',
      sortByVerified: input.sort_by_verified,
    });

    if (pages.length === 0) {
      const q = input.query ? `"${input.query}"` : '(no query)';
      // Log query misses only — browsing (no query given) is not a named gap.
      if (input.query) {
        appendRecallMiss(gapsDir, { query: input.query });
      }
      return `No knowledge pages found for ${q}.`;
    }

    const plural = pages.length === 1 ? '' : 's';

    if (detail === 'index') {
      const entries = pages.map((p) => formatIndexEntry(p, input.sort_by_verified === true));
      return (
        `# Knowledge index — ${pages.length} page${plural}\n\n` +
        `${entries.join('\n')}\n\n` +
        `_Pass slug: "<slug>" (or detail: "full") to read whole pages._`
      );
    }

    // Full mode with a size guard: emit whole pages until the budget is
    // spent, then degrade the remainder to index entries.
    const fullParts: string[] = [];
    const overflow: KnowledgePageWithCitations[] = [];
    let spent = 0;
    for (const page of pages) {
      const formatted = formatPage(page);
      // Always include at least one full page — the first result is what
      // the caller asked for even if it alone exceeds the budget.
      if (fullParts.length > 0 && spent + formatted.length > FULL_OUTPUT_CHAR_BUDGET) {
        overflow.push(page);
        continue;
      }
      fullParts.push(formatted);
      spent += formatted.length;
    }

    let out = `# Knowledge recall — ${pages.length} result${plural}\n\n${fullParts.join('\n\n---\n\n')}`;
    if (overflow.length > 0) {
      const entries = overflow.map((p) => formatIndexEntry(p, input.sort_by_verified === true));
      out +=
        `\n\n---\n\n` +
        `**${overflow.length} more match${overflow.length === 1 ? '' : 'es'}** (output budget reached — shown as index; ` +
        `recall by slug for full pages):\n\n${entries.join('\n')}`;
    }
    return out;
  } finally {
    backend.close();
  }
}
