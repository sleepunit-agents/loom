import { isPromise } from 'node:util/types';
/** Local key-holder boundary. This is not a record or a registry operation.
 * Production transports must authenticate both ends over a private local pipe;
 * no TCP listener, no value in argv/environment, and no raw errors propagated.
 * handTo sends to a pre-authorised runtime sink, never returns bytes to loom.
 * Implementations are trusted in-process code, not sandboxed extensions.
 * Methods acknowledge completed work synchronously. Async transports require a
 * separate composition path; rejecting a Promise cannot cancel its side effects.
 * The holder owns sops/age, its key, encrypted values and rotation.
 */
export interface KeyHolder {
  names(): readonly string[];
  set(name: string, value: Uint8Array, mode: 'add' | 'replace', operationId: string): void;
  handTo(name: string, sink: string): void;
  remove(name: string, operationId: string): void;
  rotate(operationId: string): void;
}

/** The synchronous registry transaction cannot await a transport. TypeScript's
 * void return accepts async implementations, so check the actual acknowledgement.
 * Arbitrary synchronous output is discarded; asynchronous output is consumed and
 * rejected, never interpreted as completed persistence or delivery.
 */
export function synchronousHolderAcknowledgement(value: unknown): void {
  const seen = new Set<unknown>();
  const discard = (result: unknown): void => {
    try { consume(result); } catch { /* Never expose holder-controlled output. */ }
  };
  const consume = (result: unknown): boolean => {
    if (result === null || (typeof result !== 'object' && typeof result !== 'function') || seen.has(result)) return false;
    seen.add(result);
    if (isPromise(result)) {
      // Use the intrinsic rather than a holder-supplied/shadowed then method.
      void Promise.prototype.then.call(result, discard, discard);
      return true;
    }
    const then = (result as {then?: unknown}).then;
    if (typeof then !== 'function') return false;
    // A thenable may both settle callbacks AND return a rejected Promise (for
    // example an accidentally async then). Consume both channels, once each.
    try { discard(Reflect.apply(then, result, [discard, discard])); }
    catch { /* Synchronous then errors are also private holder output. */ }
    return true;
  };
  if (consume(value)) throw new Error('Key holder must acknowledge synchronously');
}
