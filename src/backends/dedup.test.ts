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

describe('computeUniqKey — non-Latin text (PR120 review)', () => {
  it('keeps distinct CJK memories distinct (日本/東京 vs 中国/北京)', () => {
    const a = computeUniqKey({ category: 'project', title: '日本', content: '東京' });
    const b = computeUniqKey({ category: 'project', title: '中国', content: '北京' });
    expect(a).not.toBe(b);
  });

  it('keeps distinct Cyrillic, Greek and Arabic memories distinct', () => {
    const keys = [
      computeUniqKey({ category: 'project', title: 'Россия', content: 'Москва' }),
      computeUniqKey({ category: 'project', title: 'Украина', content: 'Киев' }),
      computeUniqKey({ category: 'project', title: 'Ελλάδα', content: 'Αθήνα' }),
      computeUniqKey({ category: 'project', title: 'مصر', content: 'القاهرة' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps combining marks: Devanagari words that differ only by a vowel sign stay distinct', () => {
    // कम (kam, "less") vs काम (kaam, "work") — the difference is U+093E, a
    // combining mark (\p{M}), not a letter.
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'कम' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'काम' });
    expect(a).not.toBe(b);
  });

  it('keeps symbol-only content distinct (emoji / operators are not punctuation)', () => {
    const a = computeUniqKey({ category: 'project', title: 'mood', content: '🙂' });
    const b = computeUniqKey({ category: 'project', title: 'mood', content: '🎉' });
    expect(a).not.toBe(b);
  });

  it('does not let a field separator inside a field alias two different splits', () => {
    const a = computeUniqKey({ category: 'project', title: 'a|b', content: 'c' });
    const b = computeUniqKey({ category: 'project', title: 'a', content: 'b|c' });
    expect(a).not.toBe(b);
  });

  it('still collapses case and whitespace in non-Latin text', () => {
    const a = computeUniqKey({ category: 'project', title: 'Москва', content: 'столица  России.' });
    const b = computeUniqKey({ category: 'project', title: 'МОСКВА', content: 'Столица России' });
    expect(a).toBe(b);
  });
});
