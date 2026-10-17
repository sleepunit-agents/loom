import { describe, it, expect } from 'vitest';
import { computeUniqKey } from './dedup.js';

describe('computeUniqKey', () => {
  it('is stable for identical input', () => {
    const input = { category: 'project', title: 'Loom rescue plan', content: 'Migrate to sqlite-vec' };
    expect(computeUniqKey(input)).toBe(computeUniqKey(input));
  });

  it('ignores only edge whitespace, trailing spaces on a line, and line-ending style', () => {
    const a = computeUniqKey({
      category: 'project',
      title: 'Loom rescue plan',
      content: 'Migrate from Qdrant to sqlite-vec.\nThen cut over.',
    });
    const b = computeUniqKey({
      category: 'project',
      title: '  Loom rescue plan\t',
      content: '\nMigrate from Qdrant to sqlite-vec.  \r\nThen cut over.\n',
    });
    expect(a).toBe(b);
  });

  it('treats canonically equivalent Unicode (NFC vs NFD) as the same text', () => {
    const a = computeUniqKey({ category: 'project', title: 'Caf\u00e9', content: 'x' });
    const b = computeUniqKey({ category: 'project', title: 'Cafe\u0301', content: 'x' });
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
});

describe('computeUniqKey — meaning-bearing characters (PR120 review, round 2)', () => {
  it('keeps a sign: "Offset -5" and "Offset 5" stay distinct', () => {
    const a = computeUniqKey({ category: 'project', title: 'Offset', content: 'Offset -5' });
    const b = computeUniqKey({ category: 'project', title: 'Offset', content: 'Offset 5' });
    expect(a).not.toBe(b);
  });

  it('keeps a decimal point: "Version 1.5" and "Version 15" stay distinct', () => {
    const a = computeUniqKey({ category: 'project', title: 'Version', content: 'Version 1.5' });
    const b = computeUniqKey({ category: 'project', title: 'Version', content: 'Version 15' });
    expect(a).not.toBe(b);
  });

  it('keeps project identifiers exact: "foo-bar" and "foobar" stay distinct', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'C', project: 'foo-bar' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'C', project: 'foobar' });
    expect(a).not.toBe(b);
  });

  it('keeps project identifiers exact: case and surrounding whitespace count', () => {
    const base = { category: 'project', title: 'T', content: 'C' };
    const keys = [
      computeUniqKey({ ...base, project: 'loom' }),
      computeUniqKey({ ...base, project: 'Loom' }),
      computeUniqKey({ ...base, project: ' loom' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps word boundaries: "foo bar" and "foobar" stay distinct', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'foo bar' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'foobar' });
    expect(a).not.toBe(b);
  });

  it('keeps case: "US" and "us" stay distinct', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'US' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'us' });
    expect(a).not.toBe(b);
  });

  it('keeps compatibility characters: "x²" and "x2" stay distinct (no NFKC)', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'x\u00b2' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'x2' });
    expect(a).not.toBe(b);
  });

  it('keeps leading indentation inside content', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'if x:\n    y()\nz()' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'if x:\n    y()\n    z()' });
    expect(a).not.toBe(b);
  });

  it('keeps internal runs of whitespace', () => {
    const a = computeUniqKey({ category: 'project', title: 'T', content: 'a  b' });
    const b = computeUniqKey({ category: 'project', title: 'T', content: 'a b' });
    expect(a).not.toBe(b);
  });
});

describe('computeUniqKey — scope (#129 interaction)', () => {
  it('differs when effective scope differs', () => {
    const base = { category: 'project', title: 'T', content: 'C', project: 'loom' };
    expect(computeUniqKey(base)).not.toBe(computeUniqKey({ ...base, scope: 'global' }));
  });

  it('is the same when an explicit scope equals the category default', () => {
    const base = { category: 'project', title: 'T', content: 'C', project: 'loom' };
    expect(computeUniqKey(base)).toBe(computeUniqKey({ ...base, scope: 'project' }));
    const user = { category: 'user', title: 'T', content: 'C', project: 'loom' };
    expect(computeUniqKey(user)).toBe(computeUniqKey({ ...user, scope: 'global' }));
  });
});
