import type { Clock } from '../core/clock.js';
import { SILENCE_MS } from './silence.js';

export const BODY_CONTACT_MS = SILENCE_MS;
export const BODY_CONTACT_MESSAGE = `Loom is still unavailable after ${BODY_CONTACT_MS / 1000} seconds. The outcome of a write may be uncertain.`;
export class BodyTransportFailure extends Error {}
export class BodyContactExpired extends Error {
  constructor() { super(BODY_CONTACT_MESSAGE); }
}
export const temporaryStatus = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599);

// Used only by reads, same-job mail pickup, and commands with stable receipts.
// Each attempt keeps its own tighter deadline, including time spent reading bytes.
export async function retryBodyContact<T>(clock: Clock, signal: AbortSignal, refused: () => Error,
  attempt: (remaining: number) => Promise<T>, budget = BODY_CONTACT_MS): Promise<T> {
  const end = clock.now() + budget;
  let delay = 1_000;
  for (;;) {
    if (signal.aborted) throw refused();
    const remaining = end - clock.now();
    if (remaining <= 0) throw budget === BODY_CONTACT_MS ? new BodyContactExpired() : refused();
    try { return await attempt(remaining); }
    catch (error) {
      if (signal.aborted) throw refused();
      if (!(error instanceof BodyTransportFailure)) throw error;
    }
    const wake = Math.min(end, clock.now() + delay);
    if (clock.now() < wake) await new Promise<void>((resolve, reject) => {
      const abort = () => { cancel(); reject(refused()); };
      const cancel = clock.at(wake, () => { signal.removeEventListener('abort', abort); resolve(); });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    delay = Math.min(10_000, delay * 2);
  }
}
