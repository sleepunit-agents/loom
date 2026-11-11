/**
 * Loom — MCP Server Factory
 *
 * Creates a McpServer with the core identity and memory tools registered.
 * This is the portable identity layer — no routing, no orchestration,
 * no chat clients. Just the tools that carry a persistent persona across
 * any MCP-compatible runtime.
 */
import { nudge } from './collections/pull.js';
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
import { harnessInit, harnessDescribe, harnessPatch } from './tools/harness.js';
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
  personMerge,
} from './tools/person.js';
import {
  projectWrite,
  projectVerify,
  projectArchive,
  projectRestore,
  projectHistory,
  projectRevisionRestore,
  project as projectRead,
  projectList,
  projectHub,
  projectOrphansText,
} from './tools/project.js';
import { knowledgeFreshness } from './tools/knowledge-list.js';
import { ConversationError, findingsOf, resolveProjectName, writeDigest } from './backends/conversations.js';
import { conversationsList, conversationView, homeFor } from './conversations.js';
import { houseConversation } from './household-store.js';
import { agentThreadRead, CommsError, threadOfAgentConversation, titleFromAgent } from './comms.js';
import { aboutAskOf, householdOf, setAbout, setAboutAsk } from './household.js';

/** The agent a context dir is: its household name, else its directory's name. */
function agentOfDir(contextDir: string): string {
  return householdOf(contextDir)?.agent ?? (contextDir.replace(/\/+$/, '').split('/').pop() || 'agent');
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface LoomServerConfig {
  contextDir: string;
  /**
   * The house this session's agent token names, and its service if it's one (t-2061): set by the household HTTP server
   * from the token, never from what the session says. A body's house (not a service's) writes a digest only for the
   * one conversation the runtime said it holds (household-store.ts, house_conversations).
   */
  caller?: { house?: string; service?: string };
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
   * Tools a piece offers (src/offered-tools.ts, agent-runtime.md "Seams", 2, `mcp_tools`): the
   * household HTTP server passes the installed pieces' tools, each called as this session's own
   * agent. A tool exists here only when a piece offers it: the runtime's `relay` among them.
   */
  tools?: SessionTool[];
}

/** One offered tool as a session has it: its JSON schema, and its call as the session's agent. */
export interface SessionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: unknown) => Promise<{ text: string; isError?: boolean }>;
}

/** A piece's JSON schema as the SDK takes it; one zod can't read is any object (the piece checks its own arguments). */
function schemaOf(json: Record<string, unknown>): z.ZodType {
  try { return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType; } catch { return z.looseObject({}); }
}

export interface LoomServerInstance {
  server: McpServer;
}

/**
 * The conversation a house holds (t-2061): undefined when the caller is in no house (loom's machine, an owner's session),
 * null when it is one the runtime named nothing for (or another agent's), else that conversation. A service's house (a
 * chat bridge, a jobs house: people other than the owner may steer one) is held to the same rule (t-2118): the runtime
 * names no conversation for one, so it writes and reads none.
 */
export function bodyHouseConversation(contextDir: string, caller: LoomServerConfig['caller']): string | null | undefined {
  const house = caller?.house;
  // A service's token with no house (an older one, or one made by hand) holds nothing either: never as loom's machine.
  if (!house) return caller?.service ? null : undefined;
  const home = homeFor(contextDir);
  const self = householdOf(contextDir)?.agent;
  let held: { agent: string; conversation: string } | null = null;
  try { held = home ? houseConversation(home, house) : null; } catch { held = null; }
  return held && held.agent === self ? held.conversation : null;
}

/**
 * Why a session from `caller`'s house may not write for `conversation` (a digest, a Comms title), or null when it may
 * (t-2061): no house (loom's machine, an owner's session), as before; any house, only the conversation the runtime said
 * it holds, and nothing at all when it said none (fail closed), a service's too (t-2118).
 */
export function houseWriteProblem(contextDir: string, caller: LoomServerConfig['caller'], conversation: string | undefined): string | null {
  const held = bodyHouseConversation(contextDir, caller);
  if (held === undefined) return null;
  if (held === null) return `${caller?.house ?? `the ${caller?.service} service`} holds no conversation the runtime named, so it writes for none`;
  return held === conversation ? null : `${caller?.house} holds ${held}: it writes for that conversation only`;
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

  /** The conversation and run this session's body was given at identity (conversation_digest writes there). */
  let here: { conversation: string; run: string } | undefined;

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
        profile: z.enum(['full', 'work']).optional().describe('Work uses the agent-authored work-identity.md and omits boot tape, salience, preferences and harness boilerplate. Missing work identity keeps full identity. Owners, project and room still load.'),
        project: z.string().optional().describe(
          'Project context to load (loads project-specific memories). A project card\'s name (slug or alias) also adds a ' +
          '"# This project" block with its rendered card.',
        ),
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
        conversation: z.string().max(64).optional().describe(
          'The conversation this body is in (cv-…), as the runtime or harness that started it says. ' +
          'With run, it is where conversation_digest writes.',
        ),
        run: z.string().max(128).optional().describe('This body run\'s id, as the runtime or harness that started it says.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, client, model, role, people, conversation, run, profile }) => {
      // The body's conversation and run (docs/specs/conversations.md): kept for this session's
      // conversation_digest. Both or neither; a later identity call replaces them.
      if (conversation !== undefined || run !== undefined) here = { conversation: conversation ?? '', run: run ?? '' };
      // Precedence: explicit param > data-driven manifest resolution > the
      // static code-map seed fallback > LOOM_CLIENT (inside loadIdentity).
      const peer = server.server.getClientVersion()?.name;
      // A connected peer always gets its harness OR an onboarding prompt (via its
      // normalized name); LOOM_CLIENT is only the no-peer fallback (in loadIdentity).
      const effectiveClient =
        client ?? (await resolvePeerToHarness(contextDir, peer)) ?? resolveClientFromPeer(peer) ?? (peer ? normalizePeer(peer) : undefined);
      // From a house, the tape carries only the digests of the conversation it holds (t-2118).
      const result = await loadIdentity(contextDir, project, effectiveClient, model, role, people, undefined, bodyHouseConversation(contextDir, config.caller), profile);
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
      // From a house, only the digests of the conversation it holds (t-2118); the episodes are the agent's own.
      const tape = tapeForContext(contextDir, { hours, tokenBudget: 6000, onlyConversation: bodyHouseConversation(contextDir, config.caller) });
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
      const counts = { invalidTimestamps: 0, futureTimestamps: 0 };
      const n = recomputeSalienceForContext(contextDir, Date.now(), counts);
      return { content: [{ type: 'text' as const, text: `recomputed salience for ${n ?? 0} memories; invalid timestamps: ${counts.invalidTimestamps}; future timestamps: ${counts.futureTimestamps}` }] };
    },
  );

  for (const t of config.tools ?? []) {
    // A name already registered (core's own, should one ever slip past install's check) is left out, never the session.
    try { server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: schemaOf(t.inputSchema),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args: unknown) => {
        const r = await t.call(args);
        return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
      },
    ); } catch (e) {
      process.stderr.write(`loom: an offered tool ${t.name} wasn't added (${(e as Error).message})\n`);
    }
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

  server.registerTool(
    'harness_patch',
    {
      description:
      'Safely edit ONE small piece of the CURRENTLY CONNECTED harness\'s own manifest, ' +
      'without reading back the full current body first. identity() bundles the manifest ' +
      'into a combined payload that can silently truncate once it grows large (t-1674), ' +
      'making a read-then-overwrite via harness_describe unsafe past that point. ' +
      'harness_patch instead applies an exact find/replace against the server\'s own ' +
      'on-disk copy of the manifest, which is always complete. `find` must match the ' +
      'current manifest body exactly once — zero or multiple matches is refused rather ' +
      'than guessed at. To append, make `find` the last line of the section you\'re adding ' +
      'to and `replace` that same line followed by the new line(s). Requires a manifest to ' +
      'already exist (harness_describe or harness_init first). Peer-scoped like ' +
      'harness_describe: a harness can only patch its own manifest.',
      inputSchema:
      {
        find: z.string().describe('Exact text to find in the current manifest body — must match exactly once.'),
        replace: z.string().describe('Text to replace it with.'),
        version: z.string().optional().describe('Manifest version stamp to set (default: keep the existing version).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ find, replace, version }) => {
      const peer = server.server.getClientVersion()?.name;
      const text = await harnessPatch(contextDir, { find, replace, version }, peer);
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
    'person_merge',
    {
      description:
      'Merge two person cards that turn out to be one person (two agents each met them and each made a card). ' +
      'from becomes an archived redirect to into: reading from answers into\'s card, and a later write to from lands on into. ' +
      'into keeps its name and summary (plus one "Merged <from> (<name>) <date>" line; from\'s card stays in into\'s history); ' +
      'where is the union of both cards\' values, how and may the union with into winning a clash. In a household this tool merges ' +
      'the shared card, your own copy, and your own memories, proposals, conversations and turns tagged from; other agents\' stores ' +
      'are theirs: not_done names them, and the owner finishes with `loom person merge`. ' +
      'from may be a bare tag with no card (memories tagged it): they are re-tagged and from redirects to into. ' +
      'Refused when into is missing or archived, from is archived, from is into, a household agent, or a member\'s card. ' +
      'dry_run: true reports what would change and writes nothing. Afterwards rename the slug in every agent\'s gates (not_done says so).',
      inputSchema: z.object({
        from: slugParam.describe('The card merged away: it becomes a redirect to into.'),
        into: slugParam.describe('The card that survives.'),
        dry_run: z.boolean().optional().describe('Report what would change (where values, re-tags per agent, conversations, projects); write nothing.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ from, into, dry_run }) => {
      const result = await personMerge(contextDir, { from, into, ...(dry_run !== undefined ? { dry_run } : {}) });
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

  // ─── Projects ───────────────────────────────────────────────────────────────
  // Project cards (docs/specs/projects.md): the condensed current state of a
  // body of work, and its hub (everything filed under it, read live). As
  // person cards: current state, revisions keep the past. Every slug-taking
  // tool also takes a live alias and says so with resolved_from.

  const projectSlug = z.string().describe('A project name: its slug (e.g. "pond") or a live alias. An archived project is reached by its slug only.');
  const projectWhere = z.object({
    value: z.string(),
    verified_at: z.string().optional(),
    source: z.string().optional(),
    stale_after_days: z.number().int().optional(),
  }).passthrough();
  const nullable = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.null()]);

  server.registerTool(
    'project_write',
    {
      description:
      'Write a project card — the condensed current state of an ongoing body of work with a goal (a product, a ' +
      'client engagement, a season), not a task tracker. merge (default true) replaces name/status/summary/goal ' +
      'when passed and merges where and links one level deep (a key passed as null is removed: passing ' +
      'links.epic keeps links.aliases); merge: false makes the card exactly what was passed. links are selectors ' +
      'the hub reads with (aliases: other memory tags that mean this project; notes: note path prefixes, default ' +
      'the slug; epic, repos, venues), never references. A slug is a project\'s for good; aliases are unique ' +
      'across live projects. Passing summary moves synthesized_at.',
      inputSchema: z.object({
        slug: projectSlug,
        name: z.string().optional().describe('Display name (required on create and on merge: false), ≤ 80 chars.'),
        status: z.enum(['active', 'paused', 'done']).optional().describe('Default active. paused and done keep the project live; archive retires it.'),
        summary: z.string().optional().describe('What it is, ≤ 1,200 chars.'),
        goal: z.string().optional().describe('What done looks like, ≤ 400 chars.'),
        where: z.record(z.string(), nullable(projectWhere)).optional().describe(
          'Where it stands: field -> {value (a string ≤ 400), verified_at?, source?, stale_after_days?}, e.g. now, next. null removes a field.',
        ),
        links: z.object({
          aliases: nullable(z.array(z.string())).optional(),
          notes: nullable(z.array(z.string())).optional(),
          epic: nullable(z.string()).optional(),
          repos: nullable(z.array(z.string())).optional(),
          venues: nullable(z.array(z.string())).optional(),
        }).passthrough().optional().describe('Selectors for the hub. A key passed replaces that key; null removes it.'),
        merge: z.boolean().optional().describe('Default true. false: the card becomes exactly what was passed.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const result = await projectWrite(contextDir, input as Parameters<typeof projectWrite>[1]);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project_verify',
    {
      description:
      'Stamp where fields on a project card as checked: sets verified_at (default now) and, if passed, source. ' +
      'Values are not changed. All-or-nothing, as person_verify.',
      inputSchema: z.object({
        slug: projectSlug,
        fields: z.array(z.string()).describe('where field names to stamp.'),
        verified_at: z.string().optional().describe('ISO-8601 UTC; default now; not in the future.'),
        source: z.string().optional().describe('What you checked against, e.g. "tasks".'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ slug, fields, verified_at, source }) => {
      const result = await projectVerify(contextDir, { slug, fields, verified_at, source });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project_archive',
    {
      description:
      'Retire a project with a tombstone (who, when, why): hidden from project_list, its aliases freed (never ' +
      'its slug). done is "finished, still findable"; archive is "gone". Rejects writes until project_restore.',
      inputSchema: z.object({
        slug: projectSlug,
        reason: z.string().describe('Why the project is being retired, ≤ 200 chars.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ slug, reason }) => {
      const result = await projectArchive(contextDir, { slug, reason });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project_restore',
    {
      description:
      'Reactivate an archived project (by its slug), fields intact. Its aliases are re-claimed: if any is now ' +
      'held by a live project, nothing is restored.',
      inputSchema: z.object({ slug: projectSlug }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await projectRestore(contextDir, { slug });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project_history',
    {
      description:
      'Revision history of a project card, newest first: {revisions: [{id, op, replaced_at, actor}]}. Every ' +
      'stored change snapshots the previous card; the newest 10 are kept.',
      inputSchema: z.object({ slug: projectSlug }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const result = await projectHistory(contextDir, { slug });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project_revision_restore',
    {
      description:
      'Put a project card back to a revision from project_history (card, its names and synthesized_at). ' +
      'Snapshots the current card first. Rejected if the revision\'s aliases are now another project\'s.',
      inputSchema: z.object({
        slug: projectSlug,
        revision_id: z.number().int().positive().describe('Revision id from project_history.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ slug, revision_id }) => {
      const result = await projectRevisionRestore(contextDir, { slug, revision_id });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project',
    {
      description:
      'Read one project card: {found, rendered, card, archived, updated, synthesized_at, resolved_from?}. A ' +
      'missing project is {found: false}, not an error. where fields carry [ok], [unverified] or [STALE <n>d].',
      inputSchema: z.object({
        slug: projectSlug,
        include_archived: z.boolean().optional().describe('Return an archived card in full (default false).'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, include_archived }) => {
      const result = await projectRead(contextDir, { slug, include_archived });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project_list',
    {
      description:
      'List projects, most recent activity first: slug, name, status, links, activity, stale and unverified ' +
      'counts, and memories_since_synthesis (memories tagged with any of its names created after the summary: ' +
      'how a consolidation lane finds summaries that have fallen behind). Without status, every live project.',
      inputSchema: z.object({
        status: z.enum(['active', 'paused', 'done']).optional().describe('Only projects with this status.'),
        include_archived: z.boolean().optional().describe('Include archived projects (default false).'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, include_archived }) => {
      const result = await projectList(contextDir, { status, include_archived });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project_hub',
    {
      description:
      'A project\'s hub: its card and its sections, computed live — memories tagged with any of its names (the ' +
      '20 newest plus the 10 most salient), notes under its prefixes, person cards with a where field for ' +
      'it, conversations whose digests name it, then each managed piece\'s section feed (piece:<name>). Items changed after since (default 7 days ago) are marked new. A section that fails is {key, error}; ' +
      'the others still return. An archived project gives {found: true, archived: true} unless include_archived.',
      inputSchema: z.object({
        slug: projectSlug,
        since: z.string().optional().describe('ISO-8601 time; default 7 days ago. Marks items new; does not filter.'),
        include_archived: z.boolean().optional().describe('Compute an archived project\'s hub too (default false).'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, since, include_archived }) => {
      // From a house, no other conversation's digests (t-2118): a house reads only the conversation it holds.
      const result = await projectHub(contextDir, { slug, since, include_archived }, bodyHouseConversation(contextDir, config.caller) === undefined ? {} : { noConversations: true });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.registerTool(
    'project_orphans',
    {
      description:
      'Memory project tags that are no live project\'s name, with counts, most first: where to find projects ' +
      'that ought to have a card. Counts only non-archived, non-expired memories.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: 'text' as const, text: await projectOrphansText(contextDir) }] }),
  );

  // ─── Conversations (docs/specs/conversations.md) ──────────────────────────────

  const convText = (f: () => unknown) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(f(), null, 2) }] };
    } catch (e) {
      if (e instanceof ConversationError) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }) }], isError: true };
      throw e;
    }
  };
  const isoTime = z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), 'an ISO-8601 time');

  server.registerTool(
    'conversation_digest',
    {
      description:
      'Write this body run\'s digest of its conversation: what was asked, decided and done, and whether the owner ' +
      'is needed. For the conversation and run given to identity (rejected without them); a second write in the ' +
      'same run replaces it. Quote a line only when its words carry the meaning: never a transcript. The test for ' +
      'anything written about a person: would they be fine reading it? A body in a conversation writes this instead of an episode.',
      inputSchema: z.object({
        summary: z.string().max(600).describe('What happened, at most 600 characters.'),
        asks: z.array(z.string().max(200)).max(8).optional().describe('What was asked of the agent.'),
        decisions: z.array(z.string().max(200)).max(8).optional().describe('What was decided.'),
        tasks: z.array(z.string().max(64)).max(16).optional().describe('Task refs made or moved (t-…).'),
        projects: z.array(z.string().max(80)).max(4).optional().describe('Project names (slugs or aliases); omitted: the project whose links.venues names this conversation\'s place, if exactly one does.'),
        needs_owner: z.union([z.string().max(200), z.object({
          ask: z.string().max(140).describe('The one question or request the owner answers, in plain words, as you\'d ask a person who doesn\'t know your lanes: no ids (a-…, t-…, cv-…, h-…, repo#N), no "round N", no lane words (nudge-watch, chain-check, local-wake). At most 140 characters. Refused with why if it names any.'),
          why: z.string().max(240).optional().describe('One plain line: why it needs them.'),
          if_yes: z.string().max(140).optional().describe('What happens if they say yes (or do it), short.'),
          if_no: z.string().max(140).optional().describe('What happens if they say no (or leave it), short.'),
          answers: z.enum(['yes-no', 'words']).optional().describe('How they answer. "yes-no": their sheet shows Yes and No buttons, and you get "Yes, to: <ask>" (or "No, …") with your if_yes (or if_no) line, as their message in this conversation. "words": a reply box only, for an ask Yes and No can\'t answer ("Gabe or Mark?"). Left off, an ask with if_yes or if_no is "yes-no", so phrase it as a yes/no question, or say "words".'),
          href: z.string().max(500).optional().describe('The exact thing to open, https:// (the pull request to merge): the sheet\'s first button.'),
          refs: z.array(z.string().max(100)).max(8).optional().describe('The ids it\'s about: t-40, a-7693c00e, owner/repo#12, cv-…. They become links and details, never the headline.'),
          waits_on: z.object({ approval: z.string().max(20).optional(), task: z.string().max(20).optional() }).optional().describe('What resolves it, one of {approval: "a-…"} (allowed, denied or gone) or {task: "t-…"} (closed): core checks and clears the ask, leaving an FYI. An approval shows its Allow and Deny right on the ask, so the owner never hunts for the card. No pull requests: loom can\'t read GitHub, so write needs_owner null in a later digest once it\'s merged.'),
        }).strict()]).nullable().optional().describe('What you need the owner for, or null. It shows in their Inbox (and on Home), headlined by `ask`, where they can answer Yes or No (a yes/no ask), reply to you in words, mark it done or dismiss it, until a later digest has none or what it waits on is resolved. Write it for them: what decision, why, what happens either way. Like {"ask": "OK to install rclone and restic on loom\'s machine to set up the Google Drive backup?", "why": "The nightly backup has no offsite copy yet.", "if_yes": "I install both and run the first backup tonight.", "if_no": "Backups stay on this machine only.", "refs": ["t-40", "a-7693c00e"], "waits_on": {"approval": "a-7693c00e"}}. A plain one-line string is still taken as the ask alone.'),
        needs_owner_href: z.string().max(500).nullable().optional().describe('The older name for needs_owner.href: the exact thing to open, as an https:// URL. Give it once, either way.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => convText(() => {
      // From a body's house, only the conversation that house holds (t-2061): inside one house every body could read
      // another's ids, so the conversation it names at identity proves nothing by itself.
      const notHeld = houseWriteProblem(contextDir, config.caller, here?.conversation);
      if (notHeld) throw new ConversationError(notHeld, 403);
      // A Comms thread's own project is the fallback for a digest that names none (comms.md, "Project").
      const home = here ? homeFor(contextDir) : undefined;
      const self = householdOf(contextDir)?.agent;
      const project = home && here && self ? threadOfAgentConversation(home, self, here.conversation)?.project ?? null : null;
      const d = writeDigest(contextDir, here ?? { conversation: '', run: '' }, input, new Date(), project);
      // An ask raised or cleared is what needs its owner moving (t-2025): the HTTP listeners pull it now, not on their
      // next round (a nudge names only the domain, through the household's live data).
      const h = homeFor(contextDir);
      if (h) nudge(h, 'loom/attention');
      return d;
    }),
  );

  server.registerTool(
    'describe_self',
    {
      description:
      'Write your own description on your loom profile, when your household\'s owner has asked you to (their agent ' +
      'window\'s Regenerate; refused otherwise, and the ask closes once you write it). One or two short sentences in plain ' +
      'words, for the household: what you do and for whom. Not your creed, nothing from your private memories, no ids.',
      inputSchema: z.object({
        text: z.string().min(1).max(300).describe('The description: one or two plain sentences, at most 300 characters.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ text }) => {
      // Whose body this is: the server's own agent dir, never anything the caller sends.
      const mine = householdOf(contextDir);
      const fail = (error: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error }) }], isError: true });
      if (!mine) return fail('only an agent in a household has a profile description');
      if (!aboutAskOf(mine.household, mine.agent)) return fail('nobody asked: your owner asks for this from your window in loom (Regenerate)');
      const t = text.replace(/\s+/g, ' ').trim();
      if ((t.match(/[.!?](\s|$)/g) ?? []).length > 2) return fail('keep it to one or two sentences');
      setAbout(mine.household, mine.agent, t);
      setAboutAsk(mine.household, mine.agent, null);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, description: t }) }] };
    },
  );

  server.registerTool(
    'comms_title',
    {
      description:
      'Name this Comms thread (a conversation in loom\'s own app, venue loom), once you know what it\'s about: a short ' +
      'title of at most 60 characters on one line, written for its owner to read in their thread list. For the ' +
      'conversation given to identity; refused anywhere else, and once the owner has named the thread themselves.',
      inputSchema: z.object({
        title: z.string().max(60).describe('The thread\'s title: at most 60 characters, one line, plain words.'),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ title }) => {
      const home = homeFor(contextDir);
      // Whose body this is: the server's own agent dir, never anything the caller sends.
      const self = householdOf(contextDir)?.agent;
      if (!here || !home || !self) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'call identity with this body\'s conversation and run first' }) }], isError: true };
      // From a body's house, only the conversation it holds (t-2061), as conversation_digest.
      const notHeld = houseWriteProblem(contextDir, config.caller, here.conversation);
      if (notHeld) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: notHeld }) }], isError: true };
      try {
        const t = titleFromAgent(home, self, here.conversation, title);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, thread: t.id, title: t.title }) }] };
      } catch (e) {
        if (e instanceof CommsError) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }) }], isError: true };
        throw e;
      }
    },
  );

  server.registerTool(
    'comms_thread',
    {
      description:
      'Read a Comms thread of your own agent\'s (a conversation in loom\'s own app, venue loom): its messages as its ' +
      'owner sees them, oldest first, with the owner\'s words, your replies, tool cards and any error card such as ' +
      '"your reply couldn\'t be shown". Words go after the household\'s comms_days (14 at most); the message stays. With no thread, the one ' +
      'of the conversation given to identity. Never another agent\'s thread. Read only.',
      inputSchema: z.object({
        thread: z.string().max(20).optional().describe('A thread id of yours, th:… (its place). Left off: this body\'s own thread.'),
        before: z.number().int().positive().optional().describe('Only messages before this seq: scrolling back.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many of the newest messages (default 30, at most 100).'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ thread, before, limit }) => {
      const home = homeFor(contextDir);
      // Whose thread: the server's own agent dir, never anything the caller sends.
      const self = householdOf(contextDir)?.agent;
      if (!home || !self) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no household here' }) }], isError: true };
      // From a body's house, only the thread of the conversation that house holds (t-2061): a thread's words are its
      // conversation's transcript, and a sibling's (or a guest's house) never reads another's.
      const held = bodyHouseConversation(contextDir, config.caller);
      if (held !== undefined) {
        const mine = held ? threadOfAgentConversation(home, self, held)?.id : undefined;
        if (!held || !mine || (thread !== undefined && thread !== mine)) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `${config.caller?.house} reads only the thread of the conversation it holds` }) }], isError: true };
        }
      }
      try {
        const r = await agentThreadRead(home, process.env, self, { conversation: held ?? here?.conversation, thread, before, limit });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
      } catch (e) {
        if (e instanceof CommsError) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }) }], isError: true };
        throw e;
      }
    },
  );

  server.registerTool(
    'conversations',
    {
      description:
      'This agent\'s conversations, newest first (at most 100): venue, place, label, people, agents, projects, ' +
      'started, last, turn count, the newest digest\'s summary and any open needs_owner. No text: conversations hold none.',
      inputSchema: z.object({
        people: z.string().max(80).optional().describe('Only conversations with this person (a slug).'),
        project: z.string().max(80).optional().describe('Only conversations whose digests name this project (a slug or alias).'),
        venue: z.string().max(32).optional().describe('Only this venue (slack, session, wake, …).'),
        since: isoTime.optional().describe('Only conversations active after this time (their last turn is later).'),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ people, project, venue, since }) => convText(() => {
      const all = conversationsList(contextDir, { people, venue, since, ...(project ? { project: resolveProjectName(contextDir, project) } : {}) });
      // From a house, only the conversation it holds (t-2118): a digest summarises its conversation's words, and a
      // house (a sibling's, a guest's, a chat bridge's) never reads another's. None from a house the runtime named none for.
      const held = bodyHouseConversation(contextDir, config.caller);
      return { conversations: held === undefined ? all : all.filter((c) => held !== null && c.id === held) };
    }),
  );

  server.registerTool(
    'conversation',
    {
      description:
      'One of this agent\'s conversations: the record, its digests (newest first), the findings on it, and its ' +
      'render (the venue\'s own when its piece is installed and offers one, else core\'s generic render).',
      inputSchema: z.object({ id: z.string().max(64).describe('The conversation id, cv-….') }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      // From a house, only the conversation it holds (t-2118), the same refusal as one that isn't there.
      const held = bodyHouseConversation(contextDir, config.caller);
      if (held !== undefined && held !== id) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `no conversation ${id}` }, null, 2) }], isError: true };
      const view = await conversationView(contextDir, agentOfDir(contextDir), id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(view ?? { error: `no conversation ${id}` }, null, 2) }], ...(view ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    'conversation_findings',
    {
      description:
      'Graders\' findings on this agent\'s own turns, newest first: one line per conversation per UTC day at most, ' +
      'from a grader that saw only redacted text. For introspection: what to learn from. Empty until the household\'s review has run.',
      inputSchema: z.object({ since: isoTime.optional().describe('Only findings after this time.') }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ since }) => convText(() => {
      // From a house, the findings on the conversation it holds only (t-2118); none from a house it named none for.
      const held = bodyHouseConversation(contextDir, config.caller);
      if (held === null) return { findings: [] };
      return { findings: findingsOf(contextDir, { ...(since ? { since } : {}), ...(held ? { conversation: held } : {}) }) };
    }),
  );

  // MCP-App render probe — env-gated, throwaway. Not part of the tool surface
  // contract; only registered when explicitly validating ui:// rendering.
  if (process.env.LOOM_MCP_APP_HELLO) {
    registerHelloApp(server, pkg.version, contextDir);
  }

  return { server };
}
