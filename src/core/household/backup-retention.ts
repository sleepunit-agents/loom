/** Pure next-side retention planning. No target IO or authority to prune. */

function validStamp(stamp: string): boolean {
  if (typeof stamp !== 'string' || !/^\d{8}-\d{4}$/.test(stamp)) return false;
  const year = Number(stamp.slice(0, 4)), month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8)), hour = Number(stamp.slice(9, 11)), minute = Number(stamp.slice(11));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60;
}

/** Inventory stamps already encode nights in the configured backup time zone:
 * YYYYMMDD-HHMM. Caller supplies only successfully published, verified bundles,
 * after publishing the new one. Parts of a bundle share a stamp; duplicate
 * stamps are collapsed. This does not inspect files or prove completeness.
 *
 * Retain the newest try of each of the latest `keep` nights, plus the newest
 * try of the earliest available night of every month. Other tries of retained
 * nights are pruned too. All output is sorted and independent of input order.
 * Unknown/malformed inventory or invalid keep refuses the entire plan.
 *
 * A plan is data, never deletion authority: the future publisher must establish
 * target ownership, recheck the execution boundary, verify the new ciphertext
 * publication and map a stamp to ALL of its parts before performing retention.
 */
export function planHouseholdBackupRetention(stamps: readonly string[], keep: number): { retain: string[]; prune: string[] } {
  if (!Number.isInteger(keep) || keep < 1 || keep > 90 || !Array.isArray(stamps)) throw new Error('Invalid household backup retention input');
  // Snapshot and validate before producing any decision. Sparse arrays also
  // refuse: an omitted inventory entry is not a successful empty inventory.
  const inventory = [...stamps];
  if (inventory.some(stamp => !validStamp(stamp))) throw new Error('Invalid household backup retention input');
  const unique = [...new Set(inventory)].sort();
  const newestByNight = new Map<string, string>();
  const firstByMonth = new Map<string, string>();
  for (const stamp of unique) {
    const night = stamp.slice(0, 8), month = stamp.slice(0, 6);
    newestByNight.set(night, stamp);
    if (!firstByMonth.has(month)) firstByMonth.set(month, night);
  }
  const nights = [...newestByNight.keys()];
  const retainedNights = new Set([...nights.slice(-keep), ...firstByMonth.values()]);
  const retained = new Set([...retainedNights].map(night => newestByNight.get(night)!));
  return { retain: unique.filter(stamp => retained.has(stamp)), prune: unique.filter(stamp => !retained.has(stamp)) };
}
