import { describe, it, expect } from 'vitest';
import { formatMatchResult, formatResults } from './recall.js';
import type { MemoryMatch } from '../backends/types.js';

describe('formatMatchResult', () => {
  const baseMatch: MemoryMatch = {
    path: 'project/2026-03-25-test.md',
    title: 'Test Memory',
    category: 'project',
    created: '2026-03-25T10:00:00.000Z',
    content: 'The body of the memory.',
    relevance: 1.5,
  };

  it('formats a match with title, metadata, and content', () => {
    const result = formatMatchResult(baseMatch);
    expect(result).toBe(
      '## Test Memory\n*project — 2026-03-25*\n\nThe body of the memory.',
    );
  });

  it('includes project tag when present', () => {
    const match: MemoryMatch = { ...baseMatch, project: 'vigil' };
    const result = formatMatchResult(match);
    expect(result).toContain('*project [vigil] — 2026-03-25*');
  });

  it('omits project tag when absent', () => {
    const result = formatMatchResult(baseMatch);
    expect(result).not.toContain('[');
  });

  it('includes sourcing tag when present', () => {
    const match: MemoryMatch = { ...baseMatch, sourcing: 'inferred' };
    const result = formatMatchResult(match);
    expect(result).toContain('· inferred');
  });

  it('includes provenance in parens when present', () => {
    const match: MemoryMatch = { ...baseMatch, sourcing: 'relayed', provenance: 'Jonathan, Discord #loom' };
    const result = formatMatchResult(match);
    expect(result).toContain('· relayed');
    expect(result).toContain('(Jonathan, Discord #loom)');
  });

  it('omits sourcing and provenance tags when absent', () => {
    const result = formatMatchResult(baseMatch);
    expect(result).not.toContain('·');
    expect(result).not.toContain('(');
  });
});

describe('formatResults', () => {
  const makeMatch = (title: string): MemoryMatch => ({
    path: 'test/file.md',
    title,
    category: 'user',
    created: '2026-01-01T00:00:00.000Z',
    content: 'Body',
    relevance: 1,
  });

  it('reports the correct count', () => {
    const result = formatResults([makeMatch('A'), makeMatch('B')]);
    expect(result).toMatch(/^Found 2 matching memories:/);
  });

  it('joins multiple results with --- separator', () => {
    const result = formatResults([makeMatch('A'), makeMatch('B')]);
    expect(result).toContain('---');
  });

  it('formats a single result without separator', () => {
    const result = formatResults([makeMatch('Only One')]);
    expect(result).toMatch(/^Found 1 matching memories:/);
    expect(result).not.toContain('---');
  });
});
