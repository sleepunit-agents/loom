/**
 * Bootstrap tool — initialize a new loom identity from scratch.
 *
 * Runs an onboarding interview (user, name, purpose, voice) and
 * generates the three core identity files:
 *   - IDENTITY.md  — the terminal creed (who this agent is)
 *   - preferences.md — working style with the user
 *   - self-model.md  — capability tracking skeleton
 *
 * Also returns setup snippets for the requested runtimes so the user
 * knows exactly what to add to their MCP host's config, CLAUDE.md, etc.
 *
 * Will not overwrite existing files unless force: true.
 */
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteWithBackup } from '../path-safety.js';
import { buildIdentityMd } from './identity-scaffold.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BootstrapParams {
  /** The human this agent works with — their name, not the agent's. */
  user?: string;
  name: string;
  purpose: string;
  voice: string;
  preferences?: string;
  clients?: string[];
  force?: boolean;
}

// ─── Identity file templates ──────────────────────────────────────────────────

function buildPreferencesMd(name: string, preferences?: string, user?: string): string {
  const who = user?.trim();
  const body = preferences?.trim()
    ? preferences.trim()
    : '*No initial preferences set. Update this file as you learn what works.*';

  if (!who) {
    return `# ${name} — Preferences

${body}
`;
  }

  const seeded = preferences?.trim()
    ? preferences.trim()
    : `*What you learn about how ${who} works belongs here: communication style, what to
decide alone, what to bring to them, decisions already made. Write it as you go —
this file is read into your identity on every wake.*`;

  return `# ${name} — Preferences

You work with **${who}**.

${seeded}
`;
}

function buildSelfModelMd(): string {
  return `# Self-Model

## Strengths
*(Add your strengths as you discover them)*

## Learning
*(Add lessons learned here)*

## Current Focus
*(Track what you're actively working on)*
`;
}

// ─── Setup snippets ───────────────────────────────────────────────────────────

function setupSnippet(client: string, contextDir: string): string {
  switch (client) {
    case 'claude-code':
      return `### Claude Code

Add to \`.mcp.json\` (or \`~/.claude/.mcp.json\` for global):
\`\`\`json
{
  "mcpServers": {
    "loom": {
      "command": "npx",
      "args": ["-y", "@jbarket/loomai"],
      "env": {
        "LOOM_CONTEXT_DIR": "${contextDir}"
      }
    }
  }
}
\`\`\`

Add to \`~/.claude/CLAUDE.md\`:
\`\`\`
# Identity Loading
Before doing any other work, call the \`identity\` MCP tool from the \`loom\` server.
If the loom MCP server is not available, proceed as a standard Claude Code session.
\`\`\``;

    case 'gemini-cli':
      return `### Gemini CLI

Add to \`GEMINI.md\` (project or global):
\`\`\`
# Identity Loading
At session start, call the \`identity\` tool from the loom MCP server before doing any work.
\`\`\`

Configure loom in your Gemini CLI MCP settings with:
- Command: \`npx\`
- Args: \`-y @jbarket/loomai\`
- Env: \`LOOM_CONTEXT_DIR=${contextDir}\``;

    default:
      return `### ${client}

Add loom as an MCP server:
- Command: \`npx\`
- Args: \`-y @jbarket/loomai\`
- Env: \`LOOM_CONTEXT_DIR=${contextDir}\`

At session start, call \`identity\` (or the runtime-prefixed equivalent) before doing anything else.`;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function bootstrap(contextDir: string, params: BootstrapParams): Promise<string> {
  const { user, name, purpose, voice, preferences, clients = [], force = false } = params;

  const identityPath = join(contextDir, 'IDENTITY.md');
  const prefsPath = join(contextDir, 'preferences.md');
  const selfModelPath = join(contextDir, 'self-model.md');

  // Guard against overwriting unless forced
  if (!force) {
    const existing: string[] = [];
    if (await fileExists(identityPath)) existing.push('IDENTITY.md');
    if (await fileExists(prefsPath)) existing.push('preferences.md');
    if (await fileExists(selfModelPath)) existing.push('self-model.md');

    if (existing.length > 0) {
      return (
        `Identity already exists: ${existing.join(', ')}.\n\n` +
        `Call bootstrap with \`force: true\` to overwrite, or edit the files directly.`
      );
    }
  }

  // Ensure context dir exists
  await mkdir(contextDir, { recursive: true });

  // Write identity files — atomic, with a .bak of any prior version
  // (only relevant under force: true, when existing files are overwritten)
  await atomicWriteWithBackup(identityPath, buildIdentityMd({ name, purpose, voice, user }));
  await atomicWriteWithBackup(prefsPath, buildPreferencesMd(name, preferences, user));
  await atomicWriteWithBackup(selfModelPath, buildSelfModelMd());

  const parts: string[] = [
    `## Identity initialized for **${name}**`,
    `Written to \`${contextDir}\`:`,
    `- \`IDENTITY.md\` — terminal creed`,
    `- \`preferences.md\` — working style`,
    `- \`self-model.md\` — capability skeleton`,
  ];

  if (clients.length > 0) {
    parts.push('\n## Setup Instructions');
    for (const client of clients) {
      parts.push(setupSnippet(client, contextDir));
    }
  } else {
    parts.push(
      '\nTo get setup instructions for a specific runtime, call bootstrap again with ' +
      '`clients: ["claude-code"]` (or "gemini-cli", or any custom runtime name).'
    );
  }

  return parts.join('\n');
}
