/**
 * Memory list tool — browse memories without semantic search.
 *
 * Lists memories with optional category/project filters. Unlike recall,
 * this doesn't require a search query — useful for auditing, browsing,
 * and memory maintenance.
 */
import { createBackend } from '../backends/index.js';
import type { ListInput, MemoryEntry } from '../backends/types.js';

export function formatEntry(e: MemoryEntry): string {
  const projectTag = e.project ? ` [${e.project}]` : '';
  const confidenceTag =
    e.confidence !== undefined ? ` · confidence ${e.confidence.toFixed(2)} (${e.evidenceCount} obs)` : '';
  return `- **${e.title}** — ${e.category}${projectTag} (${e.created.slice(0, 10)})${confidenceTag}\n  ref: \`${e.ref}\``;
}

export function formatEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return 'No memories found.';
  const formatted = entries.map(formatEntry);
  return `Found ${entries.length} memories:\n\n${formatted.join('\n')}`;
}

export async function memoryList(
  contextDir: string,
  input: ListInput,
): Promise<string> {
  const backend = createBackend(contextDir);
  const entries = await backend.list(input);
  return formatEntries(entries);
}
