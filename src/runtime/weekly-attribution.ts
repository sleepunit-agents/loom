/** Allocate only the measured increase between consecutive readings of one provider window.
 * Before the first reading, or after a downward correction, usage has no observed interval. */
export function estimateWeeklyUsage(
  readings: readonly {at: number; usage: number}[],
  jobs: readonly {id: string; start: number; end: number; tokens: number | null}[],
) {
  const shares = new Map<string, number>();
  let unattributed = readings[0]?.usage ?? 0;
  for (let index = 1; index < readings.length; index++) {
    const before = readings[index - 1], after = readings[index];
    const delta = after.usage - before.usage;
    if (delta < 0) {
      shares.clear();
      unattributed = after.usage;
      continue;
    }
    if (!delta) continue;
    const weights = [];
    let missing = false, total = 0;
    for (const job of jobs) {
      const duration = job.end - job.start;
      const overlap = Math.min(job.end, after.at) - Math.max(job.start, before.at);
      // A runner can report both endpoints in the same clock tick. Assign that
      // point once, to (before, after], including when it has unknown usage.
      const point = duration === 0 && before.at < job.end && job.end <= after.at;
      if (!point && overlap <= 0) continue;
      if (job.tokens === null) { missing = true; break; }
      const weight = point ? job.tokens : job.tokens * (overlap / duration);
      weights.push({id: job.id, weight});
      total += weight;
    }
    if (missing || !total) {
      unattributed += delta;
      continue;
    }
    for (const {id, weight} of weights) {
      if (weight) shares.set(id, (shares.get(id) ?? 0) + delta * weight / total);
    }
  }
  return {shares, unattributed};
}
