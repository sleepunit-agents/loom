/**
 * Recorder health ledger (t-562, component split t-1382) — tracks consecutive
 * failures per component so one component's success can't mask another's streak.
 *
 * Components:
 *   - `episodes` — the episode write path (remember.ts) on success/failure, and
 *     the tape-read path (identity.ts catch) on failure.
 *   - `cards` — the person-card read path (people.ts roomBlock) on failure: a
 *     bad row or a store-open failure while building identity's room block.
 * Read by:
 *   - identity.ts, which appends one warning block per component below the
 *     identity payload when that component has failed FAILURE_THRESHOLD
 *     consecutive times. Each component resets only its own streak.
 *
 * Inspired by observer-health.ts in claude-mem @ fd0ecf0. The ledger is a
 * small JSON file in the context dir alongside memories.db — one per agent,
 * keyed by component. All reads/writes are synchronous and never throw: the
 * health ledger must never cascade into a deeper failure.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The things recordSuccess/recordFailure track separately (t-1382). */
export type RecorderComponent = 'episodes' | 'cards';

export const RECORDER_COMPONENTS: readonly RecorderComponent[] = ['episodes', 'cards'];

/** Human label for a component, used in the warning block's heading and body. */
const COMPONENT_LABEL: Record<RecorderComponent, string> = {
  episodes: 'episode recorder',
  cards: 'person-card reader',
};

/** What's at risk and how to exercise the path, specific to each component. */
const COMPONENT_IMPACT: Record<RecorderComponent, string> = {
  episodes:
    'Episodes may not be reaching the tape — future bodies will wake without context.\n' +
    'Check `~/.local/state/art-episodes/hook.log` and the loom episode store. ' +
    'Call `mcp__loom__remember` with category `episode` to exercise the write path.',
  cards:
    "Person cards in identity's room block may be unreadable — bodies addressed by " +
    'these people will wake without their card context.\n' +
    'Check the people table in the context\'s memories.db. Call `mcp__loom__person` ' +
    'to exercise the card-read path.',
};

export interface RecorderHealth {
  /** How many attempts for this component have failed in a row since lastSuccess. */
  consecutiveFailures: number;
  /** ISO timestamp of the first failure in the current streak, null when healthy. */
  failingSince: string | null;
  /** Scrubbed error string from the last failure (≤200 chars, no absolute paths). */
  lastError: string | null;
  /** ISO timestamp of the last success for this component, null if never recorded. */
  lastSuccess: string | null;
}

/** Number of consecutive failures before identity.ts injects a component's warning block. */
export const FAILURE_THRESHOLD = 3;

const LEDGER_FILENAME = 'recorder-health.json';

const HEALTHY: RecorderHealth = {
  consecutiveFailures: 0,
  failingSince: null,
  lastError: null,
  lastSuccess: null,
};

/** One ledger file, keyed by component — each component's streak is independent. */
type Ledger = Partial<Record<RecorderComponent, RecorderHealth>>;

export function ledgerPath(contextDir: string): string {
  return join(contextDir, LEDGER_FILENAME);
}

function coerceHealth(raw: unknown): RecorderHealth {
  const parsed = (raw ?? {}) as Partial<RecorderHealth>;
  return {
    consecutiveFailures:
      typeof parsed.consecutiveFailures === 'number' ? parsed.consecutiveFailures : 0,
    failingSince: typeof parsed.failingSince === 'string' ? parsed.failingSince : null,
    lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
    lastSuccess: typeof parsed.lastSuccess === 'string' ? parsed.lastSuccess : null,
  };
}

/** Read the whole ledger file. Returns {} when absent, unreadable, or not an object. */
function readLedger(contextDir: string): Ledger {
  try {
    const path = ledgerPath(contextDir);
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Ledger;
  } catch {
    return {};
  }
}

/** Write the whole ledger file. Silently swallows write errors. */
function writeLedger(contextDir: string, ledger: Ledger): void {
  try {
    writeFileSync(ledgerPath(contextDir), JSON.stringify(ledger, null, 2), 'utf-8');
  } catch {
    // writing the health ledger must never block or throw
  }
}

/** Read one component's health. Returns HEALTHY when absent or unreadable. */
export function readHealth(contextDir: string, component: RecorderComponent): RecorderHealth {
  const entry = readLedger(contextDir)[component];
  return entry ? coerceHealth(entry) : { ...HEALTHY };
}

/** Scrub a raw error for the ledger: trim to 200 chars, redact absolute paths. */
function scrubError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s:,'"]+/g, '<path>').slice(0, 200);
}

/**
 * Record a success for one component. Resets that component's consecutive
 * failure streak; other components' streaks are untouched. lastError is
 * preserved so diagnostics survive a single success.
 */
export function recordSuccess(contextDir: string, component: RecorderComponent): void {
  const ledger = readLedger(contextDir);
  const prev = ledger[component] ? coerceHealth(ledger[component]) : HEALTHY;
  ledger[component] = {
    consecutiveFailures: 0,
    failingSince: null,
    lastError: prev.lastError,
    lastSuccess: new Date().toISOString(),
  };
  writeLedger(contextDir, ledger);
}

/**
 * Record a failure for one component. Increments that component's streak only.
 * failingSince is set to the first failure's timestamp and never moved forward
 * until a success resets the streak.
 */
export function recordFailure(contextDir: string, component: RecorderComponent, error: unknown): void {
  const ledger = readLedger(contextDir);
  const prev = ledger[component] ? coerceHealth(ledger[component]) : HEALTHY;
  const now = new Date().toISOString();
  ledger[component] = {
    consecutiveFailures: prev.consecutiveFailures + 1,
    failingSince: prev.failingSince ?? now,
    lastError: scrubError(error),
    lastSuccess: prev.lastSuccess,
  };
  writeLedger(contextDir, ledger);
}

/**
 * Build the warning block for one component, or null when it is below threshold.
 *
 * Returned string is a complete markdown section. Callers append it BELOW the
 * rest of the identity payload — placed last so it is freshest in the model's
 * working memory when its first reply fires.
 */
export function warningBlock(component: RecorderComponent, health: RecorderHealth): string | null {
  if (health.consecutiveFailures < FAILURE_THRESHOLD) return null;

  const label = COMPONENT_LABEL[component];
  const since = health.failingSince ? ` since ${health.failingSince}` : '';
  const errLine = health.lastError
    ? `\n\nLast error: \`${health.lastError}\``
    : '';
  const successLine = health.lastSuccess
    ? `\nLast success: ${health.lastSuccess}`
    : '\nNo successful write on record.';

  return (
    `# ⚠️ Recorder Health Warning: ${label}\n\n` +
    `The ${label} has failed **${health.consecutiveFailures} consecutive` +
    ` time${health.consecutiveFailures === 1 ? '' : 's'}**${since}.\n` +
    COMPONENT_IMPACT[component] +
    successLine +
    errLine
  );
}
