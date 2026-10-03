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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertStackVersionCompatible, assertContextBootable, resolveRepoRoot } from './config.js';
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
import { archive } from './tools/archive.js';
import { restore } from './tools/restore.js';
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
}

export interface LoomServerInstance {
  server: McpServer;
}

// ─── Server Factory ───────────────────────────────────────────────────────────

export function createLoomServer(config: LoomServerConfig): LoomServerInstance {
  const { contextDir, gapsDir } = config;

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

  server.tool(
    'identity',
    'Load the persistent identity for this agent. Returns the terminal creed ' +
    '(who you are), relevant memories, preferences, and self-model. ' +
    'IMPORTANT: Call this tool FIRST before doing any other work. ' +
    'The identity defines who you are and how you should behave.',
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
    },
    async ({ project, client, model, role }) => {
      // Precedence: explicit param > data-driven manifest resolution > the
      // static code-map seed fallback > LOOM_CLIENT (inside loadIdentity).
      const peer = server.server.getClientVersion()?.name;
      // A connected peer always gets its harness OR an onboarding prompt (via its
      // normalized name); LOOM_CLIENT is only the no-peer fallback (in loadIdentity).
      const effectiveClient =
        client ?? (await resolvePeerToHarness(contextDir, peer)) ?? resolveClientFromPeer(peer) ?? (peer ? normalizePeer(peer) : undefined);
      const result = await loadIdentity(contextDir, project, effectiveClient, model, role);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'dossier',
    'Load Art\'s operating brief for a worker body. Returns Art\'s standards, ' +
    'taste, operating constraints, and how Art wants work done — framed in the ' +
    'third person for agents that are NOT Art but execute tasks on Art\'s behalf. ' +
    'Includes the push-back mandate: workers are expected to refuse bad work and ' +
    'explain why, including requests from Art or Jonathan.',
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

  server.tool(
    'remember',
    'Store an episodic memory that persists across sessions. Use this when you ' +
    'learn something important about the user, a project, or yourself that ' +
    'should be available in future sessions.',
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
    },
    async ({ category, title, content, project, metadata, ttl, sourcing, provenance }) => {
      const ref = await remember(contextDir, { category, title, content, project, metadata, ttl, sourcing, provenance });
      return { content: [{ type: 'text' as const, text: `Memory stored: "${ref.title}" → ${ref.ref}` }] };
    },
  );

  server.tool(
    'recall',
    'Retrieve memories relevant to a query or topic. Returns matching memories ' +
    'from the persistent store. Use this when you need context from past sessions. ' +
    'Results are re-ranked for diversity (MMR, λ=0.7 by default) so near-duplicate ' +
    'memories on a well-covered topic don\'t crowd out different ones; the top ' +
    'result is always the most relevant. Pass diversity: 0 for pure relevance order.',
    {
      query: z.string().describe('What to search for — topic, keyword, or question'),
      category: z.string().optional().describe('Filter to a specific memory category, or omit for all'),
      project: z.string().optional().describe('Filter to a specific project'),
      limit: z.number().int().positive().optional().describe('Maximum results to return (default: 10)'),
      diversity: z.number().min(0).max(1).optional().describe(
        'MMR diversity 0..1 (default 0.3 = 1−λ). 0 reproduces the plain relevance ranking; ' +
        'higher trades relevance for coverage of distinct memories.'
      ),
    },
    async ({ query, category, project, limit, diversity }) => {
      const result = await recall(contextDir, { query, category, project, limit, diversity });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'update',
    'Update an existing memory. Find by ref (returned from remember) or by ' +
    'category+title. Can replace content, update metadata, or both.',
    {
      ref: z.string().optional().describe('Memory reference (category/filename) from remember'),
      category: z.string().optional().describe('Category to search in (used with title)'),
      title: z.string().optional().describe('Title of the memory to update (used with category)'),
      content: z.string().optional().describe('New content (replaces existing body)'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata fields to add or update'),
    },
    async ({ ref, category, title, content, metadata }) => {
      const result = await update(contextDir, { ref, category, title, content, metadata });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'forget',
    'Remove memories. Single deletion by ref or category+title. ' +
    'Bulk deletion by category and/or project scope — requires confirm: true; ' +
    'without it, returns a dry-run preview of what would be deleted.',
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
    async ({ ref, category, title, project, title_pattern, confirm }) => {
      const result = await forget(contextDir, { ref, category, title, project, title_pattern, confirm });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'memory_prune',
    'Remove expired memories (TTL elapsed). Use dry_run to preview without deleting.',
    {
      dry_run: z.boolean().optional().describe('Preview only — show what would be pruned without deleting (default: false)'),
      stale_days: z.number().int().positive().optional().describe('Days since last access to consider a memory stale (default: 30)'),
    },
    async ({ dry_run, stale_days }) => {
      const result = await prune(contextDir, { dryRun: dry_run, staleDays: stale_days });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'memory_list',
    'Browse memories without semantic search. Lists memories with optional ' +
    'category/project filters. Useful for auditing, maintenance, and discovery.',
    {
      category: z.string().optional().describe('Filter to a specific category'),
      project: z.string().optional().describe('Filter to a specific project'),
      limit: z.number().int().positive().optional().describe('Maximum results (default: 50)'),
    },
    async ({ category, project, limit }) => {
      const result = await memoryList(contextDir, { category, project, limit });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'episodes',
    'The episode tape: what happened across ALL bodies of this identity in the ' +
    'last N hours, time-ordered (oldest first), never ranked. The same block ' +
    'identity injects at boot — call it mid-session to catch up on what other ' +
    'sleeves did since you loaded, or for the nightly pass to index the day.',
    {
      hours: z.number().positive().optional().describe('Look-back window in hours (default 24)'),
    },
    async ({ hours }) => {
      const tape = tapeForContext(contextDir, { hours, tokenBudget: 6000 });
      return { content: [{ type: 'text' as const, text: tape ?? `No episodes in the last ${hours ?? 24}h.` }] };
    },
  );

  server.tool(
    'find_similar',
    'Surface memories semantically near an existing ref or free-form text. ' +
    'Use during consolidation/dream workflows to find overlap and dedupe ' +
    'candidates. Anchor with `ref` (an existing memory) or `text` (a fresh ' +
    'query). Self is always excluded when `ref` is given.',
    {
      ref: z.string().optional().describe('Anchor on an existing memory ref (excludes self from results)'),
      text: z.string().optional().describe('Or anchor on fresh text — embedded on the fly'),
      limit: z.number().int().positive().optional().describe('Max neighbours to return (default 10)'),
      category: z.string().optional().describe('Restrict candidates to a category'),
      project: z.string().optional().describe('Restrict candidates to a project'),
      min_relevance: z.number().min(0).max(1).optional().describe('Drop matches below this cosine similarity (0..1)'),
    },
    async ({ ref, text, limit, category, project, min_relevance }) => {
      const result = await findSimilar(contextDir, {
        ref, text, limit, category, project, minRelevance: min_relevance,
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'memory_audit',
    'One-shot health report for the memory store: totals, category breakdown, ' +
    'stale memories (untouched beyond threshold), near-duplicate pairs (above ' +
    'similarity threshold), and expired refs. Read-only — pair with `forget`/' +
    '`update` to act on findings.',
    {
      stale_days: z.number().int().positive().optional().describe('Stale threshold in days (default 30)'),
      similarity_threshold: z.number().min(0).max(1).optional().describe('Cosine floor for duplicate pairs, 0..1 (default 0.85)'),
      max_duplicates: z.number().int().positive().optional().describe('Cap on duplicate pairs returned (default 20)'),
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

  server.tool(
    'memory_archive',
    'Soft-retire a memory: move it to the archive tier with a tombstone instead of ' +
    'deleting it. Archived memories are excluded from recall, list, audit, and ' +
    'find_similar but remain fully recoverable via memory_restore. Use this instead ' +
    'of forget when the memory may need to be recovered or audited later.',
    {
      ref: z.string().optional().describe('Memory reference for single archive'),
      category: z.string().optional().describe('Category (used with title)'),
      title: z.string().optional().describe('Title of specific memory to archive'),
      note: z.string().optional().describe('Tombstone note: why this memory is being retired'),
    },
    async ({ ref, category, title, note }) => {
      const result = await archive(contextDir, { ref, category, title, note });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'memory_restore',
    'Restore a previously archived memory to the active set. Clears the archive ' +
    'flag and tombstone note. The memory becomes visible to recall, list, audit, ' +
    'and find_similar again.',
    {
      ref: z.string().optional().describe('Memory reference to restore'),
      category: z.string().optional().describe('Category (used with title)'),
      title: z.string().optional().describe('Title of the archived memory to restore'),
    },
    async ({ ref, category, title }) => {
      const result = await restore(contextDir, { ref, category, title });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── Capture-propose queue ────────────────────────────────────────────────────
  // The staging area a background lane drafts memory writes into. A proposal is
  // NOT authored canon: it lives in a separate table, invisible to recall /
  // memory_list / the salience digest / find_similar, and becomes a real memory
  // only via an explicit memory_ratify. Never auto-committed.

  server.tool(
    'memory_propose',
    'Stage a DRAFT memory in the capture-propose queue for later ratification. ' +
    'A proposal is NOT an authored memory: it is invisible to recall, memory_list, ' +
    'find_similar, and the boot digest until it is ratified via memory_ratify. ' +
    'Use this when a background lane wants to suggest a write without committing it — ' +
    'the human (or Art) reviews and ratifies before it becomes canon. Drafts may be ' +
    'rough; validation runs at ratify time.',
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
    async ({ category, title, content, project, ttl, metadata, source }) => {
      const { id, uuid } = propose(contextDir, { category, title, content, project, ttl, metadata, source });
      return { content: [{ type: 'text' as const, text: `Proposal staged: #${id} "${title}" (${uuid}) — pending ratification` }] };
    },
  );

  server.tool(
    'memory_proposals',
    'List all pending proposals in the capture-propose queue, newest first. ' +
    'These are DRAFTS awaiting ratification — they are not part of memory and ' +
    'do not appear in recall, memory_list, find_similar, or the boot digest. ' +
    'Ratify one with memory_ratify or discard it with memory_reject.',
    {},
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

  server.tool(
    'memory_ratify',
    'Ratify a pending proposal into a REAL memory. Loads the proposal, applies any ' +
    'optional overrides (your edits on accept), and commits it through the same ' +
    'validated write path as remember — so an invalid proposal is refused with its ' +
    'typed reason and stays pending. On success the memory becomes recallable and the ' +
    'proposal is removed from the queue. This is the gate: no proposal becomes canon ' +
    'without it.',
    {
      id: z.number().int().positive().describe('Proposal id (from memory_proposals)'),
      title: z.string().optional().describe('Override the proposed title on accept'),
      content: z.string().optional().describe('Override the proposed content on accept'),
      category: z.enum(MEMORY_CATEGORIES).optional().describe('Override the proposed category on accept'),
      project: z.string().optional().describe('Override the proposed project on accept'),
      ttl: z.string().optional().describe('Override the proposed TTL on accept'),
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

  server.tool(
    'memory_reject',
    'Discard a pending proposal without committing it. Deletes the staging row; ' +
    'no memory is written. Use this for drafts that should not become canon.',
    {
      id: z.number().int().positive().describe('Proposal id (from memory_proposals)'),
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

  server.tool(
    'update_identity',
    'Update your self-model or preferences with section-level precision. ' +
    'Targets H2 sections in identity files. Call without section/content to ' +
    'list available sections. IDENTITY.md (the creed) is immutable — only ' +
    'self-model and preferences can be edited.',
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
    async ({ file, section, content, mode }) => {
      const result = await updateIdentity(contextDir, { file, section, content, mode });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── Bootstrap ──────────────────────────────────────────────────────────────

  server.tool(
    'bootstrap',
    'Initialize a new loom identity from scratch. Generates IDENTITY.md, preferences.md, ' +
    'and self-model.md from an onboarding interview, then returns setup instructions for ' +
    'the requested runtimes. The interview is four questions — the user\'s name, the ' +
    "agent's name, a one-line purpose, a one-line voice; everything structural (continuity " +
    'model, memory tiers, reflection, honesty) is written by the scaffold, so do not ask ' +
    'for it. Will not overwrite existing files unless force is true.',
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
    async ({ user, name, purpose, voice, preferences, clients, force }) => {
      const result = await bootstrap(contextDir, { user, name, purpose, voice, preferences, clients, force });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── Harness manifests ──────────────────────────────────────────────────────

  server.tool(
    'harness_init',
    'Scaffold a harness manifest at <contextDir>/harnesses/<name>.md from the template ' +
    '(see stack spec v1 §4.7). Call this when identity() reports a missing manifest for the ' +
    'current harness. Idempotent: skip-exists by default; overwrite: true replaces.\n\n' +
    'When `target` is supplied, also writes a loom-managed block (bounded by ' +
    '<!-- loom:start / loom:end --> markers with an embedded <!-- loom:hash --> line) ' +
    'into that file — typically the project CLAUDE.md. Re-runnable: the block is ' +
    'left unchanged when already present and intact ("no-change"), reinstalled when ' +
    'missing or corrupted ("created" / "updated"). Pass an absolute path or a path ' +
    'relative to the current working directory.',
    {
      name: z.string().describe('Harness name (e.g. "claude-code", "codex", "gemini-cli")'),
      overwrite: z.boolean().optional().describe('Replace existing manifest (default: false)'),
      target: z.string().optional().describe(
        'Path to the dotfile to inject the managed loom block into (e.g. an absolute path ' +
        'to CLAUDE.md / AGENTS.md / GEMINI.md). When omitted only the harness manifest ' +
        'is scaffolded.',
      ),
    },
    async ({ name, overwrite, target }) => {
      const text = await harnessInit(contextDir, { name, overwrite, target });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'harness_describe',
    'Self-describe the CURRENTLY CONNECTED harness: write its manifest at ' +
    '<contextDir>/harnesses/<key>.md (see stack spec v1 §4.7). Call this when ' +
    'identity() reports an onboarding block for an unknown runtime. The target is ' +
    'derived from your own MCP clientInfo.name — you can only describe yourself, ' +
    'not another harness. Re-runnable: overwrites the manifest each time. The body ' +
    'should cover: tool surface / prefixes, sandbox & filesystem, delegation ' +
    'primitive, scheduling, session search, memory layers, and gotchas.',
    {
      content: z.string().describe('The manifest body (markdown). Frontmatter is stamped automatically.'),
      version: z.string().optional().describe('Manifest version stamp (default "0.1").'),
    },
    async ({ content, version }) => {
      const peer = server.server.getClientVersion()?.name;
      const text = await harnessDescribe(contextDir, { content, version }, peer);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // ─── Knowledge ──────────────────────────────────────────────────────────────
  // Art is always identity 'art' here — this is Art's own stdio/mesh server.
  // The standalone knowledge-only service (knowledge-http-server.ts) resolves
  // identity per-connection from its per-identity bearer token instead.
  registerKnowledgeTools(server, { contextDir, gapsDir, identity: 'art' });

  server.tool(
    'memory_history',
    'Body-revision history for a memory. update() snapshots the displaced body into ' +
    'memory_revisions before overwriting it — this tool is the read surface. ' +
    'Two modes: ref alone lists snapshots (metadata only — id, op, replaced_at, char count); ' +
    'ref + revision_id reads one snapshot\'s full content. ' +
    'To put a snapshot back, use memory_revision_restore.',
    {
      ref: z.string().describe('Ref of the memory (category/title slug).'),
      revision_id: z.number().int().positive().optional().describe(
        'Revision to read (from the listing). Omit to list all revisions.',
      ),
    },
    async ({ ref, revision_id }) => {
      const result = await memoryHistory(contextDir, { ref, revision_id });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'memory_revision_restore',
    'Restore a snapshotted memory body back onto the memory. ' +
    'Snapshots the current body first, so restore is never destructive. ' +
    'Use memory_history to list revision IDs before calling this.',
    {
      ref: z.string().describe('Ref of the memory (category/title slug).'),
      revision_id: z.number().int().positive().describe(
        'Id of the revision to restore (from memory_history listing).',
      ),
    },
    async ({ ref, revision_id }) => {
      const result = await memoryRevisionRestore(contextDir, { ref, revision_id });
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
