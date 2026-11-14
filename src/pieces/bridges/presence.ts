/** Internal venue presence controller. Not registered or installed: Runtime must
 * supply authenticated, exact-place lifecycle facts before production wiring.
 * No admission, stop, budget, credential or message-text handling lives here. */
import type { Clock } from '../../core/index.js';

export interface PresenceSnapshot {
  working: boolean;
  heartbeat: number;
  /** Original take times, preserved across heartbeats; already normalized IDs. */
  taken: Array<{ id: string; at: number }>;
  postedAt?: number;
}
export interface PresenceSource {
  /** Trusted owning role for ONE bound agent/venue/place. Undefined means done;
   * wait means unavailable, and must never be interpreted as permission to IO. */
  snapshot(): PresenceSnapshot | 'wait' | undefined;
}
export interface PresenceEffects {
  /** Idempotent set/unset of this bot's eyes reaction. A lost acknowledgement
   * may be retried. Transport must recheck current immediately before each IO,
   * including after credential acquisition, and sanitize upstream failures. */
  reaction(id: string, add: boolean, current: () => boolean): Promise<void>;
  /** Discord only; Slack supplies no typing effect. */
  typing?(current: () => boolean): Promise<void>;
}
export interface PresenceOptions {
  clock: Clock;
  source: PresenceSource;
  effects: PresenceEffects;
  /** Permanent authenticated setup/credential-generation lifetime. */
  current(): boolean;
  /** Dynamic composition staging/outside-effects gate. */
  beforeEffect(): boolean;
}
const FRESH = 90_000, PULSE = 5000, MAX_ACKS = 20;

/** One controller per bound place. No timers start until flush. State is bounded
 * and in memory: durable crash cleanup and the real Runtime source remain pending. */
export function presence(options: PresenceOptions) {
  const { clock, source, effects } = options;
  // false means an add may have reached the platform but was not acknowledged.
  const reacted = new Map<string, boolean>();
  let closed = false, running: Promise<void> | undefined, again = false;
  let cancel: (() => void) | undefined, typedAt = -Infinity;
  function current() {
    if (closed) return false;
    if (!options.current()) { closed = true; cancel?.(); return false; }
    return options.beforeEffect();
  }
  function wanted(): Set<string> | undefined {
    if (!current()) return;
    const snapshot = source.snapshot();
    if (snapshot === 'wait') return;
    if (!snapshot) return new Set();
    const now = clock.now(), validTime = (at: number) => Number.isFinite(at) && at <= now;
    if (typeof snapshot.working !== 'boolean' || !validTime(snapshot.heartbeat)
      || snapshot.postedAt !== undefined && !validTime(snapshot.postedAt)
      || !Array.isArray(snapshot.taken) || snapshot.taken.some(a => !a || typeof a.id !== 'string'
        || !a.id.length || a.id.length > 200 || !validTime(a.at))) return;
    if (!snapshot.working || now - snapshot.heartbeat >= FRESH) return new Set();
    // First take wins, like the old Presence.status. A heartbeat cannot turn a
    // previously answered message into a new acknowledgement.
    const takes = new Map<string, number>();
    for (const a of snapshot.taken) if (!takes.has(a.id)) takes.set(a.id, a.at);
    return new Set([...takes].slice(-MAX_ACKS).filter(([, at]) => snapshot.postedAt === undefined || at > snapshot.postedAt).map(([id]) => id));
  }
  const eligible = (id: string, add: boolean) => {
    const ids = wanted();
    return ids !== undefined && ids.has(id) === add;
  };
  async function cleanup() {
    for (const id of reacted.keys()) {
      const ids = wanted();
      if (!ids) return;
      if (ids.has(id)) continue;
      try {
        await effects.reaction(id, false, () => eligible(id, false));
        // Transport success acknowledges the removal even if facts changed
        // during the request; a new add can then restore it.
        reacted.delete(id);
      } catch { /* Keep uncertain removals for an idempotent retry. */ }
    }
  }
  async function show() {
    await cleanup();
    const ids = wanted();
    if (!ids) return;
    for (const id of ids) {
      if (!eligible(id, true)) continue;
      if (reacted.get(id) === true) continue;
      // Cleanup failures consume slots; repeated new takes cannot grow state.
      if (!reacted.has(id) && reacted.size >= MAX_ACKS) continue;
      reacted.set(id, false);
      try { await effects.reaction(id, true, () => eligible(id, true)); reacted.set(id, true); }
      catch { /* An add may already have happened: retry or clean it up. */ }
    }
    // A post/done/stale transition during the add must remove its late reaction
    // in this same flush, before any typing pulse.
    await cleanup();
    if (effects.typing && wanted()?.size && clock.now() - typedAt >= PULSE) {
      try {
        await effects.typing(() => !!wanted()?.size);
        typedAt = clock.now();
      } catch { /* Retry on the next pulse, without leaking upstream errors. */ }
    }
  }
  function flush(): Promise<void> {
    if (closed) return Promise.resolve();
    cancel?.(); cancel = undefined;
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; try { await show(); } catch { /* Unavailable owning source holds all effects. */ } }
      while (again && !closed);
    })().finally(() => {
      running = undefined;
      if (!closed) cancel = clock.at(clock.now() + PULSE, () => { cancel = undefined; void flush(); });
    });
    return running;
  }
  return {
    /** Owning lifecycle updates and staging release request a serialized pass. */
    flush,
    /** IO cannot outlive shutdown; terminal cleanup must be flushed beforehand.
     * This is not durable crash recovery and does not bypass a revoked lifetime. */
    async close() { closed = true; cancel?.(); cancel = undefined; await running; },
  };
}
