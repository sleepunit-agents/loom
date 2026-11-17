/**
 * Where an agent's memory files are, and which embedding model reads them.
 *
 * What is left of the older program's configuration: the memory backends still take a context directory
 * (the agent's own folder, holding memories.db) and these few answers about it.
 */
import { resolve, basename } from 'node:path';
import { realpathSync } from 'node:fs';

/** Trusted private-store selection; null is standalone, undefined preserves legacy overrides. */
export type MemorySelection = { agent?: string } | null;

// Explicit composition always uses the selected context's private store.
// Undefined keeps the legacy process-wide override for existing callers.
export function resolveSqliteDbPath(contextDir: string, selection?: MemorySelection): string {
  return (selection === undefined ? process.env.LOOM_SQLITE_DB_PATH : undefined) ?? resolve(contextDir, 'memories.db');
}

/**
 * The acting identity's name, for attribution on knowledge pages and their revisions. Derived here, never taken
 * from a tool argument, which any caller could set.
 *
 * A selection supplies the agent from household data (or null for standalone) and never reads LOOM_IDENTITY.
 * With no selection, LOOM_IDENTITY overrides; otherwise it is the context directory's real name, so a symlink
 * alias resolves to the agent it points at.
 */
export function resolveIdentityName(contextDir: string, selection?: { agent?: string } | null): string {
  if (selection?.agent !== undefined) return selection.agent;
  if (selection === undefined && process.env.LOOM_IDENTITY) return process.env.LOOM_IDENTITY;
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

export function resolveFastEmbedModel(): string {
  return process.env.LOOM_FASTEMBED_MODEL ?? 'fast-bge-small-en-v1.5';
}

export function resolveFastEmbedCacheDir(): string | undefined {
  return process.env.LOOM_FASTEMBED_CACHE_DIR || undefined;
}
