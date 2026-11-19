/** A provider read that failed. The windows and the summary worked out from them are written together,
 * by recordAccountWindows in account-windows.ts; this closes admission when there is nothing to write. */
import { accountObservationCommitted } from './account-completion.js';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { modelAccounts } from '../core/data/schema.js';

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
