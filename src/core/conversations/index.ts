/** The trusted conversation service. External callers enter through the data API;
 * built-in producers share this interface and the same tables, in every venue. */
import { inboxContentChanged, type Recipient } from '../tempo/volume.js';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, max, ne, or } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversations, conversationPeople, turns, inbox, inboxRefs, inboxReads, digests, digestItems, jobs } from '../data/schema.js';

type Conversation = typeof conversations.$inferSelect;
type Item = typeof inbox.$inferSelect;
type Turn = typeof turns.$inferInsert;
export type ConversationInput = Pick<Conversation, 'agent' | 'venue' | 'place' | 'label'> & Partial<Pick<Conversation, 'project' | 'member'>>;
export type InboxInput = Pick<Item, 'toKind' | 'to' | 'source' | 'fromKind'> & Partial<Pick<Item,
  'sourceId' | 'conversation' | 'fromId' | 'words' | 'project' | 'agent' | 'member' | 'answers' | 'why' | 'ifYes' | 'ifNo' | 'link' | 'waitsOnKind' | 'waitsOnId' | 'thread' | 'messageSeq'>> & { refs?: string[] };
export type Question = Omit<InboxInput, 'toKind' | 'conversation' | 'source' | 'sourceId' | 'fromKind' | 'fromId'> & { answers: 'yes-no' | 'words'; words: string };
export type DigestInput = {
  conversation: string; run: string; summary: string;
  items?: { kind: 'decision' | 'ask' | 'task' | 'project'; text: string }[];
  question?: Question;
};

/** These live phases follow the running acknowledgement; queued/starting do not. */
export const liveConversationJob = (state: typeof jobs.$inferSelect.state) => state === 'running' || state === 'waiting';

/** All multi-row changes commit together, including source deduplication and
 * the question/answer round trip. now is injected for fake-clock execution. */
export class Conversations {
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString()) {}

  open(input: ConversationInput): Conversation {
    return this.db.transaction(() => {
      const existing = this.db.select().from(conversations).where(and(eq(conversations.agent, input.agent), eq(conversations.venue, input.venue), eq(conversations.place, input.place))).get();
      if (existing) return existing;
      const at = this.now();
      return this.db.insert(conversations).values({ ...input, id: `cv-${randomUUID()}`, startedAt: at, lastAt: at, turnCount: 0 }).returning().get();
    });
  }

  conversation(id: string): Conversation {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) throw new Error('Conversation not found');
    return row;
  }

  turn(input: Omit<Turn, 'seq' | 'at'>): typeof turns.$inferSelect {
    return this.db.transaction(() => {
      const conversation = this.conversation(input.conversation), at = this.now();
      const seq = conversation.turnCount + 1;
      const row = this.db.insert(turns).values({ ...input, seq, at }).returning().get();
      this.db.update(conversations).set({ turnCount: seq, lastAt: at }).where(eq(conversations.id, conversation.id)).run();
      if ((input.fromKind === 'person' || input.fromKind === 'agent') && input.fromId) {
        this.db.insert(conversationPeople).values({ conversation: conversation.id, whoKind: input.fromKind, who: input.fromId }).onConflictDoNothing().run();
      }
      return row;
    });
  }

  send(input: InboxInput): Item {
    return this.db.transaction(() => {
      if (input.sourceId != null) {
        const existing = this.db.select().from(inbox).where(and(eq(inbox.toKind, input.toKind), eq(inbox.to, input.to), eq(inbox.source, input.source), eq(inbox.sourceId, input.sourceId))).get();
        if (existing) return existing;
      }
      const conversation = input.conversation ? this.conversation(input.conversation) : undefined;
      if (conversation && input.toKind === 'agent' && input.to !== conversation.agent) throw new Error('Recipient differs from conversation agent');
      const at = this.now();
      const seq = conversation ? (this.db.select({ seq: max(inbox.seq) }).from(inbox).where(eq(inbox.conversation, conversation.id)).get()?.seq ?? 0) + 1 : null;
      const { refs = [], ...values } = input;
      const item = this.db.insert(inbox).values({
        project: conversation?.project, agent: conversation?.agent, member: conversation?.member,
        ...values, id: `in-${randomUUID()}`, seq, at, changedAt: at, state: 'waiting',
      }).returning().get();
      for (const ref of new Set(refs)) this.db.insert(inboxRefs).values({ item: item.id, ref }).run();
      return item;
    });
  }

  item(id: string): Item {
    const row = this.db.select().from(inbox).where(eq(inbox.id, id)).get();
    if (!row) throw new Error('Inbox item not found');
    return row;
  }

  /** Read a delivery snapshot without claiming mail or holding a transaction
   * across decryption. The current running job is checked again by take(). */
  pending(conversationId: string, jobId: string): Item[] {
    const conversation = this.conversation(conversationId);
    const job = this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (conversation.job !== jobId || job?.conversation !== conversationId || job.agent !== conversation.agent || !liveConversationJob(job.state)) throw new Error('Job is not running in this conversation');
    return this.db.select().from(inbox).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent),
      or(eq(inbox.state, 'waiting'), and(eq(inbox.job, jobId), eq(inbox.state, 'taken'))), ne(inbox.volume, 'mute'))).orderBy(asc(inbox.seq)).all();
  }

  /** Only the current job can claim this conversation's waiting mail. An
   * explicit batch leaves mail arriving during async preparation waiting. */
  take(conversationId: string, jobId: string, batch?: readonly string[]): Item[] {
    return this.db.transaction(() => {
      this.pending(conversationId, jobId);
      if (batch?.length === 0) return [];
      const conversation = this.conversation(conversationId);
      const at = this.now();
      const selected = batch ? inArray(inbox.id, [...batch]) : undefined;
      this.db.update(inbox).set({ state: 'taken', job: jobId, takenAt: at, changedAt: at }).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'), selected)).run();
      // Snapshot each actual publication, including a retry of an unconfirmed take.
      this.db.update(inbox).set({takenVolume:inbox.volume}).where(and(eq(inbox.conversation,conversationId),eq(inbox.job,jobId),eq(inbox.state,'taken'),ne(inbox.volume,'mute'),selected)).run();
      return this.db.select().from(inbox).where(and(eq(inbox.conversation, conversationId), eq(inbox.job, jobId), eq(inbox.state, 'taken'), ne(inbox.volume, 'mute'), selected)).orderBy(asc(inbox.seq)).all();
    });
  }

  confirm(itemId: string, jobId: string): Item {
    return this.db.transaction(() => {
      const item = this.item(itemId);
      if (item.job !== jobId || !['taken', 'done'].includes(item.state)) throw new Error('Item is not held by this job');
      if (item.state === 'done') return item;
      const at = this.now();
      return this.db.update(inbox).set({ state: 'done', doneAt: at, changedAt: at }).where(eq(inbox.id, itemId)).returning().get()!;
    });
  }

  /** Permission and recipient checks belong at the external door. This method
   * receives the authenticated member, never a claimed sender from message text. */
  answer(itemId: string, member: string, answer: NonNullable<Item['answer']>, words?: string): Item {
    return this.db.transaction(() => {
      const item = this.item(itemId);
      if (item.toKind !== 'person' || !item.answers) throw new Error('Item is not a question for a person');
      if (item.thread) throw new Error('Answer through encrypted Comms');
      if (item.state === 'answered') return item;
      if (item.state !== 'waiting') throw new Error('Question is already settled');
      if (item.source === 'task' || item.source === 'approval' || item.source === 'secret-request' || item.waitsOnKind) throw new Error('Answer at the linked source');
      if ((answer === 'yes' || answer === 'no') && item.answers !== 'yes-no') throw new Error('Question needs words');
      if ((answer === 'words' || answer === 'replied') && !words?.trim()) throw new Error('Answer needs words');
      const at = this.now();
      inboxContentChanged(this.db, {kind:item.toKind,id:item.to}, item.id);
      const updated = this.db.update(inbox).set({ state: 'answered', answer, answerText: words ?? null, answeredBy: member, answeredAt: at, changedAt: at }).where(eq(inbox.id, itemId)).returning().get()!;
      if (item.conversation) {
        const conversation = this.conversation(item.conversation);
        const outcome = answer === 'yes' ? item.ifYes : answer === 'no' ? item.ifNo : null;
        this.send({ toKind: 'agent', to: conversation.agent, conversation: conversation.id, source: 'answer', sourceId: item.id, fromKind: 'person', fromId: member,
          words: [words?.trim() || answer, item.words, outcome].filter(Boolean).join('\n'), refs: [item.id] });
        this.turn({ conversation: conversation.id, kind: 'message', fromKind: 'person', fromId: member });
      }
      return updated;
    });
  }

  read(item: string, member: string): void {
    this.db.insert(inboxReads).values({ item, member, readAt: this.now() }).onConflictDoUpdate({ target: [inboxReads.item, inboxReads.member], set: { readAt: this.now() } }).run();
  }

  /** Called by tasks/approvals when their durable outcome is committed. */
  resolve(kind: 'task' | 'approval', id: string, reason: string, named?: Recipient): Item[] {
    return this.db.transaction(() => {
      const resolved = this.db.update(inbox).set({ state: 'resolved', resolution: reason, changedAt: this.now() }).where(and(eq(inbox.waitsOnKind, kind), eq(inbox.waitsOnId, id), eq(inbox.state, 'waiting'))).returning().all();
      for (const item of resolved) inboxContentChanged(this.db, {kind:item.toKind,id:item.to}, item.id, named?.kind === item.toKind && named.id === item.to);
      return resolved.map(item => this.item(item.id));
    });
  }

  digest(input: DigestInput, questionItem?: string): typeof digests.$inferSelect {
    if (input.summary.length > 600) throw new Error('Digest summary exceeds 600 characters');
    return this.db.transaction(() => {
      const conversation = this.conversation(input.conversation);
      if (input.question && questionItem) throw new Error('Digest needs one question source');
      if (input.question && conversation.venue === 'loom' && conversation.member) throw new Error('Private digest questions need encrypted Comms');
      const raised = questionItem ? this.item(questionItem) : undefined;
      if (raised && (raised.conversation !== conversation.id || raised.toKind !== 'person' || !raised.answers || raised.state !== 'waiting'
        || (conversation.member && raised.to !== conversation.member))) throw new Error('Digest question differs from conversation');
      if (raised && conversation.venue === 'loom' && conversation.member && (!raised.thread || raised.messageSeq == null
        || raised.words !== null || raised.why !== null || raised.ifYes !== null || raised.ifNo !== null || raised.link !== null)) throw new Error('Private digest question needs encrypted message reference');
      const old = this.db.select().from(digests).where(and(eq(digests.conversation, input.conversation), eq(digests.run, input.run))).get();
      // A rewrite retires its old pending question; answered questions stay as history.
      if (old?.inboxItem && old.inboxItem !== raised?.id) {
        const retired = this.db.update(inbox).set({ state: 'resolved', resolution: 'Digest rewritten', changedAt: this.now() }).where(and(eq(inbox.id, old.inboxItem), eq(inbox.state, 'waiting'))).returning().get();
        if (retired) inboxContentChanged(this.db, {kind:retired.toKind,id:retired.to}, retired.id);
      }
      const revision = (old?.revision ?? 0) + 1;
      const question = input.question ? this.send({ ...input.question, toKind: 'person', conversation: conversation.id, source: 'thread', sourceId: `digest:${input.run}:${conversation.id}:${revision}`, fromKind: 'agent', fromId: conversation.agent }) : undefined;
      if (question) this.turn({conversation:conversation.id,kind:'note',fromKind:'agent',fromId:conversation.agent,run:input.run});
      const values = { at: this.now(), summary: input.summary, revision, inboxItem: question?.id ?? raised?.id ?? null };
      const digest = old ? this.db.update(digests).set(values).where(eq(digests.id, old.id)).returning().get()!
        : this.db.insert(digests).values({ ...values, id: `dg-${randomUUID()}`, conversation: conversation.id, run: input.run }).returning().get();
      this.db.delete(digestItems).where(eq(digestItems.digest, digest.id)).run();
      for (const item of input.items ?? []) this.db.insert(digestItems).values({ ...item, digest: digest.id }).onConflictDoNothing().run();
      return digest;
    });
  }
}
