import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { CONTACT_PROBE_MS, SILENCE_MS } from './silence.js';

export const BODY_CONTACT_MS = SILENCE_MS;
export const BODY_CONTACT_MESSAGE = `Loom is still unavailable after ${BODY_CONTACT_MS / 1000} seconds. The outcome of a write may be uncertain.`;
export class BodyTransportFailure extends Error {}
export class BodyContactExpired extends Error {
  constructor() { super(BODY_CONTACT_MESSAGE); }
}
export const temporaryStatus = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599);

const unavailableReply = z.object({ok:z.literal(false),code:z.literal('unavailable'),message:z.string()}).strict();
/** An operation can itself fail with 503 while Loom is reachable. Respect that
 * answer, including a refusal to consume mail that changed during pickup. */
export function temporaryUnavailableReply(value: unknown): boolean {
  const reply = unavailableReply.safeParse(value);
  return !reply.success || /^(?:loom is )?(?:starting|closing)\.?$/i.test(reply.data.message);
}

// Used only by reads, same-job mail pickup, and commands with stable receipts.
// Each attempt keeps its own tighter deadline, including time spent reading bytes.
export async function retryBodyContact<T>(clock: Clock, signal: AbortSignal, refused: () => Error,
  attempt: (remaining: number) => Promise<T>, budget = BODY_CONTACT_MS): Promise<T> {
  // Short caller deadlines include the first attempt. A full outage window starts
  // when a bounded request first observes a missing reply.
  let end = budget === BODY_CONTACT_MS ? Infinity : clock.now() + budget;
  let delay = 1_000;
  for (;;) {
    if (signal.aborted) throw refused();
    const now = clock.now(), final = now >= end;
    const remaining = end - now + (final && budget === BODY_CONTACT_MS ? CONTACT_PROBE_MS : 0);
    if (remaining <= 0) throw budget === BODY_CONTACT_MS ? new BodyContactExpired() : refused();
    try { return await attempt(Math.min(budget, remaining)); }
    catch (error) {
      if (signal.aborted) throw refused();
      if (!(error instanceof BodyTransportFailure)) throw error;
      if (final) throw new BodyContactExpired();
      if (end === Infinity) end = clock.now() + budget;
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
