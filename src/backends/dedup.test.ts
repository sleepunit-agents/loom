import { describe, it, expect } from 'vitest';
import { computeUniqKey } from './dedup.js';

describe('computeUniqKey', () => {
  it('is stable for identical input', () => {
    const input = { category: 'project', title: 'Loom rescue plan', content: 'Migrate to sqlite-vec' };
    expect(computeUniqKey(input)).toBe(computeUniqKey(input));
  });

  it('is insensitive to case, punctuation, and whitespace differences', () => {
    const a = computeUniqKey({
      category: 'project',
      title: 'Loom rescue plan',
      content: 'Migrate from Qdrant to sqlite-vec.',
    });
    const b = computeUniqKey({
      category: 'project',
      title: '  LOOM, rescue-plan!! ',
      content: 'migrate   from qdrant to sqlite vec',
    });
    expect(a).toBe(b);
  });

  it('differs when title differs', () => {
    const a = computeUniqKey({ category: 'project', title: 'A', content: 'same body' });
    const b = computeUniqKey({ category: 'project', title: 'B', content: 'same body' });
    expect(a).not.toBe(b);
  });

  it('differs when content differs', () => {
    const a = computeUniqKey({ category: 'project', title: 'Same title', content: 'one' });
    const b = computeUniqKey({ category: 'project', title: 'Same title', content: 'two' });
    expect(a).not.toBe(b);
  });

  it('differs when category differs', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'C' });
    const b = computeUniqKey({ category: 'self', title: 'T', content: 'C' });
    expect(a).not.toBe(b);
  });

  it('differs when project scope differs', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'C', project: 'pond' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'C', project: 'loom' });
    expect(a).not.toBe(b);
  });

  it('treats a missing project the same as an empty one', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'C' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'C', project: '' });
    expect(a).toBe(b);
  });
});
