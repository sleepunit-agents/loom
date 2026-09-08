/**
 * Prune tool — removes expired memories and reports stale ones.
 *
 * Delegates to the configured memory backend for TTL-based cleanup.
 */
import { createBackend } from '../backends/index.js';
import type { PruneResult } from '../backends/types.js';



export async function prune(
  contextDir: string,
  options?: { dryRun?: boolean; staleDays?: number },
): Promise<string> {
  const backend = createBackend(contextDir);
  const result = await backend.prune(options);

  const lines: string[] = [];

  if (result.expired.length > 0) {
    const verb = options?.dryRun ? 'Would archive' : 'Archived';
    lines.push(`**${verb} ${result.expired.length} memories (TTL elapsed):**`);
    for (const ref of result.expired) {
      lines.push(`- ${ref}`);
    }
  }

  if (result.stale.length > 0) {
    lines.push(`\n**${result.stale.length} stale memories (not accessed in ${options?.staleDays ?? 30}+ days):**`);
    for (const ref of result.stale) {
      lines.push(`- ${ref}`);
    }
  }

  if (result.expired.length === 0 && result.stale.length === 0) {
    return 'No expired or stale memories found. Memory store is healthy.';
  }

  return lines.join('\n');
}
