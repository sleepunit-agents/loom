/** Which machines a model account is signed in on (`model_account_boxes`), and the rule that comes with
 * every change to it: once the operation that made the change has committed, receipt included, usage read
 * before it is out of date for that account (accountObservationCommitted). A removal followed by the same
 * sign-in must not make an earlier reading current again, so both count.
 *
 * This is the one writer of the table. An operation calls signedIn or signedOut inside its `run` with its
 * own input object, and `committed` with the same object from its `after`; a replayed receipt runs neither. */
import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { modelAccountBoxes } from '../core/data/schema.js';
import { accountObservationCommitted } from './account-completion.js';

export function accountBoxes(db: DataDatabase) {
  const pending = new WeakMap<object, string>();
  return {
    /** A fresh sign-in counts even when the account was already recorded on the machine. */
    signedIn(operation: object, account: string, box: string): void {
      db.insert(modelAccountBoxes).values({ account, box }).onConflictDoNothing().run();
      pending.set(operation, account);
    },
    /** Whether the account was recorded on the machine. */
    signedOut(operation: object, account: string, box: string): boolean {
      const removed = db.delete(modelAccountBoxes).where(and(eq(modelAccountBoxes.account, account), eq(modelAccountBoxes.box, box))).run().changes > 0;
      if (removed) pending.set(operation, account);
      return removed;
    },
    committed(operation: object): void {
      const account = pending.get(operation);
      if (account === undefined) return;
      pending.delete(operation);
      accountObservationCommitted(db, account);
    },
  };
}
