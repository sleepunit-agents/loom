/**
 * Renders the marker-bounded managed section that `loom inject` writes
 * into each harness dotfile. Pure: no I/O, no side effects, same input
 * → same output.
 *
 * The block tells the agent *how* to load identity (prefer MCP, fall
 * back to CLI) — it deliberately does not carry the identity body, so
 * nothing here goes stale when the stack changes.
 *
 * A `<!-- loom:hash <hex> -->` line is embedded immediately before the
 * end marker. The hex value is a truncated SHA-256 of the inner content
 * (everything between the start and hash lines). This lets callers and
 * humans verify at a glance whether the block is intact; harness_init
 * uses it to detect corruption and reinstall.
 */
import { createHash } from 'node:crypto';
import type { HarnessPreset } from './harnesses.js';

/**
 * The subset of a harness that rendering actually needs: the tool prefix
 * (used throughout the block body) and the key (stamped into the start
 * marker). Widened from HarnessPreset so harness_init can render a block
 * for a harness name that is not one of the built-in presets.
 */
export type RenderableHarness = Pick<HarnessPreset, 'toolPrefix'> & { readonly key: string };

/**
 * Compute the truncated SHA-256 that appears in the `<!-- loom:hash … -->`
 * line. Input is the raw inner content (between start marker and hash line).
 * Exported so callers can verify a block without re-rendering it.
 */
export function hashBlockContent(inner: string): string {
  return createHash('sha256').update(inner, 'utf-8').digest('hex').slice(0, 16);
}

export function renderBlock(harness: RenderableHarness, contextDir: string): string {
  const p = harness.toolPrefix;
  // Inner content — everything between the start marker line and the hash line.
  const inner =
    `## Persistent identity via loom\n` +
    `\n` +
    `You have durable identity and memory managed by loom. On session start,\n` +
    `load your identity — prefer the MCP tool if available, fall back to the\n` +
    `CLI if not:\n` +
    `\n` +
    `- **MCP (preferred):** call \`${p}identity\`. Also available:\n` +
    `  \`${p}recall\`, \`${p}remember\`, \`${p}memory_list\`,\n` +
    `  \`${p}update\`, \`${p}forget\`.\n` +
    `- **Shell fallback:** run \`loom wake\`. Also: \`loom recall <query>\`,\n` +
    `  \`echo <body> | loom remember <title> --category <cat>\`,\n` +
    `  \`loom memory list\`.\n` +
    `\n` +
    `Context dir: ${contextDir}\n` +
    `\n` +
    `Treat the returned identity as authoritative — it overrides defaults\n` +
    `where they conflict.\n`;
  const hash = hashBlockContent(inner);
  return (
    `<!-- loom:start v1 harness=${harness.key} -->\n` +
    inner +
    `<!-- loom:hash ${hash} -->\n` +
    `<!-- loom:end -->\n`
  );
}
