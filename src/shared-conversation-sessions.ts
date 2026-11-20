/** The two doors a body has to its conversation's kept harness session: it is handed the session when it
 * starts, and hands back the one it leaves. Nobody else has either: not another job's body, not a member,
 * not an owner. What is kept, how long and how it is sealed is core/conversations/sessions.ts.
 *
 * A conversation has one unended job at a time (the schema's index, and Jobs.admission), and both doors
 * ask for the body of that job, so two bodies cannot each resume and save the same session. */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { bridgeConnections, jobs, turns } from './core/data/schema.js';
import { DOOR_REQUEST_BYTES } from './core/data/door-limit.js';
import { bodyOperationDefaults, type conversationBodyScope } from './core/conversations/body-scope.js';
import type { ConversationSessions, OpenedSession, SealedSession } from './core/conversations/sessions.js';
import { SESSION_ID } from './core/conversations/session-limit.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { jobHeld } from './shared-place-mail.js';

export function registerConversationSessions(operations: Operations, db: DataDatabase, sessions: ConversationSessions,
  current: ReturnType<typeof conversationBodyScope>, hash: (words: string) => string) {
  // Both doors are for the body of a bridge conversation's job and no other: a Comms thread's body and a wake keep no session.
  // Nor the body of a job on anybody else's word (shared-place-mail.ts, jobHeld), asked of the job here and never
  // of the body: a session is the harness's own record of what an owners' job read and used, tool results and
  // all, and a guest's job resuming it would be handed all of that. Such a job is refused both doors: it
  // starts fresh with the conversation's kept history, and it neither saves a session nor removes the one kept.
  const bound = (viewer: Parameters<typeof current>[0]) => { const found = current(viewer); return found?.job.harness && (bridgeConnections.platform.enumValues as readonly string[]).includes(found.cv.venue) && !jobHeld(db, found.job) ? { conversation: found.cv.id, harness: found.job.harness, model: found.job.model } : undefined; };
  /** A session last saved before the conversation's last answer does not hold that answer: its body died after
   * replying, or a body of another harness answered since. Resuming it would lose what was said, so it is
   * not handed on, and the body starts fresh with the kept history.
   *
   * One answer does not count: that of a job on anybody else's word. Such a job has neither door (bound,
   * above), so it could not have saved, and counting its answer would let a guest's message throw away the
   * owners' session. The session is handed on as the owners' last job left it; it does not hold what that
   * guest's job was told or said, which the conversation's kept history does. An answer whose job cannot be
   * found counts, as before. */
  const behind = (conversation: string, savedAt: string) => {
    // Only the answers since the save are read, and each job is asked once.
    const since = new Set(db.select({ run: turns.run }).from(turns).where(and(eq(turns.conversation, conversation), eq(turns.kind, 'reply'), sql`julianday(${turns.at}) > julianday(${savedAt})`)).all().map(row => row.run));
    for (const run of since) {
      const by = run ? db.select({ id: jobs.id, agent: jobs.agent, conversation: jobs.conversation }).from(jobs).where(eq(jobs.id, run)).get() : undefined;
      if (!by || by.conversation !== conversation || !jobHeld(db, by)) return true;
    }
    return false;
  };
  const defaults = bodyOperationDefaults(current, hash, 'loom-conversation-session-v1');
  operations.register({ name: 'conversation.session', write: false, doors: ['http'], input: z.object({}).strict(),
    output: z.object({ session: z.object({ session: z.string(), files: z.string() }).strict().nullable() }).strict(),
    may: viewer => !!bound(viewer),
    async prepare(_input, ctx) { const mine = bound(ctx.viewer); return mine ? { mine, kept: await sessions.open(mine.conversation, mine.harness, mine.model) } : undefined; },
    run(ctx, _input, prepared) {
      const mine = bound(ctx.viewer), opened = prepared as { mine: NonNullable<ReturnType<typeof bound>>; kept: OpenedSession | null } | undefined;
      if (!mine || !opened || JSON.stringify(opened.mine) !== JSON.stringify(mine)) throw new OperationError('denied', 'Current conversation body required');
      const kept = opened.kept;
      // Still the row that was opened, and still ahead of the conversation's last answer. A body handed
      // nothing says so through the save door, which removes whatever is kept (runtime/body-session.ts).
      const row = sessions.kept(mine.conversation, mine.harness);
      if (!kept || row?.session !== kept.session || row.startedAt !== kept.startedAt || behind(mine.conversation, kept.lastSavedAt)) return { session: null };
      return { session: { session: kept.session, files: kept.files } };
    },
  });
  operations.register({ ...defaults, name: 'conversation.sessionSave',
    // `session: null` says the body leaves no session it can hand on: whatever is kept is then behind and is removed.
    // `since`: the time of the oldest word this body was handed that is erased at the keep time, when it started fresh.
    input: z.object({ session: z.string().regex(SESSION_ID).nullable(), files: z.base64().max(DOOR_REQUEST_BYTES).optional(), since: z.iso.datetime({ offset: true }).optional() }).strict()
      .refine(value => (value.session === null) === (value.files === undefined) && (value.session !== null || value.since === undefined)),
    output: z.object({ saved: z.boolean() }).strict(),
    may: viewer => !!bound(viewer),
    async prepare(input, ctx): Promise<SealedSession | undefined> {
      const mine = bound(ctx.viewer);
      if (!mine) return undefined;
      return input.session === null ? { ...mine, session: '', sealed: null, bytes: 0 } : sessions.seal({ ...mine, session: input.session, files: input.files!, ...(input.since ? { since: input.since } : {}) });
    },
    run(ctx, _input, prepared) {
      const mine = bound(ctx.viewer), sealed = prepared as SealedSession | undefined;
      if (!mine || !sealed || sealed.conversation !== mine.conversation || sealed.harness !== mine.harness) throw new OperationError('denied', 'Current conversation body required');
      return { saved: sessions.store(sealed) };
    },
  });
}
