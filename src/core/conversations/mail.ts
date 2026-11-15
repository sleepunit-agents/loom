/** Trusted in-process body delivery. Decrypted words are ephemeral output:
 * never save them in jobs.brief, generic operation receipts or Inbox columns.
 * External runner doors must recheck their current authentication after await
 * and before committing. This service does not authenticate a machine. */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { household, inbox, inboxRefs, messages, threads } from '../data/schema.js';
import { mailWords } from './volume.js';
import { CommsMessages } from './messages.js';

type Item = typeof inbox.$inferSelect;
export type Delivery = { item: Item; words: string | null };
// Taking a prepared batch changes only its lease bookkeeping. Changes to any
// content, reference, recipient or label require a fresh preparation.
const content = (item: Item) => JSON.stringify({ ...item, state: null, job: null, takenAt: null, changedAt: null });

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
    const keepDays = () => db.select({ days: household.commsDays }).from(household).get()?.days ?? 14;
    const retained = (message: typeof messages.$inferSelect) => {
      const days = keepDays();
      return !!message.words && !!message.keepUntil && Number.isInteger(days) && days >= 1 && days <= 14
        && Date.parse(message.keepUntil) > Date.parse(now()) && Date.parse(message.at) + days * 86400000 > Date.parse(now());
    };
    const items = conversations.pending(conversation, job).slice(0,limit), privateRows = this.privateMessages(items);
    const refs = () => items.length ? db.select().from(inboxRefs).where(inArray(inboxRefs.item, items.map(item => item.id)))
      .orderBy(asc(inboxRefs.item), asc(inboxRefs.ref)).all() : [];
    const beforeRefs = refs();
    const prepared = new Map<string, string | null>();
    for (const item of items) {
      if (!item.thread) { prepared.set(item.id, item.words); continue; }
      const row = privateRows.get(item.id);
      if (!row || row.conversation !== conversation || row.message.thread !== item.thread || row.message.seq !== item.messageSeq) throw new Error('Private mail reference differs');
      prepared.set(item.id, retained(row.message) && row.message.words ? await key.open(row.message.words) : null);
    }
    return () => db.transaction(() => {
      if (JSON.stringify(refs()) !== JSON.stringify(beforeRefs)) throw new Error('Mail references changed; prepare again');
      const current = new Map(conversations.pending(conversation, job).map(item => [item.id, item]));
      const currentRows = this.privateMessages(items);
      const words = new Map(prepared);
      for (const item of items) {
        const live = current.get(item.id);
        if (!live || content(live) !== content(item)) throw new Error('Mail changed; prepare again');
        if (!item.thread) continue;
        const before = privateRows.get(item.id)!, after = currentRows.get(item.id);
        if (!after || after.conversation !== conversation || after.message.thread !== item.thread || after.message.seq !== item.messageSeq) throw new Error('Private mail reference differs');
        // Retention is checked at release, even if ciphertext was swept during
        // decryption. Expired mail keeps its metadata with unavailable words.
        if (!retained(after.message)) words.set(item.id, null);
        else if (!before.message.words || !after.message.words || !Buffer.from(after.message.words).equals(before.message.words)
          || JSON.stringify({ ...after.message, words: null }) !== JSON.stringify({ ...before.message, words: null }))
          throw new Error('Private message changed; prepare again');
      }
      const taken=conversations.take(conversation, job, items.map(item => item.id));
      if(taken.length)db.update(messages).set({delivery:'sending'}).where(and(eq(messages.kind,'message'),inArray(messages.inboxItem,taken.map(item=>item.id)))).run();
      return taken.map(item => ({ item, words: mailWords(item.volume,words.get(item.id) ?? null) }));
    });
  }

  /** Call only after the body accepts the mail, never on enqueue or take. */
  confirm(conversation: string, job: string, itemId: string): Item {
    const { db, threads: { conversations } } = this.comms;
    return db.transaction(() => {
      conversations.pending(conversation, job); // also validates done-item retries
      const item = conversations.item(itemId), cv = conversations.conversation(conversation);
      if (item.conversation !== conversation || item.toKind !== 'agent' || item.to !== cv.agent) throw new Error('Mail differs from conversation');
      if(item.thread){const message=this.privateMessages([item]).get(item.id);if(!message||message.conversation!==conversation||message.message.thread!==item.thread||message.message.seq!==item.messageSeq)throw new Error('Private mail reference differs');}
      const result = conversations.confirm(itemId, job);
      if (item.thread && item.messageSeq !== null) db.update(messages).set({ delivery: 'delivered' })
        .where(and(eq(messages.thread, item.thread), eq(messages.seq, item.messageSeq), eq(messages.inboxItem, item.id), eq(messages.kind, 'message'))).run();
      return result;
    });
  }
}
