import type { Result } from './index.js';

/** Dispatcher's persistence port. Kept independent of concrete storage so
 * operation types used by browser clients do not import server schema code.
 * The adapter must use the dispatcher's SQLite connection and transactions.
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
