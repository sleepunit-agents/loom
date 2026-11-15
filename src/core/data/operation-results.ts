import { and, eq, lte, min } from 'drizzle-orm';
import { OperationError, type Result } from '../operations/index.js';
import type { DataDatabase } from './database.js';
import { operationResults } from './schema.js';

/** Persistence only. The dispatcher owns caller identity, hashing, current access,
 * retention deadlines and the transaction containing BOTH effect and receipt.
 * No input words are stored here. Expiry scheduling belongs to its Clock owner.
 */
export interface OperationReceipt {
  caller: string;
  id: string;
  operation: string;
  inputHash: string;
  result: Result;
  expires: number;
}
export interface ReceiptPersistence {
  get(caller: string, id: string): OperationReceipt | undefined;
  insert(receipt: OperationReceipt): void;
  recover(receipt: OperationReceipt): void;
  expire(now: number): void;
  nextExpiry(): number | undefined;
}

function utc(ms: number): string {
  if (!Number.isSafeInteger(ms)) throw new Error('Receipt time must be integer milliseconds');
  const value = new Date(ms).toISOString();
  if (!/^\d{4}-/.test(value)) throw new Error('Receipt time must fit the schema UTC format');
  return value;
}
function stored(receipt: OperationReceipt): typeof operationResults.$inferInsert {
  const result = JSON.stringify(receipt.result);
  // Round-trip before writing: do not persist an unreplayable result.
  JSON.parse(result);
  return { caller: receipt.caller, id: receipt.id, operation: receipt.operation,
    inputHash: receipt.inputHash, result: Buffer.from(result), expiresAt: utc(receipt.expires) };
}

/** All writes use the supplied shared connection, so caller-owned transactions
 * roll back receipts together with effects. Does not create/migrate any table.
 * Deadlines written by this adapter use canonical millisecond UTC strings.
 */
export class OperationResults implements ReceiptPersistence {
  constructor(private readonly db: DataDatabase) {}
  get(caller: string, id: string): OperationReceipt | undefined {
    const row = this.db.select().from(operationResults).where(and(eq(operationResults.caller, caller), eq(operationResults.id, id))).get();
    return row && { caller: row.caller, id: row.id, operation: row.operation, inputHash: row.inputHash,
      result: JSON.parse(row.result.toString('utf8')) as Result, expires: Date.parse(row.expiresAt) };
  }
  insert(receipt: OperationReceipt): void {
    this.db.insert(operationResults).values(stored(receipt)).run();
  }
  /** Recovery may replace only the answer and its original retry deadline.
   * A different operation/input under the same key must never be overwritten.
   */
  recover(receipt: OperationReceipt): void {
    const row = stored(receipt);
    this.db.transaction(() => {
      const old = this.get(receipt.caller, receipt.id);
      if (old && (old.operation !== receipt.operation || old.inputHash !== receipt.inputHash))
        throw new OperationError('conflict', 'Operation id already used for different input');
      this.db.insert(operationResults).values(row).onConflictDoUpdate({
        target: [operationResults.caller, operationResults.id],
        set: { result: row.result, expiresAt: row.expiresAt },
      }).run();
    });
  }
  expire(now: number): void {
    this.db.delete(operationResults).where(lte(operationResults.expiresAt, utc(now))).run();
  }
  nextExpiry(): number | undefined {
    const row = this.db.select({ next: min(operationResults.expiresAt) }).from(operationResults).get();
    return row?.next == null ? undefined : Date.parse(row.next);
  }
}
