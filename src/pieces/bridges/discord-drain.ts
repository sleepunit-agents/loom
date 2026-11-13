/** Serialized raw receipt -> normalized inbox handoff. No sockets or root registration. */
import type { Clock, Db } from '../../core/index.js';
import type { Message, Venue } from './model.js';
import { all } from './store.js';
import type { DiscordChannel } from './discord.js';
import type { DiscordPlace } from './discord-api.js';
import { discordMessage } from './discord.js';
import { discordInbox, DiscordBindingChanged, type DiscordBinding, type DiscordReceipt } from './discord-inbox.js';

export interface DiscordDrainOptions {
  db: Db;
  clock: Clock;
  binding: DiscordBinding;
  /** Fresh service-scoped discordApi.channel; no metadata caching. */
  channel(venue: Venue, place: DiscordPlace): Promise<DiscordChannel | 'drop' | 'wait'>;
  /** Trusted public holder generation, checked on every inbox operation. */
  currentEpoch(): string;
  /** Bridges.receive, which commits the normalized receipt before resolving.
   * Runtime admission stays in Bridges. */
  receive(venueId: string, message: Message, receivedAs: Venue): Promise<void>;
  /** Composition invalidates on credential changes as well as setup changes.
   * A false result permanently stops this drain; recreate after authentication. */
  current(): boolean;
  /** Composition's staging gate; a held drain retains raw words for later. */
  beforeRead(): boolean;
}

export function discordDrain(options: DiscordDrainOptions) {
  const { db, clock } = options;
  const venue = structuredClone(options.binding.venue);
  const inbox = discordInbox(db, clock, { venue, credentialEpoch: options.binding.credentialEpoch }, options.currentEpoch);
  let closed = false, running: Promise<void> | undefined, again = false;
  let cancel: (() => void) | undefined, retryAt = Infinity;
  const deadlines = new Map<string, number>();
  let cursor: Pick<DiscordReceipt, 'received' | 'id'> | undefined;
  function valid() {
    if (closed) return false;
    if (db.inTransaction) { retry(); return false; }
    if (!options.current()) { closed = true; cancel?.(); return false; }
    // Enforces the persistent setup revision, including edits restored mid-await.
    try { inbox.pending(1); return true; } catch (error) {
      if (error instanceof DiscordBindingChanged) { closed = true; cancel?.(); } else retry();
      return false;
    }
  }
  function retry(at = clock.now() + 5000) {
    if (closed || retryAt <= at) return;
    cancel?.(); retryAt = at;
    cancel = clock.at(at, () => { cancel = undefined; retryAt = Infinity; void flush(); });
  }
  function postpone(id: string) {
    const at = clock.now() + 5000;
    deadlines.set(id, at); retry(at);
  }
  function consume(id: string) { inbox.consume(id); deadlines.delete(id); }
  async function drain() {
    if (!valid() || !options.beforeRead()) { retry(); return; }
    const rows = inbox.pending(64, cursor);
    for (const row of rows) {
      if (!valid()) return;
      // First receipt is immutable across retries/restarts. Exactly one hour is eligible.
      if (clock.now() - row.received > 3_600_000) { consume(row.id); continue; }
      const deadline = deadlines.get(row.id);
      if (deadline !== undefined && clock.now() < deadline) { retry(deadline); continue; }
      if (!options.beforeRead()) { retry(); return; }
      const raw = row.event;
      // Provisional metadata is used only to validate the payload and derive the
      // lookup address. No message is handed off without fresh REST evidence.
      const channel = typeof raw.channel_id === 'string' ? raw.channel_id : '';
      const probe = discordMessage(raw, venue, { id: channel,
        kind: raw.guild_id === undefined ? 'dm' : 'channel' }, []);
      if (!probe) { consume(row.id); continue; }
      try {
        const metadata = await options.channel(structuredClone(venue), { channel: probe.channel, user: probe.user, dm: probe.dm });
        if (!valid()) return;
        if (!options.beforeRead()) { retry(); return; }
        if (metadata === 'drop') { consume(row.id); continue; }
        if (metadata === 'wait') { postpone(row.id); continue; }
        const message = discordMessage(raw, venue, metadata, all(db, 'venues'));
        if (!message) { consume(row.id); continue; }
        if (!valid() || !options.beforeRead()) { retry(); return; }
        // Never join an operation transaction and then erase the only durable copy.
        if (db.inTransaction) throw Error('Discord normalization requires its own transaction');
        await options.receive(venue.id, message, structuredClone(venue));
        if (!valid()) return;
        if (!options.beforeRead()) { retry(); return; }
        consume(row.id);
      } catch { postpone(row.id); } // No upstream error, raw words or credentials escape.
    }
    // Advance past retained failures so a waiting prefix cannot starve the rest.
    cursor = rows.length === 64 ? { received: rows[63].received, id: rows[63].id } : undefined;
    if (rows.length === 64 || inbox.pending(1).length) retry();
  }
  function flush(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => { do { again = false; try { await drain(); } catch { retry(); } } while (again && !closed); })()
      .finally(() => { running = undefined; });
    return running;
  }
  return {
    /** Call at startup, after raw receipt commits and on staging release. */
    flush,
    /** Stops timers and prevents post-await handoff; waits for current IO to settle. */
    async close() { closed = true; cancel?.(); cancel = undefined; await running; },
  };
}
