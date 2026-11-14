/** Owning, in-process dispatch source. Public receipts are not executable work. */
import type { Operations } from '../../core/index.js';
import type { Wake } from './store.js';
type Reader = (id: string, attempt: string, accepted?: boolean) => Wake | undefined;
const readers = new WeakMap<Operations, {read:Reader;withdrawn:(id:string,attempt:string)=>boolean}>();
export function installDispatchSource(operations: Operations, read: Reader, withdrawn:(id:string,attempt:string)=>boolean) { readers.set(operations, {read,withdrawn}); }
export function clockDispatchSource(operations: Operations, id: string, attempt: string, accepted = false): Wake | undefined {
  return readers.get(operations)?.read(id, attempt, accepted);
}

/** Owning withdrawal evidence only. Missing authority never counts as withdrawal. */
export function clockDispatchWithdrawn(operations:Operations,id:string,attempt:string):boolean {
  return readers.get(operations)?.withdrawn(id,attempt)??false;
}
