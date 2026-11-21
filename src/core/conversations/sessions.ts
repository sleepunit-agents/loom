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
 * How long: a session holds words, and the words of a direct conversation are erased at the household's
 * keep time. So a session's own count starts at the oldest such word it can hold, and it is erased when
 * the keep time has passed since then, however often it has been saved since. `started_at` is that time: when
 * the session was first saved, or earlier when its first body started fresh and was handed older words of
 * a direct conversation (its kept history, each line carrying when it will be erased). A save within the
 * keep time continues the session kept there and leaves the start as it is. So no erasable word in a
 * session outlives its keep time. A room's words are kept without limit and do not move the start. Past it the row is never handed on and the words'
 * sweep removes it (expireConversationSessions); the next body starts fresh, and its session starts a new
 * count.
 *
 * A session is also not handed on when it was saved under another family of models, or was last saved
 * before the conversation's last answer (shared-conversation-sessions.ts). The body that is handed
 * nothing says so at once through the save door, which removes what is kept: it is of no use to that body
 * and will be behind the conversation as soon as the body answers. A session too large to keep is not
 * kept and removes the one before it for the same reason.
 */
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversationSessions, deletedThreads } from '../data/schema.js';
import { commsKeepDays } from '../data/comms-days.js';
import { ageCutoff } from './retention.js';
import { SESSION_BYTES, SESSION_ID, modelFamily } from './session-limit.js';
import type { WordsKey } from './words.js';

export interface KeptSession { session: string; files: string }
/** What `open` hands back: the session, when it was started (the row's `started_at`) and when it was last saved. */
export type OpenedSession = KeptSession & { startedAt: string; lastSavedAt: string; covered?: string[] };
/** A session sealed and ready to store: made outside the transaction that stores it. */
export interface SealedSession { conversation: string; harness: string; session: string; sealed: Buffer | null; bytes: number; since?: string }

export class ConversationSessions {
  constructor(private db: DataDatabase, private now: () => string, private key: WordsKey) {}

  /** `files` is the packed session as base64. Too large, or not a session's id: sealed as nothing, which
   * stores as a removal. */
  /** `since` is the time of the oldest word this body was handed that is erased at the keep time (a direct
   * conversation's kept history): the session holds that word, so its count starts no later than then. */
  async seal(input: { conversation: string; harness: string; model: string; session: string; files: string; since?: string; covered?: string[] }): Promise<SealedSession> {
    const bytes = Buffer.byteLength(input.files, 'base64');
    const keep = SESSION_ID.test(input.session) && bytes > 0 && bytes <= SESSION_BYTES;
    return { conversation: input.conversation, harness: input.harness, session: input.session, bytes, ...(input.since ? { since: input.since } : {}),
      // When it was last saved is sealed with it: the row's own time is when the session was started.
      sealed: keep ? await this.key.seal(JSON.stringify({ model: input.model, files: input.files, at: this.now(), covered:input.covered })) : null };
  }

  /** Replace the conversation's session for this harness, or remove it when there is nothing to keep. */
  store(sealed: SealedSession): boolean {
    return this.db.transaction(() => {
      // Sealing happens outside the write transaction. Deletion may have committed in the meantime.
      if (this.db.select({id:deletedThreads.id}).from(deletedThreads)
        .where(eq(deletedThreads.conversation,sealed.conversation)).limit(1).get()) return false;
      const where = and(eq(conversationSessions.conversation, sealed.conversation), eq(conversationSessions.harness, sealed.harness));
      if (!sealed.sealed) { this.db.delete(conversationSessions).where(where).run(); return false; }
      // The count of its keep time starts at the oldest erasable word the session can hold: the start of the
      // session kept here, if one is still within the keep time (this save continues or replaces it); the
      // oldest such word its body was handed (`since`); and otherwise now. Whichever is earliest.
      const now = this.now(), times = [this.kept(sealed.conversation, sealed.harness)?.startedAt, sealed.since, now].filter((at): at is string => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.parse(now));
      const startedAt = times.reduce((oldest, at) => Date.parse(at) < Date.parse(oldest) ? at : oldest);
      // Already past the keep time by that count: there is nothing it may be kept for.
      if (Date.parse(startedAt) <= Date.parse(ageCutoff(now, commsKeepDays(this.db)))) { this.db.delete(conversationSessions).where(where).run(); return false; }
      const row = { conversation: sealed.conversation, harness: sealed.harness, session: sealed.session, files: sealed.sealed, bytes: sealed.bytes, startedAt };
      this.db.insert(conversationSessions).values(row).onConflictDoUpdate({ target: [conversationSessions.conversation, conversationSessions.harness], set: row }).run();
      return true;
    }, { behavior: 'immediate' });
  }

  /** The stored row if the keep time has not passed since its session was started, as it is: opening it is `open`. */
  kept(conversation: string, harness: string): typeof conversationSessions.$inferSelect | undefined {
    const row = this.db.select().from(conversationSessions).where(and(eq(conversationSessions.conversation, conversation), eq(conversationSessions.harness, harness),
      notInArray(conversationSessions.conversation,this.db.select({conversation:deletedThreads.conversation}).from(deletedThreads)))).get();
    return row && Date.parse(row.startedAt) > Date.parse(ageCutoff(this.now(), commsKeepDays(this.db))) ? row : undefined;
  }

  /** What the next body is handed, or nothing: none kept, kept too long, or kept under another family of models. */
  async open(conversation: string, harness: string, model: string): Promise<OpenedSession | null> {
    const row = this.kept(conversation, harness);
    if (!row) return null;
    try {
      const value = JSON.parse(await this.key.open(row.files)) as { model?: unknown; files?: unknown; at?: unknown; covered?: string[] };
      if (typeof value.model !== 'string' || typeof value.files !== 'string' || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))
        || modelFamily(value.model) !== modelFamily(model)) return null;
      // Opening can yield while the thread is deleted, the session is replaced, or its words expire.
      const current = this.kept(conversation, harness);
      if (!current || current.startedAt !== row.startedAt || current.session !== row.session || !current.files.equals(row.files)) return null;
      return { session: row.session, files: value.files, startedAt: row.startedAt, lastSavedAt: value.at, ...(value.covered ? {covered:value.covered} : {}) };
    } catch { return null; }
  }

}

/** Erase every harness checkpoint with the thread in the caller's deletion transaction. */
export function eraseConversationSessions(db: DataDatabase, conversation: string): void {
  db.delete(conversationSessions).where(eq(conversationSessions.conversation, conversation)).run();
}

/** Remove every session started at or before `cutoff`: the sweep that erases words at the keep time calls
 * this with the same cutoff (messages.ts, expire). Returns how many went. */
export function expireConversationSessions(db: DataDatabase, cutoff: string): number {
  const removed = db.select({conversation: deletedThreads.conversation}).from(deletedThreads);
  return db.delete(conversationSessions).where(or(
    sql`julianday(${conversationSessions.startedAt}) <= julianday(${cutoff})`,
    inArray(conversationSessions.conversation, removed),
  )).run().changes;
}
/** When the oldest kept session was started, for the sweep's schedule (lifetime.ts). */
export function oldestConversationSession(db: DataDatabase): number | undefined {
  const row = db.select({ at: conversationSessions.startedAt }).from(conversationSessions).orderBy(sql`julianday(${conversationSessions.startedAt})`).get();
  return row ? Date.parse(row.at) : undefined;
}
