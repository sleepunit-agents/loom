/** An Inbox item that is filed without ever being pushed to a phone.
 *
 * Dimming an item is not that: a dim item returns to full when its quiet time ends, and is pushed then. An
 * item its producer files quietly (an agent's notice raised `quiet`, or raised again straight after it was
 * cleared) must never be pushed, however long it waits and whatever devices are enrolled later. An Inbox
 * item has no column for that, so it is said in the item's own source id: one that begins with these words.
 * Stated here once. The producer builds its source id with `QUIET_SOURCE`; the one place that queues a push
 * (core/signin/shared-notifications.ts) asks `neverPushed`. Nothing else about the item differs: it is read,
 * listed, counted and cleared like any other. */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

export const QUIET_SOURCE = 'quiet-notice:';
/** Exactly 0 or 1. `fields` are the item's own columns. */
export function neverPushed(fields: { sourceId: AnyColumn | SQL }): SQL {
  return sql`(${fields.sourceId} is not null and substr(${fields.sourceId}, 1, ${QUIET_SOURCE.length}) = ${QUIET_SOURCE})`;
}
