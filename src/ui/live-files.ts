import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** fs.watch may report a readonly SQLite open as a WAL change. Compare the actual file instead.
 * Keep identity as well as nanosecond mtime and size: replacement and truncation must still tell.
 * Read errors are conservative (tell), except a known absence, which has a stable baseline.
 */
export function dataChanges(home: string, matches: RegExp) {
  const seen = new Map<string, string>();
  const fingerprint = (file: string): string | undefined => {
    try {
      const s = statSync(join(home, file), { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : undefined;
    }
  };
  const paths = (): string[] => {
    try { return readdirSync(home, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(home.length + 1))
      .filter((file) => matches.test(file)); }
    catch { return []; }
  };
  const moved = (file: string): boolean => {
    const now = fingerprint(file);
    const before = seen.get(file) ?? 'absent';
    if (now !== undefined) seen.set(file, now);
    return now === undefined || now !== before;
  };
  for (const file of paths()) {
    const value = fingerprint(file);
    if (value !== undefined) seen.set(file, value);
  }
  return {
    moved,
    // Run after watch registration: a write in the gap cannot silently become the baseline.
    reconcile: () => [...new Set([...seen.keys(), ...paths()])].filter(moved),
  };
}
