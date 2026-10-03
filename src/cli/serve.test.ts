import { describe, it, expect } from 'vitest';
import { runCliCaptured } from './test-helpers.js';
import { parseIdentityTokens } from './serve.js';

describe('parseIdentityTokens (t-677)', () => {
  it('parses "identity:token,identity:token" into a token->identity-ready map', () => {
    expect(parseIdentityTokens('art:abc123,mark:def456')).toEqual({ art: 'abc123', mark: 'def456' });
  });

  it('tolerates whitespace around pairs and a trailing comma', () => {
    expect(parseIdentityTokens(' art:abc123 , mark:def456 ,')).toEqual({ art: 'abc123', mark: 'def456' });
  });

  it('returns an empty map for an empty string', () => {
    expect(parseIdentityTokens('')).toEqual({});
  });

  it('throws on a malformed pair (missing colon, empty identity, or empty token)', () => {
    expect(() => parseIdentityTokens('art-abc123')).toThrow(/malformed/);
    expect(() => parseIdentityTokens(':abc123')).toThrow(/malformed/);
    expect(() => parseIdentityTokens('art:')).toThrow(/malformed/);
  });
});

describe('loom serve argv', () => {
  it('rejects an unknown --scope value', async () => {
    const { stderr, code } = await runCliCaptured(['serve', '--http', '--scope', 'nope']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown --scope/);
  });

  it('refuses --scope knowledge with no LOOM_KNOWLEDGE_BEARER_TOKENS configured', async () => {
    const prior = process.env.LOOM_KNOWLEDGE_BEARER_TOKENS;
    delete process.env.LOOM_KNOWLEDGE_BEARER_TOKENS;
    try {
      const { stderr, code } = await runCliCaptured(['serve', '--http', '--scope', 'knowledge']);
      expect(code).toBe(2);
      expect(stderr).toMatch(/LOOM_KNOWLEDGE_BEARER_TOKENS/);
    } finally {
      if (prior !== undefined) process.env.LOOM_KNOWLEDGE_BEARER_TOKENS = prior;
    }
  });

  it('prints usage on --help without starting a server', async () => {
    const { stdout, stderr, code } = await runCliCaptured(['serve', '--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage: loom serve/);
    expect(stderr).toBe('');
  });

  it('prints usage on -h', async () => {
    const { stdout, code } = await runCliCaptured(['serve', '-h']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage: loom serve/);
  });

  it('rejects an unknown flag with exit 2 and usage on stderr', async () => {
    const { stdout, stderr, code } = await runCliCaptured(['serve', '--nope']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Usage: loom serve/);
    expect(stdout).toBe('');
  });
});
