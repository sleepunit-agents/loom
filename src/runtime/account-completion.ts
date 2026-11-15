/** Opaque per-account completion generations shared by every writer on this
 * connection. No quota values or credentials are retained. Publish only after
 * the complete outer transaction (including any receipt) commits. */
import type { DataDatabase } from '../core/data/database.js';
const completions = new WeakMap<DataDatabase['$client'], Map<string, object>>();
export function accountCompletion(db: DataDatabase, account: string): object | undefined {
  return completions.get(db.$client)?.get(account);
}
export function accountObservationCommitted(db: DataDatabase, account: string): void {
  let accounts = completions.get(db.$client);
  if (!accounts) { accounts = new Map(); completions.set(db.$client, accounts); }
  accounts.set(account, {});
}
