/** The two doors a body has to its conversation's kept harness session: it is handed the session when it
 * starts, and hands back the one it leaves. Nobody else has either: not another job's body, not a member,
 * not an owner. What is kept, how long and how it is sealed is core/conversations/sessions.ts.
 *
 * A conversation has one unended job at a time (the schema's index, and Jobs.admission), and both doors
 * ask for the body of that job, so two bodies cannot each resume and save the same session. */
import { createHash } from 'node:crypto';
import { bridgeSessionPostKeys } from './core/conversations/bridge-history.js';
import { threadReplyKey } from './core/conversations/history-limit.js';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { bridgeConnections, jobs, messages, turns, threads, jobSessionLimits } from './core/data/schema.js';
import { DOOR_REQUEST_BYTES } from './core/data/door-limit.js';
import { bodyOperationDefaults, type conversationBodyScope } from './core/conversations/body-scope.js';
import type { ConversationSessions, OpenedSession, SealedSession } from './core/conversations/sessions.js';
import { SESSION_ID, SESSION_HISTORY_KEYS } from './core/conversations/session-limit.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { wordsDeadline } from './core/conversations/retention.js';
import { commsKeepDays } from './core/data/comms-days.js';
import { jobHeld } from './shared-place-mail.js';

export function registerConversationSessions(operations: Operations, db: DataDatabase, sessions: ConversationSessions,
  current: ReturnType<typeof conversationBodyScope>, hash: (words: string) => string) {
  // A Comms transcript is sealed to one private thread, member, agent and project. The
  // current body scope checks that assignment afresh before any bytes are handed over.
  const bound = (viewer: Parameters<typeof current>[0]) => {
    const found=current(viewer);
    if(!found?.job.harness || jobHeld(db,found.job))return;
    const {cv,job}=found;
    if (db.select({invalidated:jobSessionLimits.invalidated}).from(jobSessionLimits).where(eq(jobSessionLimits.job,job.id)).get()?.invalidated) return;
    let scope:string|undefined;
    if(cv.venue==='loom'){
      const thread=db.select({id:threads.id}).from(threads).where(eq(threads.conversation,cv.id)).get();
      if(!cv.member || !thread || thread.id!==cv.place)return;
      scope=JSON.stringify([thread.id,cv.member,cv.agent,cv.project]);
    }else{
      if(!(bridgeConnections.platform.enumValues as readonly string[]).includes(cv.venue))return;
      // Older DM checkpoints lack an authoritative input deadline. Their workers
      // can still start from retained bridge history on the first run after upgrade.
      if(cv.member || cv.direct)scope=JSON.stringify([cv.venue,cv.place,cv.member,cv.agent,cv.project]);
    }
    return {job:job.id,conversation:cv.id,harness:found.job.harness,model:job.model,scope,agent:cv.agent,thread:cv.venue==='loom' ? cv.place : undefined};
  };
  /** A session last saved before the conversation's last answer does not hold that answer: its body died after
   * replying, or a body of another harness answered since. Resuming it would lose what was said, so it is
   * not handed on, and the body starts fresh with the kept history.
   *
   * One answer does not count: that of a job on anybody else's word. Such a job has neither door (bound,
   * above), so it could not have saved, and counting its answer would let a guest's message throw away the
   * owners' session. The session is handed on as the owners' last job left it; it does not hold what that
   * guest's job was told or said, which the conversation's kept history does. An answer whose job cannot be
   * found counts, as before. */
  const behind = (conversation: string, kept: OpenedSession) => {
    // Only the answers since the save are read, and each job is asked once.
    const since = new Set(db.select({ run: turns.run }).from(turns).where(and(eq(turns.conversation, conversation), eq(turns.kind, 'reply'), kept.throughReply === undefined ? sql`julianday(${turns.at}) > julianday(${kept.lastSavedAt})` : gt(turns.seq, kept.throughReply))).all().map(row => row.run));
    for (const run of since) {
      const by = run ? db.select({ id: jobs.id, agent: jobs.agent, conversation: jobs.conversation }).from(jobs).where(eq(jobs.id, run)).get() : undefined;
      if (!by || by.conversation !== conversation || !jobHeld(db, by)) return true;
    }
    return false;
  };
  const coverage=z.array(z.hash('sha256')).max(SESSION_HISTORY_KEYS);
  const defaults = bodyOperationDefaults(current, hash, 'loom-conversation-session-v1');
  operations.register({ name: 'conversation.session', write: false, doors: ['http'], input: z.object({historyKeys:z.literal(true).optional(),retention:z.literal(true).optional()}).strict(),
    output: z.object({ servedAt:z.iso.datetime().optional(), session: z.object({ session: z.string(), files: z.string(), since:z.string().optional(),keepUntil:z.string().optional(), covered: coverage.optional() }).strict().nullable() }).strict(),
    may: (viewer, input) => {
      const mine = bound(viewer);
      return !!mine && (!mine.scope || input.retention === true);
    },
    async prepare(_input, ctx) { const mine = bound(ctx.viewer); return mine ? { mine, kept: await sessions.open(mine.conversation, mine.harness, mine.model,mine.scope) } : undefined; },
    run(ctx, input, prepared) {
      const mine = bound(ctx.viewer), opened = prepared as { mine: NonNullable<ReturnType<typeof bound>>; kept: OpenedSession | null } | undefined;
      if (!mine || !opened || JSON.stringify(opened.mine) !== JSON.stringify(mine)) throw new OperationError('denied', 'Current conversation body required');
      const kept = opened.kept;
      // Still the row that was opened, and still ahead of the conversation's last answer. A body handed
      // nothing says so through the save door, which removes whatever is kept (runtime/body-session.ts).
      const row = sessions.kept(mine.conversation, mine.harness);
      if (!kept || row?.session !== kept.session || row.startedAt !== kept.startedAt || !row.files.equals(kept.ciphertext) || behind(mine.conversation, kept)) return { session: null };
      if(mine.scope) {
        const held=db.select().from(jobSessionLimits).where(eq(jobSessionLimits.job,mine.job)).get();
        const expires=wordsDeadline({at:row.startedAt,keepUntil:row.keepUntil},commsKeepDays(db));
        if(!held || Date.parse(held.since)>Date.parse(row.startedAt) || wordsDeadline({at:held.since,keepUntil:held.keepUntil},commsKeepDays(db))>expires)return {session:null};
      }
      return { ...(input.retention ? {servedAt:new Date(operations.clock.now()).toISOString()} : {}), session: { session: kept.session, files: kept.files, ...(input.retention ? {since: row.startedAt,keepUntil: new Date(wordsDeadline({at:row.startedAt,keepUntil:row.keepUntil},commsKeepDays(db))).toISOString()} : {}), ...(input.historyKeys && kept.covered ? {covered:kept.covered} : {}) } };
    },
  });
  operations.register({ ...defaults, name: 'conversation.sessionSave',
    // `session: null` says the body leaves no session it can hand on: whatever is kept is then behind and is removed.
    // `since`: the time of the oldest word this body was handed that is erased at the keep time, when it started fresh.
    input: z.object({ session: z.string().regex(SESSION_ID).nullable(), covered:coverage.optional(), files: z.base64().max(DOOR_REQUEST_BYTES).optional(), keepUntil: z.iso.datetime({ offset:true }).optional(), since: z.iso.datetime({ offset: true }).optional() }).strict()
      .refine(value => (value.session === null) === (value.files === undefined) && (value.session !== null || (value.keepUntil === undefined && value.since === undefined && value.covered === undefined))),
    output: z.object({ saved: z.boolean() }).strict(),
    may: viewer => !!bound(viewer),
    async prepare(input, ctx): Promise<SealedSession | undefined> {
      const mine = bound(ctx.viewer);
      if (!mine) return undefined;
      if (input.session === null) return { ...mine, session: '', sealed: null, bytes: 0 };
      let covered = input.covered;
      if (covered) {
        // A harness can post progress before its final answer. Its transcript already
        // contains those tool calls, including a bridge post still in the provider queue.
        const replies = mine.thread ? db.select({seq: messages.seq}).from(messages).where(and(
          eq(messages.thread, mine.thread), eq(messages.run, mine.job),
          eq(messages.kind, 'reply'), eq(messages.sender, mine.agent),
        )).orderBy(desc(messages.seq)).limit(SESSION_HISTORY_KEYS).all().reverse().map(row => threadReplyKey(row.seq))
          : bridgeSessionPostKeys(db, mine.conversation, mine.job, SESSION_HISTORY_KEYS);
        const own = new Set(replies.map(key => createHash('sha256').update(key).digest('hex')));
        covered = [...covered.filter(key => !own.has(key)), ...own].slice(-SESSION_HISTORY_KEYS);
      }
      return sessions.seal({ ...mine, session: input.session, files: input.files!, keepUntil:input.keepUntil, covered, ...(input.since ? { since: input.since } : {}) });
    },
    run(ctx, _input, prepared) {
      const mine = bound(ctx.viewer), sealed = prepared as SealedSession | undefined;
      if (!mine || !sealed || sealed.scope!==mine.scope || sealed.conversation !== mine.conversation || sealed.harness !== mine.harness) throw new OperationError('denied', 'Current conversation body required');
      return { saved: sessions.store(sealed,mine.job) };
    },
  });
}
