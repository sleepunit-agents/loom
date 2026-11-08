/**
 * Harness preset table for `loom inject`. Each entry names a target
 * harness, its canonical default path, and the MCP tool prefix to emit
 * in the injected instruction block.
 *
 * toolPrefix is NOT redeclared here — it's read from
 * `src/install/harnesses.ts`'s INSTALL_TARGETS, which is the single
 * source of truth for the prefix per harness (t-397: the two tables used
 * to carry independent, disagreeing hardcoded values for codex).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_TARGETS } from '../install/harnesses.js';

export type HarnessKey = 'claude-code' | 'codex' | 'gemini-cli';

export interface HarnessPreset {
  readonly key: HarnessKey;
  readonly display: string;
  readonly defaultPath: string;
  readonly toolPrefix: string;
}

export const HARNESS_KEYS: readonly HarnessKey[] = [
  'claude-code',
  'codex',
  'gemini-cli',
];

export const HARNESSES: Readonly<Record<HarnessKey, HarnessPreset>> = {
  'claude-code': {
    key: 'claude-code',
    display: 'Claude Code',
    defaultPath: join(homedir(), '.claude', 'CLAUDE.md'),
    toolPrefix: INSTALL_TARGETS['claude-code'].toolPrefix,
  },
  'codex': {
    key: 'codex',
    display: 'Codex',
    defaultPath: join(homedir(), '.codex', 'AGENTS.md'),
    toolPrefix: INSTALL_TARGETS['codex'].toolPrefix,
  },
  'gemini-cli': {
    key: 'gemini-cli',
    display: 'Gemini CLI',
    defaultPath: join(homedir(), '.gemini', 'GEMINI.md'),
    toolPrefix: INSTALL_TARGETS['gemini-cli'].toolPrefix,
  },
};

export function isHarnessKey(s: string): s is HarnessKey {
  return (HARNESS_KEYS as readonly string[]).includes(s);
}

/**
 * Resolve the injection path for a harness given an optional HOME override.
 * Default path is cached from homedir() at module load; this resolver
 * lets callers (CLI args, tests passing { HOME }) redirect the base
 * without mutating the frozen preset.
 */
export function resolveHarnessPath(
  harness: HarnessPreset,
  home?: string,
): string {
  const base = home ?? homedir();
  if (base === homedir()) return harness.defaultPath;
  switch (harness.key) {
    case 'claude-code': return join(base, '.claude', 'CLAUDE.md');
    case 'codex':       return join(base, '.codex', 'AGENTS.md');
    case 'gemini-cli':  return join(base, '.gemini', 'GEMINI.md');
  }
}
