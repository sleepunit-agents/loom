/**
 * Identity tool — loads standard sections according to their shared boot policy.
 *
 * When an agent calls this tool, it receives everything it needs to become a
 * persistent identity. The creed is immutable. Memories, preferences, and
 * self-model evolve across sessions.
 *
 * The response is structured text that the agent incorporates into its context.
 * The agent doesn't need to understand the structure — it just reads and follows.
 */
import type { MemorySelection } from '../config.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadClientAdapter } from '../clients.js';
import * as harnessBlock from '../blocks/harness.js';
import * as modelBlock from '../blocks/model.js';
import { IDENTITY_SECTIONS, identitySection, identityPiecesIndex, type IdentitySectionName } from '../identity/sections.js';
import { pathSegmentError } from '../path-safety.js';
import { digestForContext } from '../backends/salience.js';
import { tapeForContext } from '../backends/episodes.js';
import { PeopleStore, roomBlock } from '../backends/people.js';
import { projectBlock } from '../backends/projects.js';
import { commonsPeoplePath } from '../backends/people-household.js';
import { openPeople, type PeopleSelection } from './person.js';
import { householdOf } from '../household.js';
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

/**
 * Who this agent belongs to, read from the household's members on every load (not the name
 * baked in when it was made): each owner's People name and slug, and whether they own the
 * household or only some of its agents. Null outside a household, or when it can't be read.
 */
/** A name as data: one line, no control characters or markdown, at most 80 characters. */
function plainName(name: unknown): string {
  return typeof name === 'string' ? name.normalize('NFKC').replace(/[\p{C}\n\r]/gu, ' ').replace(/[`*_#>\[\]<>|~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

export function ownersBlock(contextDir: string, selection?: PeopleSelection): string | null {
  try {
    const hh = selection === undefined ? householdOf(contextDir) : selection;
    if (!hh) return null;
    const mine = hh.household.members.filter((m) => m.agents === '*' || m.agents.includes(hh.agent));
    if (!mine.length) return null;
    const path = commonsPeoplePath(hh.household);
    const dir = existsSync(path) ? new PeopleStore({ dbPath: path, readonly: true }) : null;
    try {
      const lines = mine.map((m) => {
        // A card's name is agent-written text: one plain line here, never markup in an authoritative block.
        const name = plainName(dir?.getRow(m.person)?.card.name) || m.person;
        return `- ${name} (\`${m.person}\`): ${m.agents === '*' ? 'owns the household and every agent in it' : `owns ${m.agents.join(', ')}`}`;
      });
      return '# Owners\n\nThe people you belong to. Their cards are in People.\n\n' + lines.join('\n');
    } finally {
      dir?.close();
    }
  } catch {
    return null;
  }
}

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
  /** Slugs of the people the turn is addressed by: adds the `# In the room` block. */
  people?: readonly string[],
  /** Retained positional test seam for callers; missing sections are now omitted. */
  _defaultPathForTest?: string,
  /** Whose digests the tape carries (TapeOptions.onlyConversation): a house's, only the conversation it holds (t-2118). */
  onlyConversation?: string | null,
  /** Omit for core + index; all preserves the historical full output. */
  pieces?: string | readonly string[],
  /** Explicit household/standalone selection for the next stdio composition. */
  selection?: PeopleSelection,
  /** Private memory routing is independent of People metadata. */
  memorySelection?: MemorySelection,
): Promise<string> {
  const requested = pieces === undefined ? [] : typeof pieces === 'string' ? [pieces] : pieces;
  for (const name of requested) {
    if (name !== 'all' && !identitySection(name)) return `Invalid identity piece: ${name}`;
  }
  const full = requested.includes('all');
  const core = pieces === undefined || full;
  const selected = IDENTITY_SECTIONS.filter(section => full ||
    (pieces === undefined ? section.boot === 'core' : requested.includes(section.name)));
  const parts: string[] = [];
  const effectiveClient = client ?? process.env.LOOM_CLIENT;
  const effectiveModel = model ?? process.env.LOOM_MODEL;

  for (const [name, value] of [
    ['project', project], ['client', effectiveClient], ['model', effectiveModel], ['role', role],
  ] as const) {
    if (value) {
      const error = pathSegmentError(value, name);
      if (error) return error;
    }
  }

  const fileSection = async (path: string, heading: string): Promise<string | null> => {
    const body = await readOptional(path);
    return body?.trim() ? heading + '\n\n' + body.trim() : null;
  };
  const readers: Record<IdentitySectionName, () => Promise<string | null>> = {
    creed: () => fileSection(join(contextDir, 'IDENTITY.md'), '# Identity'),
    preferences: () => fileSection(join(contextDir, 'preferences.md'), '# Preferences'),
    owners: async () => ownersBlock(contextDir, selection),
    'last-24h': async () => {
      try {
        const tape = tapeForContext(contextDir, { onlyConversation, memorySelection });
        return tape ? '# Last 24h across bodies\n\n' +
          '_Episodes other sleeves of you left (short-term, 48h TTL), and the digests of their ' +
          'conversations. This is the tape, oldest first — what just happened, not what is ' +
          'important. Write your own before you end: in a conversation (identity was given ' +
          'conversation and run), a `conversation_digest`; otherwise an episode (category ' +
          '`episode`, metadata.where = your surface). The harness writes a fallback if you forget._\n\n' + tape : null;
      } catch (error) {
        console.error('[loom:identity] tape read failed:', error);
        recordFailure(contextDir, error);
        return null;
      }
    },
    'top-of-mind': async () => {
      try {
        const digest = digestForContext(contextDir, { memorySelection });
        return digest ? '# Top of Mind\n\n' + digest : null;
      } catch { return null; }
    },
    'self-model': () => fileSection(join(contextDir, 'self-model.md'), '# Self-Model'),
    harness: async () => {
      if (!effectiveClient) return null;
      const block = await harnessBlock.read(contextDir, effectiveClient);
      return block ? `# Harness: ${effectiveClient}\n\n${block.body}` : null;
    },
    model: async () => {
      if (!effectiveModel) return null;
      const block = await modelBlock.read(contextDir, effectiveModel);
      return block ? `# Model: ${effectiveModel}\n\n${block.body}` : null;
    },
  };

  // Supplements have no independent standard-section identity. Insert them at
  // their historical anchors, even when that anchor's own content is absent.
  for (const section of IDENTITY_SECTIONS) {
    if (core && section.name === 'top-of-mind') {
      try {
        const block = projectBlock(contextDir, project, { onFailure: e => recordFailure(contextDir, e), selection: memorySelection });
        if (block) parts.push(block);
      } catch (error) {
        console.error('[loom:identity] project block failed:', error);
        recordFailure(contextDir, error);
      }
      try {
        const block = roomBlock(contextDir, people, {
          onFailure: e => recordFailure(contextDir, e),
          ...(selection === undefined ? {} : { openStore: () => openPeople(contextDir, { readonly: true, selection }) }),
        });
        if (block) parts.push(block);
      } catch (error) {
        console.error('[loom:identity] room block failed:', error);
        recordFailure(contextDir, error);
      }
    }
    if (core && section.name === 'harness') {
      if (role) {
        const block = await fileSection(join(contextDir, 'roles', `${role}.md`), `# Mode: ${role}`);
        if (block) parts.push(block);
      }
      if (project) {
        const block = await fileSection(join(contextDir, 'projects', `${project}.md`), `# Project: ${project}`);
        if (block) parts.push(block);
      }
    }
    if (selected.includes(section)) {
      const block = await readers[section.name]();
      if (block) parts.push(block);
    }
  }

  // Compatibility-only appendix: not a standard section or an indexed piece.
  if (full) {
    const memoryIndex = await readOptional(join(contextDir, 'memories', 'INDEX.md'));
    if (memoryIndex) parts.push('# Memories\n\n' + summarizeMemoryIndex(memoryIndex));
  }
  // The harness section includes the client adapter. In all, keep its old
  // position after model and the legacy index rather than moving its text.
  if (selected.some(section => section.name === 'harness') && effectiveClient) {
    const adapter = await loadClientAdapter(contextDir, effectiveClient);
    if (adapter) parts.push(adapter);
  }
  if (core && !full) parts.push(identityPiecesIndex());

  if (core) {
    try {
      const warning = warningBlock(readHealth(contextDir));
      if (warning) parts.push(warning);
    } catch { /* Recorder health must never block identity. */ }
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
