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
    expect(mmrSelect([], 5)).toEqual({ selected: [], scores: [], diversityDrops: 0 });
  });

  it('exposes the blended score that drove each pick, aligned with `selected`', () => {
    // Untouched pool (diversity 0): the blended score is just each item's own relevance.
    const plain = mmrSelect(pool, 2, 0);
    expect(plain.scores).toEqual(plain.selected.map((c) => c.relevance));

    // MMR active: the blended score is NOT the raw relevance for a diversity-promoted pick.
    const { selected, scores } = mmrSelect(pool, 3, DEFAULT_DIVERSITY);
    expect(selected.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(scores).toHaveLength(3);
    const cIdx = selected.findIndex((c) => c.id === 'c');
    expect(scores[cIdx]).not.toBeCloseTo(selected[cIdx].relevance);
    expect(scores[cIdx]).toBeCloseTo(0.35, 2); // 0.7·0.5 − 0.3·0, per the comment above
  });
});
