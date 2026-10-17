/**
 * Maximal Marginal Relevance (MMR) re-ranking for recall.
 *
 * A well-covered topic in a store of hundreds of memories yields a top-k
 * that is mostly the same fact restated. MMR trades a little relevance for
 * coverage: each pick maximises
 *
 *   score(c) = λ·relevance(c) − (1−λ)·max_{s ∈ selected} sim(c, s)
 *
 * greedily until `limit` results are chosen. `sim` is cosine similarity
 * between the candidates' stored embedding vectors, so "near-duplicate" is
 * judged in the same space the search ranked in — not by text overlap.
 *
 * The knob exposed to callers is `diversity = 1 − λ` (0..1). At 0 the
 * candidates come back in their original relevance order, untouched. The
 * idea is borrowed from xai-org/grok-build's memory search (Apache-2.0;
 * idea only, no code).
 */

export interface MmrCandidate {
  /** Search relevance, higher is better (loom uses 1 − cosine distance). */
  relevance: number;
  /** The candidate's embedding, used for pairwise similarity. */
  vector: ArrayLike<number>;
}

export interface MmrResult<T> {
  /** Chosen candidates in selection order (first pick = most relevant). */
  selected: T[];
  /**
   * How many of the top-`limit` candidates by relevance were displaced by
   * a less-relevant-but-different one. 0 means MMR changed nothing.
   */
  diversityDrops: number;
}

/** Default `diversity` (1 − λ) for recall: λ = 0.7. */
export const DEFAULT_DIVERSITY = 0.3;

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  // A zero-length vector is the "no embedding available" sentinel (e.g. a
  // lookup miss in the caller) — treat it as no similarity, same as before.
  // A mismatch between two REAL vectors means the embedding dimension
  // changed between model versions somewhere upstream; silently comparing
  // the overlapping prefix (the old Math.min(a.length, b.length) behavior)
  // hid that corruption instead of catching it. Raise instead (t-334).
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dimension mismatch (${a.length} vs ${b.length}) — embeddings from different model versions can't be compared`,
    );
  }
  const n = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Greedy MMR selection over a relevance-ordered candidate pool.
 *
 * Leaves the pool untouched (returns the first `limit` as-is) when
 * `diversity` is 0 or there are no more candidates than `limit` — there is
 * nothing to trade off in either case, and callers rely on the old
 * ordering surviving both.
 */
export function mmrSelect<T extends MmrCandidate>(
  candidates: readonly T[],
  limit: number,
  diversity: number = DEFAULT_DIVERSITY,
): MmrResult<T> {
  if (!(limit > 0)) return { selected: [], diversityDrops: 0 };
  if (!(diversity > 0) || candidates.length <= limit) {
    return { selected: candidates.slice(0, limit), diversityDrops: 0 };
  }
  const lambda = 1 - Math.min(diversity, 1);

  const remaining = candidates.map((_, i) => i);
  const chosen: number[] = [];
  // maxSim[i]: similarity of candidate i to the closest already-selected item.
  const maxSim = new Float64Array(candidates.length);

  while (chosen.length < limit && remaining.length > 0) {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const i of remaining) {
      const penalty = chosen.length === 0 ? 0 : maxSim[i];
      const score = lambda * candidates[i].relevance - (1 - lambda) * penalty;
      // Strict > keeps the earlier (more relevant) candidate on ties.
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    chosen.push(best);
    remaining.splice(remaining.indexOf(best), 1);
    const pickedVec = candidates[best].vector;
    for (const i of remaining) {
      const s = cosineSimilarity(candidates[i].vector, pickedVec);
      if (s > maxSim[i]) maxSim[i] = s;
    }
  }

  const topByRelevance = candidates
    .map((_, i) => i)
    .sort((a, b) => candidates[b].relevance - candidates[a].relevance || a - b)
    .slice(0, limit);
  const chosenSet = new Set(chosen);
  const diversityDrops = topByRelevance.filter((i) => !chosenSet.has(i)).length;

  return { selected: chosen.map((i) => candidates[i]), diversityDrops };
}
