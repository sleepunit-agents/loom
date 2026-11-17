import { wordsKept } from './retention.js';
import {handoffEnvelope,handoffDeadline} from './handoff-words.js';
import {privateInboxEnvelope,privateInboxDeadline,hasPrivateInboxPayload} from './private-inbox-words.js';
/** Trusted in-process body delivery. Decrypted words are ephemeral output:
 * never save them in jobs.brief, generic operation receipts or Inbox columns.
 * External runner doors must recheck their current authentication after await
 * and before committing. This service does not authenticate a machine. */
import {prepareHistoryContext,type HistoryLine} from './history-context.js';
import {prepareBridgeHistory} from './bridge-history.js';
import {prepareAnswerContext,type AnswerContext} from './answer-context.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { inbox, inboxRefs, messages, threads } from '../data/schema.js';
import { mailWords } from './volume.js';
import { CommsMessages } from './messages.js';
import { commsKeepDays } from '../data/comms-days.js';

type Item = typeof inbox.$inferSelect;
export type Delivery = { item: Item; words: string | null; answerContext?:AnswerContext; history?:HistoryLine[] };
// Taking a prepared batch changes only its lease bookkeeping. Changes to any
// content, reference, recipient or label require a fresh preparation.
const content = (item: Item) => JSON.stringify({ ...item, state: null, job: null, takenAt: null, takenVolume:null, changedAt: null });

export class ConversationMail {
  constructor(readonly comms: CommsMessages) {}

  private privateMessages(items: Item[]): Map<string, { message: typeof messages.$inferSelect; conversation: string }> {
    const ids = items.filter(item => item.thread !== null).map(item => item.id);
    if (!ids.length) return new Map();
    const rows = this.comms.db.select({ message: messages, conversation: threads.conversation }).from(messages)
      .innerJoin(threads, eq(threads.id, messages.thread)).where(inArray(messages.inboxItem, ids)).all();
    return new Map(rows.map(row => [row.message.inboxItem!, row]));
  }

  /** Preparation has no durable effects. The returned commit is synchronous
   * and can join the caller's transaction after its current auth check. Mail
   * arriving later is left waiting for the next preparation. */
  async prepareTake(conversation: string, job: string, limit = 50): Promise<() => Delivery[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid mail batch size');
    const { db, key, now, threads: { conversations } } = this.comms;
    if (db.$client.inTransaction) throw new Error('Prepare mail outside a transaction');
    const keepDays = () => commsKeepDays(db);
    const retained = (message: typeof messages.$inferSelect) => {
      const days = keepDays();
      return !!message.words && wordsKept(message, days, now());
    };
    const items = conversations.pending(conversation, job).slice(0,limit), privateRows = this.privateMessages(items);
    const refs = () => items.length ? db.select().from(inboxRefs).where(inArray(inboxRefs.item, items.map(item => item.id)))
      .orderBy(asc(inboxRefs.item), asc(inboxRefs.ref)).all() : [];
    const beforeRefs = refs();
    const prepared = new Map<string, string | null>();
    for (const item of items) {
      if (!item.thread) {
        if(hasPrivateInboxPayload(db,item)){
          const envelope=privateInboxEnvelope(item.words)!;
          prepared.set(item.id,privateInboxDeadline(item,keepDays())>Date.parse(now())?await key.open(Buffer.from(envelope.cipher,'base64')):null);continue;
        }
        const envelope=item.source==='handoff'?handoffEnvelope(item.words):undefined;
        prepared.set(item.id,envelope?(handoffDeadline(item,keepDays())>Date.parse(now())?await key.open(Buffer.from(envelope.cipher,'base64')):null):item.source==='handoff'?null:item.words);continue;
      }
      const row = privateRows.get(item.id);
      if (!row || row.conversation !== conversation || row.message.thread !== item.thread || row.message.seq !== item.messageSeq) throw new Error('Private mail reference differs');
      prepared.set(item.id, retained(row.message) && row.message.words ? await key.open(row.message.words) : null);
    }
    const contexts=new Map<string,()=>AnswerContext|null>();
    for(const item of items)if(item.volume==='full'&&prepared.get(item.id)!==null)contexts.set(item.id,await prepareAnswerContext(this.comms,item));
    const ordinary=(item:Item,words:string|null|undefined)=>item.source==='thread'&&!!item.thread&&item.volume==='full'&&words!==null&&words!==undefined;
    const cutoff=Math.min(Number.MAX_SAFE_INTEGER,...items.filter(item=>item.thread&&item.messageSeq!==null).map(item=>item.messageSeq!));
    const history=items.some(item=>ordinary(item,prepared.get(item.id)))?await prepareHistoryContext(this.comms,conversation,cutoff):()=>[];
    // A bridge conversation has no thread; what was said earlier in it is its own kept words (bridge-history.ts).
    const bridged=(item:Item,words:string|null|undefined)=>(item.source==='discord'||item.source==='slack')&&!item.thread&&item.volume==='full'&&words!==null&&words!==undefined;
    const earlier=items.some(item=>bridged(item,prepared.get(item.id)))?prepareBridgeHistory(db,now,conversation):()=>[];
    return () => db.transaction(() => {
      if (JSON.stringify(refs()) !== JSON.stringify(beforeRefs)) throw new Error('Mail references changed; prepare again');
      const current = new Map(conversations.pending(conversation, job).map(item => [item.id, item]));
      const currentRows = this.privateMessages(items);
      const words = new Map(prepared);
      for (const item of items) {
        const live = current.get(item.id);
        if (!live || content(live) !== content(item)) throw new Error('Mail changed; prepare again');
        if (!item.thread) {if(item.source==='handoff'&&handoffDeadline(live,keepDays())<=Date.parse(now())||hasPrivateInboxPayload(db,item)&&privateInboxDeadline(live,keepDays())<=Date.parse(now()))words.set(item.id,null);continue;}
        const before = privateRows.get(item.id)!, after = currentRows.get(item.id);
        if (!after || after.conversation !== conversation || after.message.thread !== item.thread || after.message.seq !== item.messageSeq) throw new Error('Private mail reference differs');
        // Retention is checked at release, even if ciphertext was swept during
        // decryption. Expired mail keeps its metadata with unavailable words.
        if (!retained(after.message)) words.set(item.id, null);
        else if (!before.message.words || !after.message.words || !Buffer.from(after.message.words).equals(before.message.words)
          || JSON.stringify({ ...after.message, words: null }) !== JSON.stringify({ ...before.message, words: null }))
          throw new Error('Private message changed; prepare again');
      }
      const answerContexts=new Map(items.map(item=>[item.id,contexts.get(item.id)?.()]));
      const dialogue=history(),said=earlier();
      const taken=conversations.take(conversation, job, items.map(item => item.id));
      if(taken.length)db.update(messages).set({delivery:'sending'}).where(and(eq(messages.kind,'message'),inArray(messages.inboxItem,taken.map(item=>item.id)))).run();
      let historyAttached=false;
      return taken.map(item => {const visible=mailWords(item.volume,words.get(item.id)??null),answerContext=visible!==null?answerContexts.get(item.id):null,includeHistory=!historyAttached&&ordinary(item,visible)&&dialogue.length>0,includeSaid=!historyAttached&&!includeHistory&&bridged(item,visible)&&said.length>0;if(includeHistory||includeSaid)historyAttached=true;return {item,words:visible,...(answerContext?{answerContext}:{}),...(includeHistory?{history:dialogue}:includeSaid?{history:said}:{})};});
    });
  }

  /** The checks every report about one taken item shares: it is this conversation's agent mail, and a private
   * item still points at the message it carried. Whether this job holds it is the caller's next check. */
  private held(conversation: string, job: string, itemId: string): Item {
    const { threads: { conversations } } = this.comms;
    conversations.pending(conversation, job); // also validates done-item retries
    const item = conversations.item(itemId), cv = conversations.conversation(conversation);
    if (item.conversation !== conversation || item.toKind !== 'agent' || item.to !== cv.agent) throw new Error('Mail differs from conversation');
    if(item.thread){const message=this.privateMessages([item]).get(item.id);if(!message||message.conversation!==conversation||message.message.thread!==item.thread||message.message.seq!==item.messageSeq)throw new Error('Private mail reference differs');}
    return item;
  }
  private delivered(item: Item): void {
    if (item.thread && item.messageSeq !== null) this.comms.db.update(messages).set({ delivery: 'delivered' })
      .where(and(eq(messages.thread, item.thread), eq(messages.seq, item.messageSeq), eq(messages.inboxItem, item.id), eq(messages.kind, 'message'))).run();
  }

  /** The body has the mail: its sender sees it delivered. Call only after the body accepts the mail, never
   * on enqueue or take. This settles nothing. Mail is settled by its answer (settle, confirm), so a body
   * that dies before answering leaves it to the job's next attempt, where it shows as held again. So an
   * agent can be handed the same mail twice, and is never left with mail nobody answered
   * (docs/accepted-tradeoffs.md, "Mail is delivered at least once"). */
  accept(conversation: string, job: string, itemId: string): Item {
    return this.comms.db.transaction(() => {
      const item = this.held(conversation, job, itemId);
      if (item.job !== job || !['taken', 'done'].includes(item.state)) throw new Error('Item is not held by this job');
      this.delivered(item);
      return item;
    });
  }

  /** The mail is dealt with: done, and never handed to another body. A body calls this once the answer to
   * the mail is recorded, or for mail that needs none. */
  confirm(conversation: string, job: string, itemId: string): Item {
    const { db, threads: { conversations } } = this.comms;
    return db.transaction(() => {
      const item = this.held(conversation, job, itemId);
      const result = conversations.confirm(itemId, job);
      this.delivered(item);
      return result;
    });
  }

  /** A recorded reply is the answer to everything this job took before it. Settling that mail in the reply's
   * own write means a body that dies before its own confirmation cannot have it answered a second time.
   * Mail still waiting (it arrived while the body worked) is not touched. Returns the items settled. */
  settle(conversation: string, job: string): string[] {
    const { db } = this.comms;
    return db.transaction(() => db.select({ id: inbox.id }).from(inbox)
      .where(and(eq(inbox.conversation, conversation), eq(inbox.job, job), eq(inbox.state, 'taken'))).all()
      .map(({ id }) => this.confirm(conversation, job, id).id));
  }
}
