/** Home/People summaries use generated relations and selection-local batches. */
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { conversations, threads } from './schema.js';
import { conversationVisibility } from './conversation-visibility.js';
import { commsKeepDays } from './comms-days.js';

export function readRecentConversations(db: DataDatabase, viewer: Viewer, agent: string, limit: number, answeredOnly: boolean) {
  return db.query.conversations.findMany({ where: f => {
    const replyAt = sql`(select max(julianday(reply.at)) from messages reply join threads reply_thread on reply_thread.id=reply.thread where reply_thread.conversation=${f.id} and reply.kind='reply' and reply.sender=${f.agent})`;
    const allowed = conversationVisibility(viewer).conversations!(f);
    return and(sql`${{ getSQL: () => allowed }}`, eq(f.agent, agent), answeredOnly ? sql`${replyAt} is not null` : undefined);
  }, orderBy: f => {
    const replyAt = sql`(select max(julianday(reply.at)) from messages reply join threads reply_thread on reply_thread.id=reply.thread where reply_thread.conversation=${f.id} and reply.kind='reply' and reply.sender=${f.agent})`;
    return [desc(answeredOnly ? replyAt : sql`julianday(${f.lastAt})`), desc(f.id)];
  }, limit }).sync();
}
export function readConversationAnswers(db: DataDatabase, viewer: Viewer, ids: string[], words = true) {
  const scope = conversationVisibility(viewer).conversations!(getTableColumns(conversations));
  const rows = db.query.threads.findMany({ columns: { id: true, conversation: true },
    with: { conversationRow: { columns: { agent: true, project: true, member: true } } },
    where: f => {
      const allowed = sql`exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${scope})`;
      return and(inArray(f.conversation, ids), sql`${{ getSQL: () => allowed }}`);
    },
  }).sync();
  // Ciphertext stays in a root query: SQLite JSON relations cannot carry BLOBs.
  const replies = db.query.messages.findMany({
    columns: { thread: true, seq: true, at: true, keepUntil: true, words },
    extras: f => ({ hasWords: sql`${f.words} is not null`.mapWith(Boolean).as('data_answer_has_words') }),
    where: f => {
      const latest = sql`${f.seq}=(select max(reply.seq) from messages reply where reply.thread=${f.thread} and reply.kind='reply' and reply.sender=${f.sender})`;
      const agentReply = sql`exists(select 1 from ${threads} inner join ${conversations} on ${conversations.id}=${threads.conversation} where ${threads.id}=${f.thread} and ${conversations.agent}=${f.sender} and ${scope})`;
      return and(inArray(f.thread, rows.map(row => row.id)), eq(f.kind, 'reply'), sql`${{ getSQL: () => latest }}`, sql`${{ getSQL: () => agentReply }}`);
    },
  }).sync();
  const byThread = new Map(replies.map(row => [row.thread, row]));
  const days = commsKeepDays(db);
  const latest = new Map<string, { thread: string; seq: number; at: string; keepUntil: string | null; words: Buffer | null; hasWords: boolean; agent: string | null; project: string | null; member: string | null }>();
  for (const row of rows) {
    const message = byThread.get(row.id);
    if (message && row.conversationRow && (!latest.has(row.conversation) || latest.get(row.conversation)!.seq < message.seq)) latest.set(row.conversation, { ...message, words: words && 'words' in message ? message.words as Buffer | null : null, ...row.conversationRow });
  }
  return { days, fingerprint: JSON.stringify([rows, replies, days]), latest: (id: string) => latest.get(id) };
}
export type ConversationAnswerSet = ReturnType<typeof readConversationAnswers>;
