import type { WrittenTables } from './table-tracker.js';

/** How open live selections are matched to commits (t-2431). `off`: every commit reads every open selection
 * again, and no tables are tracked. `shadow`: the same readings, and beside them the decision scoping would make,
 * checked against what each reading actually returned (./live.ts). `on`: a selection is read again only when a
 * committed write touched a table its last reading read; a reading that depended on anything else (the clock,
 * another database, in-process state, a statement whose tables are not known) and a write whose tables are not
 * known still wake it on every commit, as `off` does. Unset is `on`; anything else is refused at startup rather
 * than quietly taken for one of these. LOOM_LIVE_SCOPE=off is the way back if an open window ever looks stale. */
export type LiveScope = 'off' | 'shadow' | 'on';
export function liveScope(env: NodeJS.ProcessEnv = process.env): LiveScope {
  const value = env.LOOM_LIVE_SCOPE?.trim().toLowerCase();
  if (!value || value === 'on') return 'on';
  if (value === 'off' || value === 'shadow') return value;
  throw new Error(`LOOM_LIVE_SCOPE must be off, shadow or on, not ${JSON.stringify(env.LOOM_LIVE_SCOPE)}`);
}

/** A reading scoping would have skipped, whose answer nonetheless changed. */
export interface LiveScopeViolation {
  selection: string;
  /** The tables the previous reading read: what scoping took the selection to depend on. */
  read: string[];
  /** What was written since that reading. */
  written: string[] | 'unknown';
}

const found: LiveScopeViolation[] = [];
/** Violations seen in this process; test-setup.ts fails the test that left any. */
export function liveScopeViolations(): LiveScopeViolation[] { return found.splice(0); }

export function describeWritten(written: WrittenTables): string[] | 'unknown' { return written === 'unknown' ? written : [...written].sort(); }

/** Under vitest a violation throws, so the test that found it fails (and it is kept for test-setup.ts in case the
 * throw is caught on its way out). Elsewhere it is logged. */
export function reportViolation(violation: LiveScopeViolation, log: (line: string) => void = line => { console.warn(line); }): void {
  const line = `live scope violation: ${violation.selection} read [${violation.read.join(', ')}], written ${violation.written === 'unknown' ? 'unknown' : `[${violation.written.join(', ')}]`}`;
  if (process.env.VITEST) { found.push(violation); throw new Error(line); }
  log(line);
}
