/**
 * Registry of install targets for `loom install`. Separate from
 * `src/injection/harnesses.ts` (dotfile injection paths) because the
 * skill-install convention differs per vendor: Claude Code uses
 * `~/.claude/skills/`, other harnesses converge on `~/.agents/skills/`.
 *
 * See stack spec v1 §11 (Adapters) and the alpha.6 design doc.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export type InstallTargetKey =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'opencode'
  | 'other';

export type ToolPrefix = 'mcp__loom__' | 'mcp_loom_' | 'loom_';

export interface InstallTarget {
  readonly key: InstallTargetKey;
  readonly label: string;
  /** Canonical skill directory. `null` for `other` (caller picks a path). */
  readonly skillDir: string | null;
  /** Hint for the skill prose — where this harness's MCP config lives. */
  readonly mcpConfigHint: string | null;
  /** How the user invokes the skill inside the harness. */
  readonly invoke: string;
  /** Short human-readable restart instruction. */
  readonly restart: string;
  readonly toolPrefix: ToolPrefix;
}

export const SKILL_FILENAME = 'loom-setup.md';

const HOME = homedir();

export const INSTALL_TARGETS: Readonly<Record<InstallTargetKey, InstallTarget>> = {
  'claude-code': {
    key: 'claude-code',
    label: 'Claude Code',
    skillDir: join(HOME, '.claude', 'skills'),
    mcpConfigHint: '~/.claude.json or .mcp.json in the project root',
    invoke: '/loom-setup',
    restart: 'restart Claude Code (close and reopen)',
    toolPrefix: 'mcp__loom__',
  },
  'codex': {
    key: 'codex',
    label: 'Codex',
    skillDir: join(HOME, '.agents', 'skills'),
    mcpConfigHint: '~/.codex/config.toml',
    invoke: 'use the loom-setup skill',
    restart: 'restart the Codex session',
    // mcp__loom__, not mcp_loom_: a live Codex session's own tool catalog
    // names it mcp__loom__identity (t-397, verified 2026-09-05 by mark).
    // Matches the MCP-native double-underscore convention claude-code and
    // gemini-cli also use — single-underscore is a Hermes/OpenClaw/NemoClaw
    // quirk (docs/archive/specs/2026-04-20-filesystem-injection-design.md).
    toolPrefix: 'mcp__loom__',
  },
  'gemini-cli': {
    key: 'gemini-cli',
    label: 'Gemini CLI',
    skillDir: join(HOME, '.agents', 'skills'),
    mcpConfigHint: '~/.gemini/settings.json',
    invoke: 'use the loom-setup skill',
    restart: 'exit and restart Gemini CLI',
    // mcp__loom__: same MCP-native convention as codex above; src/clients.ts
    // and the injection adapter already treat gemini-cli this way (t-397).
    toolPrefix: 'mcp__loom__',
  },
  'opencode': {
    key: 'opencode',
    label: 'OpenCode',
    skillDir: join(HOME, '.agents', 'skills'),
    mcpConfigHint: '~/.config/opencode/config.json',
    invoke: 'use the loom-setup skill',
    restart: 'restart OpenCode',
    toolPrefix: 'loom_',
  },
  'other': {
    key: 'other',
    label: 'Other (dump skill file to cwd)',
    skillDir: null,
    mcpConfigHint: null,
    invoke: 'tell your agent to read loom-setup-skill.md and follow it',
    restart: 'restart your harness after it finishes setup',
    toolPrefix: 'mcp_loom_',
  },
};

export const INSTALL_TARGET_KEYS: readonly InstallTargetKey[] = [
  'claude-code',
  'codex',
  'gemini-cli',
  'opencode',
  'other',
];

export function isInstallTargetKey(s: string): s is InstallTargetKey {
  return (INSTALL_TARGET_KEYS as readonly string[]).includes(s);
}

export function getInstallTarget(key: InstallTargetKey): InstallTarget {
  return INSTALL_TARGETS[key];
}

/**
 * Resolve the skill file path for a target. Returns `null` for `other`
 * (caller handles the dump-to-cwd branch). `home` overrides `homedir()`
 * for tests.
 */
export function resolveSkillPath(t: InstallTarget, home?: string): string | null {
  if (t.skillDir === null) return null;
  if (home === undefined) return join(t.skillDir, SKILL_FILENAME);
  switch (t.key) {
    case 'claude-code': return join(home, '.claude', 'skills', SKILL_FILENAME);
    case 'codex':
    case 'gemini-cli':
    case 'opencode':    return join(home, '.agents', 'skills', SKILL_FILENAME);
    case 'other':       return null;
  }
}
