/**
 * MCP tool handler for harness-manifest initialization.
 * Thin wrapper over src/blocks/harness.initHarness.
 *
 * When `target` is supplied the tool also writes a loom-managed block
 * (bounded by <!-- loom:start / loom:end --> markers with an embedded
 * <!-- loom:hash --> line) into that file.  Re-runnable: returns
 * "no-change" when the block is already present and intact, "updated"
 * when it was missing or corrupted.
 */
import { realpathSync } from 'node:fs';
import { initHarness, describeHarness, resolvePeerToHarness, normalizePeer } from '../blocks/harness.js';
import { renderBlock } from '../injection/render.js';
import { writeManagedBlock } from '../injection/writer.js';
import { HARNESSES, isHarnessKey } from '../injection/harnesses.js';

/** The instruction files a managed block may be written into: what harnesses read. */
const INSTRUCTION_FILES: ReadonlySet<string> = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CODEX.md', 'QWEN.md', 'CLAUDE.local.md']);

/**
 * Why `target` may not be written, or null. Over the network it never may:
 * the path is on the daemon's machine, and a caller who could name it could
 * write into another agent's stack or a shell rc file. Locally it must be an
 * instruction file a harness reads, by name.
 */
export function harnessTargetError(target: string, opts: { remote: boolean }, real = realTarget(target)): string | null {
  if (opts.remote) {
    return 'Error: harness_init can\'t write a target file over the network: the path would be on the loom server, not your machine. Run `loom inject --harness <name> --to <file>` on your own machine instead.';
  }
  if (/[\x00-\x1f\x7f]/.test(target)) return 'Error: target contains control characters.';
  for (const p of [target, real]) {
    const base = p.split(/[\\/]/).pop() ?? '';
    if (!INSTRUCTION_FILES.has(base)) {
      return `Error: target must be a harness instruction file (${[...INSTRUCTION_FILES].join(', ')}), not ${JSON.stringify(base)}.`;
    }
  }
  return null;
}

/**
 * Where a target really is: through a symlink (a dotfiles repo's CLAUDE.md),
 * so the rule above applies to the file actually written, and the write goes
 * there instead of replacing the link.
 */
export function realTarget(target: string): string {
  try { return realpathSync(target); } catch { return target; }
}

export async function harnessInit(
  contextDir: string,
  input: { name: string; overwrite?: boolean; target?: string },
  opts: { remote?: boolean } = {},
): Promise<string> {
  // Resolve the target once; the path checked is the path written.
  const real = input.target !== undefined ? realTarget(input.target) : undefined;
  if (input.target !== undefined) {
    const err = harnessTargetError(input.target, { remote: opts.remote ?? false }, real);
    if (err) return err;
  }
  const manifestResult = await initHarness(contextDir, input.name, {
    overwrite: input.overwrite,
  });
  const lines = [`Harness manifest ${manifestResult.name}: ${manifestResult.path} (${manifestResult.action})`];

  if (input.target !== undefined) {
    const preset = isHarnessKey(input.name)
      ? HARNESSES[input.name]
      : { key: input.name, display: input.name, defaultPath: input.target, toolPrefix: 'mcp__loom__' as const };
    const block = renderBlock(preset, contextDir);
    const blockResult = await writeManagedBlock(real!, block);
    lines.push(`Managed block: ${blockResult.path} (${blockResult.action})`);
  }

  return lines.join('\n');
}

/**
 * MCP tool handler for harness self-description.
 *
 * SCOPING GUARD: the target is derived from the CONNECTED PEER, never a
 * caller-supplied arbitrary name. A connected harness can only write the
 * manifest it resolves to (data-driven) or a new one named by its own
 * clientInfo.name — it cannot write another harness's file. With no connected
 * peer (no clientInfo), the call is refused.
 */
export async function harnessDescribe(
  contextDir: string,
  input: { content: string; version?: string },
  peerName?: string,
): Promise<string> {
  if (!peerName) {
    return (
      'Error: harness_describe could not identify the connected peer — no MCP ' +
      'clientInfo.name on this connection. A harness may only describe itself, ' +
      'so there is no target to write.'
    );
  }
  const target = (await resolvePeerToHarness(contextDir, peerName)) ?? normalizePeer(peerName);
  if (!target) {
    return (
      `Error: harness_describe could not derive a manifest key from peer ` +
      `${JSON.stringify(peerName)}.`
    );
  }
  const result = await describeHarness(contextDir, target, input.content, {
    version: input.version,
  });
  return `Harness manifest ${result.key}: ${result.path} (${result.action})`;
}
