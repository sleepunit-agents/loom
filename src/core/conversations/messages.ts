/** Trusted private-message service. External doors authenticate and authorize;
 * encrypted words never enter operation receipts or the plaintext Inbox. */
import { and, eq, inArray, isNotNull, lte, max, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversations, deletedThreads, household, inbox, inboxRefs, messages, threadRefs, threads } from '../data/schema.js';
import type { WordsKey } from '../../pieces/comms/crypto.js';
import { refsIn } from '../../pieces/comms/refs.js';
import { Threads } from './threads.js';

type Message = typeof messages.$inferSelect;
type Answer = NonNullable<typeof inbox.$inferSelect.answer>;
export type PrivateQuestion = { words: string; answers: 'yes-no' | 'words'; why?: string; ifYes?: string; ifNo?: string; link?: string };
export type MessageInput = {
  thread: string; sender: string; kind: 'message' | 'reply' | 'card' | 'notice'; words: string;
  clientId?: string; run?: string; tool?: string; cardState?: Message['cardState'];
};

export class CommsMessages {
  readonly threads: Threads;
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly now: () => string = () => new Date().toISOString()) {
    this.threads = new Threads(db, now);
  }

  private context(id: string) {
    const thread = this.threads.thread(id);
    return { thread, cv: this.threads.conversations.conversation(thread.conversation) };
  }

  private retry(thread: string, sender: string, clientId?: string) {
    return clientId == null ? undefined : this.db.select().from(messages)
      .where(and(eq(messages.thread, thread), eq(messages.sender, sender), eq(messages.clientId, clientId))).get();
  }

  private append(input: Omit<typeof messages.$inferInsert, 'seq' | 'at' | 'keepUntil'>, refs: string[]): Message {
    const { thread, cv } = this.context(input.thread), at = this.now();
    const days = this.db.select().from(household).get()?.commsDays ?? 14;
    if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error('Invalid Comms keep time');
    const seq = (this.db.select({ seq: max(messages.seq) }).from(messages).where(eq(messages.thread, thread.id)).get()?.seq ?? 0) + 1;
    const row = this.db.insert(messages).values({ ...input, seq, at, keepUntil: new Date(Date.parse(at) + days * 86400000).toISOString() }).returning().get();
    this.db.update(threads).set({ lastAt: at }).where(eq(threads.id, thread.id)).run();
    this.db.update(conversations).set({ lastAt: at }).where(eq(conversations.id, cv.id)).run();
    for (const ref of new Set(refs)) this.db.insert(threadRefs).values({ thread: thread.id, ref, messageSeq: seq })
      .onConflictDoUpdate({ target: [threadRefs.thread, threadRefs.ref], set: { messageSeq: seq } }).run();
    return row;
  }

  private attach(message: Message, item: typeof inbox.$inferSelect): Message {
    return this.db.update(messages).set({ inboxItem: item.id }).where(and(eq(messages.thread, message.thread), eq(messages.seq, message.seq))).returning().get()!;
  }

  async send(input: MessageInput): Promise<Message> {
    return (await this.prepareSend(input))();
  }

  /** No durable effects until the returned synchronous commit runs. The door
   * must recheck authentication and authorization before invoking it, inside
   * its operation transaction. Return only acknowledgement metadata to receipts. */
  async prepareSend(input: MessageInput): Promise<() => Message> {
    input = { ...input };
    const before = this.context(input.thread);
    if (input.sender !== (input.kind === 'message' ? before.cv.member : before.cv.agent)) throw new Error('Sender differs from thread');
    const old = this.retry(input.thread, input.sender, input.clientId);
    if (old) return () => { this.context(input.thread); return old; };
    const refs = refsIn(input.words), words = await this.key.seal(input.words);
    return () => this.db.transaction(() => {
      const { cv } = this.context(input.thread);
      if (input.sender !== (input.kind === 'message' ? cv.member : cv.agent)) throw new Error('Sender differs from thread');
      const retry = this.retry(input.thread, input.sender, input.clientId);
      if (retry) return retry;
      let row = this.append({ ...input, words, delivery: input.kind === 'message' ? 'sending' : null }, refs);
      if (input.kind === 'message') row = this.attach(row, this.threads.conversations.send({
        toKind: 'agent', to: cv.agent, conversation: cv.id, source: 'thread', sourceId: `${row.thread}:${row.seq}`,
        fromKind: 'person', fromId: input.sender, thread: row.thread, messageSeq: row.seq, refs,
      }));
      return row;
    });
  }

  async ask(threadId: string, agent: string, clientId: string, question: PrivateQuestion): Promise<Message> {
    return (await this.prepareAsk(threadId, agent, clientId, question))();
  }

  async prepareAsk(threadId: string, agent: string, clientId: string, question: PrivateQuestion): Promise<() => Message> {
    question = { ...question };
    const { cv } = this.context(threadId);
    if (agent !== cv.agent || !cv.member) throw new Error('Agent differs from private thread');
    const old = this.retry(threadId, agent, clientId);
    if (old) return () => { this.context(threadId); return old; };
    if (!question.words.trim()) throw new Error('Question needs words');
    const words = await this.key.seal(JSON.stringify(question));
    const refs = refsIn(Object.values(question).join('\n'));
    return () => this.db.transaction(() => {
      const { cv } = this.context(threadId);
      if (agent !== cv.agent || !cv.member) throw new Error('Agent differs from private thread');
      const retry = this.retry(threadId, agent, clientId);
      if (retry) return retry;
      const row = this.append({ thread: threadId, sender: agent, kind: 'ask', clientId, words }, refs);
      return this.attach(row, this.threads.conversations.send({ toKind: 'person', to: cv.member!, conversation: cv.id,
        source: 'thread', sourceId: `${threadId}:${row.seq}`, fromKind: 'agent', fromId: agent,
        answers: question.answers, thread: threadId, messageSeq: row.seq, refs }));
    });
  }

  async answer(itemId: string, member: string, answer: Answer, text?: string): Promise<typeof inbox.$inferSelect> {
    return (await this.prepareAnswer(itemId, member, answer, text))();
  }

  async prepareAnswer(itemId: string, member: string, answer: Answer, text?: string): Promise<() => typeof inbox.$inferSelect> {
    const check = () => {
      const item = this.threads.conversations.item(itemId);
      if (!item.thread || item.messageSeq == null || item.toKind !== 'person' || !item.answers) throw new Error('Not a private question');
      const { cv } = this.context(item.thread);
      if (item.conversation !== cv.id) throw new Error('Question differs from thread');
      if (item.source !== 'thread' || item.waitsOnKind) throw new Error('Answer at the linked source');
      return { item, cv };
    };
    const { item } = check();
    if (item.state === 'answered') return () => check().item;
    if (item.state !== 'waiting') throw new Error('Question is already settled');
    if ((answer === 'yes' || answer === 'no') && item.answers !== 'yes-no') throw new Error('Question needs words');
    if ((answer === 'words' || answer === 'replied') && !text?.trim()) throw new Error('Answer needs words');
    const words = await this.key.seal(text?.trim() || answer), refs = refsIn(text ?? '');
    return () => this.db.transaction(() => {
      const { item, cv } = check();
      if (item.state === 'answered') return item;
      if (item.state !== 'waiting') throw new Error('Question is already settled');
      const row = this.append({ thread: item.thread!, sender: member, kind: 'answer', words,
        verdict: answer === 'yes' || answer === 'no' ? answer : null }, refs);
      const mail = this.threads.conversations.send({ toKind: 'agent', to: cv.agent, conversation: cv.id, source: 'answer', sourceId: item.id,
        fromKind: 'person', fromId: member, thread: row.thread, messageSeq: row.seq, refs: [item.id, ...refs] });
      this.attach(row, mail);
      const at = this.now();
      return this.db.update(inbox).set({ state: 'answered', answer, answerText: null, answeredBy: member, answeredAt: at, changedAt: at })
        .where(eq(inbox.id, item.id)).returning().get()!;
    });
  }

  /** Expired words stay unavailable even before the periodic sweep runs. */
  async words(thread: string, seq: number): Promise<string | null> {
    const row = this.db.select().from(messages).where(and(eq(messages.thread, thread), eq(messages.seq, seq))).get();
    if (!row?.words || !row.keepUntil || row.keepUntil <= this.now()) return null;
    const words = await this.key.open(row.words);
    const current = this.db.select().from(messages).where(and(eq(messages.thread, thread), eq(messages.seq, seq))).get();
    return current?.words && current.keepUntil && current.keepUntil > this.now() ? words : null;
  }

  expire(): number {
    return this.db.update(messages).set({ words: null }).where(and(isNotNull(messages.words), lte(messages.keepUntil, this.now()))).returning({ seq: messages.seq }).all().length;
  }

  /** Remove private words and references; retain Inbox outcome metadata and a
   * tombstone so delayed retries cannot recreate the conversation's thread. */
  delete(threadId: string): void {
    this.db.transaction(() => {
      if (this.db.select().from(deletedThreads).where(eq(deletedThreads.id, threadId)).get()) return;
      const { thread } = this.context(threadId), at = this.now();
      this.db.insert(deletedThreads).values({ id: threadId, conversation: thread.conversation, at }).run();
      this.db.delete(inboxRefs).where(inArray(inboxRefs.item, this.db.select({ id: inbox.id }).from(inbox).where(eq(inbox.thread, threadId)))).run();
      this.db.update(inbox).set({ thread: null, messageSeq: null,
        state: sql`case when ${inbox.state} in ('waiting', 'taken') then 'resolved' else ${inbox.state} end`,
        resolution: 'Thread deleted', changedAt: at }).where(eq(inbox.thread, threadId)).run();
      this.db.delete(threads).where(eq(threads.id, threadId)).run();
    });
  }
}
