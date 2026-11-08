/**
 * Convert a glob pattern (with `*` wildcards) into a predicate function.
 * Case-insensitive. `*` matches any sequence of characters.
 *
 * Examples:
 *   "Forgejo sweep*"  → matches "Forgejo sweep — 2026-04-01 (sixty-first)"
 *   "*loom*"          → matches "loom PR #48 — stall detection"
 *   "exact title"     → matches only "exact title"
 */
export function globToMatcher(pattern: string): (value: string) => boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return (value: string) => regex.test(value);
}
