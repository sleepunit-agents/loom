/**
 * Knowledge tool registration (t-677) — factored out of server.ts so there
 * is exactly ONE implementation of "how a knowledge tool call turns into a
 * backend call with identity attribution", shared by:
 *   - the full loom server (createLoomServer, identity hardcoded to 'art') —
 *     Art's own stdio/mesh session, same code path as the service below.
 *   - the standalone knowledge-only HTTP service (createKnowledgeOnlyServer),
 *     where `identity` is resolved per-connection from the per-identity
 *     bearer token (checkBearerMulti) and never from a client-supplied field.
 *
 * This is the "no separate local-file fast path" requirement from t-677:
 * Art's own knowledge_write/knowledge_recall calls run through the exact
 * same registration function — same backend calls, same identity threading
 * — as a second identity's calls through the scoped service, so the two
 * cannot silently diverge in how they read/write knowledge.db.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { knowledgeWrite } from '../tools/knowledge-write.js';
import { knowledgeRecall } from '../tools/knowledge-recall.js';
import { knowledgeMaintain } from '../tools/knowledge-maintain.js';
import { knowledgeArchive } from '../tools/knowledge-archive.js';
import { knowledgeRestore } from '../tools/knowledge-restore.js';
import { knowledgeSupersede } from '../tools/knowledge-supersede.js';
import { knowledgeMove } from '../tools/knowledge-move.js';
import { knowledgeMerge } from '../tools/knowledge-merge.js';
import { knowledgePurge } from '../tools/knowledge-purge.js';
import { knowledgeVerify } from '../tools/knowledge-verify.js';
import { knowledgeHistory } from '../tools/knowledge-history.js';

export interface RegisterKnowledgeToolsOptions {
  contextDir: string;
  /** Knowledge-gaps dir for recall-miss logging (see knowledge-recall.ts). */
  gapsDir?: string;
  /**
   * The identity making calls through this registration. 'art' for the main
   * server; for the standalone knowledge-only service this is resolved per
   * connection from the per-identity bearer token at session-open time —
   * never from a tool argument, so a caller can't spoof attribution.
   */
  identity: string;
}

/** Registers the full knowledge_* tool surface (11 tools) on `server`. */
export function registerKnowledgeTools(server: McpServer, opts: RegisterKnowledgeToolsOptions): void {
  const { contextDir, gapsDir, identity } = opts;

  server.tool(
    'knowledge_write',
    'Upsert a knowledge page by slug. Two classes:\n' +
    '  world/ (default) — facts true independent of us. Domain = "music/gear", "software/loom", etc.\n' +
    '  ours/  — Art-created artifacts, revised-in-place (breakbrain density model, homelab design,\n' +
    '            wake-chain spec, script templates). Domain starts with "ours/", e.g. "ours/art-ops".\n' +
    'On an existing slug: body REPLACES by default (mode: "append" adds to it instead), ' +
    'title/domain follow the write, citations always appended with exact-duplicate dedup — safe to re-send.\n' +
    'Epistemic gate (§E1):\n' +
    '  • conversation-only citations → provisional (both classes).\n' +
    '  • ours/ domain + any repo citation → internal (ours/ class artifact; repo = git path / commit / live-system probe).\n' +
    '  • any web/repo citation on a non-ours/ domain → sourced (world/ default).\n' +
    '  NOTE: repo citations on world-class pages (domain not starting with "ours/") are treated as sourced, not internal.\n' +
    '  A citation to github.com/someone-else/project is a world source.\n' +
    'World filing test: knowledge must be true independent of Jonathan. For our own artifacts use ours/.\n' +
    'Shared surface, not a scratchpad: knowledge is readable by other identities (e.g. Mark) and by ' +
    'Jonathan, not just you. Write pages as finished synthesis for that audience — no raw inner-monologue ' +
    'reasoning, no private-to-you deliberation, nothing that assumes only you will ever read it. A ' +
    'personal reflection or working-out-loud note belongs in `remember`, not here.',
    {
      title: z.string().describe('Page title — the entity name (e.g. "Mutable Instruments Rings") or artifact name (e.g. "breakbrain density model")'),
      domain: z.string().describe(
        'Domain tag. World class: "music/eurorack", "programming/typescript". ' +
        'Ours class: prefix with "ours/" — e.g. "ours/art-ops", "ours/breakbrain", "ours/homelab". ' +
        'Hierarchical string; sub-domains queryable via prefix filter.',
      ),
      body: z.string().describe('Synthesized markdown body for the entity or artifact page (max 64 KB)'),
      slug: z.string().optional().describe(
        'Entity key for upsert — stable URL-safe identifier. ' +
        'Derived from title if omitted.',
      ),
      freshness_anchor: z.string().optional().describe(
        'The version/date the page\'s claims are valid as-of — e.g. "Syntakt OS 1.21" for a ' +
        'device, "as of 2026-05" for a topic, or "t-81 / 2026-08-31" for an ours/ artifact. ' +
        'Drives the verification engine: a page is re-verified when this anchor moves or the freshness SLA elapses.',
      ),
      mode: z.enum(['replace', 'append']).optional().describe(
        'Body combine mode when the slug already exists: "replace" (default) overwrites the ' +
        'stored body; "append" adds this body after the existing one. Citations are appended ' +
        '(deduped) in both modes. Ignored when creating a new page.',
      ),
      citations: z.array(z.object({
        claim: z.string().describe('The assertion this citation supports'),
        source_kind: z.enum(['web', 'loom_memory', 'conversation', 'repo']).describe(
          'web = external URL; loom_memory = opaque memory ref; conversation = session distillation; ' +
          'repo = git repo path / commit / live-system probe (signals internal only when domain is ours/; ' +
          'on world-class pages, treated as sourced)',
        ),
        source_locator: z.string().optional().describe('URL, memory ref, session ID, or repo path + commit hash'),
        excerpt: z.string().describe('Inline supporting quote or repo excerpt — link-rot insurance (max 4 KB)'),
      })).describe(
        'Support citations. At least one required. ' +
        'All-conversation → provisional. ours/ domain + repo → internal. Any web or repo on non-ours/ → sourced.',
      ),
      created_by: z.string().optional().describe(
        'ours/ class: who created or last owned this artifact (e.g. "art", "jonathan"). ' +
        'Preserved across upserts when omitted; defaults to the calling identity for ours/ pages.',
      ),
      version: z.string().optional().describe(
        'ours/ class: artifact version or revision tag (e.g. "v2", "2026-08-31", "t-81"). ' +
        'Preserved across upserts when omitted.',
      ),
    },
    async ({ title, domain, body, slug, freshness_anchor, mode, citations, created_by, version }) => {
      const result = await knowledgeWrite(
        contextDir,
        { title, domain, body, slug, freshness_anchor, mode, citations, created_by, version },
        identity,
      );
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_recall',
    'Search the knowledge store with LIKE matching over title, body, and domain, ' +
    'or fetch one page exactly by slug. Never surfaces archived pages. Two detail ' +
    'tiers: "full" returns whole entity pages (the synthesis unit) and stamps ' +
    'last_accessed/hit_count; "index" returns compact slug/domain/snippet entries ' +
    'without stamping. Defaults: full when a query is given, index when browsing ' +
    'without one. Full output is size-guarded — overflow results degrade to index ' +
    'entries; recall by slug to read them. Prefer slug over query when you know ' +
    'the page — token matching can hit cross-references in other pages\' bodies.',
    {
      slug: z.string().optional().describe(
        'Exact-slug lookup — returns that single page in full detail and stamps ' +
        'access. Takes precedence over query/domain/limit.',
      ),
      query: z.string().optional().describe(
        'Search terms — matched against title, body, and domain. ' +
        'Omit to browse (returns an index of non-archived pages up to limit).',
      ),
      domain: z.string().optional().describe(
        'Filter by domain prefix, inclusive of the exact domain ' +
        '(e.g. "music/gear" matches "music/gear" and "music/gear/elektron")',
      ),
      limit: z.number().int().positive().optional().describe('Maximum results to return (default: 10)'),
      detail: z.enum(['index', 'full']).optional().describe(
        'Output tier override. "index": compact listing, no body, no access stamping. ' +
        '"full": whole pages with citations. Default: full with a query, index without.',
      ),
      sort_by_verified: z.boolean().optional().describe(
        'Stale-first ordering for the verification engine: verified_at ASC with ' +
        'never-verified pages first. Index entries gain a "verified:" stamp so the ' +
        'SLA filter can run from the listing alone.',
      ),
    },
    async ({ slug, query, domain, limit, detail, sort_by_verified }) => {
      const result = await knowledgeRecall(
        contextDir,
        { slug, query, domain, limit, detail, sort_by_verified },
        gapsDir,
        identity,
      );
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_maintain',
    'Read-only health report for the knowledge store. Three branches: ' +
    '(1) expansion candidates — thin body + high hit_count (needs deepening); ' +
    '(2) cold pages — not accessed recently (unused or undiscovered); ' +
    '(3) misfile audit — provisional sourcing or conversation-only citations ' +
    '(world/ class: should be in the memory store instead — including pages that drifted in as ' +
    'personal/inner-monologue content rather than shared-ready synthesis, which matters more now ' +
    'that knowledge is read by other identities and by Jonathan, not just you; ' +
    'ours/ class with internal sourcing are NOT misfiles — they are correct).\n' +
    'Cold/expansion ranking reads the shared hit_count/last_accessed aggregate (any reader\'s access ' +
    'keeps a page warm), not a per-identity breakdown — per-reader stats exist (knowledge_access) for ' +
    'attribution, but splitting cold-ranking by identity would make the list miss pages a *different* ' +
    'reader keeps alive.\n' +
    'Pair with knowledge_write to act on findings.',
    {
      expansion_hit_threshold: z.number().int().nonnegative().optional().describe(
        'hit_count floor for expansion candidates (default 3; 0 considers every page)',
      ),
      thin_body_threshold: z.number().int().positive().optional().describe(
        'body char ceiling to consider a page thin (default 500)',
      ),
      cold_days: z.number().int().positive().optional().describe(
        'Days without access before a page is cold (default 30)',
      ),
    },
    async ({ expansion_hit_threshold, thin_body_threshold, cold_days }) => {
      const result = await knowledgeMaintain(contextDir, {
        expansionHitThreshold: expansion_hit_threshold,
        thinBodyThreshold: thin_body_threshold,
        coldDays: cold_days,
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_archive',
    'Soft-retire a knowledge page: set its status to archived with an optional tombstone note. ' +
    'Archived pages are excluded from knowledge_recall and knowledge_maintain but remain ' +
    'in the database and are fully recoverable via knowledge_restore. ' +
    'Use this instead of deletion when the page may need to be audited or recovered. ' +
    'For deduplication merges, prefer knowledge_supersede which archives and records the relationship.',
    {
      slug: z.string().describe('Slug of the knowledge page to archive'),
      note: z.string().optional().describe('Tombstone note: why this page is being retired'),
    },
    async ({ slug, note }) => {
      const result = await knowledgeArchive(contextDir, { slug, note });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_restore',
    'Restore a previously archived knowledge page back to active status. ' +
    'Clears the archive flag and tombstone note. The page becomes visible ' +
    'to knowledge_recall and knowledge_maintain again.',
    {
      slug: z.string().describe('Slug of the archived knowledge page to restore'),
    },
    async ({ slug }) => {
      const result = await knowledgeRestore(contextDir, { slug });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_supersede',
    'Mark one knowledge page as superseded by another, then archive the old page. ' +
    'Records the supersession relationship in the supersessions table. ' +
    'This is the dedup-merge primitive: write the canonical page with knowledge_write, ' +
    'then call knowledge_supersede(old_slug=loser, new_slug=canonical). ' +
    'Both pages must already exist. old_slug is archived with a tombstone pointing to new_slug.',
    {
      old_slug: z.string().describe('Slug of the page being retired (the duplicate or loser)'),
      new_slug: z.string().describe('Slug of the canonical replacement page (must already exist)'),
      note: z.string().optional().describe('Optional note explaining the merge or supersession decision'),
    },
    async ({ old_slug, new_slug, note }) => {
      const result = await knowledgeSupersede(contextDir, { old_slug, new_slug, note });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_move',
    'Re-key or re-domain a knowledge page in place — same row, same uuid, citations and verification history preserved. ' +
    'Three modes: (1) Single-page: provide slug + new_slug and/or new_domain. ' +
    'Slug rename writes a supersessions pointer (old→new) unless leave_pointer=false. ' +
    'If new_slug already exists, the call is rejected — use knowledge_merge instead. ' +
    '(2) Batch by slug list: provide slugs array + new_domain to re-home multiple pages atomically. ' +
    '(3) Batch by domain prefix: provide from_domain_prefix + to_domain_prefix to re-home a whole subtree in one transaction.',
    {
      slug: z.string().optional().describe(
        'Current slug of the page to move (single-page mode)',
      ),
      new_slug: z.string().optional().describe(
        'New slug (re-slug). Collision with an existing page is rejected — use knowledge_merge instead.',
      ),
      new_domain: z.string().optional().describe(
        'New domain for the page (single-page re-domain or shared target for batch-by-slugs mode)',
      ),
      leave_pointer: z.boolean().optional().describe(
        'Write a supersessions pointer old_slug→new_slug when the slug changes. Default true.',
      ),
      slugs: z.array(z.string()).optional().describe(
        'Batch mode: list of slugs to re-domain. Requires new_domain. Atomic — rolls back on any missing slug.',
      ),
      from_domain_prefix: z.string().optional().describe(
        'Batch prefix mode: domain prefix to replace (e.g. "gear/elektron"). Requires to_domain_prefix.',
      ),
      to_domain_prefix: z.string().optional().describe(
        'Batch prefix mode: replacement domain prefix (e.g. "instruments/elektron").',
      ),
    },
    async ({ slug, new_slug, new_domain, leave_pointer, slugs, from_domain_prefix, to_domain_prefix }) => {
      const result = await knowledgeMove(contextDir, {
        slug, new_slug, new_domain, leave_pointer, slugs, from_domain_prefix, to_domain_prefix,
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_merge',
    'Consolidate 2+ knowledge pages into one canonical page. ' +
    'Re-parents all citations from source pages to the target, deduplicating by (claim, source_kind, source_locator, excerpt). ' +
    'Takes MAX(verified_at) across all pages. ' +
    'Losers are superseded: archived with a tombstone and a supersessions pointer to the target. ' +
    'Loser bodies are returned in the result for curator review; set append_loser_bodies=true to concatenate them. ' +
    'Use knowledge_write first if the target body needs updating before merging. ' +
    'Distinct from knowledge_supersede (1:1 pointer, no citation consolidation) — ' +
    'use merge when consolidating data from multiple pages into one.',
    {
      source_slugs: z.array(z.string()).describe(
        'Slugs of the pages to merge into the target (all must exist)',
      ),
      target_slug: z.string().describe(
        'Slug of the canonical target page that survives the merge (must already exist)',
      ),
      note: z.string().optional().describe(
        'Optional note about this merge, stored in supersession tombstones on the losers',
      ),
      hard_delete_losers: z.boolean().optional().describe(
        'Hard-delete losers after archiving them. Losers are archived (supersession pointer written) then DELETEd from the database, cascading their citations.',
      ),
      append_loser_bodies: z.boolean().optional().describe(
        'Append loser page bodies to the target body under section markers (default false). Off by default — curator normally hand-merges body content.',
      ),
    },
    async ({ source_slugs, target_slug, note, hard_delete_losers, append_loser_bodies }) => {
      const result = await knowledgeMerge(contextDir, {
        source_slugs, target_slug, note, hard_delete_losers, append_loser_bodies,
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_purge',
    'Hard-delete one or more archived knowledge pages and cascade their citations. ' +
    'Archive-first guard: rejects any page that is not already archived — call knowledge_archive first. ' +
    'All slugs must be archived; a mixed list (any active) rejects the entire batch with no mutation. ' +
    'confirm: true is required explicitly to prevent accidental irreversible deletes. ' +
    'Supersession pointers in the supersessions table are NOT removed (historical record preserved). ' +
    'Use this to clean up tombstoned cruft after merge/supersede workflows — not for retiring active pages.',
    {
      slugs: z.array(z.string()).describe(
        'Slugs of archived pages to hard-delete. All must have status=archived.',
      ),
      confirm: z.literal(true).describe(
        'Must be explicitly true — required safety gate for an irreversible operation.',
      ),
    },
    async ({ slugs, confirm }) => {
      const result = await knowledgePurge(contextDir, { slugs, confirm });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_verify',
    'Stamp a knowledge page as verified WITHOUT touching its body — sets verified_at ' +
    'and optionally freshness_anchor. This is the verification engine\'s primitive: ' +
    'use it (never knowledge_write) to record "claims still hold". An optional note ' +
    'appends a dated "## Verification" section to the body (append-only, single-page ' +
    'mode). Batch mode (slugs) stamps many pages with a shared timestamp; archived ' +
    'pages are rejected; a batch with any unknown slug is rejected whole.',
    {
      slug: z.string().optional().describe(
        'Single-page mode: slug of the page to verify.',
      ),
      slugs: z.array(z.string()).optional().describe(
        'Batch mode: stamp many pages at once. Mutually exclusive with slug; ' +
        'note and freshness_anchor are not allowed in batch mode.',
      ),
      verified_at: z.string().optional().describe(
        'ISO timestamp to stamp. Defaults to now.',
      ),
      freshness_anchor: z.string().optional().describe(
        'New freshness anchor (e.g. "Syntakt OS 1.41"). Preserved when omitted. Single-page mode only.',
      ),
      note: z.string().optional().describe(
        'Optional verification note — appended to the body as a "## Verification — <date>" ' +
        'section. Never replaces the body. Single-page mode only.',
      ),
    },
    async ({ slug, slugs, verified_at, freshness_anchor, note }) => {
      const result = await knowledgeVerify(contextDir, { slug, slugs, verified_at, freshness_anchor, note });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'knowledge_history',
    'Body-revision history for a knowledge page. Replace-writes snapshot the displaced ' +
    'body into page_revisions (newest kept, capped per page) — this tool is the recovery ' +
    'surface. Three modes: slug alone lists snapshots (metadata only); slug + revision_id ' +
    'reads one snapshot\'s full body; adding restore: true puts that body back on the page ' +
    '(the displaced body is snapshotted first, so restore is never destructive).',
    {
      slug: z.string().describe('Slug of the knowledge page.'),
      revision_id: z.number().int().positive().optional().describe(
        'Revision to read (from the listing). Combine with restore: true to put it back.',
      ),
      restore: z.boolean().optional().describe(
        'Restore the revision\'s body onto the page. Requires revision_id.',
      ),
    },
    async ({ slug, revision_id, restore }) => {
      const result = await knowledgeHistory(contextDir, { slug, revision_id, restore });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );
}
