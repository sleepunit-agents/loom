/** A transport lifetime, separate from the foundation's synchronous readers. */
import type { Operations } from '../operations/index.js';
import { listenForTouches, type TouchSource } from './index.js';

/**
 * Composition calls this after acquiring its daemon home lock and preparing
 * endpoints. Sources must be distinct existing store directories. A failed
 * startup releases every listener it acquired; it never steals an endpoint.
 */
export async function listenForTouchSources(operations: Operations, sources: readonly TouchSource[]) {
  const stops: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled(stops.splice(0).reverse().map(stop => stop()));
    const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Touch listener shutdown failed');
  })();
  try {
    for (const source of sources) stops.push(await listenForTouches(operations, source));
  } catch (error) {
    try { await close(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Touch listener startup and cleanup failed');
    }
    throw error;
  }
  return close;
}
