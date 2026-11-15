import { eq, sql } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { secretChanges } from '../../core/data/schema.js';

/** Each successful add/remove changes presence by +1/-1; replace does not.
 * The immutable audit therefore determines presence even when timestamps tie.
 * Fresh values begin with an audited add. The separate real-data move must
 * establish that same baseline for values it imports, never infer it from a name.
 */
export function secretHasValue(db: DataDatabase, name: string): boolean {
  const balance = db.select({ balance: sql<number>`coalesce(sum(case when ${secretChanges.action} = 'add' then 1 when ${secretChanges.action} = 'removed' then -1 else 0 end), 0)` })
    .from(secretChanges).where(eq(secretChanges.secret, name)).get()!.balance;
  if (balance !== 0 && balance !== 1) throw Error('Invalid secret presence history');
  return balance === 1;
}

