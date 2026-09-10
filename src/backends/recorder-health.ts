/**
 * Recorder health ledger (t-562) — tracks consecutive episode-write failures.
 *
 * Written by:
 *   - the episode write path (remember.ts) on success and failure
 *   - the tape-read path (identity.ts catch) on failure
 * Read by:
 *   - identity.ts, which appends a warning block below the identity payload
 *     when the recorder has failed FAILURE_THRESHOLD consecutive times.
 *
 * Inspired by observer-health.ts in claude-mem @ fd0ecf0. The ledger is a
 * small JSON file in the context dir alongside memories.db — one per agent.
 * All reads/writes are synchronous and never throw: the health ledger must
 * never cascade into a deeper failure.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RecorderHealth {
  /** How many episode write-or-read attempts have failed in a row since lastSuccess. */
  consecutiveFailures: number;
  /** ISO timestamp of the first failure in the current streak, null when healthy. */
  failingSince: string | null;
  /** Scrubbed error string from the last failure (≤200 chars, no absolute paths). */
  lastError: string | null;
  /** ISO timestamp of the last successful episode write, null if never recorded. */
  lastSuccess: string | null;
}

/** Number of consecutive failures before identity.ts injects the warning block. */
export const FAILURE_THRESHOLD = 3;

const LEDGER_FILENAME = 'recorder-health.json';

const HEALTHY: RecorderHealth = {
  consecutiveFailures: 0,
  failingSince: null,
  lastError: null,
  lastSuccess: null,
};

export function ledgerPath(contextDir: string): string {
  return join(contextDir, LEDGER_FILENAME);
}

/** Read the health ledger synchronously. Returns HEALTHY when absent or unreadable. */
export function readHealth(contextDir: string): RecorderHealth {
  try {
    const path = ledgerPath(contextDir);
    if (!existsSync(path)) return { ...HEALTHY };
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RecorderHealth>;
    return {
      consecutiveFailures:
        typeof parsed.consecutiveFailures === 'number' ? parsed.consecutiveFailures : 0,
      failingSince:
        typeof parsed.failingSince === 'string' ? parsed.failingSince : null,
      lastError:
        typeof parsed.lastError === 'string' ? parsed.lastError : null,
      lastSuccess:
        typeof parsed.lastSuccess === 'string' ? parsed.lastSuccess : null,
    };
  } catch {
    return { ...HEALTHY };
  }
}

/** Scrub a raw error for the ledger: trim to 200 chars, redact absolute paths. */
function scrubError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s:,'"]+/g, '<path>').slice(0, 200);
}

/** Write the health ledger synchronously. Silently swallows write errors. */
function writeHealth(contextDir: string, health: RecorderHealth): void {
  try {
    writeFileSync(ledgerPath(contextDir), JSON.stringify(health, null, 2), 'utf-8');
  } catch {
    // writing the health ledger must never block or throw
  }
}

/**
 * Record a successful episode write. Resets the consecutive failure streak.
 * The lastError field is preserved so diagnostics survive a single success.
 */
export function recordSuccess(contextDir: string): void {
  const prev = readHealth(contextDir);
  writeHealth(contextDir, {
    consecutiveFailures: 0,
    failingSince: null,
    lastError: prev.lastError,
    lastSuccess: new Date().toISOString(),
  });
}

/**
 * Record a failed episode write or tape-read attempt. Increments the streak.
 * failingSince is set to the first failure's timestamp and never moved forward
 * until a success resets the streak.
 */
export function recordFailure(contextDir: string, error: unknown): void {
  const prev = readHealth(contextDir);
  const now = new Date().toISOString();
  writeHealth(contextDir, {
    consecutiveFailures: prev.consecutiveFailures + 1,
    failingSince: prev.failingSince ?? now,
    lastError: scrubError(error),
    lastSuccess: prev.lastSuccess,
  });
}

/**
 * Build the warning block to inject into the boot context, or null when healthy.
 *
 * Returned string is a complete markdown section. Callers append it BELOW the
 * rest of the identity payload — placed last so it is freshest in the model's
 * working memory when its first reply fires.
 */
export function warningBlock(health: RecorderHealth): string | null {
  if (health.consecutiveFailures < FAILURE_THRESHOLD) return null;

  const since = health.failingSince ? ` since ${health.failingSince}` : '';
  const errLine = health.lastError
    ? `\n\nLast error: \`${health.lastError}\``
    : '';
  const successLine = health.lastSuccess
    ? `\nLast success: ${health.lastSuccess}`
    : '\nNo successful write on record.';

  return (
    `# ⚠️ Recorder Health Warning\n\n` +
    `The episode recorder has failed **${health.consecutiveFailures} consecutive` +
    ` time${health.consecutiveFailures === 1 ? '' : 's'}**${since}.\n` +
    `Episodes may not be reaching the tape — future bodies will wake without context.\n` +
    successLine +
    errLine +
    `\n\n` +
    `Check \`~/.local/state/art-episodes/hook.log\` and the loom episode store. ` +
    `Call \`mcp__loom__remember\` with category \`episode\` to exercise the write path.`
  );
}
