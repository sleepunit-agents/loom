import { types } from 'node:util';
import type { DataDatabase } from './database.js';
import { rowsWritten } from './rows-written.js';

export interface CommittedWrite<T> {
  value: T;
  /** The write is committed even if a notification failed. Report these through
   * the composition's error handling; never retry the operation because of them. */
  notificationErrors: unknown[];
}

/** Trusted, synchronous write boundary for the shared connection. Composition
 * wraps commands (including their receipt), membership edits and credential
 * changes here. Existing services may keep their own Drizzle transactions.
 *
 * This is explicit wiring, not a database observer: writes made outside run()
 * do not notify. One instance per connection must own all composed writes.
 * Nested results remain provisional until the outer run() returns. Callbacks
 * must not schedule later writes: all database work belongs inside this call.
 *
 * A commit that wrote no row tells nobody: there is nothing to read again and no
 * access to refresh. A commit whose every run() said `stampOnly` (it wrote only
 * what loom keeps for itself, last-seen style times and numbers a machine reads
 * about itself that changed no state a person is shown, and nothing that decides
 * who may read what) is told to `stamped` alone, which may wake readers late and
 * rarely. Every other commit is told to everyone, at once. Each caller that says
 * `stampOnly` is named in docs/accepted-tradeoffs.md.
 */
export class DataWrites {
  private depth = 0;
  private loud = false;
  private observers = new Set<() => void>();

  /** Trusted composition hooks, invoked only after the outer transaction commits.
   * Unsubscribe before the composed service or connection closes. */
  observe(committed: () => void): () => void {
    this.observers.add(committed);
    return () => { this.observers.delete(committed); };
  }

  constructor(private readonly db: DataDatabase, private readonly notify: {
    refreshAccess(): void;
    changed(): void;
    /** Without this, a stamp-only commit is told as any other. */
    stamped?(): void;
  }) {}

  /** `stampOnly` is asked once, after the operation returned and before its transaction commits. */
  run<T>(operation: () => T, stampOnly?: () => boolean): CommittedWrite<T> {
    // An unrelated outer transaction could roll back after we notified. Refuse
    // that composition rather than mistake a released savepoint for a commit.
    if (this.depth === 0 && this.db.$client.inTransaction) throw new Error('Shared writes must own the outer transaction');
    if (types.isAsyncFunction(operation)) throw new Error('Shared writes must be synchronous');
    const outer = this.depth === 0;
    if (outer) this.loud = false;
    const before = outer ? rowsWritten(this.db) : 0;
    this.depth++;
    let value: T;
    try {
      value = this.db.$client.transaction(() => {
        const result = operation();
        if (result != null && typeof (result as { then?: unknown }).then === 'function') throw new Error('Shared writes must be synchronous');
        // One run that does not vouch for its writes makes the whole commit an ordinary one.
        if (!stampOnly?.()) this.loud = true;
        return result;
      })();
    } finally {
      this.depth--;
    }
    const notificationErrors: unknown[] = [];
    if (outer && rowsWritten(this.db) !== before) {
      // Revocation takes effect before live reads are woken. Attempt both hooks
      // even when one fails; notification failure cannot roll back a commit.
      const all = this.loud || !this.notify.stamped ? [() => this.notify.refreshAccess(), () => this.notify.changed(), ...[...this.observers].map(observer => () => { if (this.observers.has(observer)) observer(); })]
        : [() => this.notify.stamped!()];
      for (const notify of all) {
        try { notify(); } catch (error) { notificationErrors.push(error); }
      }
    }
    return { value, notificationErrors };
  }
}
