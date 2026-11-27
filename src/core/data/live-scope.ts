import type { WrittenTables } from './table-tracker.js';

/** How open live selections are matched to commits (t-2431). `off` (the default): every commit reads every open
 * selection again, and no tables are tracked. `shadow`: the same readings, and beside them the decision scoping
 * would make, checked against what each reading actually returned (./live.ts). Nothing acts on that decision yet,
 * so there is no `on`: the value is refused rather than quietly taken for one of these. */
export type LiveScope = 'off' | 'shadow';
export function liveScope(env: NodeJS.ProcessEnv = process.env): LiveScope {
  const value = env.LOOM_LIVE_SCOPE?.trim().toLowerCase();
  if (!value || value === 'off') return 'off';
  if (value === 'shadow') return 'shadow';
  if (value === 'on') throw new Error('LOOM_LIVE_SCOPE=on is not built yet (t-2431 ships off and shadow only); use off or shadow');
  throw new Error(`LOOM_LIVE_SCOPE must be off or shadow, not ${JSON.stringify(env.LOOM_LIVE_SCOPE)}`);
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
