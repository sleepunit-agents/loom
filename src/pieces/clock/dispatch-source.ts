/** Owning, in-process dispatch source. Public receipts are not executable work. */
import type { Operations } from '../../core/index.js';
import type { Wake } from './store.js';
type Reader = (id: string, attempt: string) => Wake | undefined;
const readers = new WeakMap<Operations, Reader>();
export function installDispatchSource(operations: Operations, read: Reader) { readers.set(operations, read); }
export function clockDispatchSource(operations: Operations, id: string, attempt: string): Wake | undefined {
  return readers.get(operations)?.(id, attempt);
}
