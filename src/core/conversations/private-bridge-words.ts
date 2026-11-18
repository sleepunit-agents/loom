/** A direct message on a bridge is private words, like a Comms thread: it is
 * kept for the household's keep time and then erased. That is every direct
 * conversation: a linked member's own, one with someone unlinked, and a group
 * one. The words sit in three columns (the Inbox item a body took them from,
 * the received message, and the replies sent back), so all three are erased
 * here together. Records of who wrote when, and what became of it, stay.
 * The Slack files fetched for a direct message expire with its words: the
 * message stops listing them, and a file no other message carries is removed
 * (bridge_files otherwise keeps a file fourteen days, pieces/bridges/files.ts).
 * `bridge_incoming.text` and `bridge_sends.text` cannot be null, so erased
 * words are the empty string there. A reply still waiting to be sent, or
 * awaiting a person's review, keeps its words until that is settled.
 * A message that went into no conversation holds no words to erase: a dropped
 * one never keeps them, and a held one loses them when it is closed
 * (pieces/bridges/incoming.ts, receiver.ts). */
import { and, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { bridgeConnections, bridgeFileMessages, bridgeFiles, bridgeIncoming, bridgeSends, conversations, inbox } from '../data/schema.js';

type Stamp = typeof inbox.at | typeof bridgeIncoming.receivedAt | typeof bridgeSends.createdAt;
/** The rows that still hold a direct message's words, by the column that dates each. */
function held(db: DataDatabase) {
  const private_ = db.select({ id: conversations.id }).from(conversations)
    .where(and(or(isNotNull(conversations.member), eq(conversations.direct, true)), inArray(conversations.venue, bridgeConnections.platform.enumValues)));
  return {
    mail: and(inArray(inbox.source, bridgeConnections.platform.enumValues), isNotNull(inbox.words), inArray(inbox.conversation, private_))!,
    sent: and(ne(bridgeSends.text, ''), inArray(bridgeSends.state, ['sent', 'dismissed']),
      // What was posted there: answers to its messages, and posts that answered none (a firing's or a note's answer).
      or(inArray(bridgeSends.incoming, db.select({ id: bridgeIncoming.id }).from(bridgeIncoming).where(inArray(bridgeIncoming.conversation, private_))),
        and(isNull(bridgeSends.incoming), inArray(bridgeSends.conversation, private_))))!,
    received: and(ne(bridgeIncoming.text, ''), eq(bridgeIncoming.state, 'delivered'), inArray(bridgeIncoming.conversation, private_))!,
    // A direct message that still lists a file, whether or not it had words. Dated by when it was received.
    filed: and(inArray(bridgeIncoming.conversation, private_),
      inArray(bridgeIncoming.id, db.select({ id: bridgeFileMessages.incoming }).from(bridgeFileMessages)))!,
  };
}

/** Erase words written at or before `cutoff`, and the files of the messages received by then. Returns how
 * many rows lost their words or their files. */
export function expirePrivateBridgeWords(db: DataDatabase, cutoff: string): number {
  return db.transaction(() => {
    const rows = held(db), old = (column: Stamp) => sql`julianday(${column}) <= julianday(${cutoff})`;
    return db.update(inbox).set({ words: null }).where(and(rows.mail, old(inbox.at))).run().changes
      + db.update(bridgeSends).set({ text: '' }).where(and(rows.sent, old(bridgeSends.createdAt))).run().changes
      + db.update(bridgeIncoming).set({ text: '' }).where(and(rows.received, old(bridgeIncoming.receivedAt))).run().changes
      + forgetFiles(db, db.select({ id: bridgeIncoming.id }).from(bridgeIncoming).where(and(rows.filed, old(bridgeIncoming.receivedAt))).all().map(row => row.id));
  });
}
/** Stop listing files under these messages, and remove each file that no message carries any more. */
function forgetFiles(db: DataDatabase, messages: readonly string[]): number {
  let unlisted = 0;
  for (const incoming of messages) unlisted += db.delete(bridgeFileMessages).where(eq(bridgeFileMessages.incoming, incoming)).run().changes;
  if (unlisted) db.delete(bridgeFiles).where(notExists(db.select({ file: bridgeFileMessages.file }).from(bridgeFileMessages)
    .where(and(eq(bridgeFileMessages.connection, bridgeFiles.connection), eq(bridgeFileMessages.file, bridgeFiles.file))))).run();
  return unlisted;
}

/** When the oldest words still held were written, for the timer that erases them on time. */
export function oldestPrivateBridgeWords(db: DataDatabase): number | undefined {
  const rows = held(db), first = (column: Stamp) => sql<string | null>`min(${column})`;
  const times = [
    db.select({ at: first(inbox.at) }).from(inbox).where(rows.mail).get()?.at,
    db.select({ at: first(bridgeSends.createdAt) }).from(bridgeSends).where(rows.sent).get()?.at,
    db.select({ at: first(bridgeIncoming.receivedAt) }).from(bridgeIncoming).where(rows.received).get()?.at,
    db.select({ at: first(bridgeIncoming.receivedAt) }).from(bridgeIncoming).where(rows.filed).get()?.at,
  ].flatMap(at => at ? [Date.parse(at)] : []).filter(Number.isFinite);
  return times.length ? Math.min(...times) : undefined;
}
