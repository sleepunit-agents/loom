import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from './types.js';

describe('parseFrontmatter', () => {
  it('returns empty frontmatter and body verbatim when no fences are present', () => {
    const text = '# Heading\n\nPlain body.';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
  });

  it('parses simple key:value pairs between --- fences', () => {
    const text = '---\nharness: claude-code\nversion: 0.4\n---\n\n## Section\nhello';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({ harness: 'claude-code', version: '0.4' });
    expect(body).toBe('\n## Section\nhello');
  });

  it('trims whitespace around keys and values', () => {
    const text = '---\n  harness :   claude-code  \n---\nbody';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.harness).toBe('claude-code');
  });

  it('ignores malformed frontmatter lines silently', () => {
    const text = '---\nharness: claude-code\nno-colon-here\nversion: 0.4\n---\nbody';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter).toEqual({ harness: 'claude-code', version: '0.4' });
  });

  it('leaves frontmatter empty and body intact when the closing fence is missing', () => {
    const text = '---\nharness: claude-code\nbody without closing fence';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
  });

  it('supports values containing colons after the first one', () => {
    const text = '---\nnote: time is 08:30 CT\n---\nbody';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.note).toBe('time is 08:30 CT');
  });

  it('normalizes CRLF line endings before parsing', () => {
    const text = '---\r\nharness: claude-code\r\nversion: 0.4\r\n---\r\n\r\n## Section\r\nhello';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({ harness: 'claude-code', version: '0.4' });
    expect(body).toContain('## Section');
  });
});
