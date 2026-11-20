import { closeThreadWakes } from '../tempo/wake-mail.js';
import { threadTitle } from './title.js';
/** Private Comms thread metadata over the same conversation and message tables.
 * This trusted service takes already authenticated inputs from its caller. */
import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, max } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { unendedJobStates } from '../data/job-states.js';
import { conversations, deletedThreads, jobs, messages, threads } from '../data/schema.js';
import { Conversations, lateMailWaits, type LateJoins } from './index.js';

type Thread = typeof threads.$inferSelect;
export type ThreadInput = { id?: string; venue?: 'loom' | 'terminal'; member: string; agent: string; project?: string; title: string; titledBy?: Thread['titledBy'] };

export class Threads {
  readonly conversations: Conversations;
  /** `lateJoins` is the conversations service's (index.ts): closed unless the composition gives the rule. */
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString(), lateJoins: LateJoins = lateMailWaits) {
    this.conversations = new Conversations(db, now, lateJoins);
  }

  thread(id: string): Thread {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) throw new Error('Thread not found');
    return row;
  }

  open(input: ThreadInput): Thread {
    const id = input.id ?? `th:${randomUUID()}`;
    return this.db.transaction(() => {
      if (this.db.select().from(deletedThreads).where(eq(deletedThreads.id, id)).get()) throw new Error('Thread was deleted');
      const existing = this.db.select().from(threads).where(eq(threads.id, id)).get();
      if (existing) {
        const cv = this.conversations.conversation(existing.conversation);
        if (cv.venue !== (input.venue ?? 'loom') || cv.agent !== input.agent || cv.member !== input.member || cv.project !== (input.project ?? null)) throw new Error('Thread identity differs');
        return existing;
      }
      const title = this.title(input.title), at = this.now();
      const cv = this.conversations.open({ agent: input.agent, member: input.member, project: input.project, venue: input.venue ?? 'loom', place: id, label: title }, at);
      if (cv.member !== input.member || cv.project !== (input.project ?? null)) throw new Error('Conversation is not this private thread');
      return this.db.insert(threads).values({ id, conversation: cv.id, title, titledBy: input.titledBy ?? 'member', pinned: false, openedAt: at, lastAt: at, readSeq: 0, working: false, stopRequested: false }).returning().get();
    });
  }

  private title(value: string): string {
    const title=threadTitle.safeParse(value);
    if(!title.success)throw new Error('Thread title must be 1–60 characters');
    return title.data;
  }

  rename(id: string, value: string, by: Thread['titledBy']): Thread {
    return this.db.transaction(() => {
      const thread = this.thread(id);
      if (by === 'agent' && thread.titledBy === 'member') return thread;
      const title = this.title(value);
      // The title is kept in three places: the thread, its conversation's label, and the title a job
      // copied when it was queued. This is the one place a title changes, so all three change here.
      // A finished job keeps the title it ran under.
      this.db.update(conversations).set({ label: title }).where(eq(conversations.id, thread.conversation)).run();
      this.db.update(jobs).set({ title }).where(and(eq(jobs.conversation, thread.conversation), inArray(jobs.state, unendedJobStates))).run();
      return this.db.update(threads).set({ title, titledBy: by }).where(eq(threads.id, id)).returning().get()!;
    });
  }

  pin(id: string, pinned: boolean): Thread {
    return this.db.transaction(() => {
      const thread = this.thread(id);
      if (pinned && !thread.pinned) {
        const cv = this.conversations.conversation(thread.conversation);
        if (!cv.member) throw new Error('Thread must be private to a member');
        const total = this.db.select({ count: count() }).from(threads).innerJoin(conversations, eq(threads.conversation, conversations.id))
          .where(and(eq(conversations.member, cv.member), eq(threads.pinned, true))).get()!.count;
        if (total >= 8) throw new Error('A member can pin eight threads');
      }
      return this.db.update(threads).set({ pinned }).where(eq(threads.id, id)).returning().get()!;
    });
  }

  archive(id: string, archived: boolean): Thread {
    return this.db.transaction(() => {
      const thread = this.thread(id), at = this.now();
      if (archived) closeThreadWakes(this.db, thread, at);
      return this.db.update(threads).set({ archivedAt: archived ? thread.archivedAt ?? at : null }).where(eq(threads.id, id)).returning().get()!;
    });
  }

  read(id: string, seq: number): Thread {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid message sequence');
    return this.db.transaction(() => {
      const thread = this.thread(id);
      const latest = this.db.select({ seq: max(messages.seq) }).from(messages).where(eq(messages.thread, id)).get()?.seq ?? 0;
      return this.db.update(threads).set({ readSeq: Math.max(thread.readSeq, Math.min(seq, latest)) }).where(eq(threads.id, id)).returning().get()!;
    });
  }

  working(id: string, active: boolean): Thread {
    return this.db.transaction(() => {
      const thread = this.thread(id), at = this.now();
      return this.db.update(threads).set({ working: active, workingSince: active ? thread.workingSince ?? at : null, workingBeat: active ? at : null })
        .where(eq(threads.id, id)).returning().get()!;
    });
  }

  requestStop(id: string): Thread {
    const thread = this.thread(id);
    if (!thread.working) return thread;
    return this.db.update(threads).set({ stopRequested: true }).where(eq(threads.id, id)).returning().get()!;
  }

  takeStop(id: string): boolean {
    return this.db.transaction(() => {
      const thread = this.thread(id);
      this.db.update(threads).set({ stopRequested: false }).where(eq(threads.id, id)).run();
      return thread.stopRequested;
    });
  }
}
