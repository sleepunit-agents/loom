/** Trusted provider-observation ingestion. No credentials, provider calls or
 * private query projection here; the composition root owns those boundaries.
 * Raw windows remain with the provider adapter until the shared schema's window
 * storage lands. This writes only the approved model_accounts summary columns. */
import { accountObservationCommitted } from './account-completion.js';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { modelAccounts } from '../core/data/schema.js';
import { accountCapacity, type QuotaWindow } from './quota.js';

export function recordAccountUsage(db: DataDatabase, input: {
  account: string; owner: string; provider: string; windows: readonly QuotaWindow[]; now: string;
}) {
  const capacity = accountCapacity(input.windows, input.now);
  const readings = input.windows.map(window => window.readAt).filter((at): at is string => at !== null);
  const oldest = readings.length === input.windows.length && readings.length
    ? Math.min(...readings.map(Date.parse)) : null;
  const usageReadAt = oldest === null || readings.some(at => Date.parse(at) > Date.parse(input.now))
    ? null : new Date(oldest).toISOString();
  const resetsAt = input.windows.length && input.windows.every(window => window.resetsAt !== null) ? new Date(Math.min(...input.windows.map(window => Date.parse(window.resetsAt!)))).toISOString() : null;
  const usage = capacity.windows.length && capacity.windows.every(window => window.estimatedUsage !== null)
    ? Math.min(1, Math.max(...capacity.windows.map(window => window.estimatedUsage!))) : null;
  const result = db.transaction(() => {
    const before = db.select().from(modelAccounts).where(eq(modelAccounts.id, input.account)).get();
    if (!before || before.owner !== input.owner || before.provider !== input.provider) throw new Error('Account changed during refresh');
    // An older asynchronous refresh must not replace a more recent reading.
    if (usageReadAt !== null && before.usageReadAt !== null && Date.parse(usageReadAt) < Date.parse(before.usageReadAt))
      return { recorded: false as const, account: before };
    const account = db.update(modelAccounts).set({ usage, usageReadAt, resetsAt, hasRoom: capacity.hasRoom })
      .where(eq(modelAccounts.id, input.account)).returning().get()!;
    return { recorded: true as const, account };
  }, { behavior: 'immediate' });
  if (result.recorded && !db.$client.inTransaction) accountObservationCommitted(db, input.account);
  return result;
}

/** Provider failure closes admission without fabricating fresh usage or a reset.
 * Pass the observed identity so a late error cannot poison a replacement account. */
export function accountUsageUnavailable(db: DataDatabase, input: { account: string; owner: string; provider: string }) {
  const applied = db.transaction(() => {
    const account = db.select().from(modelAccounts).where(eq(modelAccounts.id, input.account)).get();
    if (!account || account.owner !== input.owner || account.provider !== input.provider) return false;
    db.update(modelAccounts).set({ hasRoom: false }).where(eq(modelAccounts.id, input.account)).run();
    return true;
  });
  if (applied && !db.$client.inTransaction) accountObservationCommitted(db, input.account);
  return applied;
}
