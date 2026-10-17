import { describe, it, expect } from 'vitest';
import { cosineSimilarity, mmrSelect, DEFAULT_DIVERSITY } from './mmr.js';

interface C { id: string; relevance: number; vector: number[] }

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/**
 * A pool where the top two by relevance are near-duplicates of each other
 * and the third is about something else. Relevance order: a > a2 > b > c.
 */
const pool: C[] = [
  { id: 'a',  relevance: 0.90, vector: unit([1, 0, 0]) },
  { id: 'a2', relevance: 0.88, vector: unit([0.98, 0.05, 0]) }, // ≈ duplicate of a
  { id: 'b',  relevance: 0.80, vector: unit([0, 1, 0]) },       // orthogonal to a
  { id: 'c',  relevance: 0.50, vector: unit([0, 0, 1]) },
];

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('is scale-invariant and 0 against a zero vector', () => {
    expect(cosineSimilarity([2, 2], [1, 1])).toBeCloseTo(1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('raises on a dimension mismatch instead of silently comparing a truncated prefix (t-334)', () => {
    // Pre-fix, Math.min(a.length, b.length) would score these as identical
    // (both reduce to the shared [1, 0] prefix) even though b carries real
    // signal in dimensions the model-version change added.
    expect(() => cosineSimilarity([1, 0], [1, 0, 1])).toThrow(/dimension mismatch/i);
    expect(() => cosineSimilarity([1, 0, 1], [1, 0])).toThrow(/dimension mismatch/i);
  });

  it('still treats a zero-length vector as the "no embedding" sentinel, not a mismatch', () => {
    // sqlite-vec.ts falls back to a length-0 vector when a lookup misses;
    // that's a distinct case from two real embeddings of different sizes
    // and must keep returning 0 rather than throwing.
    expect(cosineSimilarity([], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0, 0], [])).toBe(0);
  });
});

describe('mmrSelect', () => {
  it('displaces a near-duplicate with a less-relevant but different candidate', () => {
    const { selected, diversityDrops } = mmrSelect(pool, 2, DEFAULT_DIVERSITY);
    expect(selected.map((c) => c.id)).toEqual(['a', 'b']);
    expect(diversityDrops).toBe(1); // a2 was in the top-2 by relevance and got dropped
  });

  it('always leads with the most relevant candidate', () => {
    for (const d of [0.1, 0.3, 0.5, 0.9]) {
      expect(mmrSelect(pool, 3, d).selected[0].id).toBe('a');
    }
  });

  it('diversity=0 reproduces the original ranking exactly', () => {
    const { selected, diversityDrops } = mmrSelect(pool, 2, 0);
    expect(selected.map((c) => c.id)).toEqual(['a', 'a2']);
    expect(diversityDrops).toBe(0);
    expect(mmrSelect(pool, 10, 0).selected.map((c) => c.id)).toEqual(['a', 'a2', 'b', 'c']);
  });

  it('leaves the pool untouched when there are no more candidates than limit', () => {
    const { selected, diversityDrops } = mmrSelect(pool, 4, 0.9);
    expect(selected.map((c) => c.id)).toEqual(['a', 'a2', 'b', 'c']);
    expect(diversityDrops).toBe(0);
  });

  it('at the default λ prefers a new topic over a duplicate even at much lower relevance', () => {
    // a2: 0.7·0.88 − 0.3·sim(a2,a)≈0.316  <  c: 0.7·0.5 − 0.3·0 = 0.35
    const { selected, diversityDrops } = mmrSelect(pool, 3, DEFAULT_DIVERSITY);
    expect(selected.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(diversityDrops).toBe(1);
  });

  it('brings the duplicate back when diversity is low enough', () => {
    // λ=0.9: a2 scores 0.9·0.88 − 0.1·1 ≈ 0.69 against c's 0.45.
    const { selected } = mmrSelect(pool, 3, 0.1);
    expect(selected.map((c) => c.id)).toEqual(['a', 'b', 'a2']);
  });

  it('a tiny diversity keeps the relevance order when the gap is large', () => {
    // λ≈1: the 0.02 relevance gap between a and a2 outweighs a 0.01-weighted similarity.
    const { selected } = mmrSelect(pool, 2, 0.01);
    expect(selected.map((c) => c.id)).toEqual(['a', 'a2']);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(mmrSelect(pool, 0).selected).toEqual([]);
  });

  it('handles an empty pool', () => {
    expect(mmrSelect([], 5)).toEqual({ selected: [], diversityDrops: 0 });
  });
});
