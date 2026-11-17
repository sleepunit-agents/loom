/** The two doors a body has to its conversation's kept harness session: it is handed the session when it
 * starts, and hands back the one it leaves. Nobody else has either: not another job's body, not a member,
 * not an owner. What is kept, how long and how it is sealed is core/conversations/sessions.ts.
 *
 * A conversation has one unended job at a time (the schema's index, and Jobs.admission), and both doors
 * ask for the body of that job, so two bodies cannot each resume and save the same session. */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { turns } from './core/data/schema.js';
import { DOOR_REQUEST_BYTES } from './core/data/door-limit.js';
import { bodyOperationDefaults, type conversationBodyScope } from './core/conversations/body-scope.js';
import type { ConversationSessions, KeptSession, SealedSession } from './core/conversations/sessions.js';
import { SESSION_ID } from './core/conversations/session-limit.js';
import { OperationError, type Operations } from './core/operations/index.js';

export function registerConversationSessions(operations: Operations, db: DataDatabase, sessions: ConversationSessions,
  current: ReturnType<typeof conversationBodyScope>, hash: (words: string) => string) {
  const bound = (viewer: Parameters<typeof current>[0]) => { const found = current(viewer); return found?.job.harness ? { conversation: found.cv.id, harness: found.job.harness, model: found.job.model } : undefined; };
  /** A session saved before the conversation's last answer does not hold that answer: its body died after
   * replying, or a body of another harness answered since. Resuming it would lose what was said, so it is
   * not handed on, and the body starts fresh with the kept history. */
  const behind = (conversation: string, savedAt: string) => {
    const answered = db.select({ at: turns.at }).from(turns).where(and(eq(turns.conversation, conversation), eq(turns.kind, 'reply'))).orderBy(desc(turns.seq)).get();
    return !!answered && Date.parse(answered.at) > Date.parse(savedAt);
  };
  const defaults = bodyOperationDefaults(current, hash, 'loom-conversation-session-v1');
  operations.register({ name: 'conversation.session', write: false, doors: ['http'], input: z.object({}).strict(),
    output: z.object({ session: z.object({ session: z.string(), files: z.string() }).strict().nullable() }).strict(),
    may: viewer => !!bound(viewer),
    async prepare(_input, ctx) { const mine = bound(ctx.viewer); return mine ? { mine, kept: await sessions.open(mine.conversation, mine.harness, mine.model) } : undefined; },
    run(ctx, _input, prepared) {
      const mine = bound(ctx.viewer), opened = prepared as { mine: NonNullable<ReturnType<typeof bound>>; kept: (KeptSession & { savedAt: string }) | null } | undefined;
      if (!mine || !opened || JSON.stringify(opened.mine) !== JSON.stringify(mine)) throw new OperationError('denied', 'Current conversation body required');
      const kept = opened.kept;
      // Still the row that was opened, and still ahead of the conversation's last answer.
      if (!kept || sessions.kept(mine.conversation, mine.harness)?.savedAt !== kept.savedAt || behind(mine.conversation, kept.savedAt)) return { session: null };
      return { session: { session: kept.session, files: kept.files } };
    },
  });
  operations.register({ ...defaults, name: 'conversation.sessionSave',
    // `session: null` says the body leaves no session it can hand on: whatever is kept is then behind and is removed.
    input: z.object({ session: z.string().regex(SESSION_ID).nullable(), files: z.base64().max(DOOR_REQUEST_BYTES).optional() }).strict()
      .refine(value => (value.session === null) === (value.files === undefined)),
    output: z.object({ saved: z.boolean() }).strict(),
    may: viewer => !!bound(viewer),
    async prepare(input, ctx): Promise<SealedSession | undefined> {
      const mine = bound(ctx.viewer);
      if (!mine) return undefined;
      return input.session === null ? { ...mine, session: '', sealed: null, bytes: 0 } : sessions.seal({ ...mine, session: input.session, files: input.files! });
    },
    run(ctx, _input, prepared) {
      const mine = bound(ctx.viewer), sealed = prepared as SealedSession | undefined;
      if (!mine || !sealed || sealed.conversation !== mine.conversation || sealed.harness !== mine.harness) throw new OperationError('denied', 'Current conversation body required');
      return { saved: sessions.store(sealed) };
    },
  });
}
