/** A member's private bridge DM is private words, like a Comms thread: it is
 * kept for the household's keep time and then erased. The words sit in three
 * columns (the Inbox item a body took them from, the received message, and the
 * replies sent back), so all three are erased here together. Records of who
 * wrote when, and what became of it, stay.
 * `bridge_incoming.text` and `bridge_sends.text` cannot be null, so erased
 * words are the empty string there. A reply still waiting to be sent, or
 * awaiting a person's review, keeps its words until that is settled. */
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { bridgeIncoming, bridgeSends, conversations, inbox } from '../data/schema.js';

type Stamp = typeof inbox.at | typeof bridgeIncoming.receivedAt | typeof bridgeSends.createdAt;
/** The rows that still hold a private DM's words, by the column that dates each. */
function held(db: DataDatabase) {
  const private_ = db.select({ id: conversations.id }).from(conversations)
    .where(and(isNotNull(conversations.member), inArray(conversations.venue, ['discord', 'slack'])));
  return {
    mail: and(inArray(inbox.source, ['discord', 'slack']), isNotNull(inbox.words), inArray(inbox.conversation, private_))!,
    sent: and(ne(bridgeSends.text, ''), inArray(bridgeSends.state, ['sent', 'dismissed']),
      inArray(bridgeSends.incoming, db.select({ id: bridgeIncoming.id }).from(bridgeIncoming).where(inArray(bridgeIncoming.conversation, private_))))!,
    received: and(ne(bridgeIncoming.text, ''), eq(bridgeIncoming.state, 'delivered'), inArray(bridgeIncoming.conversation, private_))!,
  };
}

/** Erase words written at or before `cutoff`. Returns how many rows lost theirs. */
export function expirePrivateBridgeWords(db: DataDatabase, cutoff: string): number {
  return db.transaction(() => {
    const rows = held(db), old = (column: Stamp) => sql`julianday(${column}) <= julianday(${cutoff})`;
    return db.update(inbox).set({ words: null }).where(and(rows.mail, old(inbox.at))).run().changes
      + db.update(bridgeSends).set({ text: '' }).where(and(rows.sent, old(bridgeSends.createdAt))).run().changes
      + db.update(bridgeIncoming).set({ text: '' }).where(and(rows.received, old(bridgeIncoming.receivedAt))).run().changes;
  });
}

/** When the oldest words still held were written, for the timer that erases them on time. */
export function oldestPrivateBridgeWords(db: DataDatabase): number | undefined {
  const rows = held(db), first = (column: Stamp) => sql<string | null>`min(${column})`;
  const times = [
    db.select({ at: first(inbox.at) }).from(inbox).where(rows.mail).get()?.at,
    db.select({ at: first(bridgeSends.createdAt) }).from(bridgeSends).where(rows.sent).get()?.at,
    db.select({ at: first(bridgeIncoming.receivedAt) }).from(bridgeIncoming).where(rows.received).get()?.at,
  ].flatMap(at => at ? [Date.parse(at)] : []).filter(Number.isFinite);
  return times.length ? Math.min(...times) : undefined;
}
