import {handoffEnvelope} from './handoff-words.js';
import {privateInboxEnvelope,isPrivateInboxQuestion} from './private-inbox-words.js';
/** The trusted conversation service. External callers enter through the data API;
 * built-in producers share this interface and the same tables, in every venue. */
import { inboxContentChanged, type Recipient } from '../tempo/volume.js';
import { acceptAnswer } from './answer-rule.js';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, max, ne, or, type SQL } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversations, conversationPeople, turns, inbox, inboxRefs, inboxReads, digests, digestItems, jobs } from '../data/schema.js';
import { conversationId } from '../../slug.js';

type Conversation = typeof conversations.$inferSelect;
type Item = typeof inbox.$inferSelect;
type Turn = typeof turns.$inferInsert;
export type ConversationInput = Pick<Conversation, 'agent' | 'venue' | 'place' | 'label'> & Partial<Pick<Conversation, 'project' | 'member' | 'direct'>>;
export type InboxInput = Pick<Item, 'toKind' | 'to' | 'source' | 'fromKind'> & Partial<Pick<Item,
  'sourceId' | 'conversation' | 'fromId' | 'words' | 'project' | 'agent' | 'member' | 'answers' | 'why' | 'ifYes' | 'ifNo' | 'link' | 'waitsOnKind' | 'waitsOnId' | 'thread' | 'messageSeq' | 'onWordKind' | 'onWord' | 'chain' | 'chainStartedAt'>> & { refs?: string[] };
export type Question = Omit<InboxInput, 'toKind' | 'conversation' | 'source' | 'sourceId' | 'fromKind' | 'fromId'> & { answers: 'yes-no' | 'words'; words: string };
export type DigestInput = {
  conversation: string; run: string; summary: string;
  items?: { kind: 'decision' | 'ask' | 'task' | 'project'; text: string }[];
  question?: Question;
};

/** Mail that never joins a job already admitted, by what it is: sent on somebody's word, from an agent, or
 * from the schedule. It starts the next job (pending). Said once, for pending and for who is counted in a
 * job's room (runtime/body-policy.ts). */
export const waitsForNextJob = (item: Pick<Item, 'onWordKind' | 'fromKind'>): boolean => item.onWordKind !== null || item.fromKind === 'agent' || item.fromKind === 'schedule';
/** Whether mail from a person that came after a job was admitted joins that job: asked once for the job
 * (so whatever it reads is read once), then of each piece. */
export type LateJoins = (job: { id: string; agent: string; conversation: string }) => (item: Item) => boolean;
/** The closed answer, and the default: nothing that came after admission joins; it waits for the next job.
 * For every instance no body takes its mail through. */
export const lateMailWaits: LateJoins = () => () => false;
/** These live phases follow the running acknowledgement; queued/starting do not. */
export const liveConversationJob = (state: typeof jobs.$inferSelect.state) => state === 'running';

/** All multi-row changes commit together, including source deduplication and
 * the question/answer round trip. now is injected for fake-clock execution. */
export class Conversations {
  /** `lateJoins` says whether mail from a person, arrived after a job was admitted, may still join it
   * (pending). Whose request a job is working on is not this service's to know, so whoever makes one says: the
   * composition gives the instance bodies take their mail through the real rule (shared-conversations.ts,
   * from shared-place-mail.ts lateMailJoins). Not given, it is closed: such mail waits for the next job. */
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString(), private readonly lateJoins: LateJoins = lateMailWaits) {}

  /** `at` is for a caller that stamps a second record of the same moment (a
   * thread and its conversation): it passes the one time it read. */
  open(input: ConversationInput, at = this.now()): Conversation {
    return this.db.transaction(() => {
      const existing = this.db.select().from(conversations).where(and(eq(conversations.agent, input.agent), eq(conversations.venue, input.venue), eq(conversations.place, input.place))).get();
      if (existing) return existing;
      return this.db.insert(conversations).values({ ...input, id: conversationId(randomUUID()), startedAt: at, lastAt: at, turnCount: 0 }).returning().get();
    });
  }

  conversation(id: string): Conversation {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) throw new Error('Conversation not found');
    return row;
  }

  /** `at` as for open(): a thread message and its turn are one moment. */
  turn(input: Omit<Turn, 'seq' | 'at'>, at = this.now()): typeof turns.$inferSelect {
    return this.db.transaction(() => {
      const conversation = this.conversation(input.conversation);
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
      if(input.source==='handoff'&&input.words!=null&&!handoffEnvelope(input.words))throw new Error('Handoff briefs must be encrypted');
      if(conversation?.member&&conversation.venue!=='loom'&&input.source==='thread'&&input.answers&&(!privateInboxEnvelope(input.words??null)||[input.why,input.ifYes,input.ifNo,input.link].some(value=>value!=null)))throw new Error('Private questions must be encrypted');
      const at = this.now();
      const seq = conversation ? (this.db.select({ seq: max(inbox.seq) }).from(inbox).where(eq(inbox.conversation, conversation.id)).get()?.seq ?? 0) + 1 : null;
      const { refs = [], ...values } = input;
      // The labels are a snapshot taken when the item is sent: the visibility rules read them without a
      // join, and an item with no conversation has nowhere else to keep them. They do not follow a later
      // change of the conversation's labels.
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

  /** An item filed under its source's labels holds a copy of them (send). When the source's own labels
   * change, whoever filed the item gives it the new ones here, in the same write. Its words, state and
   * answer are untouched; its changed time is set, so a reader that follows changes sees it move. */
  relabel(id: string, labels: Partial<Pick<Item, 'project' | 'agent' | 'member'>>): void {
    this.item(id);
    this.db.update(inbox).set({ ...labels, changedAt: this.now() }).where(eq(inbox.id, id)).run();
  }

  /** A waiting notice whose producer says it again in newer words: the same item, with its words replaced.
   * Its volume and its place are left as they are, so saying a thing again does not announce it again. */
  restate(id: string, said: { words: string; why: string | null }): void {
    if (this.item(id).state !== 'waiting') throw new Error('Only a waiting item can be restated');
    this.db.update(inbox).set({ words: said.words, why: said.why, changedAt: this.now() }).where(eq(inbox.id, id)).run();
  }

  /** Work-source facts keep their own scope. Their reply to an agent in a
   * private conversation must carry that conversation's current labels. A
   * different member's private source can never be relabelled into it. */
  answerScope(conversation:string|null,agent:string,source:{project:string|null;member:string|null}){
    if(!conversation)return undefined;
    const cv=this.conversation(conversation);
    if(cv.agent!==agent)throw new Error('Answer recipient differs from conversation');
    if(!cv.member)return undefined;
    if(source.member&&source.member!==cv.member)throw new Error('Answer source is private to another member');
    return {project:cv.project,member:cv.member};
  }

  /** Read a delivery snapshot without claiming mail or holding a transaction
   * across decryption. The current running job is checked again by take(). */
  pending(conversationId: string, jobId: string): Item[] {
    const conversation = this.conversation(conversationId);
    const job = this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (job?.conversation !== conversationId || job.agent !== conversation.agent || !liveConversationJob(job.state)) throw new Error('Job is not running in this conversation');
    // Mail on somebody's word, from an agent or from the schedule, that was not there when this job was admitted
    // is left for the next job: this one was claimed for the people behind its own mail, and runs with what
    // they are given. Admission marks the mail a job was started for (runtime/jobs.ts, `inbox.job`), and a
    // retry carries the mark over, so what came later has no job yet. By that mark and by no clock: mail
    // written in the millisecond the job was claimed came later all the same. A job nothing is marked for
    // was not started by admission (only tests make one), and nothing says what it was started for.
    // Mail from a person that came later joins the job only when the same asker wrote it (lateJoins): a job
    // formed for its owners is never handed a guest's words to answer, nor a guest's job an owner's.
    const admitted = !!this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.conversation, conversationId), eq(inbox.job, jobId))).get();
    let judge: ((item: Item) => boolean) | undefined;
    const joins = (item: Item) => !waitsForNextJob(item) && (judge ??= this.lateJoins({ id: jobId, agent: conversation.agent, conversation: conversationId }))(item);
    return this.db.select().from(inbox).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent),
      or(eq(inbox.state, 'waiting'), and(eq(inbox.job, jobId), eq(inbox.state, 'taken'))), ne(inbox.volume, 'mute'))).orderBy(asc(inbox.seq)).all()
      .filter(item => !admitted || item.job === jobId || joins(item));
  }

  /** Only the current job can claim this conversation's waiting mail. An
   * explicit batch leaves mail arriving during async preparation waiting. */
  take(conversationId: string, jobId: string, batch?: readonly string[]): Item[] {
    return this.db.transaction(() => {
      // Only what pending() offers this job is ever taken, with a batch or without: mail it leaves for the next job stays waiting.
      const offered = this.pending(conversationId, jobId).map(item => item.id), ids = batch ? batch.filter(id => offered.includes(id)) : offered;
      if (!ids.length) return [];
      const conversation = this.conversation(conversationId);
      const at = this.now();
      const selected = inArray(inbox.id, ids);
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
      if (item.thread || isPrivateInboxQuestion(item)) throw new Error('Answer through encrypted conversation service');
      if (acceptAnswer(item, member, answer, words, false) === 'repeat') return item;
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

  /** The one place a waiting item becomes resolved: only an item still waiting closes, and its
   * recipient's volume hears of it. Every resolve below names which items; none restates this. */
  private close(which: SQL | undefined, reason: string, named?: Recipient): Item[] {
    return this.db.transaction(() => {
      const resolved = this.db.update(inbox).set({ state: 'resolved', resolution: reason, changedAt: this.now() }).where(and(which, eq(inbox.state, 'waiting'))).returning().all();
      for (const item of resolved) inboxContentChanged(this.db, {kind:item.toKind,id:item.to}, item.id, named?.kind === item.toKind && named.id === item.to);
      // Read again: the volume change above is part of what the caller is told.
      return resolved.map(item => this.item(item.id));
    });
  }

  /** Called by tasks/approvals when their durable outcome is committed. */
  resolve(kind: 'task' | 'approval', id: string, reason: string, named?: Recipient): Item[] {
    return this.close(and(eq(inbox.waitsOnKind, kind), eq(inbox.waitsOnId, id)), reason, named);
  }

  /** Close what a producer sent under its own source id (a secret request, a notice), for one recipient or for all. */
  resolveSource(source: Item['source'], sourceId: string, reason: string, to?: Recipient): Item[] {
    return this.close(and(eq(inbox.source, source), eq(inbox.sourceId, sourceId), to && and(eq(inbox.toKind, to.kind), eq(inbox.to, to.id))), reason);
  }

  /** Close one item by its id, if it still waits. */
  resolveItem(id: string, reason: string): Item | undefined {
    return this.close(eq(inbox.id, id), reason)[0];
  }

  /** The reverse of take: mail a job took and never confirmed waits again, still bound to that job,
   * so whoever ends the job decides whether a next attempt gets it. */
  returnTaken(jobId: string): void {
    this.db.update(inbox).set({ state: 'waiting', takenAt: null, changedAt: this.now() }).where(and(eq(inbox.job, jobId), eq(inbox.state, 'taken'))).run();
  }

  /** Replace the words of an answer that must not be kept (a one-time code) with a marker, in every record
   * that holds them: the answer on the question, and the copy of it mailed to the agent when the question
   * was asked in a conversation (answer, above). The item stays answered; only words not already replaced
   * change. A sealed answer has no plain words on the question and is left to its keep time. */
  redactAnswer(id: string, marker: string): void {
    this.db.transaction(() => {
      const at = this.now();
      if (!this.db.update(inbox).set({ answerText: marker, changedAt: at }).where(and(eq(inbox.id, id), isNotNull(inbox.answerText), ne(inbox.answerText, marker))).run().changes) return;
      this.db.update(inbox).set({ words: marker, changedAt: at }).where(and(eq(inbox.source, 'answer'), eq(inbox.sourceId, id), isNotNull(inbox.words), ne(inbox.words, marker))).run();
    });
  }

  digest(input: DigestInput, questionItem?: string): typeof digests.$inferSelect {
    if (input.summary.length > 600) throw new Error('Digest summary exceeds 600 characters');
    return this.db.transaction(() => {
      const conversation = this.conversation(input.conversation);
      if (input.question && questionItem) throw new Error('Digest needs one question source');
      if (input.question && conversation.venue === 'loom' && conversation.member) throw new Error('Private digest questions need encrypted Comms');
      if (input.question && conversation.member) throw new Error('Private digest questions need encrypted conversation service');
      const raised = questionItem ? this.item(questionItem) : undefined;
      if (raised && (raised.conversation !== conversation.id || raised.toKind !== 'person' || !raised.answers || raised.state !== 'waiting'
        || (conversation.member && raised.to !== conversation.member))) throw new Error('Digest question differs from conversation');
      if (raised && conversation.venue === 'loom' && conversation.member && (!raised.thread || raised.messageSeq == null
        || raised.words !== null || raised.why !== null || raised.ifYes !== null || raised.ifNo !== null || raised.link !== null)) throw new Error('Private digest question needs encrypted message reference');
      if(raised&&conversation.member&&conversation.venue!=='loom'&&(raised.thread!==null||raised.messageSeq!==null||!privateInboxEnvelope(raised.words)||raised.why!==null||raised.ifYes!==null||raised.ifNo!==null||raised.link!==null))throw new Error('Private digest question needs encrypted Inbox words');
      const old = this.db.select().from(digests).where(and(eq(digests.conversation, input.conversation), eq(digests.run, input.run))).get();
      // A rewrite retires its old pending question; answered questions stay as history.
      if (old?.inboxItem && old.inboxItem !== raised?.id) {
        this.resolveItem(old.inboxItem, 'Digest rewritten');
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

/** Every conversation, and every inbox item, filed under one project is filed under another: for a merge of
 * the two (shared-projects.ts). The two go together, so an item still carries its conversation's project. */
export function refileConversations(db: DataDatabase, from: string, into: string): void {
  db.update(conversations).set({ project: into }).where(eq(conversations.project, from)).run();
}
export function refileInbox(db: DataDatabase, from: string, into: string): void {
  db.update(inbox).set({ project: into }).where(eq(inbox.project, from)).run();
}
