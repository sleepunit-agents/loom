/**
 * Loom — MCP Server Factory
 *
 * Creates a McpServer with the core identity and memory tools registered.
 * This is the portable identity layer — no routing, no orchestration,
 * no chat clients. Just the tools that carry a persistent persona across
 * any MCP-compatible runtime.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { assertStackVersionCompatible, assertContextBootable, resolveRepoRoot, resolveIdentityName } from './config.js';
import { MEMORY_CATEGORIES } from './categories.js';
import { loadIdentity, resolveClientFromPeer } from './tools/identity.js';
import { loadDossier } from './tools/dossier.js';
import { remember } from './tools/remember.js';
import { recall } from './tools/recall.js';
import { update } from './tools/update.js';
import { forget } from './tools/forget.js';
import { prune } from './tools/prune.js';
import { memoryList } from './tools/memory-list.js';
import { tapeForContext } from './backends/episodes.js';
import { findSimilar } from './tools/find-similar.js';
import { memoryAudit } from './tools/memory-audit.js';
import { recomputeSalienceForContext } from './backends/salience.js';
import { archive } from './tools/archive.js';
import { restore } from './tools/restore.js';
import { memoryMerge } from './tools/memory-merge.js';
import {
  propose,
  listProposals,
  ratifyProposal,
  rejectProposal,
  UnknownProposalError,
} from './backends/proposals.js';
import { updateIdentity } from './tools/update-identity.js';
import { bootstrap } from './tools/bootstrap.js';
import { harnessInit, harnessDescribe } from './tools/harness.js';
import { resolvePeerToHarness, normalizePeer } from './blocks/harness.js';
import { registerHelloApp } from './transport/mcp-app-hello.js';
import { registerKnowledgeTools } from './transport/knowledge-tools.js';
import { memoryHistory } from './tools/memory-history.js';
import { memoryRevisionRestore } from './tools/memory-revision-restore.js';
import { LIFESPANS, NoteError, Notes, type Lifespan } from './notes.js';
import {
  personWrite,
  personVerify,
  personArchive,
  personRestore,
  person,
  personList,
  personHistory,
  personRevisionRestore,
  personEvidence,
} from './tools/person.js';
import { knowledgeFreshness } from './tools/knowledge-list.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface LoomServerConfig {
  contextDir: string;
  /**
   * Optional path to the knowledge-gaps directory (e.g. `~/Art/.knowledge-gaps`).
   * When set, zero-result knowledge_recall calls append a miss entry to
   * `${gapsDir}/recall-miss.jsonl`, feeding the expansion engine's second
   * signal channel. Set via LOOM_GAPS_DIR env var in production.
   */
  gapsDir?: string;
  /**
   * Served over the network (the HTTP daemon), not as a local stdio server.
   * Tools that would touch the server's own filesystem outside the stack
   * (harness_init's `target`) refuse then: the path would name a file on the
   * daemon's machine, not the caller's.
   */
  remote?: boolean;
  /**
   * Agent to agent (t-1597): the household HTTP server passes a relay that
   * runs the clock piece's `relay` as this session's own agent (so it reaches
   * no further than that agent's `wake relay`). Without one there is no
   * relay tool.
   */
  relay?: (argv: string[]) => Promise<{ ok: boolean; text: string }>;
}

export interface LoomServerInstance {
  server: McpServer;
}

// ─── Server Factory ───────────────────────────────────────────────────────────

export function createLoomServer(config: LoomServerConfig): LoomServerInstance {
  const { contextDir, gapsDir, remote = false } = config;

  // Refuse to boot against a stack this loom build doesn't understand.
  assertStackVersionCompatible(contextDir);

  // Refuse to serve a blank identity from the default fallback path.
  assertContextBootable(contextDir);

  const pkg = JSON.parse(readFileSync(join(resolveRepoRoot(), 'package.json'), 'utf-8')) as { version: string };
  const server = new McpServer({
    name: 'loom',
    version: pkg.version,
  });

  // ─── Identity ───────────────────────────────────────────────────────────────

  server.registerTool(
    'identity',
    {
      description:
      'Load the persistent identity for this agent. Returns the terminal creed ' +
      '(who you are), relevant memories, preferences, and self-model. ' +
      'IMPORTANT: Call this tool FIRST before doing any other work. ' +
      'The identity defines who you are and how you should behave.',
      inputSchema:
      {
        project: z.string().optional().describe('Project context to load (loads project-specific memories)'),
        client: z.string().optional().describe(
          'Runtime client name for tool-prefix context: "claude-code", "gemini-cli", or a custom name with a matching <contextDir>/clients/<name>.md override. ' +
          'Overrides the LOOM_CLIENT environment variable.',
        ),
        model: z.string().optional().describe(
          'Model identifier for model-manifest context (e.g. "claude-opus", "gemma4"). ' +
          'Overrides the LOOM_MODEL environment variable.',
        ),
        role: z.string().optional().describe(
          'Reflection mode to append as an addendum from roles/<role>.md. When Art is ' +
          'dispatched into a mode ("wonder", "tend", "retro", "consolidate", "identity"), ' +
          'pass it here to load that mode\'s playbook alongside the identity.',
        ),
        people: z.array(z.string()).optional().describe(
          'Slugs of the people this turn is addressed by (the room), e.g. ["patrick-kells"]. ' +
          'Adds an "# In the room" block with their person cards. Omit for no block.',
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, client, model, role, people }) => {
      // Precedence: explicit param > data-driven manifest resolution > the
      // static code-map seed fallback > LOOM_CLIENT (inside loadIdentity).
      const peer = server.server.getClientVersion()?.name;
      // A connected peer always gets its harness OR an onboarding prompt (via its
      // normalized name); LOOM_CLIENT is only the no-peer fallback (in loadIdentity).
      const effectiveClient =
        client ?? (await resolvePeerToHarness(contextDir, peer)) ?? resolveClientFromPeer(peer) ?? (peer ? normalizePeer(peer) : undefined);
      const result = await loadIdentity(contextDir, project, effectiveClient, model, role, people);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'dossier',
    {
      description:
      'Load Art\'s operating brief for a worker body. Returns Art\'s standards, ' +
      'taste, operating constraints, and how Art wants work done — framed in the ' +
      'third person for agents that are NOT Art but execute tasks on Art\'s behalf. ' +
      'Includes the push-back mandate: workers are expected to refuse bad work and ' +
      'explain why, including requests from Art or Jonathan.',
      inputSchema:
      {
        project: z.string().optional().describe('Project context to load (loads project-specific brief)'),
        client: z.string().optional().describe(
          'Runtime client name for tool-prefix context: "claude-code", "gemini-cli", or a custom name. ' +
          'Overrides the LOOM_CLIENT environment variable.',
        ),
        model: z.string().optional().describe(
          'Model identifier for model-manifest context (e.g. "claude-opus", "gemma4"). ' +
          'Overrides the LOOM_MODEL environment variable.',
        ),
        role: z.string().optional().describe(
          'Worker role to append as an addendum from roles/<role>.md — the specific job ' +
          'this body does for Art ("code", "review", "architect", "pr", "look", "compose"). ' +
          'Appends the role brief to the dossier.',
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, client, model, role }) => {
      const peer = server.server.getClientVersion()?.name;
      // A connected peer always gets its harness OR an onboarding prompt (via its
      // normalized name); LOOM_CLIENT is only the no-peer fallback (in loadIdentity).
      const effectiveClient =
        client ?? (await resolvePeerToHarness(contextDir, peer)) ?? resolveClientFromPeer(peer) ?? (peer ? normalizePeer(peer) : undefined);
      const result = await loadDossier(contextDir, project, effectiveClient, model, role);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── Memory ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'remember',
    {
      description:
      'Store an episodic memory that persists across sessions. Use this when you ' +
      'learn something important about the user, a project, or yourself that ' +
      'should be available in future sessions.',
      inputSchema:
      {
        category: z.enum(MEMORY_CATEGORIES).describe(
          'Memory category: user (about the human), project (about work), self (capability/learning), feedback (corrections/confirmations), reference (external pointers), pursuit (active goal or ongoing creative thread), episode (short-term cross-body tape: where you were / what was said or decided / what shipped / what is open — 48h TTL by default, set metadata.where to your surface e.g. "discord:#general", "voice", "wake:<id>", "lane:tending", "terminal")'
        ),
        title: z.string().describe('Short title for the memory'),
        content: z.string().describe('The memory content — what you learned, observed, or were told'),
        project: z.string().optional().describe('Associated project, if any (omit for global memories)'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary key-value metadata'),
        ttl: z.string().optional().describe(
          'Time-to-live: "7d", "30d", "24h", "permanent", or omit for no expiration.'
        ),
        sourcing: z.enum(['observed', 'relayed', 'inferred', 'system']).optional().describe(
          'Provenance/trust tier — how this memory was produced. ' +
          '"observed": directly witnessed (measured, tested, read from source). ' +
          '"relayed": learned from another person/body (conversation, letter, episode). ' +
          '"inferred": AI-generated reasoning/synthesis — treat with skepticism, not ground truth. ' +
          '"system": auto-written by the harness (episode fallback, lane output). ' +
          'Shown in recall results and the boot digest so readers calibrate confidence.'
        ),
        provenance: z.string().optional().describe(
          'Free-form origin: surface, body, session, or person. ' +
          'E.g. "wake:w-74fccc 2026-09-07", "Jonathan, Discord #loom", "lane:letters". ' +
          'For episodes, prefer metadata.where (already conventional); provenance carries detail.'
        ),
        scope: z.enum(['project', 'global']).optional().describe(
          'Override this memory\'s recall visibility. Omit to take the category default: ' +
          '"user" and "reference" default global, everything else defaults to project-scoped ' +
          'when a project is set (global when it isn\'t — nothing to scope against). Set this ' +
          'explicitly to "global" for a fact learned in one project that actually applies ' +
          'everywhere — a security, git, or tool-workflow practice, not a language/framework/' +
          'file-layout/code-style/error-handling convention (those stay project-scoped).'
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ category, title, content, project, metadata, ttl, sourcing, provenance, scope }) => {
      const ref = await remember(contextDir, { category, title, content, project, metadata, ttl, sourcing, provenance, scope });
      return { content: [{ type: 'text' as const, text: `Memory stored: "${ref.title}" → ${ref.ref}` }] };
    },
  );

  server.registerTool(
    'recall',
    {
      description:
      'Retrieve memories relevant to a query or topic. Returns matching memories ' +
      'from the persistent store. Use this when you need context from past sessions. ' +
      'Results are re-ranked for diversity (MMR, λ=0.7 by default) so near-duplicate ' +
      'memories on a well-covered topic don\'t crowd out different ones; the top ' +
      'result is always the most relevant. Pass diversity: 0 for pure relevance order.',
      inputSchema:
      {
        query: z.string().describe('What to search for — topic, keyword, or question'),
        category: z.string().optional().describe('Filter to a specific memory category, or omit for all'),
        project: z.string().optional().describe(
          'Scope to a specific project — pass the project you are currently working in. ' +
          'Enforces scope discipline (t-337): memories tagged to a different project are ' +
          'excluded unless their effective scope is global (user/reference by default, or ' +
          'anything written with scope: "global"). Omit to search without project scoping.'
        ),
        limit: z.number().int().positive().optional().describe('Maximum results to return (default: 10)'),
        diversity: z.number().min(0).max(1).optional().describe(
          'MMR diversity 0..1 (default 0.3 = 1−λ). 0 reproduces the plain relevance ranking; ' +
          'higher trades relevance for coverage of distinct memories.'
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ query, category, project, limit, diversity }) => {
      const result = await recall(contextDir, { query, category, project, limit, diversity });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'update',
    {
      description:
      'Update an existing memory. Find by ref (returned from remember) or by ' +
      'category+title. Can replace content, update metadata, or both.',
      inputSchema:
      {
        ref: z.string().optional().describe('Memory reference (category/filename) from remember'),
        category: z.string().optional().describe('Category to search in (used with title)'),
        title: z.string().optional().describe('Title of the memory to update (used with category)'),
        content: z.string().optional().describe('New content (replaces existing body)'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata fields to add or update'),
        observation: z.enum(['confirm', 'contradict']).optional().describe(
          'Feedback memories only: record a confirming or contradicting observation. ' +
          '"confirm" raises confidence (+0.05, capped at 0.9), "contradict" lowers it ' +
          '(-0.1, floored at 0.3); either way the evidence count goes up. Ignored on ' +
          'non-feedback memories. Confidence decays toward neutral the longer it goes ' +
          'unconfirmed — see the feedback category description on remember.'
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ ref, category, title, content, metadata, observation }) => {
      const result = await update(contextDir, { ref, category, title, content, metadata, observation });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'forget',
    {
      description:
      'Remove memories. Single deletion by ref or category+title. ' +
      'Bulk deletion by category and/or project scope — requires confirm: true; ' +
      'without it, returns a dry-run preview of what would be deleted.',
      inputSchema:
      {
        ref: z.string().optional().describe('Memory reference for single deletion'),
        category: z.string().optional().describe('Category (with title for single, alone for bulk)'),
        title: z.string().optional().describe('Title of specific memory to forget'),
        project: z.string().optional().describe('Delete all memories for this project (bulk)'),
        title_pattern: z.string().optional().describe('Glob pattern for bulk title matching. Requires category or project as scope guard.'),
        confirm: z.boolean().optional().describe(
          'Safety gate for scope deletions (category alone, project alone, or title_pattern). ' +
          'Must be true to actually delete; omit for a free dry-run preview. ' +
          'Single-target deletions (ref, or category+title) never need it.',
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ref, category, title, project, title_pattern, confirm }) => {
      const result = await forget(contextDir, { ref, category, title, project, title_pattern, confirm });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'memory_prune',
    {
      description:
      'Remove expired memories (TTL elapsed). Use dry_run to preview without deleting.',
      inputSchema:
      {
        dry_run: z.boolean().optional().describe('Preview only — show what would be pruned without deleting (default: false)'),
        stale_days: z.number().int().positive().optional().describe('Days since last access to consider a memory stale (default: 30)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ dry_run, stale_days }) => {
      const result = await prune(contextDir, { dryRun: dry_run, staleDays: stale_days });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'memory_list',
    {
      description:
      'Browse memories without semantic search. Lists memories with optional ' +
      'category/project filters. Useful for auditing, maintenance, and discovery.',
      inputSchema:
      {
        category: z.string().optional().describe('Filter to a specific category'),
        project: z.string().optional().describe('Filter to a specific project'),
        limit: z.number().int().positive().optional().describe('Maximum results (default: 50)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ category, project, limit }) => {
      const result = await memoryList(contextDir, { category, project, limit });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'episodes',
    {
      description:
      'The episode tape: what happened across ALL bodies of this identity in the ' +
      'last N hours, time-ordered (oldest first), never ranked. The same block ' +
      'identity injects at boot — call it mid-session to catch up on what other ' +
      'sleeves did since you loaded, or for the nightly pass to index the day.',
      inputSchema:
      {
        hours: z.number().positive().optional().describe('Look-back window in hours (default 24)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hours }) => {
      const tape = tapeForContext(contextDir, { hours, tokenBudget: 6000 });
      return { content: [{ type: 'text' as const, text: tape ?? `No episodes in the last ${hours ?? 24}h.` }] };
    },
  );

  server.registerTool(
    'find_similar',
    {
      description:
      'Surface memories semantically near an existing ref or free-form text. ' +
      'Use during consolidation/dream workflows to find overlap and dedupe ' +
      'candidates. Anchor with `ref` (an existing memory) or `text` (a fresh ' +
      'query). Self is always excluded when `ref` is given.',
      inputSchema:
      {
        ref: z.string().optional().describe('Anchor on an existing memory ref (excludes self from results)'),
        text: z.string().optional().describe('Or anchor on fresh text — embedded on the fly'),
        limit: z.number().int().positive().optional().describe('Max neighbours to return (default 10)'),
        category: z.string().optional().describe('Restrict candidates to a category'),
        project: z.string().optional().describe('Restrict candidates to a project'),
        min_relevance: z.number().min(0).max(1).optional().describe('Drop matches below this cosine similarity (0..1)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ref, text, limit, category, project, min_relevance }) => {
      const result = await findSimilar(contextDir, {
        ref, text, limit, category, project, minRelevance: min_relevance,
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'memory_audit',
    {
      description:
      'One-shot health report for the memory store: totals, category breakdown, ' +
      'stale memories (untouched beyond threshold), near-duplicate pairs (above ' +
      'similarity threshold), and expired refs. Read-only — pair with `forget`/' +
      '`update` to act on findings.',
      inputSchema:
      {
        stale_days: z.number().int().positive().optional().describe('Stale threshold in days (default 30)'),
        similarity_threshold: z.number().min(0).max(1).optional().describe('Cosine floor for duplicate pairs, 0..1 (default 0.85)'),
        max_duplicates: z.number().int().positive().optional().describe('Cap on duplicate pairs returned (default 20)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ stale_days, similarity_threshold, max_duplicates }) => {
      const result = await memoryAudit(contextDir, {
        staleDays: stale_days,
        similarityThreshold: similarity_threshold,
        maxDuplicates: max_duplicates,
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'memory_recompute_salience',
    {
      description:
      'Refresh every memory\'s stored salience from its timestamps (the consolidation ' +
      'lane\'s step after memory_audit). Derived and idempotent: no content changes, ' +
      'and running it twice gives the same result.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const n = recomputeSalienceForContext(contextDir, Date.now());
      return { content: [{ type: 'text' as const, text: `recomputed salience for ${n ?? 0} memories` }] };
    },
  );

  if (config.relay) {
    const relay = config.relay;
    server.registerTool(
      'relay',
      {
        description:
        'Ask another agent in this household something: it wakes a body of theirs in their house ' +
        'with your words, framed as a peer\'s request (none of the owner\'s authority). Their answer ' +
        'comes back the same way, as a wake of yours. Only between agents the household pairs; the ' +
        'same words twice within the hour are refused. Answer a relay with reply_to set to its id.',
        inputSchema: {
          to: z.string().describe('The other agent, e.g. "mark"'),
          say: z.string().describe('What to tell or ask them (2500 characters at most; point at a PR or file for more)'),
          why: z.string().optional().describe('One line: why you are asking'),
          reply_to: z.string().optional().describe('The relay id (r-…) this answers'),
          from: z.string().optional().describe('Where it was asked, e.g. "discord:#workshop", so the answer can go back there'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ to, say, why, reply_to, from }) => {
        const argv = ['relay', '--to', to, '--say', say,
          ...(why ? ['--why', why] : []), ...(reply_to ? ['--reply-to', reply_to] : []), ...(from ? ['--from', from] : [])];
        const r = await relay(argv);
        return { content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
      },
    );
  }

  server.registerTool(
    'memory_archive',
    {
      description:
      'Soft-retire a memory: move it to the archive tier with a tombstone instead of ' +
      'deleting it. Archived memories are excluded from recall, list, audit, and ' +
      'find_similar but remain fully recoverable via memory_restore. Use this instead ' +
      'of forget when the memory may need to be recovered or audited later.',
      inputSchema:
      {
        ref: z.string().optional().describe('Memory reference for single archive'),
        category: z.string().optional().describe('Category (used with title)'),
        title: z.string().optional().describe('Title of specific memory to archive'),
        note: z.string().optional().describe('Tombstone note: why this memory is being retired'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ref, category, title, note }) => {
      const result = await archive(contextDir, { ref, category, title, note });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'memory_restore',
    {
      description:
      'Restore a previously archived memory to the active set. Clears the archive ' +
      'flag and tombstone note. The memory becomes visible to recall, list, audit, ' +
      'and find_similar again.',
      inputSchema:
      {
        ref: z.string().optional().describe('Memory reference to restore'),
        category: z.string().optional().describe('Category (used with title)'),
        title: z.string().optional().describe('Title of the archived memory to restore'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ref, category, title }) => {
      const result = await restore(contextDir, { ref, category, title });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'memory_merge',
    {
      description:
      'Consolidate 2+ memories into one canonical row. Acts on a memory_audit duplicate ' +
      'finding: pick the survivor (target_ref) and fold the rest (source_refs) into it. ' +
      'Sources are archived with a tombstone and a supersession pointer to the target ' +
      '(same mechanism as memory_archive/supersede, N:1 instead of 1:1); the target\'s ' +
      'times_seen sums in each source\'s count. Unlike forget/archive on a duplicate pair, ' +
      'this consolidates both sides into one row instead of just discarding one.',
      inputSchema:
      {
        source_refs: z.array(z.string()).describe(
          'Refs of the losing memories to fold into the target (all must be active)',
        ),
        target_ref: z.string().describe(
          'Ref of the canonical memory that survives the merge (must already exist, active)',
        ),
        note: z.string().optional().describe(
          'Optional note about this merge, stored in supersession tombstones on the losers',
        ),
        hard_delete_losers: z.boolean().optional().describe(
          'Hard-delete losers after archiving/superseding them (default false).',
        ),
        append_loser_bodies: z.boolean().optional().describe(
          'Append loser bodies to the target content under section markers (default false). ' +
          'Off by default — review loser bodies (returned in the result) before deciding.',
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ source_refs, target_ref, note, hard_delete_losers, append_loser_bodies }) => {
      const result = await memoryMerge(contextDir, {
        source_refs, target_ref, note, hard_delete_losers, append_loser_bodies,
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── Capture-propose queue ────────────────────────────────────────────────────
  // The staging area a background lane drafts memory writes into. A proposal is
  // NOT authored canon: it lives in a separate table, invisible to recall /
  // memory_list / the salience digest / find_similar, and becomes a real memory
  // only via an explicit memory_ratify. Never auto-committed.

  server.registerTool(
    'memory_propose',
    {
      description:
      'Stage a DRAFT memory in the capture-propose queue for later ratification. ' +
      'A proposal is NOT an authored memory: it is invisible to recall, memory_list, ' +
      'find_similar, and the boot digest until it is ratified via memory_ratify. ' +
      'Use this when a background lane wants to suggest a write without committing it — ' +
      'the human (or Art) reviews and ratifies before it becomes canon. Drafts may be ' +
      'rough; validation runs at ratify time.',
      inputSchema:
      {
        category: z.enum(MEMORY_CATEGORIES).describe(
          'Memory category: user (about the human), project (about work), self (capability/learning), feedback (corrections/confirmations), reference (external pointers), pursuit (active goal or ongoing creative thread), episode (short-term cross-body tape: where you were / what was said or decided / what shipped / what is open — 48h TTL by default, set metadata.where to your surface e.g. "discord:#general", "voice", "wake:<id>", "lane:tending", "terminal")'
        ),
        title: z.string().describe('Short title for the proposed memory'),
        content: z.string().describe('The proposed memory content'),
        project: z.string().optional().describe('Associated project, if any'),
        ttl: z.string().optional().describe('Time-to-live: "7d", "30d", "24h", "permanent", or omit'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary key-value metadata'),
        source: z.string().optional().describe('Where this proposal came from, e.g. a lane name'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ category, title, content, project, ttl, metadata, source }) => {
      const { id, uuid } = propose(contextDir, { category, title, content, project, ttl, metadata, source });
      return { content: [{ type: 'text' as const, text: `Proposal staged: #${id} "${title}" (${uuid}) — pending ratification` }] };
    },
  );

  server.registerTool(
    'memory_proposals',
    {
      description:
      'List all pending proposals in the capture-propose queue, newest first. ' +
      'These are DRAFTS awaiting ratification — they are not part of memory and ' +
      'do not appear in recall, memory_list, find_similar, or the boot digest. ' +
      'Ratify one with memory_ratify or discard it with memory_reject.',
      inputSchema:
      {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rows = listProposals(contextDir);
      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No pending proposals.' }] };
      }
      const lines = rows.map((r) => {
        const src = r.source ? ` [${r.source}]` : '';
        const body = (r.content ?? '').replace(/\s+/g, ' ').trim();
        const clipped = body.length > 120 ? body.slice(0, 117).trimEnd() + '…' : body;
        return `#${r.id} (${r.category ?? '?'})${src} ${r.title ?? '(untitled)'} — ${clipped}`;
      });
      return { content: [{ type: 'text' as const, text: `${rows.length} pending proposal(s):\n${lines.join('\n')}` }] };
    },
  );

  server.registerTool(
    'memory_ratify',
    {
      description:
      'Ratify a pending proposal into a REAL memory. Loads the proposal, applies any ' +
      'optional overrides (your edits on accept), and commits it through the same ' +
      'validated write path as remember — so an invalid proposal is refused with its ' +
      'typed reason and stays pending. On success the memory becomes recallable and the ' +
      'proposal is removed from the queue. This is the gate: no proposal becomes canon ' +
      'without it.',
      inputSchema:
      {
        id: z.number().int().positive().describe('Proposal id (from memory_proposals)'),
        title: z.string().optional().describe('Override the proposed title on accept'),
        content: z.string().optional().describe('Override the proposed content on accept'),
        category: z.enum(MEMORY_CATEGORIES).optional().describe('Override the proposed category on accept'),
        project: z.string().optional().describe('Override the proposed project on accept'),
        ttl: z.string().optional().describe('Override the proposed TTL on accept'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, title, content, category, project, ttl }) => {
      try {
        const ref = await ratifyProposal(contextDir, id, { title, content, category, project, ttl });
        return { content: [{ type: 'text' as const, text: `Proposal #${id} ratified → ${ref.ref}` }] };
      } catch (err) {
        if (err instanceof UnknownProposalError) {
          return { content: [{ type: 'text' as const, text: `Proposal #${id} not found.` }] };
        }
        const reason = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Proposal #${id} refused — ${reason}. It remains pending.` }] };
      }
    },
  );

  server.registerTool(
    'memory_reject',
    {
      description:
      'Discard a pending proposal without committing it. Deletes the staging row; ' +
      'no memory is written. Use this for drafts that should not become canon.',
      inputSchema:
      {
        id: z.number().int().positive().describe('Proposal id (from memory_proposals)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const removed = rejectProposal(contextDir, id);
      return {
        content: [{
          type: 'text' as const,
          text: removed ? `Proposal #${id} rejected and removed.` : `Proposal #${id} not found.`,
        }],
      };
    },
  );

  // ─── Identity Update ────────────────────────────────────────────────────────

  server.registerTool(
    'update_identity',
    {
      description:
      'Update your self-model or preferences with section-level precision. ' +
      'Targets H2 sections in identity files. Call without section/content to ' +
      'list available sections. IDENTITY.md (the creed) is immutable — only ' +
      'self-model and preferences can be edited.',
      inputSchema:
      {
        file: z.enum(['self-model', 'preferences']).describe(
          'Which identity file to update: "self-model" or "preferences"'
        ),
        section: z.string().optional().describe(
          'H2 section name to target. Omit to list all sections.'
        ),
        content: z.string().optional().describe(
          'New content for the section (replaces everything under the H2 header)'
        ),
        mode: z.enum(['replace', 'append']).optional().describe(
          '"replace" updates an existing section (default), "append" adds a new section'
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ file, section, content, mode }) => {
      const result = await updateIdentity(contextDir, { file, section, content, mode });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── Bootstrap ──────────────────────────────────────────────────────────────

  server.registerTool(
    'bootstrap',
    {
      description:
      'Initialize a new loom identity from scratch. Generates IDENTITY.md, preferences.md, ' +
      'and self-model.md from an onboarding interview, then returns setup instructions for ' +
      'the requested runtimes. The interview is four questions — the user\'s name, the ' +
      "agent's name, a one-line purpose, a one-line voice; everything structural (continuity " +
      'model, memory tiers, reflection, honesty) is written by the scaffold, so do not ask ' +
      'for it. Will not overwrite existing files unless force is true.',
      inputSchema:
      {
        user: z.string().optional().describe("The human this agent works with — their name, not the agent's"),
        name: z.string().describe('Name for the agent identity (e.g. "Aria")'),
        purpose: z.string().describe('What this agent exists to do — its reason for being, one line'),
        voice: z.string().describe('Communication style and personality, one line'),
        preferences: z.string().optional().describe('Seed preferences about the user or working style'),
        clients: z.array(z.string()).optional().describe(
          'Runtimes to generate setup instructions for: "claude-code", "gemini-cli", or any custom runtime name (uses a generic template)'
        ),
        force: z.boolean().optional().describe('Overwrite existing identity files (default: false)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ user, name, purpose, voice, preferences, clients, force }) => {
      const result = await bootstrap(contextDir, { user, name, purpose, voice, preferences, clients, force });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── Harness manifests ──────────────────────────────────────────────────────

  server.registerTool(
    'harness_init',
    {
      description:
      'Scaffold a harness manifest at <contextDir>/harnesses/<name>.md from the template ' +
      '(see stack spec v1 §4.7). Call this when identity() reports a missing manifest for the ' +
      'current harness. Idempotent: skip-exists by default; overwrite: true replaces.\n\n' +
      'When `target` is supplied, also writes a loom-managed block (bounded by ' +
      '<!-- loom:start / loom:end --> markers with an embedded <!-- loom:hash --> line) ' +
      'into that file — typically the project CLAUDE.md. Re-runnable: the block is ' +
      'left unchanged when already present and intact ("no-change"), reinstalled when ' +
      'missing or corrupted ("created" / "updated"). Pass an absolute path or a path ' +
      'relative to the current working directory.',
      inputSchema:
      {
        name: z.string().describe('Harness name (e.g. "claude-code", "codex", "gemini-cli")'),
        overwrite: z.boolean().optional().describe('Replace existing manifest (default: false)'),
        target: z.string().optional().describe(
          'Path to the dotfile to inject the managed loom block into (e.g. an absolute path ' +
          'to CLAUDE.md / AGENTS.md / GEMINI.md). When omitted only the harness manifest ' +
          'is scaffolded.',
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, overwrite, target }) => {
      const text = await harnessInit(contextDir, { name, overwrite, target }, { remote });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.registerTool(
    'harness_describe',
    {
      description:
      'Self-describe the CURRENTLY CONNECTED harness: write its manifest at ' +
      '<contextDir>/harnesses/<key>.md (see stack spec v1 §4.7). Call this when ' +
      'identity() reports an onboarding block for an unknown runtime. The target is ' +
      'derived from your own MCP clientInfo.name — you can only describe yourself, ' +
      'not another harness. Re-runnable: overwrites the manifest each time. The body ' +
      'should cover: tool surface / prefixes, sandbox & filesystem, delegation ' +
      'primitive, scheduling, session search, memory layers, and gotchas.',
      inputSchema:
      {
        content: z.string().describe('The manifest body (markdown). Frontmatter is stamped automatically.'),
        version: z.string().optional().describe('Manifest version stamp (default "0.1").'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ content, version }) => {
      const peer = server.server.getClientVersion()?.name;
      const text = await harnessDescribe(contextDir, { content, version }, peer);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // ─── Knowledge ──────────────────────────────────────────────────────────────
  // The local identity — LOOM_IDENTITY, else the context dir's real name —
  // since this server runs as whichever identity owns contextDir, not only
  // Art. The standalone knowledge-only service (knowledge-http-server.ts)
  // resolves identity per-connection from its per-identity bearer token instead.
  registerKnowledgeTools(server, { contextDir, gapsDir, identity: resolveIdentityName(contextDir), personCards: true });

  server.registerTool(
    'memory_history',
    {
      description:
      'Body-revision history for a memory. update() snapshots the displaced body into ' +
      'memory_revisions before overwriting it — this tool is the read surface. ' +
      'Two modes: ref alone lists snapshots (metadata only — id, op, replaced_at, char count); ' +
      'ref + revision_id reads one snapshot\'s full content. ' +
      'To put a snapshot back, use memory_revision_restore.',
      inputSchema:
      {
        ref: z.string().describe('Ref of the memory (category/title slug).'),
        revision_id: z.number().int().positive().optional().describe(
          'Revision to read (from the listing). Omit to list all revisions.',
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ref, revision_id }) => {
      const result = await memoryHistory(contextDir, { ref, revision_id });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'memory_revision_restore',
    {
      description:
      'Restore a snapshotted memory body back onto the memory. ' +
      'Snapshots the current body first, so restore is never destructive. ' +
      'Use memory_history to list revision IDs before calling this.',
      inputSchema:
      {
        ref: z.string().describe('Ref of the memory (category/title slug).'),
        revision_id: z.number().int().positive().describe(
          'Id of the revision to restore (from memory_history listing).',
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ ref, revision_id }) => {
      const result = await memoryRevisionRestore(contextDir, { ref, revision_id });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── People ─────────────────────────────────────────────────────────────────
  // Person cards (docs/specs/person-cards.md): the condensed current state of a
  // human the agent works with. Current state, overwritten; revisions keep the
  // past. Descriptive only — never an authorization surface. Schemas are
  // strict: a raw shape strips unknown keys, and a misspelled section on a
  // merge: false write would then silently clear state (PR143 review).

  const cardValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
  const slugParam = z.string().describe('Person slug: lowercase [a-z0-9-], e.g. "patrick-kells".');

  server.registerTool(
    'person_write',
    {
      description:
      'Write a person card — the condensed current state of what you know about one human ' +
      '(not a knowledge page, not the memories: those stay the evidence). merge (default true) ' +
      'merges where/how one level deep (a field passed as null is removed), and replaces name, ' +
      'summary and may when passed; merge: false makes the card exactly what was passed. ' +
      'Passing summary says "I re-read the evidence and this is still right" and moves ' +
      'synthesized_at. Reserved keys (tier, field, projects, scope, trust) are rejected: gates ' +
      'stay in the harness. Worker bodies must not call this — cards are written by Art.',
      inputSchema: z.object({
        slug: slugParam,
        name: z.string().optional().describe('Display name (required on create and on merge: false), ≤ 80 chars.'),
        summary: z.string().optional().describe('Short synthesized summary, ≤ 1,200 chars.'),
        where: z.record(
          z.string(),
          z.union([
            z.object({
              value: cardValue,
              verified_at: z.string().optional(),
              source: z.string().optional(),
              stale_after_days: z.number().int().optional(),
              label: z.string().optional().describe('What a person reads for the value, ≤ 200 chars: "@sleepunit" for a Discord id.'),
            }).passthrough(),
            z.null(),
          ]),
        ).optional().describe(
          'Where the person is in each system: field -> {value, verified_at?, source?, stale_after_days?, label?}. ' +
          'null removes a field (merge writes only).',
        ),
        how: z.record(z.string(), z.union([cardValue, z.null()])).optional().describe(
          'How to work with them: field -> value (e.g. tz, mode, loop_in). null removes a field.',
        ),
        may: z.array(z.object({ text: z.string(), source: z.string() }).passthrough()).optional().describe(
          'What they were said to be allowed to do, each with its source. Descriptive, not a grant. Replaces the whole list.',
        ),
        merge: z.boolean().optional().describe('Default true. false: the card becomes exactly what was passed.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const result = await personWrite(contextDir, input as Parameters<typeof personWrite>[1]);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'person_verify',
    {
      description:
      'Stamp where fields on a person card as checked: sets verified_at (default now) and, if ' +
      'passed, source. Values are not changed. All-or-nothing: an unknown field rejects the call. ' +
      'A failed check is recorded by not stamping.',
      inputSchema: z.object({
        slug: slugParam,
        fields: z.array(z.string()).describe('where field names to stamp.'),
        verified_at: z.string().optional().describe('ISO-8601 UTC; default now; not in the future.'),
        source: z.string().optional().describe('What you checked against, e.g. "pond /api/tadpoles".'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ slug, fields, verified_at, source }) => {
      const result = await personVerify(contextDir, { slug, fields, verified_at, source });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'person_archive',
    {
      description:
      'Soft-retire a person card with a tombstone (who, when, why). An archived card is left ' +
      'out of identity\'s room block and person_list, and rejects writes until person_restore.',
      inputSchema: z.object({
        slug: slugParam,
        reason: z.string().describe('Why the card is being retired, ≤ 200 chars.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ slug, reason }) => {
      const result = await personArchive(contextDir, { slug, reason });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'person_restore',
    {
      description: 'Reactivate an archived person card, fields intact.',
      inputSchema: z.object({ slug: slugParam }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await personRestore(contextDir, { slug });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'person',
    {
      description:
      'Read one person card: {found, rendered, card, archived, updated, synthesized_at}. ' +
      'A missing card is {found: false}, not an error. where fields carry a freshness marker: ' +
      '[ok], [unverified], or [STALE <n>d] — never trust a stale one without re-checking.',
      inputSchema: z.object({
        slug: slugParam,
        include_archived: z.boolean().optional().describe('Return an archived card in full (default false).'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, include_archived }) => {
      const result = await person(contextDir, { slug, include_archived });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'person_list',
    {
      description:
      'List person cards with slug, name, archived, updated, synthesized_at, stale and unverified ' +
      'field counts, and memories_since_synthesis (tagged user memories newer than the summary — ' +
      'how the consolidation lane finds summaries that have fallen behind).',
      inputSchema: z.object({
        include_archived: z.boolean().optional().describe('Include archived cards (default false).'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ include_archived }) => {
      const result = await personList(contextDir, { include_archived });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'person_evidence',
    {
      description:
      'The memories a person card condenses: active, unexpired user and feedback memories tagged ' +
      'to the person (metadata.person), oldest first, as JSON. What a summary is rewritten from.',
      inputSchema: z.object({
        slug: z.string().describe('The person\'s slug'),
        since: z.string().optional().describe('Only memories created after this ISO time'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, since }) => {
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        return { content: [{ type: 'text' as const, text: 'Error: since takes an ISO time' }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(personEvidence(contextDir, slug, since ?? null)) }] };
    },
  );

  server.registerTool(
    'knowledge_list',
    {
      description:
      'Every active knowledge page\'s freshness fields (slug, title, domain, created, verified_at, ' +
      'freshness_anchor, sla_class) as JSON, no bodies: what a verification sweep picks from. ' +
      'A listing, not a read: it doesn\'t count as an access.',
      inputSchema: z.object({
        domain: z.string().optional().describe('Only pages in this domain'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ domain }) => ({ content: [{ type: 'text' as const, text: JSON.stringify(await knowledgeFreshness(contextDir, domain)) }] }),
  );

  // ─── Notes (src/notes.ts): what the agent holds on to for a while ───────────

  const notePath = z.string().min(1).max(300).describe('The note\'s path: up to six segments, e.g. homelab/2026-10-30-dns-health');
  const withNotes = <T>(f: (n: Notes) => T): T => { const n = new Notes(contextDir); try { return f(n); } finally { n.close(); } };
  const noteText = (f: () => unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(f()) }] }; }
    catch (err) { if (err instanceof NoteError) return { content: [{ type: 'text' as const, text: err.message }], isError: true }; throw err; }
  };

  server.registerTool(
    'note_write',
    {
      description:
      'Write a note, whole: a plan, a brief, a write-up, a run\'s findings. Not memory (a lesson goes there) and not ' +
      'knowledge (facts about the world): something held on to for a while, with some words about it. A new note ' +
      'needs its lifespan: keep (a ruling, a write-up; never expires), while (a lane\'s journal; 60 days after its last ' +
      'change) or short (evidence, scratch worth a look; 14 days). An expired note goes unless a memory or knowledge ' +
      'page cites it (note:<path>) or it\'s pinned. Files attach with the CLI: loom note attach <path> <file>.',
      inputSchema: z.object({
        path: notePath,
        body: z.string().describe('Markdown, at most 1 MB'),
        lifespan: z.enum(['keep', 'while', 'short']).optional().describe('Required for a new note; an existing one keeps its own'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ path, body, lifespan }) => noteText(() => withNotes((n) => n.write(path, body, { by: 'mcp', ...(lifespan && LIFESPANS.has(lifespan) ? { lifespan: lifespan as Lifespan } : {}) }))),
  );

  server.registerTool(
    'note_read',
    {
      description: 'A note: its text, lifespan, when it expires (null for keep or pinned) and its files (names and sizes).',
      inputSchema: z.object({ path: notePath }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => noteText(() => withNotes((n) => n.read(path) ?? { error: `no note ${path}` })),
  );

  server.registerTool(
    'note_list',
    {
      description: 'The notes under a prefix (a folder like planning/), newest first: path, lifespan, expiry, file count. No text.',
      inputSchema: z.object({
        prefix: z.string().max(300).optional().describe('A folder or note path; omit for all'),
        limit: z.number().int().positive().max(500).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ prefix, limit }) => noteText(() => withNotes((n) => n.list({ ...(prefix ? { prefix } : {}), ...(limit ? { limit } : {}) }))),
  );

  server.registerTool(
    'person_history',
    {
      description:
      'Revision history of a person card, newest first: id, op, replaced_at. Every stored change ' +
      'snapshots the previous card; the newest 10 are kept. Use person_revision_restore to put one back.',
      inputSchema: z.object({ slug: slugParam }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await personHistory(contextDir, { slug });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'person_revision_restore',
    {
      description:
      'Put a person card back to a revision from person_history (card and its synthesized_at). ' +
      'Snapshots the current card first, so it is never destructive. Archive state is unchanged.',
      inputSchema: z.object({
        slug: slugParam,
        revision_id: z.number().int().positive().describe('Revision id from person_history.'),
        store: z.enum(['directory', 'relationship']).optional().describe(
          'In a household, which half the revision is from (person_history says): the shared directory ' +
          'entry, or this agent\'s relationship (the default). Ignored outside a household.',
        ),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ slug, revision_id, store }) => {
      const result = await personRevisionRestore(contextDir, { slug, revision_id, store });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // MCP-App render probe — env-gated, throwaway. Not part of the tool surface
  // contract; only registered when explicitly validating ui:// rendering.
  if (process.env.LOOM_MCP_APP_HELLO) {
    registerHelloApp(server, pkg.version, contextDir);
  }

  return { server };
}
