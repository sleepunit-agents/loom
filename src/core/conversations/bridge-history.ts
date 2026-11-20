/** What was said earlier in a Discord or Slack conversation, for the body that takes its next message.
 *
 * A body starts fresh every run. A Comms thread's body is handed the thread's retained dialogue
 * (history-context.ts); this is the same for a bridge conversation, from the words loom already keeps for
 * it and from nowhere else: the messages delivered into the conversation whose mail an earlier body
 * finished with (`bridge_incoming.text`), and what was posted back (`bridge_sends.text` of sent posts).
 * Mail still waiting or taken is the body's input, not its history, and is never in here.
 *
 * It is the conversation's own words, handed only to the job that takes that conversation's mail, so it
 * crosses no boundary the mail does not: a member's private direct conversation is one conversation, and
 * its history goes to its own body alone. Words that were erased at the keep time are empty and are left
 * out; the words of a direct conversation carry the time they will be erased, and a line past it is not
 * handed over. A room's words are kept without limit and carry no such time.
 *
 * Each line says who said it: a member by id; an outside account by the key loom knows it by, as a job is told
 * who it works for (runtime/harness-traits.ts, workingFor), so two guests in one room are two names; a bot as
 * a bot. A body works for one asker, and what anybody else said in the room is talk it reads here.
 *
 * Newest first until the bound is reached, then in the order they were said.
 */
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { bridgeConnections, bridgeIncoming, bridgeSends, conversations, inbox, inboxRefs } from '../data/schema.js';
import { commsKeepDays } from '../data/comms-days.js';
import { HISTORY_BYTES, HISTORY_LINES } from './history-limit.js';
import type { HistoryLine } from './history-context.js';
import { keepUntilFor } from './retention.js';
import { outsidePersonKey } from '../../pieces/bridges/keys.js';


export function prepareBridgeHistory(db: DataDatabase, now: () => string, conversation: string, identify = false): () => HistoryLine[] {
  const cv = db.select().from(conversations).where(eq(conversations.id, conversation)).get();
  if (!cv || !(bridgeConnections.platform.enumValues as readonly string[]).includes(cv.venue)) return () => [];
  // Erased with the household's keep time when the conversation is a direct one (private-bridge-words.ts).
  const erased = cv.member !== null || cv.direct;
  // Two things said in the same instant keep the order they were recorded in (a message before the post
  // that answers it), so the same words are always handed over in the same order.
  type Said = Omit<HistoryLine, 'seq'> & { order: number };
  const read = (): Omit<HistoryLine, 'seq'>[] => {
    const days = commsKeepDays(db), until = (at: string) => erased ? keepUntilFor(at, days) : null;
    const workspace = (() => { try { const place: unknown = JSON.parse(cv.place); return Array.isArray(place) && typeof place[0] === 'string' ? place[0] : null; } catch { return null; } })();
    const received: Said[] = db.selectDistinct({ id: bridgeIncoming.id, user: bridgeIncoming.user, order: sql<number>`${bridgeIncoming}.rowid`, at: bridgeIncoming.postedAt, dated: bridgeIncoming.receivedAt, words: bridgeIncoming.text, member: bridgeIncoming.member, bot: bridgeIncoming.bot, webhook: bridgeIncoming.webhook })
      .from(bridgeIncoming).innerJoin(inboxRefs, eq(inboxRefs.ref, bridgeIncoming.id)).innerJoin(inbox, eq(inbox.id, inboxRefs.item))
      .where(and(eq(bridgeIncoming.conversation, conversation), eq(bridgeIncoming.state, 'delivered'), ne(bridgeIncoming.text, ''),
        eq(inbox.conversation, conversation), eq(inbox.toKind, 'agent'), eq(inbox.to, cv.agent), eq(inbox.state, 'done')))
      .orderBy(desc(bridgeIncoming.postedAt), desc(sql`${bridgeIncoming}.rowid`)).limit(HISTORY_LINES).all()
      .map(row => ({ ...(identify ? {sourceKey: row.id} : {}), kind: 'message' as const, sender: row.member ?? (row.bot || row.webhook ? 'a bot' : workspace !== null && row.user ? `the outside account ${outsidePersonKey(cv.venue as 'discord' | 'slack', workspace, row.user)}` : 'someone outside the household'), at: row.at, words: row.words, keepUntil: until(row.dated), order: row.order }));
    const sent: Said[] = db.select({ id: bridgeSends.id, order: sql<number>`${bridgeSends}.rowid`, at: bridgeSends.createdAt, words: bridgeSends.text }).from(bridgeSends)
      .where(and(eq(bridgeSends.state, 'sent'), ne(bridgeSends.text, ''),
        // What it posted there: answers to the conversation's messages, and posts that answered none.
        or(inArray(bridgeSends.incoming, db.select({ id: bridgeIncoming.id }).from(bridgeIncoming).where(eq(bridgeIncoming.conversation, conversation))),
          and(isNull(bridgeSends.incoming), eq(bridgeSends.conversation, conversation)))))
      .orderBy(desc(bridgeSends.createdAt), desc(sql`${bridgeSends}.rowid`)).limit(HISTORY_LINES).all()
      .map(row => ({ ...(identify ? {sourceKey: row.id} : {}), kind: 'reply' as const, sender: cv.agent, at: row.at, words: row.words, keepUntil: until(row.at), order: row.order }));
    const kept = [...received, ...sent].filter(line => line.keepUntil === null || Date.parse(line.keepUntil) > Date.parse(now()))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || Number(b.kind === 'reply') - Number(a.kind === 'reply') || b.order - a.order)
      .map(({ order: _order, ...line }) => line);
    const lines: Omit<HistoryLine, 'seq'>[] = []; let bytes = 2;
    for (const line of kept.slice(0, HISTORY_LINES)) {
      // Measured as it will be sent, with the largest sequence number it could be given.
      const size = Buffer.byteLength(JSON.stringify({ seq: HISTORY_LINES, ...line })) + (lines.length ? 1 : 0);
      if (bytes + size > HISTORY_BYTES) break;
      bytes += size; lines.push(line);
    }
    return lines.reverse();
  };
  const prepared = JSON.stringify(read());
  return () => {
    // Read again inside the transaction that takes the mail: what is handed over is what is kept then.
    const current = read();
    if (JSON.stringify(current) !== prepared) throw Error('Dialogue changed; take again');
    return current.map((line, index) => ({ seq: index + 1, ...line }));
  };
}
