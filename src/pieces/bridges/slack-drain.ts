/** Serialized raw receipt -> normalized inbox handoff. No sockets or root registration. */
import type { Clock, Db } from '../../core/index.js';
import type { Message, Venue } from './model.js';
import type { Inspection } from './role.js';
import { slackMessage } from './slack.js';
import { slackInbox, type SlackBinding } from './slack-inbox.js';

export interface SlackDrainOptions {
  db: Db;
  clock: Clock;
  binding: SlackBinding;
  /** Service-scoped slackApi.inspect; every call remains staging/secret gated. */
  inspect(venue: Venue, message: Message): Promise<Inspection>;
  /** Current People display name resolved via an unambiguous owner-written link.
   * A missing name is harmless; it grants nothing. Never use Slack profile names. */
  name(user: string): string | undefined;
  /** Bridges.receive, which commits the normalized receipt before resolving.
   * Runtime admission stays in Bridges, including every human in a group. */
  receive(venueId: string, message: Message, receivedAs: Venue): Promise<void>;
  /** Composition invalidates on credential changes as well as setup changes.
   * A false result permanently stops this drain; recreate after authentication. */
  current(): boolean;
  /** Composition's staging gate; a held drain retains raw words for later. */
  beforeRead(): boolean;
}

export function slackDrain(options: SlackDrainOptions) {
  const { db, clock } = options;
  const venue = structuredClone(options.binding.venue);
  const inbox = slackInbox(db, clock, { venue, app: options.binding.app });
  let closed = false, running: Promise<void> | undefined, again = false;
  let cancel: (() => void) | undefined;
  function valid() {
    if (closed) return false;
    if (db.inTransaction) { retry(); return false; }
    if (!options.current()) { closed = true; cancel?.(); return false; }
    // Enforces the persistent setup revision, including edits restored mid-await.
    try { inbox.pending(1); return true; } catch { closed = true; cancel?.(); return false; }
  }
  function retry() {
    if (!closed && !cancel) cancel = clock.at(clock.now() + 5000, () => { cancel = undefined; void flush(); });
  }
  async function drain() {
    if (!valid() || !options.beforeRead()) { retry(); return; }
    const rows = inbox.pending(64);
    for (const row of rows) {
      if (!valid()) return;
      // First receipt is immutable across retries/restarts. Exactly one hour is eligible.
      if (clock.now() - row.received > 3_600_000) { inbox.consume(row.id); continue; }
      if (!options.beforeRead()) { retry(); return; }
      // This provisional kind is conservative: non-D ids are always group gated.
      // It is never delivered until authenticated conversations.info agrees.
      const raw = row.event;
      const channel = typeof raw.channel === 'string' ? raw.channel : '';
      const probe = slackMessage(raw, venue, { id: channel, workspace: venue.workspace,
        kind: channel.startsWith('D') ? 'dm' : 'group', members: [] });
      if (!probe) { inbox.consume(row.id); continue; }
      try {
        const inspected = await options.inspect(structuredClone(venue), probe);
        if (!valid()) return;
        if (!options.beforeRead()) { retry(); return; }
        if (inspected === 'drop') { inbox.consume(row.id); continue; }
        if (typeof inspected !== 'object' || inspected.kind !== 'allow') { retry(); continue; }
        const members = inspected.members;
        if (new Set(members).size !== members.length || !members.includes(venue.bot) || !members.includes(probe.user)
          || (probe.group ? members.length < 3 : members.length !== 2)) { retry(); continue; }
        const message = slackMessage(raw, venue, { id: probe.channel, workspace: venue.workspace,
          kind: probe.group ? 'group' : 'dm', members: members.map(user => ({ user, name: options.name(user) })) });
        if (!message) { inbox.consume(row.id); continue; }
        if (!valid() || !options.beforeRead()) { retry(); return; }
        // Never join an operation transaction and then erase the only durable copy.
        if (db.inTransaction) throw Error('Slack normalization requires its own transaction');
        await options.receive(venue.id, message, structuredClone(venue));
        if (!valid()) return;
        inbox.consume(row.id);
      } catch { retry(); } // No upstream error, raw words or credentials escape.
    }
    if (rows.length === 64) retry(); // Bounded work per pass, including large backlogs.
  }
  function flush(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) { again = true; return running; }
    cancel?.(); cancel = undefined;
    running = (async () => { do { again = false; await drain(); } while (again && !closed); })()
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
