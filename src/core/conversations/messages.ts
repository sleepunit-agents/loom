import { expireArchivedQuestions } from './archived-question-store.js';
import {isBridgeVenue} from './channel-target.js';
import { ageCutoff, keepUntilFor, validKeepDays, wordsKept } from './retention.js';
import {handoffExpiries} from './handoff-words.js';
import {privateInboxExpiries,hasPrivateInboxWords,sealPrivateInbox} from './private-inbox-words.js';
import { inboxContentChanged } from '../tempo/volume.js';
import { randomUUID } from 'node:crypto';
/** Trusted private-message service. External doors authenticate and authorize;
 * encrypted words never enter operation receipts or the plaintext Inbox. */
import { and, eq, inArray, isNotNull, max, or, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversations, deletedThreads, inbox, inboxRefs, messages, threadRefs, threads, turns, digests } from '../data/schema.js';
import type { WordsKey } from './words.js';
import { refsIn } from './refs.js';
import { Threads } from './threads.js';
import { expirePrivateBridgeWords } from './private-bridge-words.js';
import { eraseConversationSessions, expireConversationSessions } from './sessions.js';
import { acceptAnswer, type Answer } from './answer-rule.js';
import { lateMailWaits, type DigestInput, type LateJoins } from './index.js';
import { commsKeepDays } from '../data/comms-days.js';

type Message = typeof messages.$inferSelect;
type TurnDetails = Partial<Pick<typeof turns.$inferInsert, 'model' | 'outcome' | 'latencyMs'>>;

export type PrivateQuestion = { words: string; answers: 'yes-no' | 'words'; why?: string; ifYes?: string; ifNo?: string; link?: string; waitsOnKind?: 'approval' | 'task'; waitsOnId?: string; refs?: string[] };
export type MessageInput = {
  thread: string; sender: string; kind: 'message' | 'reply' | 'card' | 'notice'; words: string;
  clientId?: string; run?: string; tool?: string; cardState?: Message['cardState'];
  turn?: TurnDetails;
  progress?: boolean;
};

export class CommsMessages {
  readonly threads: Threads;
  /** `lateJoins` is the conversations service's (index.ts): bodies take their mail through this one's, so the
   * composition gives it the rule; closed otherwise. */
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly now: () => string = () => new Date().toISOString(), lateJoins: LateJoins = lateMailWaits) {
    this.threads = new Threads(db, now, lateJoins);
  }

  private context(id: string) {
    const thread = this.threads.thread(id);
    return { thread, cv: this.threads.conversations.conversation(thread.conversation) };
  }

  private retry(thread: string, sender: string, clientId?: string) {
    return clientId == null ? undefined : this.db.select().from(messages)
      .where(and(eq(messages.thread, thread), eq(messages.sender, sender), eq(messages.clientId, clientId))).get();
  }

  private append(input: Omit<typeof messages.$inferInsert, 'seq' | 'at' | 'keepUntil'>, refs: string[], detail: TurnDetails = {}, progress = false): Message {
    const { thread, cv } = this.context(input.thread), at = this.now();
    const days = commsKeepDays(this.db);
    if (!validKeepDays(days)) throw new Error('Invalid Comms keep time');
    const seq = (this.db.select({ seq: max(messages.seq) }).from(messages).where(eq(messages.thread, thread.id)).get()?.seq ?? 0) + 1;
    const row = this.db.insert(messages).values({ ...input, seq, at, keepUntil: keepUntilFor(at, days) }).returning().get();
    // threads.last_at and conversations.last_at are two columns for one fact. They are
    // only ever written here, together, from the one time read above.
    this.db.update(threads).set({ lastAt: at }).where(eq(threads.id, thread.id)).run();
    const person = input.kind === 'message' || input.kind === 'answer';
    this.threads.conversations.turn({ conversation: cv.id,
      kind: person ? 'message' : input.kind === 'reply' ? (progress ? 'note' : 'reply') : input.kind === 'card' ? 'action' : 'note',
      fromKind: person ? 'person' : 'agent', fromId: input.sender,
      run: person ? null : input.run, ...detail,
    }, at);
    for (const ref of new Set(refs)) this.db.insert(threadRefs).values({ thread: thread.id, ref, messageSeq: seq })
      .onConflictDoUpdate({ target: [threadRefs.thread, threadRefs.ref], set: { messageSeq: seq } }).run();
    return row;
  }

  attach(message: Message, item: typeof inbox.$inferSelect): Message {
    return this.db.update(messages).set({ inboxItem: item.id }).where(and(eq(messages.thread, message.thread), eq(messages.seq, message.seq))).returning().get()!;
  }

  /** A turn already delivered in the terminal. Record it without queueing another delivery. */
  recordObserved(thread: string, role: 'member' | 'agent', clientId: string, words: Buffer, run: string): boolean {
    return this.db.transaction(() => {
      const { cv } = this.context(thread);
      const sender = role === 'member' ? cv.member : cv.agent;
      if (!sender) throw new Error('A private thread is required');
      if (this.retry(thread, sender, clientId)) return false;
      this.append({
        thread, sender, clientId, kind: role === 'member' ? 'message' : 'reply', words, run,
        delivery: null,
      }, []);
      return true;
    });
  }

  async send(input: MessageInput): Promise<Message> {
    return (await this.prepareSend(input))();
  }

  /** No durable effects until the returned synchronous commit runs. The door
   * must recheck authentication and authorization before invoking it, inside
   * its operation transaction. Return only acknowledgement metadata to receipts. */
  async prepareSend(input: MessageInput): Promise<() => Message> {
    input = { ...input, turn: input.turn ? { ...input.turn } : undefined };
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
      const { turn, progress, ...messageInput } = input;
      let row = this.append({ ...messageInput, words, delivery: input.kind === 'message' ? 'sending' : null }, refs, turn, progress);
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

  async prepareAsk(threadId: string, agent: string, clientId: string, question: PrivateQuestion, run?: string): Promise<() => Message> {
    question = { ...question, refs: question.refs ? [...question.refs] : undefined };
    const { cv } = this.context(threadId);
    if (agent !== cv.agent || !cv.member) throw new Error('Agent differs from private thread');
    const old = this.retry(threadId, agent, clientId);
    if (old) return () => { this.context(threadId); return old; };
    if (!question.words.trim()) throw new Error('Question needs words');
    const words = await this.key.seal(JSON.stringify(question));
    const refs = [...refsIn(Object.values(question).join('\n')), ...question.refs ?? []];
    return () => this.db.transaction(() => {
      const { cv } = this.context(threadId);
      if (agent !== cv.agent || !cv.member) throw new Error('Agent differs from private thread');
      const retry = this.retry(threadId, agent, clientId);
      if (retry) return retry;
      const row = this.append({ thread: threadId, sender: agent, kind: 'ask', clientId, words, run }, refs);
      return this.attach(row, this.threads.conversations.send({ toKind: 'person', to: cv.member!, conversation: cv.id,
        source: 'thread', sourceId: `${threadId}:${row.seq}`, fromKind: 'agent', fromId: agent,
        answers: question.answers, waitsOnKind: question.waitsOnKind, waitsOnId: question.waitsOnId, thread: threadId, messageSeq: row.seq, refs }));
    });
  }

  /** Body reports use this for private digests: prepare encryption outside the
   * caller's transaction, then commit question, digest and rewrite retirement
   * together after that caller rechecks its current authority. */
  async prepareDigest(input: DigestInput & {ifAbsent?:boolean}, outsideDecision?:string): Promise<() => typeof digests.$inferSelect> {
    input = { ...input, items: input.items?.map(item => ({ ...item })),
      question: input.question ? { ...input.question, refs: input.question.refs ? [...input.question.refs] : undefined } : undefined };
    const cvs = this.threads.conversations, cv = cvs.conversation(input.conversation);
    if (input.summary.length > 600) throw new Error('Digest summary exceeds 600 characters');
    const privateThread = cv.venue === 'loom' && !!cv.member;
    const thread = privateThread ? this.db.select().from(threads).where(eq(threads.conversation, cv.id)).get() : undefined;
    if (privateThread && (!thread || input.question && input.question.to !== cv.member)) throw new Error('Private digest needs its member thread');
    const previous = () => this.db.select().from(digests).where(and(eq(digests.conversation, cv.id), eq(digests.run, input.run))).get();
    const before = previous(), ifAbsent=input.ifAbsent===true;
    const validate = () => {
      const current = cvs.conversation(cv.id);
      if (current.agent !== cv.agent || current.member !== cv.member || current.project !== cv.project || current.venue !== cv.venue || current.place !== cv.place
        || privateThread && (!thread || this.threads.thread(thread.id).conversation !== cv.id)) throw new Error('Digest changed during preparation');
      const currentDigest=previous();
      if(ifAbsent&&currentDigest)return currentDigest;
      if(JSON.stringify(currentDigest)!==JSON.stringify(before))throw new Error('Digest changed during preparation');
      return undefined;
    };
    if(outsideDecision&&input.question){
      const q=input.question;
      if(cv.member||!cv.direct||!isBridgeVenue(cv.venue)||q.answers!=='yes-no'||q.onWord!==outsideDecision||q.onWordKind!=='outside')throw Error('Private decision scope changed');
      const words=await sealPrivateInbox(this.key,JSON.stringify({words:q.words,why:q.why,ifYes:q.ifYes,ifNo:q.ifNo}),this.now(),commsKeepDays(this.db));
      return ()=>this.db.transaction(()=>{
        const kept=validate();if(kept)return kept;
        return cvs.guestDecisionDigest(input,q.to,outsideDecision,words);
      });
    }
    if(input.question&&cv.member&&!privateThread){
      const question=input.question;
      if(question.to!==cv.member)throw Error('Private question needs its member');
      const words=await sealPrivateInbox(this.key,JSON.stringify({words:question.words,why:question.why??null,ifYes:question.ifYes??null,ifNo:question.ifNo??null,link:question.link??null}),this.now(),commsKeepDays(this.db));
      return ()=>this.db.transaction(()=>{
        const kept=validate();if(kept)return kept;
        const item=cvs.send({conversation:cv.id,toKind:'person',to:question.to,source:'thread',sourceId:`digest:${randomUUID()}`,fromKind:'agent',fromId:cv.agent,words,answers:question.answers,waitsOnKind:question.waitsOnKind,waitsOnId:question.waitsOnId,refs:question.refs});
        cvs.turn({conversation:cv.id,kind:'note',fromKind:'agent',fromId:cv.agent,run:input.run});
        return cvs.digest({...input,question:undefined},item.id);
      });
    }
    if (!input.question || !privateThread) return () => this.db.transaction(() => { const kept=validate(); return kept??cvs.digest(input); });
    const question = input.question;
    const ask = await this.prepareAsk(thread!.id, cv.agent, `digest:${randomUUID()}`, {
      words: question.words, answers: question.answers, why: question.why ?? undefined,
      ifYes: question.ifYes ?? undefined, ifNo: question.ifNo ?? undefined, link: question.link ?? undefined,
      waitsOnKind: question.waitsOnKind === 'task' || question.waitsOnKind === 'approval' ? question.waitsOnKind : undefined,
      waitsOnId: question.waitsOnId ?? undefined, refs: question.refs,
    }, input.run);
    return () => this.db.transaction(() => {
      const kept=validate();if(kept)return kept;
      const message = ask();
      return cvs.digest({ ...input, question: undefined }, message.inboxItem!);
    });
  }

  async digest(input: DigestInput): Promise<typeof digests.$inferSelect> {
    return (await this.prepareDigest(input))();
  }

  async answer(itemId: string, member: string, answer: Answer, text?: string): Promise<typeof inbox.$inferSelect> {
    return (await this.prepareAnswer(itemId, member, answer, text))();
  }

  async prepareAnswer(itemId: string, member: string, answer: Answer, text?: string): Promise<() => typeof inbox.$inferSelect> {
    const check = () => {
      const item = this.threads.conversations.item(itemId);
      if (!item.thread || item.messageSeq == null || item.toKind !== 'person' || !item.answers) throw new Error('Not a private question');
      const { cv } = this.context(item.thread);
      if (item.conversation !== cv.id || item.source !== 'thread') throw new Error('Question differs from thread');
      return { item, cv, verdict: acceptAnswer(item, member, answer, text, true) };
    };
    if (check().verdict === 'repeat') return () => check().item;
    const words = await this.key.seal(text?.trim() || answer), refs = refsIn(text ?? '');
    return () => this.db.transaction(() => {
      const { item, cv, verdict } = check();
      if (verdict === 'repeat') return item;
      const row = this.append({ thread: item.thread!, sender: member, kind: 'answer', words,
        verdict: answer === 'yes' || answer === 'no' ? answer : null }, refs);
      const mail = this.threads.conversations.send({ toKind: 'agent', to: cv.agent, conversation: cv.id, source: 'answer', sourceId: item.id,
        fromKind: 'person', fromId: member, thread: row.thread, messageSeq: row.seq, refs: [item.id, ...refs] });
      this.attach(row, mail);
      const at = this.now();
      inboxContentChanged(this.db, {kind:item.toKind,id:item.to}, item.id);
      return this.db.update(inbox).set({ state: 'answered', answer, answerText: null, answeredBy: member, answeredAt: at, changedAt: at })
        .where(eq(inbox.id, item.id)).returning().get()!;
    });
  }

  async prepareInboxAnswer(itemId:string,member:string,answer:Answer,text?:string):Promise<()=>typeof inbox.$inferSelect>{
    const cvs=this.threads.conversations;
    const check=()=>{
      const item=cvs.item(itemId),cv=item.conversation?cvs.conversation(item.conversation):undefined;
      if(!cv||!cv.member||item.thread||cv.venue==='loom'||item.member!==cv.member||item.toKind!=='person'||item.to!==cv.member||item.agent!==cv.agent||item.project!==cv.project||item.source!=='thread'||item.fromKind!=='agent'||item.fromId!==cv.agent||!item.answers||!hasPrivateInboxWords(item.words)&&item.words!==null)throw Error('Not a standalone private question');
      if(item.sourceId?.startsWith('guest-decision:')&&(answer==='words'||answer==='replied'))throw Error('Choose yes or no for this decision');
      return {item,cv,verdict:acceptAnswer(item,member,answer,text,true)};
    };
    const before=check();if(before.verdict==='repeat')return()=>check().item;
    const words=await sealPrivateInbox(this.key,text?.trim()||answer,this.now(),commsKeepDays(this.db));
    return ()=>this.db.transaction(()=>{
      const live=check();if(live.verdict==='repeat')return live.item;
      if(JSON.stringify(live)!==JSON.stringify(before))throw Error('Question changed during preparation');
      const {item,cv}=live,at=this.now();
      const privateDecision=cv.venue==='wake'&&cv.place===JSON.stringify(['guest-decision',member])&&item.sourceId?.startsWith('guest-decision:');
      const ownerCopy=cvs.send({conversation:cv.id,toKind:'agent',to:cv.agent,source:'answer',sourceId:item.id,fromKind:'person',fromId:member,words,refs:privateDecision?[item.id]:[item.id,...refsIn(text??'')]});
      if(privateDecision){
        const digest=this.db.select().from(digests).where(eq(digests.inboxItem,item.id)).get();
        if(!digest||item.sourceId!=='guest-decision:'+digest.id+':'+digest.revision||item.onWordKind!=='outside'||!item.onWord)throw Error('Decision source changed');
        const source=cvs.conversation(digest.conversation);
        if(source.agent!==cv.agent||source.member||!source.direct||!isBridgeVenue(source.venue))throw Error('Decision recipient changed');
        // Keep the optional explanation with the owner. Only the verdict is work for the guest.
        this.db.update(inbox).set({state:'done',doneAt:at,changedAt:at}).where(eq(inbox.id,ownerCopy.id)).run();
        if(answer==='yes'||answer==='no')cvs.send({conversation:source.id,toKind:'agent',to:source.agent,source:'answer',sourceId:'guest-decision:'+item.id,fromKind:'agent',fromId:source.agent,onWordKind:'outside',onWord:item.onWord,words:'Owner decision for digest '+digest.id+' revision '+digest.revision+': '+answer+'.'});
      }
      cvs.turn({conversation:cv.id,kind:'message',fromKind:'person',fromId:member});
      inboxContentChanged(this.db,{kind:item.toKind,id:item.to},item.id);
      return this.db.update(inbox).set({state:'answered',answer,answerText:null,answeredBy:member,answeredAt:at,changedAt:at}).where(eq(inbox.id,item.id)).returning().get()!;
    });
  }

  /** Expired words stay unavailable even before the periodic sweep runs. */
  async words(thread: string, seq: number): Promise<string | null> {
    const row = this.db.select().from(messages).where(and(eq(messages.thread, thread), eq(messages.seq, seq))).get();
    const keepDays = () => commsKeepDays(this.db);
    const retained = (message: Message | undefined, days: number) => !!message?.words && wordsKept(message, days, this.now());
    const days = keepDays();
    if (!retained(row, days) || !row?.words) return null;
    const words = await this.key.open(row.words);
    const current = this.db.select().from(messages).where(and(eq(messages.thread, thread), eq(messages.seq, seq))).get();
    return retained(current, keepDays()) && keepDays() === days && current?.words
      && current.at === row.at && current.keepUntil === row.keepUntil && current.words.equals(row.words) ? words : null;
  }

  expire(): number {
    const days = commsKeepDays(this.db);
    if (!validKeepDays(days)) throw new Error('Invalid Comms keep time');
    const at = this.now(), cutoff = ageCutoff(at, days);
    let expired=0;
    for(const item of privateInboxExpiries(this.db,days))if(item.until<=Date.parse(at)){this.db.update(inbox).set({words:null}).where(eq(inbox.id,item.id)).run();expired++;}
    expired+=expirePrivateBridgeWords(this.db,cutoff);
    expired += expireArchivedQuestions(this.db,at,cutoff);
    // A kept harness session holds its conversation's words: it goes at the same keep time.
    expired+=expireConversationSessions(this.db,at);
    for(const item of handoffExpiries(this.db,days))if(item.until<=Date.parse(at)){this.db.update(inbox).set({words:null}).where(eq(inbox.id,item.id)).run();expired++;}
    return expired+this.db.update(messages).set({ words: null }).where(and(isNotNull(messages.words),
      or(sql`julianday(${messages.keepUntil}) <= julianday(${at})`, sql`julianday(${messages.at}) <= julianday(${cutoff})`))).returning({ seq: messages.seq }).all().length;
  }

  /** Remove private words and references; retain Inbox outcome metadata and a
   * tombstone so delayed retries cannot recreate the conversation's thread. */
  delete(threadId: string): void {
    this.db.transaction(() => {
      const prior = this.db.select().from(deletedThreads).where(eq(deletedThreads.id, threadId)).get();
      if (prior) {
        eraseConversationSessions(this.db, prior.conversation);
        return;
      }
      const { thread } = this.context(threadId), at = this.now();
      this.db.insert(deletedThreads).values({ id: threadId, conversation: thread.conversation, at }).run();
      this.db.delete(inboxRefs).where(inArray(inboxRefs.item, this.db.select({ id: inbox.id }).from(inbox).where(eq(inbox.thread, threadId)))).run();
      this.db.update(inbox).set({ thread: null, messageSeq: null,
        state: sql`case when ${inbox.state} in ('waiting', 'taken') then 'resolved' else ${inbox.state} end`,
        resolution: 'Thread deleted', changedAt: at }).where(eq(inbox.thread, threadId)).run();
      eraseConversationSessions(this.db, thread.conversation);
      this.db.delete(threads).where(eq(threads.id, threadId)).run();
    });
  }
}
