/**
 * Configuration — resolves directories and backend settings for a
 * given loom agent.
 *
 * The context directory is the agent's brain — everything
 * agent-specific lives here:
 *   IDENTITY.md       — the terminal creed (who this agent is)
 *   preferences.md    — user preferences and working style
 *   self-model.md     — agent capability tracking
 *   memories.db       — sqlite + sqlite-vec memory store (pursuits live here too, as category=pursuit)
 *
 * Context dir resolution order:
 *   1. LOOM_CONTEXT_DIR environment variable
 *   2. --context-dir CLI argument
 *   3. ~/.config/loom/default (fallback)
 */
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';

/**
 * The single canonical helper for the default context path. Every call
 * site that needs `~/.config/loom/default` must go through this —
 * no more duplicated literals in config.ts / args.ts / doctor.ts.
 */
export function resolveDefaultContextPath(home?: string): string {
  return resolve(home ?? homedir(), '.config', 'loom', 'default');
}

export function resolveContextDir(): string {
  if (process.env.LOOM_CONTEXT_DIR) {
    return resolve(process.env.LOOM_CONTEXT_DIR);
  }

  const argIdx = process.argv.indexOf('--context-dir');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    return resolve(process.argv[argIdx + 1]);
  }

  return resolveDefaultContextPath();
}

/**
 * Throws if the context dir is the default fallback path AND it has no
 * IDENTITY.md. This is the "fail loud instead of silent fallback" guard —
 * a blank-identity boot is only permitted when the caller explicitly opted
 * in via LOOM_CONTEXT_DIR or --context-dir pointing at a real (even empty)
 * dir. A missing/dangling/empty default must never silently serve a fresh-
 * agent skeleton.
 *
 * @param contextDir  The resolved context dir to validate.
 * @param defaultPath Override the default path (used in unit tests to avoid
 *                    depending on the real homedir).
 */
export function assertContextBootable(
  contextDir: string,
  defaultPath: string = resolveDefaultContextPath(),
): void {
  if (contextDir !== defaultPath) return;
  if (!existsSync(resolve(contextDir, 'IDENTITY.md'))) {
    throw new Error(
      'no loom context configured — refusing to serve a blank identity. ' +
      'Set LOOM_CONTEXT_DIR or run `loom bootstrap` to initialize an agent.',
    );
  }
}

/**
 * Resolve the loom repo root from the running module location.
 * Works from both src/ (dev via tsx) and dist/ (production).
 */
export function resolveRepoRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), '..');
}

export function resolveSqliteDbPath(contextDir: string): string {
  return process.env.LOOM_SQLITE_DB_PATH ?? resolve(contextDir, 'memories.db');
}

export function resolveKnowledgeDbPath(contextDir: string): string {
  return process.env.LOOM_KNOWLEDGE_DB_PATH ?? resolve(contextDir, 'knowledge.db');
}

/**
 * Resolve the acting identity's name for actor attribution (knowledge
 * pages.author / page_revisions.actor / verifications.verifier). This is
 * deliberately NOT a tool argument — an LLM-supplied free-text identity is
 * spoofable (any caller could claim to be any identity), so it is derived
 * server-side from the connection instead.
 *
 * LOOM_IDENTITY overrides explicitly (useful for the multi-identity
 * knowledge service, where each bearer token maps to a known identity).
 * Otherwise derived from the context dir's real path basename — this
 * resolves symlink aliases (e.g. `~/.config/loom/default` -> the real
 * `.../loom/art` dir) to the actual identity name rather than the alias.
 */
export function resolveIdentityName(contextDir: string): string {
  if (process.env.LOOM_IDENTITY) return process.env.LOOM_IDENTITY;
  try {
    return basename(realpathSync(contextDir));
  } catch {
    return basename(contextDir);
  }
}

/**
 * Local-only observation logs (e.g. `telemetry/recall.jsonl`). Lives inside
 * the context dir so it travels with the agent and never leaves the machine.
 */
export function resolveTelemetryDir(contextDir: string): string {
  return resolve(contextDir, 'telemetry');
}

/**
 * Assert that the knowledge database path does not co-locate with the memory
 * database path. If they resolve to the same file (or inode), throw.
 */
export function assertKnowledgePathsNotCoLocated(contextDir: string): void {
  const memPath = resolveSqliteDbPath(contextDir);
  const knPath = resolveKnowledgeDbPath(contextDir);

  if (memPath === knPath) {
    throw new Error(
      `Knowledge database path is the same as memory database path (${memPath}). ` +
      `This violates the isolation invariant. Set LOOM_SQLITE_DB_PATH or LOOM_KNOWLEDGE_DB_PATH to different files.`,
    );
  }

  // Also check inode-level co-location (hard links)
  let memStat: { ino: number; dev: number } | null = null;
  let knStat: { ino: number; dev: number } | null = null;
  try {
    memStat = statSync(memPath);
  } catch {
    // File doesn't exist yet
  }
  try {
    knStat = statSync(knPath);
  } catch {
    // File doesn't exist yet
  }
  if (memStat && knStat && memStat.ino === knStat.ino && memStat.dev === knStat.dev) {
    throw new Error(
      `Knowledge database (${knPath}) and memory database (${memPath}) ` +
      `are hard-linked to the same inode (${memStat.ino}). This violates the isolation invariant.`,
    );
  }
}

export function resolveFastEmbedModel(): string {
  return process.env.LOOM_FASTEMBED_MODEL ?? 'fast-bge-small-en-v1.5';
}

export function resolveFastEmbedCacheDir(): string | undefined {
  return process.env.LOOM_FASTEMBED_CACHE_DIR || undefined;
}

// ─── Stack version ────────────────────────────────────────────────────────────

/** The stack schema version this loom build understands. */
export const CURRENT_STACK_VERSION = 2;

/** The filename at the stack root that records the on-disk schema version. */
export const STACK_VERSION_FILE = 'LOOM_STACK_VERSION';

/**
 * Read the stack version stamp at `<contextDir>/LOOM_STACK_VERSION`.
 * Returns null if the file is missing, or NaN if the content doesn't parse.
 */
export function readStackVersion(contextDir: string): number | null {
  const path = resolve(contextDir, STACK_VERSION_FILE);
  if (!existsSync(path)) return null;
  return Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
}

/**
 * Lazy-write the current stack version if the stamp is missing. Does not
 * overwrite an existing file; the caller is responsible for validating
 * (and refusing) versions ahead of CURRENT_STACK_VERSION.
 */
export function ensureStackVersion(contextDir: string): void {
  const path = resolve(contextDir, STACK_VERSION_FILE);
  if (existsSync(path)) return;
  writeFileSync(path, `${CURRENT_STACK_VERSION}\n`, 'utf-8');
}

/**
 * Refuse to operate against a stack at a higher version than this build
 * understands; stamp the current version if the file is missing.
 */
export function assertStackVersionCompatible(contextDir: string): void {
  const onDisk = readStackVersion(contextDir);
  if (onDisk !== null) {
    if (Number.isNaN(onDisk)) {
      throw new Error(
        `LOOM_STACK_VERSION unparseable at ${contextDir}/${STACK_VERSION_FILE}. ` +
        `Expected an integer; got raw content.`,
      );
    }
    if (onDisk > CURRENT_STACK_VERSION) {
      throw new Error(
        `Stack at ${contextDir} is version ${onDisk}; ` +
        `this loom build understands up to v${CURRENT_STACK_VERSION}. Upgrade loom.`,
      );
    }
  }
  ensureStackVersion(contextDir);
}
