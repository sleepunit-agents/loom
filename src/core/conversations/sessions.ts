/** A harness's own record of a conversation, kept between bodies (docs/accepted-tradeoffs.md, "A harness
 * session is kept between bodies, sealed, for the next body alone").
 *
 * Every run of a body is a new process, usually in a container that is thrown away, on whichever machine
 * takes the job. So that the next body of a conversation can resume the last one's session, the body
 * hands loom the session's files when it ends and is handed them back when it starts. One is kept for a
 * conversation and harness, replaced whole each time. What is kept is sealed with the household's words
 * key: the file on disk does not hold the words, and nothing reads the table but `take`, which only the
 * body holding the conversation's job is let through to (shared-conversation-sessions.ts). It is not
 * served by the query door, so no page shows it to anybody, an owner included.
 *
 * A session is not handed on when it was saved under another family of models, or is older than the
 * household keeps words. Either way it is removed, and the body starts fresh with the conversation's
 * kept history. A session too large to keep is not kept, and removes the one before it: a later body
 * must not resume a session that is behind the conversation.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversationSessions } from '../data/schema.js';
import { commsKeepDays } from '../data/comms-days.js';
import { ageCutoff } from './retention.js';
import { SESSION_BYTES, SESSION_ID, modelFamily } from './session-limit.js';
import type { WordsKey } from './words.js';

export interface KeptSession { session: string; files: string }
/** A session sealed and ready to store: made outside the transaction that stores it. */
export interface SealedSession { conversation: string; harness: string; session: string; sealed: Buffer | null; bytes: number }

export class ConversationSessions {
  constructor(private db: DataDatabase, private now: () => string, private key: WordsKey) {}

  /** `files` is the packed session as base64. Too large, or not a session's id: sealed as nothing, which
   * stores as a removal. */
  async seal(input: { conversation: string; harness: string; model: string; session: string; files: string }): Promise<SealedSession> {
    const bytes = Buffer.byteLength(input.files, 'base64');
    const keep = SESSION_ID.test(input.session) && bytes > 0 && bytes <= SESSION_BYTES;
    return { conversation: input.conversation, harness: input.harness, session: input.session, bytes,
      sealed: keep ? await this.key.seal(JSON.stringify({ model: input.model, files: input.files })) : null };
  }

  /** Replace the conversation's session for this harness, or remove it when there is nothing to keep. */
  store(sealed: SealedSession): boolean {
    const where = and(eq(conversationSessions.conversation, sealed.conversation), eq(conversationSessions.harness, sealed.harness));
    if (!sealed.sealed) { this.db.delete(conversationSessions).where(where).run(); return false; }
    const row = { conversation: sealed.conversation, harness: sealed.harness, session: sealed.session, files: sealed.sealed, bytes: sealed.bytes, savedAt: this.now() };
    this.db.insert(conversationSessions).values(row).onConflictDoUpdate({ target: [conversationSessions.conversation, conversationSessions.harness], set: row }).run();
    return true;
  }

  /** The stored row if it is still within the keep time, as it is: opening it is `open`. */
  kept(conversation: string, harness: string): typeof conversationSessions.$inferSelect | undefined {
    const row = this.db.select().from(conversationSessions).where(and(eq(conversationSessions.conversation, conversation), eq(conversationSessions.harness, harness))).get();
    return row && Date.parse(row.savedAt) > Date.parse(ageCutoff(this.now(), commsKeepDays(this.db))) ? row : undefined;
  }

  /** What the next body is handed, or nothing: none kept, kept too long, or kept under another family of models. */
  async open(conversation: string, harness: string, model: string): Promise<(KeptSession & { savedAt: string }) | null> {
    const row = this.kept(conversation, harness);
    if (!row) return null;
    try {
      const value = JSON.parse(await this.key.open(row.files)) as { model?: unknown; files?: unknown };
      if (typeof value.model !== 'string' || typeof value.files !== 'string' || modelFamily(value.model) !== modelFamily(model)) return null;
      return { session: row.session, files: value.files, savedAt: row.savedAt };
    } catch { return null; }
  }

  /** Remove a conversation's session for this harness: it was not handed on, so it is behind the conversation. */
  forget(conversation: string, harness: string): void {
    this.db.delete(conversationSessions).where(and(eq(conversationSessions.conversation, conversation), eq(conversationSessions.harness, harness))).run();
  }

}

/** Remove every session saved at or before `cutoff`: the sweep that erases words at the keep time calls
 * this with the same cutoff (messages.ts, expire). Returns how many went. */
export function expireConversationSessions(db: DataDatabase, cutoff: string): number {
  return db.delete(conversationSessions).where(sql`julianday(${conversationSessions.savedAt}) <= julianday(${cutoff})`).run().changes;
}
/** When the oldest kept session was saved, for the sweep's schedule (lifetime.ts). */
export function oldestConversationSession(db: DataDatabase): number | undefined {
  const row = db.select({ at: conversationSessions.savedAt }).from(conversationSessions).orderBy(sql`julianday(${conversationSessions.savedAt})`).get();
  return row ? Date.parse(row.at) : undefined;
}
