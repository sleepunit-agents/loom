/**
 * find_similar tool — surface memories semantically near an existing ref or
 * free-form text. Built for consolidation workflows: feed an anchor and
 * inspect what overlaps with it.
 */
import { createBackend } from '../backends/index.js';
import { formatMatchResult } from './recall.js';
import type { FindSimilarInput, MemoryMatch } from '../backends/types.js';

function formatHeader(input: FindSimilarInput, count: number): string {
  const anchor = input.ref ? `ref ${input.ref}` : `text "${input.text}"`;
  return `Found ${count} memories near ${anchor}:`;
}

export function formatSimilarResults(
  input: FindSimilarInput,
  matches: MemoryMatch[],
): string {
  if (matches.length === 0) {
    const anchor = input.ref ? `ref ${input.ref}` : `text "${input.text}"`;
    return `No similar memories found for ${anchor}.`;
  }
  const body = matches
    .map((m) => `${formatMatchResult(m)}\n\n*relevance: ${m.relevance.toFixed(3)}*`)
    .join('\n\n---\n\n');
  return `${formatHeader(input, matches.length)}\n\n${body}`;
}

export async function findSimilar(
  contextDir: string,
  input: FindSimilarInput,
): Promise<string> {
  const backend = createBackend(contextDir);
  const matches = await backend.findSimilar(input);
  return formatSimilarResults(input, matches);
}
