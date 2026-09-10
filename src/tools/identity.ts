/**
 * Identity tool — loads the terminal creed, memories, preferences, and self-model.
 *
 * When an agent calls this tool, it receives everything it needs to become a
 * persistent identity. The creed is immutable. Memories, preferences, and
 * self-model evolve across sessions.
 *
 * The response is structured text that the agent incorporates into its context.
 * The agent doesn't need to understand the structure — it just reads and follows.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadClientAdapter } from '../clients.js';
import * as harnessBlock from '../blocks/harness.js';
import * as modelBlock from '../blocks/model.js';
import { resolveDefaultContextPath } from '../config.js';
import { pathSegmentError } from '../path-safety.js';
import { digestForContext } from '../backends/salience.js';
import { tapeForContext } from '../backends/episodes.js';
import { readHealth, recordFailure, warningBlock } from '../backends/recorder-health.js';

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Map an MCP peer's handshake clientInfo.name to a loom client/harness name.
 *
 * A single HTTP daemon is inherently multi-client: the connecting peer — not a
 * server-wide LOOM_CLIENT env — should pick the harness. The server reads the
 * peer from the `initialize` handshake (server.getClientVersion()) and passes
 * its name here. Resolution precedence at the call site is:
 *   explicit `client` param  >  this (the connected peer)  >  LOOM_CLIENT env.
 *
 * Unknown / proxy-ish peers return undefined so the call falls back to
 * LOOM_CLIENT — never override a working default with a name we can't place
 * (which would only yield a "(manifest missing)" block). Known aliases are
 * normalized cross-vendor: e.g. Claude Desktop identifies as "claude-ai".
 */
const PEER_CLIENT_ALIASES: Record<string, string> = {
  'claude-code': 'claude-code',
  'claude-ai': 'claude-desktop', // Claude Desktop's MCP clientInfo.name
  'claude-desktop': 'claude-desktop',
  claude: 'claude-desktop',
  'gemini-cli': 'gemini-cli',
  gemini: 'gemini-cli',
  opencode: 'opencode',
};

export function resolveClientFromPeer(peerName?: string): string | undefined {
  if (!peerName) return undefined;
  // Proxies annotate the name, e.g. "claude-ai (via mcp-remote 0.1.37)" — take
  // the base identity before the first parenthetical, then normalize.
  const base = peerName.split(/\s*\(/, 1)[0];
  const normalized = base.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return PEER_CLIENT_ALIASES[normalized];
}

export async function loadIdentity(
  contextDir: string,
  project?: string,
  client?: string,
  model?: string,
  role?: string,
  /** Override the default context path — used in unit tests only. */
  _defaultPathForTest?: string,
): Promise<string> {
  const parts: string[] = [];
  const effectiveClient = client ?? process.env.LOOM_CLIENT;
  const effectiveModel = model ?? process.env.LOOM_MODEL;

  // Boundary discipline: every param that becomes a path segment validates
  // here, before any file read. Empty/unset values are simply "not provided"
  // (all readers below are guarded), so only truthy values are checked.
  for (const [name, value] of [
    ['project', project],
    ['client', effectiveClient],
    ['model', effectiveModel],
    ['role', role],
  ] as const) {
    if (value) {
      const error = pathSegmentError(value, name);
      if (error) return error;
    }
  }

  const defaultPath = _defaultPathForTest ?? resolveDefaultContextPath();

  // Terminal creed — the immutable identity
  const creed = await readOptional(join(contextDir, 'IDENTITY.md'));
  if (creed) {
    parts.push('# Identity\n\n' + creed.trim());
  } else if (contextDir === defaultPath) {
    // Default fallback path with no creed: refuse to serve a blank identity.
    // An explicit LOOM_CONTEXT_DIR pointing at an empty dir is allowed (opt-in);
    // a silent default fallback is not.
    throw new Error(
      'no loom context configured — refusing to serve a blank identity. ' +
      'Set LOOM_CONTEXT_DIR or run `loom bootstrap` to initialize an agent.',
    );
  } else {
    parts.push(
      '# Identity\n\n' +
      '*No IDENTITY.md found. Create one in your context directory to define who this agent is.*'
    );
  }

  // Preferences — how the user likes to work
  const preferences = await readOptional(join(contextDir, 'preferences.md'));
  if (preferences) {
    parts.push('# Preferences\n\n' + preferences.trim());
  }

  // Episode tape (t-142) — the short-term cross-body tier: what happened across
  // ALL sleeves in the last 24h, time-ordered and unconditional. Injected right
  // after preferences so a fresh body knows what the last body did before it
  // reads anything ranked. Best-effort: no store / no episodes → no block.
  try {
    const tape = tapeForContext(contextDir);
    if (tape) {
      parts.push(
        '# Last 24h across bodies\n\n' +
        '_Episodes other sleeves of you left (short-term, 48h TTL). This is the tape, ' +
        'oldest first — what just happened, not what is important. Write your own before ' +
        'you end (category `episode`, metadata.where = your surface); the harness writes a ' +
        'fallback if you forget._\n\n' +
        tape,
      );
    }
  } catch (tapeErr) {
    // The tape must never block identity load, but a failure here means the
    // episode store may be broken — record it so the next body sees a warning.
    recordFailure(contextDir, tapeErr);
  }

  // Boot digest — the salience-tiered view of episodic memory, so a fresh sleeve
  // wakes knowing what is top-of-mind vs settled background without fishing via
  // recall. ASSEMBLED from authored atoms (never generated); injected after
  // preferences. Best-effort — a missing/empty store just omits the block.
  try {
    const digest = digestForContext(contextDir);
    if (digest) parts.push('# Top of Mind\n\n' + digest);
  } catch {
    // a digest failure must never block identity load
  }

  // Self-model — what the agent knows about its own capabilities
  const selfModel = await readOptional(join(contextDir, 'self-model.md'));
  if (selfModel) {
    parts.push('# Self-Model\n\n' + selfModel.trim());
  }

  // Mode addendum — when Art is dispatched into a reflection mode (wonder,
  // tend, retro, consolidate, identity), append that mode's playbook. The SAME
  // mechanism dossier() uses for worker roles; lives in roles/<role>.md.
  if (role) {
    const modeBrief = await readOptional(join(contextDir, 'roles', `${role}.md`));
    if (modeBrief) {
      parts.push(`# Mode: ${role}\n\n` + modeBrief.trim());
    }
  }

  // Project-specific context
  if (project) {
    const projectBrief = await readOptional(join(contextDir, 'projects', `${project}.md`));
    if (projectBrief) {
      parts.push(`# Project: ${project}\n\n` + projectBrief.trim());
    }
  }

  // Harness manifest — the shape of the current runtime (stack spec §4.7).
  if (effectiveClient) {
    const block = await harnessBlock.read(contextDir, effectiveClient);
    if (block) {
      parts.push(`# Harness: ${effectiveClient}\n\n${block.body}`);
    } else {
      // Genuinely unknown runtime: instead of a bare "(manifest missing)" stub,
      // instruct the connected harness to self-describe via harness_describe.
      parts.push(
        `# Harness: ${effectiveClient} (unknown)\n\n` +
        `I don't have a manifest for this runtime. Describe yourself by calling ` +
        `the harness_describe tool with a manifest covering: tool surface / ` +
        `prefixes, sandbox & filesystem, delegation primitive, scheduling, ` +
        `session search, memory layers, and gotchas.`,
      );
    }
  }

  // Model manifest — model-family-specific capability notes (stack spec §4.8).
  if (effectiveModel) {
    const block = await modelBlock.read(contextDir, effectiveModel);
    if (block) {
      parts.push(`# Model: ${effectiveModel}\n\n${block.body}`);
    } else {
      parts.push(
        `# Model: ${effectiveModel} (manifest missing)\n\n` +
        `No manifest found at ${contextDir}/models/${effectiveModel}.md. ` +
        `Write one — here's the template:\n\n` +
        modelBlock.template(effectiveModel),
      );
    }
  }

  // Optional recent-memory summary. The memory store of record is
  // memories.db (sqlite-vec); navigate it via recall(). If a legacy
  // memories/INDEX.md sidecar exists from FS-backend days, surface a
  // brief summary as a hint — full content lives in the DB.
  const memoryIndex = await readOptional(join(contextDir, 'memories', 'INDEX.md'));
  if (memoryIndex) {
    parts.push('# Memories\n\n' + summarizeMemoryIndex(memoryIndex));
  }

  // Runtime-specific context (tool name prefix, notes) — legacy `## Runtime:` block.
  if (effectiveClient) {
    const adapter = await loadClientAdapter(contextDir, effectiveClient);
    if (adapter) {
      parts.push(adapter);
    }
  }

  // Recorder health warning (t-562) — appended LAST so it is closest to the
  // model's first reply. Only shown when the episode recorder has failed
  // FAILURE_THRESHOLD consecutive times. Best-effort: ledger read errors are
  // silently ignored so the health check never blocks identity load.
  try {
    const health = readHealth(contextDir);
    const warning = warningBlock(health);
    if (warning) parts.push(warning);
  } catch {
    // health ledger read must never block identity load
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Produce a compact summary of a legacy memories/INDEX.md sidecar. The
 * DB is the source of truth; this only surfaces a hint when an old
 * filesystem-era index still exists in the context dir.
 */
function summarizeMemoryIndex(index: string): string {
  const lines = index.split('\n').filter((l) => l.trim().startsWith('- '));

  // Count by type tag e.g. [project], [feedback], [reference], [user], [self]
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const match = line.match(/\[(\w+)\]/);
    if (match) {
      const type = match[1];
      counts[type] = (counts[type] ?? 0) + 1;
    }
  }

  const total = lines.length;
  const countStr = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');

  // Show last 5 entries as a recent-activity signal
  const recent = lines.slice(-5).map((l) => l.trim()).join('\n');

  return (
    `${total} memories stored (${countStr || 'various types'}).\n` +
    `Use \`recall()\` to search by relevance.\n\n` +
    `**Recent:**\n${recent}`
  );
}
