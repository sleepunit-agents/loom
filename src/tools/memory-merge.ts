/**
 * memory_merge tool — consolidate N memories into one canonical row.
 *
 * Acts on a memory_audit duplicate-finding: pick a survivor (target_ref) and
 * fold the rest (source_refs) into it. Sources are archived with a
 * tombstone pointing at the target and the supersession edge is recorded in
 * memory_supersessions (same table supersede() writes to) — merge is just
 * supersede() for N sources instead of one, plus times_seen consolidation
 * and (optionally) body concatenation. Distinct from forget/archive, which
 * only discard one side of a duplicate pair rather than consolidating it.
 */
import { createBackend } from '../backends/index.js';
import type { MemoryMergeInput } from '../backends/types.js';

export async function memoryMerge(
  contextDir: string,
  input: MemoryMergeInput,
): Promise<string> {
  if (!input.source_refs || input.source_refs.length === 0) {
    return 'Error: source_refs must not be empty.';
  }

  const backend = createBackend(contextDir);
  try {
    const result = await backend.mergeMemories(input);

    const lines: string[] = [
      `Merged ${result.sources_merged} memory(ies) into \`${result.target_ref}\`.`,
      `times_seen on the survivor: ${result.times_seen}.`,
      `Losers archived: ${result.losers.map((l) => `\`${l.ref}\``).join(', ')}.`,
    ];

    if (!input.append_loser_bodies && result.losers.length > 0) {
      lines.push('');
      lines.push('Loser bodies (target content NOT modified — review before discarding):');
      for (const loser of result.losers) {
        lines.push(`\n**${loser.ref}** (*${loser.title}*):\n${loser.content}`);
      }
    }

    return lines.join('\n');
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  } finally {
    backend.close();
  }
}
