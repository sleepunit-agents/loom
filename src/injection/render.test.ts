import { describe, it, expect } from 'vitest';
import { HARNESSES } from './harnesses.js';
import { renderBlock, hashBlockContent } from './render.js';

describe('hashBlockContent', () => {
  it('produces a 16-char hex string', () => {
    const h = hashBlockContent('some inner content\n');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for equal inputs', () => {
    const inner = 'same content\n';
    expect(hashBlockContent(inner)).toBe(hashBlockContent(inner));
  });

  it('differs for different inputs', () => {
    expect(hashBlockContent('content A\n')).not.toBe(hashBlockContent('content B\n'));
  });
});

describe('renderBlock', () => {
  const contextDir = '/home/agent/.config/loom/art';

  it('emits both start and end markers', () => {
    const block = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(block).toMatch(/<!-- loom:start v1 harness=claude-code -->/);
    expect(block).toMatch(/<!-- loom:end -->/);
  });

  it('start marker carries harness key, end marker is bare', () => {
    for (const harness of Object.values(HARNESSES)) {
      const block = renderBlock(harness, contextDir);
      expect(block).toContain(`<!-- loom:start v1 harness=${harness.key} -->`);
      expect(block).toContain('<!-- loom:end -->');
    }
  });

  it('interpolates the tool prefix into the MCP section', () => {
    const block = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(block).toContain('`mcp__loom__identity`');
    expect(block).toContain('`mcp__loom__recall`');
    expect(block).toContain('`mcp__loom__remember`');
  });

  it('renders Gemini CLI calls with its single-underscore namespace (t-397)', () => {
    // gemini-cli joins server + '_' + tool and prepends 'mcp_'
    // (MCP_QUALIFIED_NAME_SEPARATOR / generateValidName, packages/core/src/tools/mcp-tool.ts @ b25669d).
    const block = renderBlock(HARNESSES['gemini-cli'], contextDir);
    expect(block).toContain('`mcp_loom_identity`');
    expect(block).not.toContain('mcp__loom__');
  });

  it('renders Codex calls with the double-underscore namespace (t-397)', () => {
    const block = renderBlock(HARNESSES['codex'], contextDir);
    expect(block).toContain('`mcp__loom__identity`');
  });

  it('interpolates the literal context dir', () => {
    const block = renderBlock(HARNESSES['gemini-cli'], contextDir);
    expect(block).toContain(`Context dir: ${contextDir}`);
  });

  it('ends with exactly one trailing newline', () => {
    const block = renderBlock(HARNESSES['codex'], contextDir);
    expect(block.endsWith('\n')).toBe(true);
    expect(block.endsWith('\n\n')).toBe(false);
  });

  it('output is byte-identical across repeat calls (deterministic)', () => {
    const a = renderBlock(HARNESSES['claude-code'], contextDir);
    const b = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(a).toBe(b);
  });

  it('embeds a <!-- loom:hash --> line before the end marker', () => {
    const block = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(block).toMatch(/<!-- loom:hash [0-9a-f]{16} -->/);
    // Hash line must appear before end marker
    const hashIdx = block.indexOf('<!-- loom:hash ');
    const endIdx = block.indexOf('<!-- loom:end -->');
    expect(hashIdx).toBeGreaterThan(0);
    expect(hashIdx).toBeLessThan(endIdx);
  });

  it('hash changes when contextDir changes', () => {
    const a = renderBlock(HARNESSES['claude-code'], '/ctx/one');
    const b = renderBlock(HARNESSES['claude-code'], '/ctx/two');
    const hashA = a.match(/<!-- loom:hash ([0-9a-f]{16}) -->/)?.[1];
    const hashB = b.match(/<!-- loom:hash ([0-9a-f]{16}) -->/)?.[1];
    expect(hashA).toBeDefined();
    expect(hashB).toBeDefined();
    expect(hashA).not.toBe(hashB);
  });

  it('contains the "prefer MCP, fall back to CLI" phrasing', () => {
    const block = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(block).toContain('prefer the MCP tool if available');
    expect(block).toContain('Shell fallback');
    expect(block).toContain('loom wake');
  });
});
